/**
 * Repair Framer's icon references.
 *
 * Framer server-renders every icon as `<use href="#3164290856"/>`, where the
 * number is a *cache key*, not an element id - nothing in the document has it.
 * At runtime `shared-lib.mjs` registers each icon's SVG template into the
 * `#svg-templates` container and rewrites the reference to the real id of the
 * shape inside that template (`#o4RpECsKY`).
 *
 * The templates are already present in the shipped markup, so the only missing
 * piece is the mapping. It is recoverable statically: the bundle pairs each
 * cache key with the template variable holding its SVG, e.g.
 *
 *   let I = `<svg ...><path id="o4RpECsKY" .../></svg>`;
 *   ... h(`3164290856`, I) ...
 *
 * Resolving that pairing turns every icon back on, with no runtime at all.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** `h(`<digits>`, VAR)` - the icon registration call. */
const REGISTER_RE = /\(\s*`(\d{4,})`\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;

/** ``VAR = `<svg …>` `` - the template assignment. */
const templateRe = (name) =>
  new RegExp(`\\b${name}\\s*=\\s*\`(<svg[\\s\\S]*?)\``);

/**
 * Build cacheKey -> real element id from the mirrored bundles.
 * @returns {Promise<Map<string,string>>}
 */
export async function buildIconMap(vendorScriptsDir) {
  const map = new Map();
  let files = [];
  try {
    files = (await readdir(vendorScriptsDir)).filter((f) => f.endsWith('.mjs'));
  } catch {
    return map;
  }

  for (const file of files) {
    const src = await readFile(join(vendorScriptsDir, file), 'utf8');
    if (!src.includes('<svg')) continue;

    for (const m of src.matchAll(REGISTER_RE)) {
      const [, key, varName] = m;
      if (map.has(key)) continue;
      const tpl = src.match(templateRe(varName));
      if (!tpl) continue;
      // The first id inside the template is the shape <use> must point at.
      const id = tpl[1].match(/\bid="([^"]+)"/);
      if (id) map.set(key, id[1]);
    }
  }
  return map;
}

/**
 * Point every `<use>` at the id that actually exists in the document.
 * @returns {{ rewritten: number, unresolved: string[] }}
 */
export function applyIconMap($, iconMap) {
  let rewritten = 0;
  const unresolved = new Set();

  $('use').each((_, el) => {
    const $el = $(el);
    const raw = $el.attr('href') || $el.attr('xlink:href') || '';
    if (!raw.startsWith('#')) return;
    const key = raw.slice(1);
    // Already a real id (present in #svg-templates) - leave it alone.
    if ($(`#${CSS_ESCAPE(key)}`).length) return;

    const target = iconMap.get(key);
    if (!target) {
      unresolved.add(key);
      return;
    }
    $el.attr('href', `#${target}`);
    $el.removeAttr('xlink:href');
    rewritten++;
  });

  return { rewritten, unresolved: [...unresolved] };
}

/** Ids here are Framer-generated, but keep selector building safe anyway. */
function CSS_ESCAPE(value) {
  return value.replace(/["\\\]\[#.:>~+*^$|=()]/g, '\\$&');
}
