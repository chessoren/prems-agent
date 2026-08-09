/**
 * Proxy-aware fetch helpers shared by every pipeline stage.
 *
 * Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, which
 * the runner sets for us. We keep a small retry/backoff wrapper because the
 * Framer CDN occasionally 503s on burst downloads.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function get(url, { as = 'text', retries = 4, timeout = 60000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(2 ** attempt * 500);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: '*/*' },
        signal: ctl.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        // 4xx other than 429 will not fix themselves - fail fast.
        if (res.status < 500 && res.status !== 429) {
          throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
        }
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500 && err.status !== 429) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `worker` over `items` with bounded concurrency, preserving order. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
