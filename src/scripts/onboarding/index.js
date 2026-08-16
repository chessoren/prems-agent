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
import * as billing from '../../lib/prems/billing.js';
import { ensureSession } from '../../lib/prems/supabase.js';
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

  // Publish the current screen on the shell so the stylesheet can treat screens
  // differently where it matters. On a wide viewport the questions want a
  // narrow, readable measure while the results grid wants room to breathe -
  // one shell width cannot serve both, and CSS has no other way to tell them
  // apart.
  root.dataset.screen = id;

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
/**
 * Can this screen be shown as an entry point?
 *
 * Every screen past the first question renders answers given before it - the
 * results screen says "À {ville}, tous dans ton budget". Deep-linking straight
 * into one with an empty draft printed "À null" and a count of zero, which is
 * the flow's best moment turned into a bug report. A stale hash from weeks ago
 * lands here too, not just a hand-typed URL.
 *
 * The city is the right thing to test: it is the first answer collected, so
 * having it means the visitor genuinely started the flow.
 */
function canResume(id) {
  const index = ORDER.indexOf(id);
  if (index <= ORDER.indexOf('city')) return true;
  return Boolean(store.get().citySlug);
}

function initialScreen() {
  // Coming back from Google. The target rides in `?next=` because the fragment
  // is not ours alone on this URL: Supabase puts `?code=` on it too, and the
  // two used to collide into `#employment?code=...`, which matched no screen
  // and sent the visitor back to the first one without a word.
  //
  // `code` is deliberately left in the URL - supabase-js reads it
  // asynchronously to exchange the session, and strips it itself once done.
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  if (next && SCREENS[next] && canResume(next)) {
    history = ORDER.slice(0, ORDER.indexOf(next));
    params.delete('next');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${location.pathname}${query ? `?${query}` : ''}#${next}`,
    );

    // Google just gave us an identity, so the account screen never ran. Create
    // the profile row here instead, or the answers collected from now on would
    // have nothing to attach to. Not awaited, for the same reason as screen 5.
    ensureSession()
      .then(() => store.sync())
      .then(() => billing.warm())
      .catch(() => {});

    return next;
  }

  // Split on "?" so a link produced by the older, broken redirect still lands
  // on the right screen rather than on the hook.
  const fromHash = location.hash.slice(1).split('?')[0];
  if (fromHash && SCREENS[fromHash] && canResume(fromHash)) {
    // Returning from a shared link. Rebuild a plausible history so the back
    // control is not a dead end.
    history = ORDER.slice(0, ORDER.indexOf(fromHash));
    return fromHash;
  }

  const saved = store.get().step;
  if (saved && SCREENS[saved] && saved !== 'hook' && canResume(saved)) {
    history = ORDER.slice(0, ORDER.indexOf(saved));
    return saved;
  }
  return 'hook';
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  // The same prerequisite check as the boot path. Changing only the fragment is
  // a same-document navigation, so a link or a browser Back into a later screen
  // arrives here without ever passing through initialScreen() - guarding one
  // and not the other left the hole wide open.
  if (id && SCREENS[id] && id !== currentId && canResume(id)) {
    direction = 'back';
    render(id);
  }
});

document.body.classList.add('ob-body');
render(initialScreen());
