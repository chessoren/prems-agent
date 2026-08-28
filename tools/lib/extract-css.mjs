/**
 * Pulls the stylesheet out of a Framer page and makes it readable.
 *
 * Framer inlines four kinds of <style> block, in this order:
 *   data-framer-font-css         - @font-face declarations
 *   data-framer-breakpoint-css   - the `hidden-<hash>` responsive helpers
 *   data-framer-css-ssr-minified - the component styles (one big blob)
 *   data-framer-html-style       - small per-page overrides (e.g. body bg)
 *
 * IMPORTANT: source order is preserved exactly. CSS resolves equal-specificity
 * conflicts by document order, so regrouping rules by kind - however tidy it
 * looks - silently changes the rendering. The only things this module changes
 * are *names* (tokens), *formatting*, and which rules are present at all
 * (pruning). Never the order.
 */
import postcss from 'postcss';
import prettier from 'prettier';
import {
  buildTokenMap,
  applyTokenMap,
  localiseUrls,
  pruneToDocument,
  documentClasses,
  stripFramerChrome,
} from './css.mjs';

/**
 * Lift the design-token declaration out of the stream so it can live in its own
 * documented file. Framer declares them once, on `body`; re-declaring them on
 * `:root` is equivalent for every descendant and leaves no duplicate.
 *
 * @returns {{ css: string, tokens: Map<string,string> }}
 */
function liftTokens(css, tokenNames) {
  const root = postcss.parse(css);
  const values = new Map();

  root.walkRules((rule) => {
    let touched = false;
    rule.walkDecls((decl) => {
      // Names have already been rewritten, so match on the new `--color-*` form.
      if (tokenNames.has(decl.prop)) {
        values.set(decl.prop, decl.value);
        decl.remove();
        touched = true;
      }
    });
    if (touched && rule.nodes.length === 0) rule.remove();
  });

  return { css: root.toString(), values };
}

const format = (css, header) =>
  prettier.format(css, { parser: 'css', printWidth: 100 }).then((out) => `${header}\n\n${out}`);

/**
 * @param {import('cheerio').CheerioAPI} $ page document (before cleaning)
 * @param {Record<string,string>} assetMap remote url -> local path
 * @param {Set<string>} keepClasses classes toggled at runtime by our own js
 */
export async function extractCss($, assetMap, keepClasses = new Set()) {
  const grab = (selector) =>
    $(selector)
      .map((_, el) => $(el).html() || '')
      .get()
      .join('\n');

  const fontCss = grab('style[data-framer-font-css]');

  // Concatenated in the same order the browser saw them.
  const stream = [
    grab('style[data-framer-breakpoint-css]'),
    grab('style[data-framer-css-ssr-minified], style[data-framer-css]'),
    grab('style[data-framer-html-style]'),
  ].join('\n');

  // 1. semantic token names, derived from the palette Framer declared
  const tokenMap = buildTokenMap(stream);

  // 2. local asset urls, then drop Framer's own badge/editor rules
  let css = stripFramerChrome(localiseUrls(applyTokenMap(stream, tokenMap), assetMap));

  // 3. move the palette into its own file
  const lifted = liftTokens(css, new Set(tokenMap.values()));
  css = lifted.css;

  // 4. drop rules whose classes never occur on this page
  const before = css.length;
  css = pruneToDocument(css, documentClasses($), keepClasses);

  return {
    tokenMap,
    tokenValues: lifted.values,
    stats: { before, after: css.length },
    files: {
      fonts: await format(
        localiseUrls(fontCss, assetMap),
        '/* Self-hosted @font-face declarations, mirrored from the original site. */',
      ),
      page: await format(
        css,
        [
          '/*',
          ' * Page styles, in the original source order.',
          ' *',
          ' * Formatted and pruned to the classes this page actually uses; the',
          ' * declarations themselves are untouched. Class names are Framer hashes',
          ' * on purpose - they are the contract between this file and the markup.',
          ' * Use the data-name attributes in the components to navigate.',
          ' */',
        ].join('\n'),
      ),
    },
  };
}

/** Render the palette as a standalone, documented :root block. */
export async function renderTokens(tokenValues) {
  const lines = [...tokenValues.entries()].map(([name, value]) => `  ${name}: ${value};`);
  return prettier.format(
    [
      '/**',
      ' * Design tokens.',
      ' *',
      ' * The colours defined in the original Framer document. Framer named them',
      ' * after internal UUIDs; they are renamed here to what they actually are',
      ' * and referenced by the readable name throughout the stylesheets.',
      ' */',
      ':root {',
      ...lines,
      '}',
      '',
    ].join('\n'),
    { parser: 'css', printWidth: 100 },
  );
}
