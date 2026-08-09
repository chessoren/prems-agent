/**
 * Stage 3 - Reference capture.
 *
 * Boots the mirrored original (React and all) on localhost, then for every
 * route and breakpoint:
 *   - waits for hydration + appear animations to settle
 *   - screenshots the full page  -> .cache/reference/<slug>@<bp>.png
 *   - records the hydrated DOM   -> .cache/hydrated/<slug>@<bp>.html
 *
 * The hydrated DOM matters because Framer's SSR output omits content that only
 * materialises client-side (collapsed FAQ answers, inactive tab panels).
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { CACHE_DIR, CHROME, BREAKPOINTS } from './lib/config.mjs';
import { startMirrorServer } from './lib/mirror-server.mjs';
import { FINALISE_APPEAR } from './lib/appear.mjs';

const REF_DIR = `${CACHE_DIR}/reference`;
const DOM_DIR = `${CACHE_DIR}/hydrated`;

/** Settle: fonts loaded, appear animations finished, lazy images decoded. */
async function settle(page) {
  await page.evaluate(() => document.fonts?.ready);
  // Walk the page so IntersectionObserver-driven content mounts, then return.
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);

  // Framer's optimised appear animations are started by an inline script and
  // handed over to Framer Motion during hydration. That handover does not
  // complete in an offline mirror, leaving elements pinned at their start
  // state (opacity 0.001). Settle them to the end state a real visitor sees.
  const settled = await page.evaluate(FINALISE_APPEAR);
  await page.waitForTimeout(300);
  return settled;
}

async function main() {
  const mirror = await startMirrorServer();
  console.log(`mirror serving original at ${mirror.origin}`);

  await mkdir(REF_DIR, { recursive: true });
  await mkdir(DOM_DIR, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME });
  const problems = [];

  for (const route of mirror.routes) {
    for (const bp of BREAKPOINTS) {
      const ctx = await browser.newContext({
        viewport: { width: bp.width, height: 900 },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
      });
      const page = await ctx.newPage();
      const failures = [];
      page.on('requestfailed', (r) => failures.push(r.url()));
      page.on('pageerror', (e) => problems.push(`${route.slug}@${bp.name} JS: ${e.message}`));

      await page.goto(mirror.origin + route.pathname, {
        waitUntil: 'load',
        timeout: 120000,
      });
      const settled = await settle(page);

      const tag = `${route.slug}@${bp.name}`;
      await page.screenshot({ path: `${REF_DIR}/${tag}.png`, fullPage: true });
      await writeFile(`${DOM_DIR}/${tag}.html`, await page.content());

      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      const hydrated = await page.evaluate(() => !!document.querySelector('#main')?.children.length);
      console.log(
        `  ${tag.padEnd(52)} h=${String(h).padStart(6)} appear=${settled}` +
          (failures.length ? ` MISSING=${failures.length}` : ''),
      );
      if (failures.length) {
        problems.push(`${tag}: ${failures.length} failed requests, e.g. ${failures[0]}`);
      }
      await ctx.close();
    }
  }

  await browser.close();
  await mirror.close();

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems.slice(0, 20)) console.log('  ! ' + p);
  } else {
    console.log('\nno missing assets, no page errors - mirror is complete.');
  }
}

await main();
