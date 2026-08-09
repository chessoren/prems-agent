/**
 * Fold the recovered FAQ answers back into the markup.
 *
 * Framer ships each accordion item in one of two variants that differ only by a
 * `framer-v-*` class and the container's inline style (radius, background,
 * shadow). Collapsed items simply have no answer node at all.
 *
 * So: give every collapsed item the answer it is missing - cloned from a real
 * open item, so it inherits the exact same classes and typography - and record
 * both variants on the element for the runtime to swap between. The result
 * still renders correctly with JavaScript disabled: open items stay open,
 * collapsed answers are just hidden.
 */

const normalise = (s) => (s || '').replace(/\s+/g, ' ').trim();

const variantClass = (cls) =>
  (cls || '').split(/\s+/).find((c) => c.startsWith('framer-v-')) || '';

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {Array<{question:string, answer:string}>} pairs
 * @returns {{ injected: number, items: number }}
 */
export function injectFaq($, pairs) {
  if (!pairs?.length) return { injected: 0, items: 0 };

  const template = $('[data-framer-name="Answer"]').first();
  if (!template.length) return { injected: 0, items: 0 };

  const answerFor = new Map(pairs.map((p) => [normalise(p.question), p.answer]));

  const openItem = template.closest('[data-framer-name="Open"]');
  const closedItem = $('[data-framer-name="Closed"]').first();
  const openClass = variantClass(openItem.attr('class'));
  const closedClass = variantClass(closedItem.attr('class'));
  const styleOf = (item) =>
    item.find('[data-framer-name="Container"]').first().attr('style') || '';
  const openStyle = styleOf(openItem);
  const closedStyle = styleOf(closedItem);

  let injected = 0;
  let items = 0;

  $('[data-framer-name="Open"], [data-framer-name="Closed"]').each((_, el) => {
    const $item = $(el);
    const $question = $item.find('[data-framer-name="Question"]').first();
    // "Open" is also the mobile nav drawer's variant name; only accordion items
    // carry a Question.
    if (!$question.length) return;
    items++;

    const isOpen = $item.attr('data-framer-name') === 'Open';
    $item.attr('data-faq-item', '');
    if (openClass) $item.attr('data-faq-open-class', openClass);
    if (closedClass) $item.attr('data-faq-closed-class', closedClass);
    if (openStyle) $item.attr('data-faq-open-style', openStyle);
    if (closedStyle) $item.attr('data-faq-closed-style', closedStyle);

    let $answer = $item.find('[data-framer-name="Answer"]').first();

    if (!$answer.length) {
      const text = answerFor.get(normalise($question.text()));
      if (!text) return;
      const $clone = $($.html(template));
      // The rich-text paragraph is the only text node that matters.
      const $p = $clone.find('p').first();
      if ($p.length) $p.text(text);
      else $clone.text(text);
      $item.find('[data-framer-name="Container"]').first().append($clone);
      $answer = $clone;
      injected++;
    }

    $answer.attr('data-faq-answer', '');
    if (!isOpen) $answer.attr('hidden', '');
  });

  return { injected, items };
}
