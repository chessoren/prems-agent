/**
 * A local HTTP server that serves the *original* Framer site entirely from the
 * mirrored assets - React bundles included.
 *
 * This is the trick that makes the whole pipeline verifiable offline: once the
 * original runs locally with working JS, it becomes the ground-truth reference
 * we screenshot against, and we can drive it with a browser to harvest content
 * that only exists after hydration (collapsed FAQ answers, inactive tabs...).
 *
 * Framer's ES module bundles import each other by absolute CDN URL, so module
 * bodies are rewritten on the fly against the same asset map.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CACHE_DIR, PUBLIC_DIR, VENDOR_DIR } from './config.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Longest-first so `?scale-down-to=512` variants win over the bare url. */
function buildRewriter(assetMap) {
  const entries = Object.entries(assetMap).sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [remote, local] of entries) {
      if (out.includes(remote)) out = out.split(remote).join(local);
      const escaped = remote.replace(/&/g, '&amp;');
      if (escaped !== remote && out.includes(escaped)) out = out.split(escaped).join(local);
    }
    return out;
  };
}

export async function startMirrorServer({ port = 0 } = {}) {
  const assetMap = JSON.parse(await readFile(join(CACHE_DIR, 'assets.json'), 'utf8'));
  const routes = JSON.parse(await readFile(join(CACHE_DIR, 'routes.json'), 'utf8'));
  const rewrite = buildRewriter(assetMap);

  // Routes are keyed on the *decoded* path so that percent-encoded slugs in the
  // sitemap (e.g. "5%C3%97") match the decoded pathname the browser sends.
  const byPath = new Map();
  for (const r of routes) {
    const key = decodeURIComponent(r.pathname).replace(/\/$/, '') || '/';
    byPath.set(key, r.slug);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      // Asset passthrough (with module-body rewriting for JS).
      if (pathname.startsWith('/assets/') || pathname.startsWith('/vendor/')) {
        const file = pathname.startsWith('/vendor/')
          ? join(VENDOR_DIR, pathname.slice('/vendor/'.length))
          : join(PUBLIC_DIR, pathname);
        const ext = extname(pathname).toLowerCase();
        if (ext === '.mjs' || ext === '.js') {
          const body = rewrite(await readFile(file, 'utf8'));
          res.writeHead(200, { 'content-type': MIME[ext] });
          return res.end(body);
        }
        const buf = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        return res.end(buf);
      }

      // Page route -> mirrored SSR html with every url localised.
      const key = pathname.replace(/\/$/, '') || '/';
      const slug = byPath.get(key);
      if (!slug) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end(`no mirrored route for ${pathname}`);
      }
      let html = await readFile(join(CACHE_DIR, 'raw', `${slug}.html`), 'utf8');
      html = rewrite(html);
      // Kill the outbound analytics beacon; it cannot resolve offline.
      html = html.replace(/<script[^>]*events\.framer\.com[^>]*>\s*<\/script>/g, '');
      // Hide (never remove) the Framer badge: the clone has no badge, so this
      // keeps the reference comparable. Removing the node instead would change
      // the tree React hydrates against and trigger a hydration mismatch.
      html = html.replace(
        '</head>',
        '<style>#__framer-badge-container{display:none!important}</style></head>',
      );
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(html);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  return {
    port: actual,
    origin: `http://127.0.0.1:${actual}`,
    routes,
    close: () => new Promise((r) => server.close(r)),
  };
}
