/**
 * Drive the onboarding end to end in a real browser and capture every screen.
 *
 *   npm run preview   # in another shell
 *   node tools/onboarding-shots.mjs
 *
 * A pixel diff cannot check this flow - there is no original to diff against -
 * so the check is that a scripted run reaches the final screen without a
 * console error, at both breakpoints, with a screenshot of each step.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4321';
const OUT = '.cache/onboarding';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, isMobile: true },
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    locale: 'fr-FR',
    hasTouch: viewport.isMobile,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  const shot = async (name) => {
    await page.waitForTimeout(650);
    await page.screenshot({ path: `${OUT}/${viewport.name}-${name}.png` });
  };

  await page.goto(`${BASE}/onboarding/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // 0 - hook
  await shot('00-hook');
  await page.click('.ob-hook__cta button');

  // 1 - city
  await page.fill('.ob-autocomplete input', 'Paris');
  await page.waitForSelector('.ob-autocomplete__item', { timeout: 8000 });
  await shot('01-city');
  await page.click('.ob-autocomplete__item');

  // 2 - budget
  await page.waitForSelector('.ob-slider');
  await page.fill('.ob-slider__input', '1300');
  await page.dispatchEvent('.ob-slider__input', 'input');
  await shot('02-budget');
  await page.click('.ob__footer .ob-btn');

  // 3 - rooms
  await page.waitForSelector('.ob-option[data-value="2"]');
  await shot('03-rooms');
  await page.click('.ob-option[data-value="2"]');

  // 4 - date
  await page.waitForSelector('.ob-option[data-value="asap"]');
  await shot('04-date');
  await page.click('.ob-option[data-value="asap"]');

  // aha
  await page.waitForSelector('.ob-listing', { timeout: 10000 });
  await shot('05-aha');
  await page.click('.ob__footer .ob-btn');

  // 5 - account
  await page.waitForSelector('input[type="tel"]');
  await page.fill('input[type="tel"]', '612345678');
  await shot('06-account');
  await page.click('.ob__footer .ob-btn');

  // 6 - employment
  await page.waitForSelector('.ob-option[data-value="cdi"]', { timeout: 10000 });
  await shot('07-employment');
  await page.click('.ob-option[data-value="cdi"]');

  // 7 - income, below the 3x threshold so the guarantor branch is exercised
  await page.waitForSelector('.ob-affix input');
  await page.fill('.ob-affix input', '2000');
  await shot('08-income-guarantor');

  // and again above it, to capture the positive verdict
  await page.fill('.ob-affix input', '4500');
  await shot('08b-income-strong');
  await page.fill('.ob-affix input', '2000');
  await page.click('.ob__footer .ob-btn');

  // 8 - guarantor
  await page.waitForSelector('.ob-option[data-value="parent"]', { timeout: 10000 });
  await page.click('.ob-option[data-value="parent"]');
  await page.fill('.ob-field input[aria-label="Nom du garant"]', 'Martine Durand');
  await shot('09-guarantor');
  await page.click('.ob__footer .ob-btn');

  // 9 - identity
  await page.waitForSelector('input[autocomplete="given-name"]', { timeout: 10000 });
  await page.fill('input[autocomplete="given-name"]', 'Camille');
  await page.fill('input[autocomplete="family-name"]', 'Durand');
  await page.fill('input[type="date"]', '1996-04-12');
  await page.click('.ob-option[data-value="cni"]');
  await page.fill('input[placeholder="12AB34567"]', '12AB34567');
  await shot('10-identity');
  await page.click('.ob__footer .ob-btn');

  // 10 - proof of address
  await page.waitForSelector('.ob-drop', { timeout: 10000 });
  await page.click('.ob-option[data-value="quittances"]');
  await page.setInputFiles('input[type="file"]:not([capture])', {
    name: 'quittance-juillet.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 quittance de démonstration'),
  });
  await page.waitForSelector('.ob-file__size', { timeout: 15000 });
  await shot('11-address');
  await page.click('.ob__footer .ob-btn');

  // final
  await page.waitForSelector('.ob-done__seal', { timeout: 15000 });
  await shot('12-done');

  const real = errors.filter((e) => !/favicon|net::ERR_/i.test(e));
  console.log(`${viewport.name}: parcours complet — ${real.length} erreur(s) console`);
  for (const error of real) console.log(`   ! ${error}`);
  failures += real.length;

  await context.close();
}

await browser.close();
console.log(`\nCaptures dans ${OUT}/`);
process.exit(failures ? 1 : 0);
