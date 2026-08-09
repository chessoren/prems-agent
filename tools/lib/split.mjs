/**
 * Slices a cleaned Framer page into named Astro components.
 *
 * Framer labels every block it generated with `data-framer-name`, which is the
 * name the site author gave it in the editor ("Section-Hero", "Section-Pricing"
 * ...). Those labels are the natural seams: cutting on them yields components
 * that line up with how the design is actually organised, rather than arbitrary
 * chunks of markup.
 *
 * Note on the three copies of each block: Framer server-renders one subtree per
 * breakpoint and hides the inactive ones with `display:none`. We keep that as-is
 * - collapsing it would mean re-deriving every responsive style by hand, which
 * is exactly the sort of rewrite that breaks pixel fidelity.
 */
import { createHash } from 'node:crypto';
import { componentName, escapeForAstro } from './html.mjs';

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * Classify a direct child of the layout root.
 * Framer wraps the nav and footer in their own positioning containers.
 */
function classify($, el) {
  const $el = $(el);
  if ($el.is('style')) return 'style';
  if ($el.find('nav').length) return 'nav';
  if ($el.find('footer').length) return 'footer';
  if ($el.find('[data-framer-name^="Section-"]').length) return 'content';
  return 'other';
}

/**
 * @returns {{ shell: string, parts: Array<{name:string, html:string, hash:string}> }}
 *   `shell` is the page body with each extracted part replaced by a placeholder
 *   token of the form `<!--PART:Name-->`.
 */
export function splitPage($, { pageName }) {
  const root = $('#main > div').first();
  if (!root.length) throw new Error('could not find the Framer layout root (#main > div)');

  const parts = [];
  const used = new Set();

  const take = (el, preferredName) => {
    const html = $.html(el);
    const name = componentName(preferredName, 'Block', used);
    parts.push({ name, html: escapeForAstro(html), hash: hash(html) });
    $(el).replaceWith(`<!--PART:${name}-->`);
    return name;
  };

  // Nav and footer wrappers become one component each, keeping all breakpoint
  // variants together so the responsive behaviour is self-contained.
  const navEls = [];
  const footerEls = [];
  const contentEls = [];

  root.children().each((_, el) => {
    const kind = classify($, el);
    if (kind === 'nav') navEls.push(el);
    else if (kind === 'footer') footerEls.push(el);
    else if (kind === 'content') contentEls.push(el);
  });

  if (navEls.length) {
    const html = navEls.map((el) => $.html(el)).join('\n');
    const name = componentName('Nav', 'Nav', used);
    parts.push({ name, html: escapeForAstro(html), hash: hash(html) });
    $(navEls[0]).replaceWith(`<!--PART:${name}-->`);
    for (const el of navEls.slice(1)) $(el).remove();
  }

  if (footerEls.length) {
    const html = footerEls.map((el) => $.html(el)).join('\n');
    const name = componentName('Footer', 'Footer', used);
    parts.push({ name, html: escapeForAstro(html), hash: hash(html) });
    $(footerEls[0]).replaceWith(`<!--PART:${name}-->`);
    for (const el of footerEls.slice(1)) $(el).remove();
  }

  // Inside the content wrapper, each Section-* becomes its own component.
  for (const wrapper of contentEls) {
    $(wrapper)
      .children()
      .each((_, el) => {
        const label = $(el).attr('data-framer-name');
        if (label && /^Section-/i.test(label)) take(el, label);
      });
  }

  // Framer keeps a library of <svg> symbol definitions in a #svg-templates div
  // at the end of <body>, and every icon on the page is a <use> pointing into
  // it. It lives outside the layout root, so it has to be collected explicitly
  // - without it every icon renders blank.
  const templates = $('#svg-templates');
  const svgTemplates = templates.length ? escapeForAstro($.html(templates)) : '';

  // Emit the root element itself, not just its children: it carries the layout
  // classes (position/display/min-height) that everything inside is laid out
  // against. Dropping it silently pushes the fixed nav into normal flow.
  return { shell: $.html(root), svgTemplates, parts, pageName };
}
