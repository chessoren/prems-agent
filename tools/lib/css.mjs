/**
 * CSS transforms: token renaming, pruning against a page's DOM, prettifying.
 *
 * Framer emits one big minified stylesheet per page containing every rule the
 * page *might* need, keyed by hashed class names, plus design tokens named
 * after their internal UUIDs (`--token-cecc2f3f-8752-...`). Both are mechanical
 * to clean up without touching a single declaration value, which is what keeps
 * the result pixel-identical.
 */
import postcss from 'postcss';

/**
 * Semantic names for this site's design tokens, keyed by the literal value
 * Framer assigned. Derived from the palette in the published site.
 */
const TOKEN_NAMES = {
  '#f5f5f5': 'surface',
  '#1a1a1a': 'ink',
  '#4d4d4d': 'ink-muted',
  '#fff': 'white',
  '#ff7a00': 'accent',
  '#7a7a7a': 'gray-500',
  '#e0e0e0': 'border',
  '#999': 'gray-400',
  '#262626': 'ink-800',
  '#eaeaea': 'gray-100',
  '#f0f0f0': 'gray-50',
  '#000': 'black',
  gray: 'gray-mid',
  '#0d0d0d': 'ink-900',
};

/**
 * Build `--token-<uuid>` -> `--color-<semantic>` from the :root/body block that
 * declares them. Falls back to a numbered name for anything unrecognised, so a
 * palette change upstream degrades gracefully instead of throwing.
 */
export function buildTokenMap(css) {
  const map = new Map();
  const used = new Set();
  let n = 0;
  for (const m of css.matchAll(/(--token-[0-9a-f-]{36})\s*:\s*([^;}]+)/gi)) {
    const [, varName, rawValue] = m;
    if (map.has(varName)) continue;
    const value = rawValue.trim().toLowerCase();
    let base = TOKEN_NAMES[value];
    if (!base) base = `custom-${++n}`;
    let name = `--color-${base}`;
    while (used.has(name)) name = `--color-${base}-${++n}`;
    used.add(name);
    map.set(varName, name);
  }
  return map;
}

export function applyTokenMap(text, tokenMap) {
  if (!tokenMap.size) return text;
  const re = new RegExp([...tokenMap.keys()].join('|'), 'g');
  return text.replace(re, (m) => tokenMap.get(m) || m);
}

/** Rewrite absolute CDN urls inside css to their mirrored local paths. */
export function localiseUrls(css, assetMap) {
  return css.replace(/url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi, (whole, q, url) => {
    const local = assetMap[url] || assetMap[url.replace(/&amp;/g, '&')];
    return local ? `url(${local})` : whole;
  });
}

/**
 * Selector -> the class names it depends on. Used for pruning; we deliberately
 * ignore attribute/pseudo detail and only ask "could this selector ever match
 * an element in this document?".
 */
function classesIn(selector) {
  // Classes inside functional pseudo-classes are NOT requirements:
  //   :not(.x)   matches when .x is absent - requiring .x deletes the rule
  //   :is(.a,.b) is a disjunction, so neither branch is individually required
  // Strip those arguments before deciding what the selector depends on.
  const stripped = selector.replace(
    /:(?:not|is|where|has|matches|any)\((?:[^()]|\([^()]*\))*\)/gi,
    '',
  );
  return [...stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

/**
 * Drop rules whose class names appear nowhere in the page. Conservative:
 * - a rule with no class selector at all is always kept (element/global rules)
 * - `keepClasses` protects classes our own runtime toggles at runtime
 * - at-rules (@font-face, @keyframes, @supports) are always kept
 */
export function pruneToDocument(css, presentClasses, keepClasses = new Set()) {
  const root = postcss.parse(css);
  const isPresent = (c) => presentClasses.has(c) || keepClasses.has(c);

  root.walkRules((rule) => {
    // Never prune inside @keyframes - the "selectors" are percentages.
    if (rule.parent?.type === 'atrule' && /keyframes/i.test(rule.parent.name)) return;

    const keep = rule.selectors.filter((sel) => {
      const classes = classesIn(sel);
      return classes.length === 0 || classes.every(isPresent);
    });

    if (keep.length === 0) rule.remove();
    else if (keep.length !== rule.selectors.length) rule.selectors = keep;
  });

  // Sweep up at-rules left empty by the pass above.
  let changed = true;
  while (changed) {
    changed = false;
    root.walkAtRules((at) => {
      if (at.nodes && at.nodes.length === 0) {
        at.remove();
        changed = true;
      }
    });
  }
  return root.toString();
}

/** Collect every class name used anywhere in a cheerio document. */
export function documentClasses($) {
  const set = new Set();
  $('[class]').each((_, el) => {
    for (const c of ($(el).attr('class') || '').split(/\s+/)) if (c) set.add(c);
  });
  return set;
}

/** Strip rules for Framer's own badge / editor chrome. */
export function stripFramerChrome(css) {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (/__framer-badge|framer-badge-container|#__framer-editorbar/i.test(rule.selector)) {
      rule.remove();
    }
  });
  root.walkAtRules((at) => {
    if (at.nodes && at.nodes.length === 0) at.remove();
  });
  return root.toString();
}
