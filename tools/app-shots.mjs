/**
 * Drive the four-tab app in a real browser and capture every state.
 *
 *   npm run preview   # in another shell
 *   node tools/app-shots.mjs
 *
 * Same reasoning as `onboarding-shots.mjs`: there is no Framer original to
 * diff against, so the check is that a scripted run reaches every state at
 * both breakpoints without a console error, with a screenshot of each.
 *
 * The lifecycle is driven by time - a match is "contact envoyé" because two
 * minutes have passed since it was found. Rather than wait, the script rewinds
 * the clock the model reads from, which is the timestamp stored when the
 * availability was saved. Moving it back three days puts the whole feed into
 * its mid-life states in one reload.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Wait for the app to be drawn, not for the network to go quiet.
 *
 * `networkidle` cannot be reached any more and that is correct behaviour: the
 * app holds an open Realtime socket so a match landing while somebody is
 * looking at the screen appears under their thumb. A socket that stays open is
 * the feature; waiting for it to close is the bug.
 */
async function settled(page) {
  await page.waitForSelector('#app .pm__view', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

const BASE = process.env.BASE || 'http://localhost:4321';
const OUT = '.cache/app';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, isMobile: true },
  { name: 'desktop', width: 1440, height: 950, isMobile: false },
];

/** A completed onboarding, as the flow would have left it. */
const DRAFT = {
  step: 'done',
  city: 'Paris',
  citySlug: 'paris',
  postcode: '75011',
  budget: 1300,
  propertyType: 'appartement',
  rooms: 2,
  moveInDate: null,
  moveInAsap: true,
  phone: '+33612345678',
  employment: 'cdi',
  incomeCents: 340000,
  needsGuarantor: false,
  firstName: 'Camille',
  lastName: 'Durand',
  birthDate: '1996-04-12',
  idType: 'cni',
  idNumber: '12AB34567',
  addressProofType: 'quittances',
  addressProofName: 'quittance-juillet.pdf',
  matchCount: 8,
  completedAt: new Date().toISOString(),
};

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
    // "Failed to load resource" carries no URL, so it is counted from the
    // response listener below instead - otherwise a missing favicon and a
    // missing stylesheet are the same unactionable line.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400 && !/favicon/.test(res.url())) {
      errors.push(`${res.status()} ${res.url()}`);
    }
  });

  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${viewport.name}-${name}.png`, fullPage: true });
  };

  /* Rewind the agent's clock by `days` and reload. */
  const rewind = async (days) => {
    await page.evaluate((d) => {
      const state = JSON.parse(localStorage.getItem('prems.app.v1') || '{}');
      state.availabilitySavedAt = new Date(Date.now() - d * 86400000).toISOString();
      localStorage.setItem('prems.app.v1', JSON.stringify(state));
    }, days);
    await page.reload({ waitUntil: 'domcontentloaded' });
  };

  await page.goto(`${BASE}/app/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((draft) => {
    localStorage.clear();
    localStorage.setItem('prems.onboarding.v1', JSON.stringify(draft));
  }, DRAFT);
  await page.reload({ waitUntil: 'domcontentloaded' });

  /* ---- the gate ------------------------------------------------------- */
  await page.waitForSelector('.pm-gate__title');
  await shot('01-accueil-gate');

  await page.click('.pm-tab[data-tab="visites"]');
  await page.waitForSelector('.pm-avail__cell');
  await shot('02-visites-disponibilites');

  // Four slots across the week, the way someone actually answers.
  for (const index of [10, 14, 22, 25]) {
    await page.click(`.pm-avail__cell >> nth=${index}`);
  }
  await shot('03-visites-disponibilites-remplies');
  await page.click('.pm-avail .ob-btn');

  /* ---- the agent starts ------------------------------------------------ */
  await page.waitForSelector('.pm-log__list');
  await shot('04-accueil-demarrage');

  /* ---- three days in --------------------------------------------------- */
  await rewind(3);
  await page.waitForSelector('.pm-match', { timeout: 15000 });
  await shot('05-accueil-matchs');

  // Both calendars are in the DOM; CSS hides the one this breakpoint does not
  // use, so the wait has to name the visible one.
  const calendar = viewport.isMobile ? '.pm-cal--week' : '.pm-cal--month';

  await page.click('.pm-tab[data-tab="visites"]');
  await page.waitForSelector(calendar);
  await shot('06-visites-creneaux');

  /* Pick a slot if any agency has replied, then look at the calendar. */
  const slot = await page.$('.pm-slot');
  if (slot) {
    await slot.click();
    await page.waitForTimeout(500);
    await shot('07-visites-confirmee');
  }

  await page.click('.pm-tab[data-tab="messages"]');
  await page.waitForSelector('.pm-thread, .pm-empty');
  await shot('08-messages-liste');

  const thread = await page.$('.pm-thread');
  if (thread) {
    await thread.click();
    await page.waitForSelector('.pm-conv__stream');
    await shot('09-messages-conversation');

    await page.click('.pm-conv__handover');
    await page.waitForSelector('.pm-conv__composer');
    await shot('10-messages-reprise-en-main');
  }

  await page.click('.pm-tab[data-tab="profil"]');
  await page.waitForSelector('.pm-accordion');
  await shot('11-profil');

  // Open every panel: a collapsed accordion says nothing about its contents.
  const heads = await page.$$('.pm-acc__head[aria-expanded="false"]');
  for (const head of heads) await head.click();
  await shot('12-profil-deplie');

  /* ---- a visit that has already happened ------------------------------- */
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('prems.app.v1') || '{}');
    for (const [id, action] of Object.entries(state.actions || {})) {
      if (action.chosenSlot) {
        action.chosenSlot = new Date(Date.now() - 86400000).toISOString();
        state.actions[id] = action;
      }
    }
    localStorage.setItem('prems.app.v1', JSON.stringify(state));
  });
  // A goto that differs only by fragment is a same-document navigation - the
  // page keeps running with the state it booted on, and the rewrite above
  // would never be read. The reload is what makes it take effect.
  await page.goto(`${BASE}/app/#visites`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pm-review', { timeout: 10000 });
  await shot('13-visites-retour-de-visite');

  /* ---- the pricing screen at the end of the flow ----------------------- */
  await page.goto(`${BASE}/onboarding/#pricing`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ob-plan--hero', { timeout: 10000 });
  await shot('14-onboarding-pricing');

  const real = errors.filter((e) => !/favicon|net::ERR_|supabase/i.test(e));
  console.log(`${viewport.name}: parcours complet — ${real.length} erreur(s) console`);
  for (const error of real) console.log(`   ! ${error}`);
  failures += real.length;

  await context.close();
}

await browser.close();
console.log(`\nCaptures dans ${OUT}/`);
process.exit(failures ? 1 : 0);
