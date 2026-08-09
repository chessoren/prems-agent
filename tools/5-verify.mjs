/**
 * Stage 5 - Verify.
 *
 * Serves the built clone, renders every route at every breakpoint with the same
 * settle procedure used for the reference, and pixel-diffs the two.
 *
 * Output: .cache/diff/<slug>@<bp>.png for anything that differs, plus a summary
 * table. This is the check that the clone is actually pixel-faithful rather
 * than merely "looks about right".
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { CACHE_DIR, ROOT, CHROME, BREAKPOINTS } from './lib/config.mjs';

const DIST = join(ROOT, 'dist');
const REF_DIR = join(CACHE_DIR, 'reference');
const OUT_DIR = join(CACHE_DIR, 'clone');
const DIFF_DIR = join(CACHE_DIR, 'diff');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function serveDist() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = join(DIST, p);
        if (!extname(p)) file = join(DIST, p, 'index.html');
        const buf = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'text/plain' });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function settle(page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  // Long enough for the slowest appear animation (2s duration + 1s delay).
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
}

function compare(aBuf, bBuf) {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (img) => {
    const o = new PNG({ width: w, height: h });
    PNG.bitblt(img, o, 0, 0, w, h, 0, 0);
    return o;
  };
  const A = crop(a);
  const B = crop(b);
  const out = new PNG({ width: w, height: h });
  const n = pixelmatch(A.data, B.data, out.data, w, h, { threshold: 0.1 });
  return {
    diffPixels: n,
    pct: (n / (w * h)) * 100,
    sizeA: [a.width, a.height],
    sizeB: [b.width, b.height],
    png: out,
  };
}

async function main() {
  const routes = JSON.parse(await readFile(join(CACHE_DIR, 'routes.json'), 'utf8'));
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(DIFF_DIR, { recursive: true });

  const server = await serveDist();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME });

  const rows = [];
  for (const route of routes) {
    for (const bp of BREAKPOINTS) {
      const tag = `${route.slug}@${bp.name}`;
      const ctx = await browser.newContext({
        viewport: { width: bp.width, height: 900 },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin + route.pathname, { waitUntil: 'load', timeout: 120000 });
      await settle(page);
      const shot = await page.screenshot({ fullPage: true });
      await writeFile(join(OUT_DIR, `${tag}.png`), shot);
      await ctx.close();

      let ref;
      try {
        ref = await readFile(join(REF_DIR, `${tag}.png`));
      } catch {
        rows.push({ tag, status: 'NO REFERENCE' });
        continue;
      }
      const r = compare(ref, shot);
      if (r.diffPixels > 0) {
        await writeFile(join(DIFF_DIR, `${tag}.png`), PNG.sync.write(r.png));
      }
      rows.push({
        tag,
        pct: r.pct,
        diffPixels: r.diffPixels,
        heights: `${r.sizeA[1]} vs ${r.sizeB[1]}`,
        errors: errors.length,
      });
    }
  }

  await browser.close();
  server.close();

  rows.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  console.log('\n  diff%    pixels    height(ref vs clone)   route');
  for (const r of rows) {
    if (r.status) {
      console.log(`  ${r.status.padEnd(38)} ${r.tag}`);
      continue;
    }
    const flag = r.pct > 1 ? '  <-- check' : '';
    console.log(
      `  ${r.pct.toFixed(3).padStart(6)}  ${String(r.diffPixels).padStart(9)}   ` +
        `${r.heights.padEnd(20)}  ${r.tag}${flag}`,
    );
  }
  const worst = rows.filter((r) => r.pct > 1).length;
  const mean = rows.reduce((s, r) => s + (r.pct || 0), 0) / rows.length;
  console.log(`\nmean diff ${mean.toFixed(3)}% - ${worst}/${rows.length} views above 1%`);
  await writeFile(join(CACHE_DIR, 'verify-report.json'), JSON.stringify(rows, null, 2));
}

await main();
