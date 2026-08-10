/**
 * Produce the social preview card.
 *
 *   npm run build && node tools/make-og-image.mjs
 *
 * The exported og:image was inherited from the Framer template and shows a
 * different product entirely - an email SaaS dashboard reading "AI That Handles
 * Your Inbox For You". Every Prems link shared anywhere would have carried it.
 * It was also 7.3 MB, over the 5 MB at which X drops the card.
 *
 * So the card is drawn here instead, from the same tokens as the site: the
 * surface, the ink, the #ff7a00 accent, Inter Tight at -0.02em, the Instrument
 * Serif italic. Rendered through the real preview server so the self-hosted
 * fonts resolve exactly as they do in production.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4321';
const OUTPUT = 'public/assets/og/prems.jpg';
const TEMP = 'dist/__og-card.html';

/** Warm, architectural hues - the same family the listing previews use. */
const TILE_HUES = [28, 38, 18, 200, 12, 45];

const card = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/styles/fonts.css">
<link rel="stylesheet" href="/styles/tokens.css">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden; position: relative;
    background: var(--color-surface);
    font-family: "Inter", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .glow {
    position: absolute; inset: -20%;
    background:
      radial-gradient(38% 44% at 78% 22%, rgba(255,161,77,.55), transparent 70%),
      radial-gradient(42% 50% at 92% 78%, rgba(255,122,0,.35), transparent 70%),
      radial-gradient(30% 36% at 8% 92%, rgba(255,196,140,.35), transparent 70%);
  }
  .tiles {
    position: absolute; top: 96px; right: -40px;
    display: grid; grid-template-columns: repeat(2, 190px); gap: 16px;
    filter: blur(9px) saturate(1.2); opacity: .62; transform: rotate(-8deg);
  }
  .tile { height: 140px; border-radius: 20px; position: relative; overflow: hidden; }
  .tile::after {
    content: ""; position: absolute; inset: 32% 0 0 0;
    background:
      linear-gradient(transparent, rgba(20,16,12,.5)),
      repeating-linear-gradient(90deg,
        rgba(255,255,255,.3) 0 7px, transparent 7px 16px,
        rgba(0,0,0,.26) 16px 25px, transparent 25px 36px);
  }
  .scrim {
    position: absolute; inset: 0;
    background: linear-gradient(100deg,
      var(--color-surface) 34%,
      color-mix(in srgb, var(--color-surface) 72%, transparent) 56%,
      transparent 82%);
  }
  .content { position: absolute; inset: 0; padding: 72px 76px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .dot {
    width: 15px; height: 15px; border-radius: 50%;
    background: var(--color-accent); box-shadow: 0 0 0 6px rgba(255,122,0,.16);
  }
  .word {
    font-family: "Inter Tight", sans-serif; font-weight: 600;
    font-size: 30px; letter-spacing: -.02em; color: var(--color-ink);
  }
  h1 {
    margin-top: auto;
    font-family: "Inter Tight", sans-serif; font-weight: 600;
    font-size: 66px; line-height: 1.06; letter-spacing: -.028em;
    color: var(--color-ink); max-width: 15ch;
  }
  h1 em {
    font-family: "Instrument Serif", serif; font-style: italic;
    font-weight: 400; color: var(--color-accent);
  }
  p {
    margin-top: 22px; max-width: 30ch;
    font-size: 23px; line-height: 1.48; color: var(--color-ink-muted);
  }
  .foot { margin-top: auto; display: flex; align-items: center; gap: 14px; }
  .pill {
    padding: 11px 20px; border-radius: 100px;
    background: var(--color-ink); color: var(--color-white);
    font-size: 17px; font-weight: 600; letter-spacing: -.01em;
  }
  .host { font-size: 17px; color: var(--color-gray-500); }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="tiles">
    ${TILE_HUES.map(
      (hue) => `<div class="tile" style="background:
        radial-gradient(120% 80% at 22% 12%, rgba(255,255,255,.55), transparent 60%),
        linear-gradient(165deg, hsl(${hue} 46% 74%), hsl(${hue} 34% 56%) 52%, hsl(${hue + 22} 30% 38%))"></div>`,
    ).join('')}
  </div>
  <div class="scrim"></div>
  <div class="content">
    <div class="brand"><span class="dot"></span><span class="word">Prems</span></div>
    <h1>Ton prochain appart est <em>déjà en ligne</em>.</h1>
    <p>L'IA détecte les annonces en premier et envoie ton dossier à ta place.</p>
    <div class="foot">
      <span class="pill">Trouve ton appart en 30 secondes</span>
      <span class="host">prems.getmira.run</span>
    </div>
  </div>
</body>
</html>`;

writeFileSync(TEMP, card);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

try {
  await page.goto(`${BASE}/__og-card.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const bytes = await page.screenshot({ type: 'jpeg', quality: 88 });
  mkdirSync(resolve('public/assets/og'), { recursive: true });
  writeFileSync(OUTPUT, bytes);
  console.log(`${OUTPUT} — 1200x630, ${Math.round(bytes.length / 1024)} ko`);
} finally {
  await browser.close();
  rmSync(TEMP, { force: true });
}
