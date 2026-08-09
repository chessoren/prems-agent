/**
 * Reveal Framer's Ticker strips.
 *
 * Framer server-renders each marquee inside a <section> carrying an inline
 * `opacity: 0`. The strip is complete - images, cards, everything - but the
 * component's runtime is what flips it to visible once it has measured itself.
 * Without that runtime the section stays fully transparent, so the band renders
 * as an empty rectangle. It is invisible in Framer's own output too, which is
 * why comparing against an offline copy of the original never revealed it.
 *
 * Setting the opacity at build time fixes it for good, and keeps working with
 * JavaScript disabled.
 */

/** Ticker sections are the ones that clip a <ul> behind a fade mask. */
const isTicker = ($, el) => {
  const style = $(el).attr('style') || '';
  return /opacity:\s*0\s*(;|$)/.test(style) && $(el).find('ul').length > 0;
};

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {number} how many strips were revealed
 */
export function revealTickers($) {
  let revealed = 0;

  $('section[style], div[style]').each((_, el) => {
    if (!isTicker($, el)) return;
    const style = $(el).attr('style') || '';
    $(el).attr('style', style.replace(/opacity:\s*0\s*(;|$)/, 'opacity:1$1'));
    revealed++;
  });

  return revealed;
}
