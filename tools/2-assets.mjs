/**
 * Stage 2 - Asset mirroring.
 *
 * Scans every cached page (markup + the inline <style> blocks) for remote
 * assets on Framer / Google Fonts hosts, downloads them into public/assets/,
 * and writes .cache/assets.json - the canonical remote-URL -> local-path map
 * every later stage rewrites against.
 */
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { get, pool } from './lib/net.mjs';
import { CACHE_DIR, PUBLIC_DIR, VENDOR_DIR, ASSET_HOSTS } from './lib/config.mjs';

const RAW_DIR = `${CACHE_DIR}/raw`;
const ASSET_DIR = `${PUBLIC_DIR}/assets`;

/** Script bundles are build-time only; everything else is a real site asset. */
const isVendor = (kind) => kind === 'scripts';
const dirFor = (kind) => (isVendor(kind) ? `${VENDOR_DIR}/${kind}` : `${ASSET_DIR}/${kind}`);
const urlFor = (kind, name) =>
  isVendor(kind) ? `/vendor/${kind}/${name}` : `/assets/${kind}/${name}`;

/**
 * Asset urls appear inside JS template literals and srcset lists, so the
 * character class has to stop at every delimiter those use - backticks and
 * commas included - or we capture a url plus the rest of the expression.
 */
const HOST_RE = new RegExp(
  `https?://(?:[a-z0-9-]+\\.)*(?:${ASSET_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})` +
    '/[^\\s"\'()\\\\<>`,;]+',
  'gi',
);

/** Framer appends ?scale-down-to=... / lossless=1 - those are separate files. */
function classify(url) {
  const u = new URL(url);
  const ext = (extname(u.pathname) || '').toLowerCase();
  if (/\.(woff2?|ttf|otf|eot)$/.test(ext)) return 'fonts';
  if (/\.(mp4|webm|mov|m4v)$/.test(ext)) return 'videos';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(ext)) return 'images';
  if (/\.(js|mjs)$/.test(ext)) return 'scripts';
  if (/\.css$/.test(ext)) return 'styles';
  return 'misc';
}

/**
 * Stable, readable local filename: keep the original basename, and only add a
 * short hash when query params make the same basename mean different bytes.
 */
function localNameFor(url) {
  const u = new URL(url);
  const raw = u.pathname.split('/').pop() || 'asset';
  let base;
  try {
    base = decodeURIComponent(raw);
  } catch {
    base = raw; // stray % in the path - keep it verbatim
  }
  base = base.replace(/[^\w.-]/g, '_');
  if (!u.search) return base;
  const h = createHash('sha1').update(u.search).digest('hex').slice(0, 8);
  const ext = extname(base);
  return `${base.slice(0, base.length - ext.length)}.${h}${ext}`;
}

async function collectUrls() {
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.html'));
  const urls = new Set();
  for (const f of files) {
    const html = await readFile(`${RAW_DIR}/${f}`, 'utf8');
    // Decode HTML entities so srcset/&amp; URLs are captured correctly.
    const text = html.replace(/&amp;/g, '&').replace(/&#x27;|&quot;/g, '"');
    for (const m of text.matchAll(HOST_RE)) urls.add(m[0].replace(/[),;'"]+$/, ''));
  }
  return [...urls];
}

/** Text assets can reference further assets - JS chunks especially. */
const isScannable = (kind) => kind === 'scripts' || kind === 'styles' || kind === 'misc';

async function downloadAll(urls, map, stats) {
  const fresh = [];
  await pool(urls, 8, async (url) => {
    const kind = classify(url);
    const name = localNameFor(url);
    const rel = urlFor(kind, name);
    const dest = `${dirFor(kind)}/${name}`;
    await mkdir(dirFor(kind), { recursive: true });
    try {
      const existing = await stat(dest).catch(() => null);
      if (existing?.size) {
        map[url] = rel;
        stats.ok++;
        stats.bytes += existing.size;
        if (isScannable(kind)) fresh.push(dest);
        return;
      }
      const buf = await get(url, { as: 'buffer' });
      await writeFile(dest, buf);
      map[url] = rel;
      stats.ok++;
      stats.bytes += buf.length;
      if (isScannable(kind)) fresh.push(dest);
    } catch (err) {
      stats.failed++;
      console.warn(`  ! ${url.slice(0, 90)} -> ${err.message}`);
    }
  });
  return fresh;
}

/**
 * Rolldown emits sibling chunks as bare "Name.hash.mjs" strings resolved
 * against import.meta.url, so they never appear as absolute urls. Resolve them
 * against the bundle base we already know.
 */
const CHUNK_RE = /["'`](?:\.\/)?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{6,}\.m?js)["'`]/g;

function bundleBases(map) {
  const bases = new Set();
  for (const url of Object.keys(map)) {
    const m = url.match(/^(https:\/\/framerusercontent\.com\/sites\/[^/]+\/)/);
    if (m) bases.add(m[1]);
  }
  return [...bases];
}

/** Pull further asset urls out of already-downloaded text files. */
async function scanFiles(paths, map) {
  const found = new Set();
  const bases = bundleBases(map);
  for (const p of paths) {
    const text = await readFile(p, 'utf8').catch(() => '');
    for (const m of text.matchAll(HOST_RE)) found.add(m[0].replace(/[),;'"\\]+$/, ''));
    for (const m of text.matchAll(CHUNK_RE)) {
      for (const base of bases) found.add(base + m[1]);
    }
  }
  return found;
}

async function main() {
  const map = {};
  const stats = { ok: 0, failed: 0, bytes: 0 };

  let frontier = await collectUrls();
  const seen = new Set(frontier);
  const byKind = {};
  for (const u of frontier) byKind[classify(u)] = (byKind[classify(u)] || 0) + 1;
  console.log(`pass 1: ${frontier.length} assets referenced from markup`, byKind);

  // Framer code-splits, so chunks are only discoverable from inside other
  // chunks. Keep following references until the graph closes.
  for (let pass = 1; frontier.length && pass <= 8; pass++) {
    const fresh = await downloadAll(frontier, map, stats);
    const discovered = await scanFiles(fresh, map);
    frontier = [...discovered].filter((u) => !seen.has(u));
    for (const u of frontier) seen.add(u);
    if (frontier.length) console.log(`pass ${pass + 1}: +${frontier.length} newly referenced`);
  }

  await writeFile(`${CACHE_DIR}/assets.json`, JSON.stringify(map, null, 2));
  console.log(
    `\nmirrored ${stats.ok}/${seen.size} assets (${(stats.bytes / 1e6).toFixed(1)} MB), ${stats.failed} failed`,
  );
  console.log(`map -> ${CACHE_DIR}/assets.json`);
}

await main();
