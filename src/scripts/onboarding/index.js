/**
 * The onboarding controller.
 *
 * Owns the shell - back control, progress bar, sticky primary action - and
 * swaps screens in and out. Screens never touch the chrome directly; they
 * describe what they need and this decides how it is presented, which is what
 * keeps thirteen screens visually identical to each other.
 *
 * Navigation is hash-based so the browser's own back button behaves, and the
 * draft in localStorage means a refresh resumes where you left off.
 */
import { SCREENS, ORDER } from './screens.js';
import * as store from '../../lib/prems/store.js';
import { track } from '../../lib/prems/analytics.js';
import { h, ICONS, button, setLoading } from './ui.js';

let current = null;
let currentId = null;
let history = [];
let direction = 'forward';

/* -------------------------------------------------------------------------
 * Shell
 * ------------------------------------------------------------------------- */
const root = document.getElementById('onboarding');

const backBtn = h('button', {
  class: 'ob__back',
  type: 'button',
  'aria-label': 'Revenir à la question précédente',
  html: ICONS.arrowLeft,
  onClick: () => back(),
});

const progressFill = h('div', { class: 'ob__progress-fill' });
const progressLabel = h('span', { class: 'ob__progress-label' }, '0 %');

const header = h(
  'header',
  { class: 'ob__header', hidden: true },
  h(
    'div',
    { class: 'ob__header-inner' },
    backBtn,
    h(
      'div',
      {
        class: 'ob__progress',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
        'aria-label': 'Progression du dossier',
      },
      progressFill,
    ),
    progressLabel,
  ),
);

const stage = h('div', { class: 'ob__stage' });
const main = h('main', { class: 'ob__main' }, stage);

const footerHint = h('p', { class: 'ob__footer-hint' });
const footerSlot = h('div', { style: { width: '100%' } });
const footer = h(
  'footer',
  { class: 'ob__footer', hidden: true },
  h('div', { class: 'ob__footer-inner' }, footerSlot, footerHint),
);

root.append(header, main, footer);

function setProgress(value) {
  if (value == null) return;
  progressFill.style.width = `${value}%`;
  progressLabel.textContent = `${value} %`;
  progressFill.parentElement.setAttribute('aria-valuenow', String(value));
}

/* -------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */
function render(id) {
  const screen = SCREENS[id];
  if (!screen) return render('hook');

  // Let the previous screen clean up anything it started (timers, observers).
  stage.firstElementChild?.dispatchEvent(new CustomEvent('ob:teardown'));
  for (const node of stage.querySelectorAll('*')) {
    node.dispatchEvent(new CustomEvent('ob:teardown'));
  }

  currentId = id;
  store.set({ step: id });
  track(id, 'view');

  let primary = null;

  const ctx = {
    go,
    back,
    next: () => advance(),
    setValid(valid) {
      if (!primary) return;
      primary.disabled = !valid;
      primary.setAttribute('aria-disabled', String(!valid));
    },
  };

  current = screen.build(ctx);

  /* --- chrome ------------------------------------------------------------
   * Three independent decisions, because the two special screens want
   * different combinations: the hook hides everything and bleeds to the edges,
   * while the celebration keeps the header precisely so the bar can be seen
   * reaching 100%. Collapsing these into one "full" flag is what stripped the
   * gutters off the final screen.
   */
  header.hidden = Boolean(screen.hideHeader);
  footer.hidden = Boolean(screen.hideFooter);
  backBtn.hidden = !screen.back || history.length === 0;

  setProgress(screen.progress);

  /* --- body -------------------------------------------------------------- */
  const wrapper = h(
    'div',
    { class: `ob__screen${direction === 'back' ? ' ob__screen--back' : ''}` },
    screen.eyebrow ? h('span', { class: 'ob__eyebrow' }, screen.eyebrow) : null,
    screen.title ? h('h1', { class: 'ob__title' }, screen.title) : null,
    screen.subtitle ? h('p', { class: 'ob__subtitle' }, screen.subtitle) : null,
    current.body ? h('div', { class: screen.title ? 'ob__body' : '' }, current.body) : null,
  );

  if (screen.bleed) {
    stage.replaceChildren(current.body);
    stage.style.padding = '0';
    stage.style.maxWidth = 'none';
    main.style.padding = '0';
  } else {
    stage.replaceChildren(wrapper);
    stage.style.padding = '';
    stage.style.maxWidth = '';
    main.style.padding = '';
  }

  /* --- primary action ---------------------------------------------------- */
  if (!screen.hideFooter) {
    const config = current.cta || { label: 'Continuer', arrow: true };
    primary = button(config.label, {
      variant: config.variant || '',
      arrow: config.arrow !== false,
      onClick: () => advance(),
    });
    ctx.setValid(current.valid !== false);
    footerSlot.replaceChildren(primary);
    footerHint.textContent = current.hint || '';
    footerHint.hidden = !current.hint;
  }

  // Only pull focus on screens whose first act is typing, and never on touch,
  // where a surprise keyboard hides the question that was just asked.
  const isCoarse = matchMedia('(pointer: coarse)').matches;
  if (current.focus && !isCoarse) setTimeout(() => current.focus.focus(), 340);

  main.scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* -------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------- */
async function advance() {
  if (!current) return;

  const primary = footerSlot.querySelector('.ob-btn');
  let target;

  if (typeof current.onNext === 'function') {
    const result = current.onNext();
    if (result instanceof Promise) {
      if (primary) setLoading(primary, true);
      try {
        target = await result;
      } finally {
        if (primary) setLoading(primary, false);
      }
    } else {
      target = result;
    }
  }

  // `false` means the screen rejected the input and has already said why.
  if (target === false) return;
  if (!target) target = ORDER[Math.min(ORDER.indexOf(currentId) + 1, ORDER.length - 1)];

  track(currentId, 'complete');
  go(target);
}

function go(id) {
  if (id === currentId) return;
  direction = 'forward';
  history.push(currentId);
  location.hash = id;
  render(id);
}

function back() {
  if (!history.length) return;
  direction = 'back';
  track(currentId, 'back');
  const previous = history.pop();
  location.hash = previous;
  render(previous);
}

/* -------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */
function initialScreen() {
  const fromHash = location.hash.slice(1);
  if (fromHash && SCREENS[fromHash]) {
    // Returning from Google OAuth, or a shared link. Rebuild a plausible
    // history so the back control is not a dead end.
    history = ORDER.slice(0, ORDER.indexOf(fromHash));
    return fromHash;
  }

  const saved = store.get().step;
  if (saved && SCREENS[saved] && saved !== 'hook') {
    history = ORDER.slice(0, ORDER.indexOf(saved));
    return saved;
  }
  return 'hook';
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && SCREENS[id] && id !== currentId) {
    direction = 'back';
    render(id);
  }
});

document.body.classList.add('ob-body');
render(initialScreen());
