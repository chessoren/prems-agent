/**
 * Screenshot the built site from a running preview server.
 *
 * Useful when the site is being served somewhere you cannot open a browser
 * against - a remote container, CI - and you just want to look at it. Reports
 * page errors and failed requests alongside each shot, so a broken asset path
 * shows up as a number rather than something you have to spot by eye.
 *
 *   npm run preview &        # or: npx astro preview
 *   npm run shots            # -> .cache/shots/*.png
 *   npm run shots -- /contact /blogs/…   # specific routes
 *
 * Routes default to the three that exercise the most layout.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { CHROME, CACHE_DIR, BREAKPOINTS } from './lib/config.mjs';

const OUT = `${CACHE_DIR}/shots`;
const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4321';

const routes = process.argv.slice(2);
const targets = routes.length
  ? routes.flatMap((route) => BREAKPOINTS.map((bp) => ({ route, bp })))
  : [
      { route: '/', bp: BREAKPOINTS[0] },
      { route: '/', bp: BREAKPOINTS[2] },
      { route: '/pricing', bp: BREAKPOINTS[0] },
    ];

/** Scroll the page so lazy content mounts and appear animations finish. */
async function settle(page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 100));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });

for (const { route, bp } of targets) {
  const ctx = await browser.newContext({
    viewport: { width: bp.width, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`js: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`missing: ${r.url().slice(-60)}`));

  await page.goto(ORIGIN + route, { waitUntil: 'load', timeout: 60000 });
  await settle(page);

  const name = `${(route === '/' ? 'index' : route.replace(/^\/|\/$/g, '').replace(/\//g, '__'))}@${bp.name}`;
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);

  console.log(
    `  ${name.padEnd(40)} ${String(bp.width).padStart(4)}px  h=${String(height).padStart(6)}  ` +
      (problems.length ? `${problems.length} issue(s): ${problems[0]}` : 'clean'),
  );
  await ctx.close();
}

await browser.close();
console.log(`\nshots -> ${OUT}`);
