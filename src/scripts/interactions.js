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
  const drawers = document.querySelectorAll('[data-framer-name="Open"]');
  const triggers = document.querySelectorAll('[data-framer-name="Icon Container"]');
  if (!triggers.length || !drawers.length) return;

  // Pair each trigger with the drawer inside the same nav element.
  for (const trigger of triggers) {
    const nav = trigger.closest('nav');
    if (!nav) continue;
    const drawer = nav.querySelector('[data-framer-name="Open"]');
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
 * Framer's Ticker (the looping testimonial/logo marquees).
 *
 * Ticker is a code component: Framer server-renders the list but computes its
 * width, height and duplication in JavaScript, so the exported markup collapses
 * to 0x0 without a runtime. This restores it declaratively - lay the strip out
 * at its natural width, duplicate it once, and loop it with a CSS animation.
 *
 * Markup signature: a <ul> carrying an inline translateX, inside a clipping
 * wrapper, with one <li> per item.
 */
function initTickers() {
  const lists = document.querySelectorAll('ul[style*="translateX"]');

  for (const ul of lists) {
    const items = [...ul.children].filter((c) => c.tagName === 'LI');
    if (!items.length || ul.dataset.tickerReady) continue;
    ul.dataset.tickerReady = '1';

    // The SSR inline style pins the strip to the wrapper's size, which is what
    // collapses it. Let it take its content's width instead.
    ul.style.width = 'max-content';
    ul.style.maxWidth = 'none';
    ul.style.height = 'auto';
    ul.style.maxHeight = 'none';
    ul.style.transform = 'none';
    ul.style.willChange = 'transform';

    const wrapper = ul.parentElement;
    if (wrapper) {
      // The clip wrapper inherits a percentage height from the collapsed strip.
      if (getComputedStyle(wrapper).height === '0px') wrapper.style.height = 'auto';
      wrapper.style.overflow = 'hidden';
    }

    // Duplicate the strip so the loop has something to scroll into.
    const strip = document.createElement('div');
    strip.style.cssText = 'display:flex;align-items:center;flex-direction:row;flex:none;';
    for (const item of items) strip.appendChild(item);

    const clone = strip.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    ul.appendChild(strip);
    ul.appendChild(clone);
    ul.style.display = 'flex';

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) continue;

    // Duration from width keeps every ticker at the same visual speed.
    const width = strip.getBoundingClientRect().width;
    if (!width) continue;
    const seconds = Math.max(20, Math.round(width / 60));
    ul.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${width}px)` }],
      { duration: seconds * 1000, iterations: Infinity, easing: 'linear' },
    );
  }
}

export function initInteractions() {
  initMobileNav();
  initAnchors();
  initTickers();
}
