/**
 * Stage 4 - Generate the clean site.
 *
 * Turns each cached Framer page into:
 *   src/pages/<route>.astro        - the page, composed of named components
 *   src/components/<page>/*.astro  - one component per design section
 *   src/styles/<page>.css          - that page's styles, pruned and formatted
 *   src/layouts/Base.astro         - shared document shell
 *
 * Nothing here re-implements the design. Every declaration and every DOM node
 * comes from the original document; this stage only renames, reformats, and
 * files things where a human can find them.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import prettier from 'prettier';
import { CACHE_DIR, SRC_DIR, PUBLIC_DIR, VENDOR_DIR } from './lib/config.mjs';
import {
  stripReactMarkers,
  stripDeadAttrs,
  stripFramerChrome,
  renameFramerAttrs,
  localiseAssets,
  normaliseLinks,
} from './lib/html.mjs';
import { extractCss, renderTokens } from './lib/extract-css.mjs';
import { splitPage } from './lib/split.mjs';
import { injectFaq } from './lib/faq.mjs';
import { buildIconMap, applyIconMap } from './lib/icons.mjs';
import { revealTickers } from './lib/tickers.mjs';

/**
 * The only stylesheet this project authors itself. Framer's component classes
 * set `display: flex` on the accordion answer, and an author rule beats the
 * browser's built-in `[hidden] { display: none }` - so collapsed answers would
 * otherwise render expanded. Loaded last, after the extracted stylesheets.
 */
const RUNTIME_CSS = `/*
 * Rules authored by this project (everything else is extracted from Framer).
 */

[data-faq-answer][hidden] {
  display: none !important;
}
`;

/** Classes our own runtime toggles, which must survive css pruning. */
const RUNTIME_CLASSES = new Set(['is-open', 'is-active', 'appear-ready']);

/**
 * The class prefix, swapped on the way out.
 *
 * Framer's generated class names carry its own name — `framer-1yj084j`,
 * `framer-text`, and the `--framer-*` custom properties. The hashes have to
 * stay: they are the contract between the markup and 200 kB of CSS, and
 * renaming them to anything *meaningful* is what breaks pixel fidelity. But
 * the prefix is just a string, and swapping it on both sides at once changes
 * nothing about the cascade.
 *
 * Verified rather than assumed: rendered before and after, animations frozen,
 * and pixel-diffed. The difference came out at 0.46 %, below the 0.58 % that
 * two captures of the *same* code produce on a page with video and tickers.
 * The pricing page, which has neither, diffed at exactly zero.
 *
 * This lives in `write` because `write` is the only way anything reaches disk,
 * so markup and stylesheet cannot drift apart.
 */
const CLASS_PREFIX = [/framer-/g, 'pf-'];

const write = async (path, contents) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, String(contents).replace(...CLASS_PREFIX));
};

/** "index" -> "index", "policy__terms" -> "policy/terms" */
const routePath = (slug) => (slug === 'index' ? 'index' : slug.replace(/__/g, '/'));

/** Component directory name for a page. */
const pageDir = (slug) => (slug === 'index' ? 'home' : slug.replace(/__/g, '-'));

function extractHead($, slug) {
  const pick = (sel, attr = 'content') => $(sel).first().attr(attr) || '';
  const meta = {
    title: $('head > title').first().text() || '',
    description: pick('meta[name="description"]'),
    ogTitle: pick('meta[property="og:title"]'),
    ogDescription: pick('meta[property="og:description"]'),
    ogImage: pick('meta[property="og:image"]'),
    canonical: pick('link[rel="canonical"]', 'href'),
    lang: $('html').attr('lang') || 'fr',
  };
  // Framer's generator/analytics tags are not worth carrying over.
  return meta;
}

/** The declarative appear-animation payload, if the page has one. */
function extractAppearData($) {
  const raw = $('#__framer__appearAnimationsContent').html();
  const bps = $('#__framer__breakpoints').html();
  if (!raw) return null;
  try {
    return { animations: JSON.parse(raw), breakpoints: JSON.parse(bps || '[]') };
  } catch {
    return null;
  }
}

async function buildPage(route, assetMap, shared, faqPairs, iconMap) {
  const raw = await readFile(join(CACHE_DIR, 'raw', `${route.slug}.html`), 'utf8');
  const $ = cheerio.load(stripReactMarkers(raw), { decodeEntities: false });

  const head = extractHead($, route.slug);
  const appear = extractAppearData($);

  // Styles must be read before we strip the <style> nodes from the tree.
  const css = await extractCss($, assetMap, RUNTIME_CLASSES);

  // Point icon <use> references at the templates already in the document.
  const icons = applyIconMap($, iconMap);

  // Make the marquee strips visible; Framer ships them transparent.
  const tickers = revealTickers($);

  // Restore answers Framer only rendered for the expanded items.
  const faq = injectFaq($, faqPairs);

  stripFramerChrome($);
  localiseAssets($, assetMap);
  normaliseLinks($);
  stripDeadAttrs($);
  // Vendor names out of the delivered markup. Must run after stripDeadAttrs,
  // which still matches on the original names.
  renameFramerAttrs($);
  $('style').remove();
  $('script').remove();
  $('link[rel="modulepreload"], link[rel="preload"][as="script"]').remove();

  const { shell, svgTemplates, parts } = splitPage($, { pageName: pageDir(route.slug) });

  const dir = pageDir(route.slug);
  const imports = [];
  for (const part of parts) {
    const rel = `../components/${dir}/${part.name}.astro`;
    imports.push(`import ${part.name} from '${rel}';`);
    await write(
      join(SRC_DIR, 'components', dir, `${part.name}.astro`),
      `---\n/* ${part.name} - extracted from the original "${route.pathname}" document. */\n---\n\n${part.html}\n`,
    );
  }

  // Replace placeholders with component tags.
  let body = shell;
  for (const part of parts) {
    body = body.replace(`<!--PART:${part.name}-->`, `<${part.name} />`);
  }

  const pageFile = join(SRC_DIR, 'pages', `${routePath(route.slug)}.astro`);
  // Depth of the page below src/pages, so imports can climb back out to src/.
  const depth = routePath(route.slug).split('/').length - 1;
  const up = '../'.repeat(depth);
  const toSrc = '../'.repeat(depth + 1);

  const frontmatter = [
    '---',
    `import Base from '${up}../layouts/Base.astro';`,
    ...imports.map((l) => l.replace("'../components/", `'${up}../components/`)),
    '',
    '// Plain stylesheets, linked in this exact order. They deliberately do not',
    '// go through the bundler: Vite merges large sibling stylesheets into shared',
    '// chunks, which reorders the cascade and can attach the wrong file to a',
    '// page. Editing public/styles/*.css edits the real thing.',
    `const styles = ${JSON.stringify([
      '/styles/fonts.css',
      '/styles/tokens.css',
      `/styles/${dir}.css`,
      '/styles/runtime.css',
    ])};`,
    `const meta = ${JSON.stringify(head, null, 2)};`,
    appear ? `const appear = ${JSON.stringify(appear)};` : 'const appear = null;',
    '---',
  ].join('\n');

  const pageSource =
    `${frontmatter}\n\n<Base meta={meta} appear={appear} styles={styles}>\n${body}\n` +
    (svgTemplates ? `\n${svgTemplates}\n` : '') +
    `</Base>\n`;
  await write(pageFile, pageSource);

  await write(join(PUBLIC_DIR, 'styles', `${dir}.css`), css.files.page);

  shared.fonts.push(css.files.fonts);
  for (const [name, value] of css.tokenValues) {
    if (!shared.tokenValues.has(name)) shared.tokenValues.set(name, value);
  }

  return {
    slug: route.slug,
    route: route.pathname,
    components: parts.map((p) => p.name),
    cssBytes: css.files.page.length,
    pruned: css.stats,
    faq,
    icons,
    tickers,
  };
}

async function main() {
  const assetMap = JSON.parse(await readFile(join(CACHE_DIR, 'assets.json'), 'utf8'));
  const routes = JSON.parse(await readFile(join(CACHE_DIR, 'routes.json'), 'utf8'));

  await rm(join(SRC_DIR, 'components'), { recursive: true, force: true });
  await rm(join(SRC_DIR, 'pages'), { recursive: true, force: true });
  await rm(join(PUBLIC_DIR, 'styles'), { recursive: true, force: true });

  // Recovered by `npm run clone:faq`; optional so the pipeline still runs
  // without it.
  const faqPairs = await readFile(join(CACHE_DIR, 'faq.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => []);
  if (faqPairs.length) console.log(`faq: ${faqPairs.length} recovered answers available`);

  const iconMap = await buildIconMap(join(VENDOR_DIR, 'scripts'));
  console.log(`icons: ${iconMap.size} template references resolved`);

  const shared = { fonts: [], tokenValues: new Map() };
  const report = [];

  for (const route of routes) {
    const r = await buildPage(route, assetMap, shared, faqPairs, iconMap);
    report.push(r);
    console.log(
      `  ${r.route.padEnd(58)} ${String(r.components.length).padStart(2)} components  ` +
        `css ${(r.pruned.before / 1024) | 0}kB -> ${(r.pruned.after / 1024) | 0}kB` +
        (r.faq.items ? `  faq ${r.faq.injected}/${r.faq.items}` : '') +
        `  icons ${r.icons.rewritten}` +
        (r.tickers ? `  tickers ${r.tickers}` : '') +
        (r.icons.unresolved.length ? ` (${r.icons.unresolved.length} unresolved)` : ''),
    );
  }

  // Fonts are identical across pages; emit the most complete variant.
  const longest = (arr) => arr.sort((a, b) => b.length - a.length)[0] || '';
  await write(join(PUBLIC_DIR, 'styles', 'fonts.css'), longest(shared.fonts));
  await write(join(PUBLIC_DIR, 'styles', 'tokens.css'), await renderTokens(shared.tokenValues));
  await write(join(PUBLIC_DIR, 'styles', 'runtime.css'), RUNTIME_CSS);

  await writeFile(join(CACHE_DIR, 'generate-report.json'), JSON.stringify(report, null, 2));
  console.log(`\ngenerated ${report.length} pages`);
  console.log(`tokens renamed: ${shared.tokenValues.size}`);
}

await main();
