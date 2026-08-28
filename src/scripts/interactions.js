/**
 * Interactive behaviour.
 *
 * Framer server-renders only the *current* variant of a stateful component, so
 * anything whose alternate state is not in the markup cannot be revived from
 * the export alone. What this file covers is the behaviour whose markup IS
 * present in the document:
 *
 *   - the mobile navigation drawer (open/closed variants both rendered)
 *   - anchor links, which the React router used to intercept
 *
 * See docs/INTERACTIVE.md for the components that need their alternate states
 * authored before they can be wired up.
 */

/** Toggle the mobile nav. Framer renders both the closed and "Open" variants. */
function initMobileNav() {
  const drawers = document.querySelectorAll('[data-name="Open"]');
  const triggers = document.querySelectorAll('[data-name="Icon Container"]');
  if (!triggers.length || !drawers.length) return;

  // Pair each trigger with the drawer inside the same nav element.
  for (const trigger of triggers) {
    const nav = trigger.closest('nav');
    if (!nav) continue;
    const drawer = nav.querySelector('[data-name="Open"]');
    if (!drawer) continue;

    drawer.hidden = true;
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('aria-expanded', 'false');

    const toggle = () => {
      const open = drawer.hidden;
      drawer.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    };

    trigger.addEventListener('click', toggle);
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
}

/** Smooth in-page anchor scrolling, which the SPA router used to provide. */
function initAnchors() {
  document.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (!link) return;
    const id = link.getAttribute('href')?.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/**
 * Framer's Ticker (the looping logo and testimonial marquees).
 *
 * Ticker is a code component. The exported markup already lays the strip out
 * correctly - one <li> holding a row wider than its clipping wrapper - but the
 * scrolling itself lived in Framer's runtime, so the strip sits motionless.
 *
 * This only adds the motion: duplicate the row so there is something to scroll
 * into, then translate the list by exactly one row's width on a loop. Nothing
 * here touches width, height or display, because the existing layout is already
 * pixel-correct and every attempt to "help" it broke it.
 */
const TICKER_SPEED = 60; // px per second

/**
 * Tickers must not be touched until layout has settled.
 *
 * Measuring a row before its fonts and images have their intrinsic size gives a
 * wrong row width, and mutating the list at that point makes the whole strip
 * land hundreds of pixels off. Waiting for `load` plus `fonts.ready` reproduces
 * the conditions under which the duplication provably changes nothing.
 */
function whenSettled(run) {
  const go = () =>
    Promise.resolve(document.fonts?.ready).then(() =>
      requestAnimationFrame(() => requestAnimationFrame(run)),
    );
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

function initTickers() {
  for (const ul of document.querySelectorAll('ul[style*="translateX"]')) {
    if (ul.dataset.tickerReady) continue;
    const items = [...ul.children].filter((c) => c.tagName === 'LI');
    if (!items.length) continue;

    // Framer ships one copy of every block per breakpoint and hides the
    // inactive ones. Only animate the copy that is actually on screen: cloning
    // into a hidden variant still perturbs the sizing of shared ancestors, and
    // that is what threw the visible strip out of its cell.
    if (ul.getBoundingClientRect().width < 1) continue;

    const rowWidth = items.reduce((sum, li) => sum + li.getBoundingClientRect().width, 0);
    if (rowWidth < 1) continue;

    ul.dataset.tickerReady = '1';

    // The duplicate is positioned absolutely, one row to the right. That is the
    // whole trick: an in-flow copy widens the list, the list's parent sizes to
    // its content, and the centred row jumps hundreds of pixels out of its
    // cell. Out of flow, the copy contributes nothing to intrinsic width, so
    // the layout stays byte-identical to the original.
    //
    // The list already carries an inline transform, which makes it the
    // containing block for the copy - no positioning change needed on the list.
    for (const li of items) {
      const copy = li.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      copy.style.position = 'absolute';
      copy.style.top = '0';
      copy.style.left = `${rowWidth}px`;
      ul.appendChild(copy);
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    ul.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${rowWidth}px)` }],
      {
        duration: (rowWidth / TICKER_SPEED) * 1000,
        iterations: Infinity,
        easing: 'linear',
      },
    );
  }
}

/**
 * FAQ accordion.
 *
 * The build annotates each item with both variants - the `pf-v-*`
 * class and the container's inline style - and gives collapsed items the answer
 * Framer had omitted. Toggling is then just swapping between the two variants,
 * so an open item looks exactly like one Framer rendered open.
 */
function initFaq() {
  for (const item of document.querySelectorAll('[data-faq-item]')) {
    const question = item.querySelector('[data-name="Question"]');
    const answer = item.querySelector('[data-faq-answer]');
    if (!question || !answer) continue;

    const container = item.querySelector('[data-name="Container"]');
    const { faqOpenClass, faqClosedClass, faqOpenStyle, faqClosedStyle } = item.dataset;

    question.setAttribute('role', 'button');
    question.setAttribute('tabindex', '0');
    question.style.cursor = 'pointer';

    const apply = (open) => {
      answer.hidden = !open;
      if (faqOpenClass && faqClosedClass) {
        item.classList.toggle(faqOpenClass, open);
        item.classList.toggle(faqClosedClass, !open);
      }
      item.setAttribute('data-name', open ? 'Open' : 'Closed');
      if (container && faqOpenStyle && faqClosedStyle) {
        container.setAttribute('style', open ? faqOpenStyle : faqClosedStyle);
      }
      question.setAttribute('aria-expanded', String(open));
    };

    apply(!answer.hidden);

    const toggle = () => apply(answer.hidden);
    question.addEventListener('click', toggle);
    question.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
}

export function initInteractions() {
  initMobileNav();
  initAnchors();
  whenSettled(initTickers);
  initFaq();
}
