/**
 * Stage 1 - Snapshot.
 *
 * Reads the Framer sitemap and stores the server-rendered HTML for every route
 * under .cache/raw/. No browser needed: Framer ships a complete SSR document,
 * the React bundle only hydrates it.
 *
 * Output: .cache/raw/<slug>.html + .cache/routes.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { get, pool } from './lib/net.mjs';
import { SITE_ORIGIN, CACHE_DIR } from './lib/config.mjs';

const RAW_DIR = `${CACHE_DIR}/raw`;

/** "/" -> "index", "/blogs/foo" -> "blogs__foo" */
export function slugFor(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/|\/$/g, '');
  return clean === '' ? 'index' : clean.replace(/\//g, '__');
}

async function readSitemap() {
  const xml = await get(`${SITE_ORIGIN}/sitemap.xml`);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (!locs.length) throw new Error('sitemap.xml contained no <loc> entries');
  return locs;
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  const urls = await readSitemap();
  console.log(`sitemap: ${urls.length} routes`);

  const routes = await pool(urls, 4, async (url) => {
    const { pathname } = new URL(url);
    const slug = slugFor(pathname);
    const html = await get(url);
    await writeFile(`${RAW_DIR}/${slug}.html`, html);
    console.log(`  ${String(html.length).padStart(8)}  ${pathname}`);
    return { url, pathname, slug, bytes: html.length };
  });

  await writeFile(`${CACHE_DIR}/routes.json`, JSON.stringify(routes, null, 2));
  console.log(`\nsaved ${routes.length} routes -> ${RAW_DIR}`);
}

await main();
