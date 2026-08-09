/**
 * HTML transforms.
 *
 * The Framer document is already the finished markup - the React bundle only
 * hydrates it. So the job here is subtractive: remove hydration bookkeeping,
 * point assets at local copies, and hand back a tree we can slice into
 * components. We never rewrite structure or class names, because those are the
 * contract the stylesheet is written against.
 */

/** Attributes that exist purely for React/Framer hydration. */
const DEAD_ATTRS = [
  'data-framer-hydrate-v2',
  'data-framer-ssr-released-at',
  'data-framer-page-optimized-at',
  'data-framer-generated-page',
  'data-framer-original-sizes',
  'data-framer-component-type',
  'data-reactroot',
];

/** React streaming/suspense comment markers left in the SSR output. */
export function stripReactMarkers(html) {
  return html.replace(/<!--\/?\$[!?]?-->/g, '');
}

export function stripDeadAttrs($, scope) {
  for (const attr of DEAD_ATTRS) {
    $(`[${attr}]`, scope).removeAttr(attr);
  }
  return $;
}

/** Remove the Framer badge, analytics and any editor-only nodes. */
export function stripFramerChrome($) {
  $('#__framer-badge-container').remove();
  $('[data-framer-badge]').remove();
  $('script[src*="events.framer.com"]').remove();
  return $;
}

/**
 * Rewrite every remote asset reference (src, href, srcset, poster, inline
 * style url(), and <meta content>) to its mirrored local path.
 */
export function localiseAssets($, assetMap, scope) {
  const lookup = (raw) => {
    if (!raw) return null;
    const url = raw.trim().replace(/&amp;/g, '&');
    return assetMap[url] || assetMap[raw.trim()] || null;
  };

  $('[src], [href], [poster], [content]', scope).each((_, el) => {
    const $el = $(el);
    for (const attr of ['src', 'href', 'poster', 'content']) {
      const local = lookup($el.attr(attr));
      if (local) $el.attr(attr, local);
    }
  });

  $('[srcset], [imagesrcset]', scope).each((_, el) => {
    const $el = $(el);
    for (const attr of ['srcset', 'imagesrcset']) {
      const val = $el.attr(attr);
      if (!val) continue;
      const rewritten = val
        .split(',')
        .map((part) => {
          const seg = part.trim();
          if (!seg) return null;
          const sp = seg.lastIndexOf(' ');
          const url = sp === -1 ? seg : seg.slice(0, sp);
          const desc = sp === -1 ? '' : seg.slice(sp);
          return (lookup(url) || url) + desc;
        })
        .filter(Boolean)
        .join(', ');
      $el.attr(attr, rewritten);
    }
  });

  $('[style]', scope).each((_, el) => {
    const $el = $(el);
    const style = $el.attr('style');
    if (!style || !style.includes('url(')) return;
    $el.attr(
      'style',
      style.replace(/url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi, (whole, q, url) => {
        const local = lookup(url);
        return local ? `url(${local})` : whole;
      }),
    );
  });

  return $;
}

/**
 * Framer links are already root-relative except for the "./" form it uses for
 * the home route; normalise so they work under any host.
 */
export function normaliseLinks($, scope) {
  $('a[href]', scope).each((_, el) => {
    const $el = $(el);
    let href = $el.attr('href');
    if (!href) return;
    if (href === './' || href === '.') href = '/';
    else if (href.startsWith('./')) href = '/' + href.slice(2);
    $el.attr('href', href);
    $el.removeAttr('data-framer-page-link-current');
  });
  return $;
}

/** A filesystem/component-safe PascalCase name from a data-framer-name. */
export function componentName(rawName, fallback, used = new Set()) {
  let base = (rawName || fallback || 'Block')
    .replace(/^Section-/i, '')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  if (!base) base = 'Block';
  if (/^\d/.test(base)) base = `S${base}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

/** Escape the handful of sequences that are not literal inside an .astro file. */
export function escapeForAstro(html) {
  // In Astro markup, `{` opens an expression - escape braces that are content.
  return html.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}
