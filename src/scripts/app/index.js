/**
 * The app shell.
 *
 * Four tabs, one of which is always the answer to "what happened while I was
 * away". The controller owns the chrome - the tab bar, the badges, the title -
 * and each tab is a function returning a node, the same contract the
 * onboarding screens use.
 *
 * Two behaviours are worth stating because they are the reason the shell is
 * not just a router:
 *
 * 1. The badges are live. A match that reaches "créneaux proposés" while the
 *    person is reading a thread updates the count on the Visites tab under
 *    their thumb. An unfinished task you can see is what brings someone back,
 *    and it stops being credible the moment it is only correct on load.
 * 2. The view re-renders only when the model actually changed. A blanket
 *    interval would reset scroll position and close accordions every thirty
 *    seconds, which is how a live screen becomes an unusable one.
 */
import * as agent from '../../lib/prems/agent.js';
import * as store from '../../lib/prems/store.js';
import * as billing from '../../lib/prems/billing.js';
import * as live from '../../lib/prems/live.js';
import { ensureSession } from '../../lib/prems/supabase.js';
import { h, appIcon, countBadge, toast } from './ui.js';
import renderMatches from './matches.js';
import renderVisits from './visits.js';
import renderMessages from './messages.js';
import renderProfile from './profile.js';

const TABS = [
  { id: 'accueil', label: 'Accueil', icon: 'home', render: renderMatches, title: 'Mes matchs' },
  { id: 'visites', label: 'Visites', icon: 'calendar', render: renderVisits, title: 'Visites' },
  { id: 'messages', label: 'Messages', icon: 'chat', render: renderMessages, title: 'Messages' },
  { id: 'profil', label: 'Profil', icon: 'user', render: renderProfile, title: 'Mon dossier' },
];

const root = document.getElementById('app');

let currentTab = 'accueil';
let model = null;
let signature = '';

/* -------------------------------------------------------------------------
 * Chrome
 * ------------------------------------------------------------------------- */
const title = h('h1', { class: 'pm__title' }, 'Mes matchs');
const cityChip = h('span', { class: 'pm__chip' });

const header = h(
  'header',
  { class: 'pm__top' },
  h(
    'div',
    { class: 'pm__top-inner' },
    h(
      'a',
      { class: 'pm__brand', href: '/', 'aria-label': 'Prems — accueil du site' },
      h('span', { class: 'pm__brand-dot', 'aria-hidden': 'true' }),
      'Prems',
    ),
    title,
    cityChip,
  ),
);

const view = h('div', { class: 'pm__view' });
const main = h('main', { class: 'pm__main' }, view);

const badges = {};
const tabButtons = {};

const nav = h(
  'nav',
  { class: 'pm__tabs', 'aria-label': 'Navigation principale' },
  h(
    'div',
    { class: 'pm__tabs-inner' },
    TABS.map((tab) => {
      const badge = countBadge(0);
      badges[tab.id] = badge;

      const btn = h(
        'button',
        {
          class: 'pm-tab',
          type: 'button',
          'data-tab': tab.id,
          'aria-current': tab.id === currentTab ? 'page' : null,
          onClick: () => go(tab.id),
        },
        h('span', { class: 'pm-tab__icon' }, appIcon(tab.icon, 22), badge),
        h('span', { class: 'pm-tab__label' }, tab.label),
      );

      tabButtons[tab.id] = btn;
      return btn;
    }),
  ),
);

root.append(header, main, nav);

/* -------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */
/**
 * A cheap fingerprint of everything the UI draws.
 *
 * If this string is unchanged, re-rendering would produce identical markup and
 * cost the person their scroll position, so it is skipped.
 */
function fingerprint(next) {
  return [
    next.started,
    next.matches.length,
    next.badges.visites,
    next.badges.messages,
    next.matches.map((m) => `${m.id}:${m.status}`).join(','),
  ].join('|');
}

function refreshBadges() {
  badges.visites.setCount(model.badges.visites);
  badges.messages.setCount(model.badges.messages);
}

const ctx = {
  get model() {
    return model;
  },
  go: (id) => go(id),
  refresh: () => update({ force: true }),
  toast,
};

function paint() {
  const tab = TABS.find((t) => t.id === currentTab) || TABS[0];
  title.textContent = tab.title;

  const draft = store.get();
  cityChip.textContent = draft.city ? `${draft.city} · ${draft.budget} € max` : '';
  cityChip.hidden = !draft.city;

  for (const [id, btn] of Object.entries(tabButtons)) {
    if (id === currentTab) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  view.replaceChildren(tab.render(ctx));
  view.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/**
 * Recompute the model, repaint if it moved.
 *
 * `force` is for actions taken by the person - dismissing a match, choosing a
 * slot - where the view must change even though the fingerprint may not have.
 */
function update({ force = false } = {}) {
  model = agent.derive();
  refreshBadges();

  const next = fingerprint(model);
  if (force || next !== signature) {
    signature = next;
    paint();
  }
}

function go(id) {
  if (!TABS.some((t) => t.id === id)) id = 'accueil';
  currentTab = id;
  if (location.hash.slice(1) !== id) location.hash = id;
  paint();
}

/* -------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */
document.body.classList.add('pm-body');

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== currentTab) go(id);
});

// Actions taken inside a tab write to the store; the shell listens rather than
// having every tab remember to call back up.
agent.subscribe(() => update({ force: true }));

/**
 * Coming back from Stripe.
 *
 * The parameter is a hint that a payment just happened, and nothing more. It
 * used to *grant* the plan - `?checkout=fondateur` wrote the founder offer
 * straight into localStorage, which handed the 100 € tier to anyone who typed
 * the URL and lost it for the person who actually paid as soon as they cleared
 * their browser.
 *
 * The grant now belongs to the Stripe webhook, which is the only party that
 * can prove a payment. All this does is wait for that row to appear.
 */
async function readCheckout() {
  const params = new URLSearchParams(location.search);
  const plan = params.get('checkout');
  if (!plan) return;

  params.delete('checkout');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);

  toast('Paiement reçu, activation en cours…');

  // The webhook usually lands within a second, but it is a different network
  // path from the redirect and it can arrive second. Poll briefly rather than
  // claim an outcome we have not seen.
  const confirmed = await billing.waitForActivation({ timeoutMs: 15000 });

  toast(
    confirmed?.plan === 'fondateur'
      ? 'Bienvenue chez les fondateurs. Ton accès est actif jusqu’à la signature de ton bail.'
      : confirmed
        ? 'Abonnement actif. Ton agent est en route.'
        : 'Paiement enregistré. L’activation peut prendre une minute — recharge si besoin.',
  );

  update({ force: true });
}

async function boot() {
  const hash = location.hash.slice(1);
  currentTab = TABS.some((t) => t.id === hash) ? hash : 'accueil';

  // Paint immediately with whatever is known, then fill in the catalogue. The
  // first frame must not wait on a network call - the same rule the onboarding
  // applies to its results screen.
  //
  // This is load-bearing, not a preference: an earlier version of this function
  // awaited the account lookup before painting, and on a network that could not
  // reach Supabase the app rendered nothing at all rather than rendering its
  // offline state.
  update({ force: true });

  // Both are network calls, so both come after the first frame. `warm()` only
  // has to finish before somebody can click a checkout button, and the click
  // handler resolves the id again anyway.
  billing.warm().catch(() => {});
  ensureSession().catch(() => {});
  readCheckout();

  await agent.load();
  update({ force: true });

  /* The clock the whole model reads from. Twenty seconds is short enough that
   * "il y a 4 min" is never wrong by more than a rounding, and long enough
   * that a phone left open on this screen is not kept awake by it. */
  setInterval(() => update(), 20_000);

  /* A match landing while the person is on the screen.
   *
   * The pipeline runs on its own schedule and owes nothing to this tab being
   * open, so the rows can change under it at any moment. Realtime is what turns
   * that from a refresh-to-find-out into the thing the product actually sells:
   * watching the agent work. The interval above only ages the labels. */
  live.watch(async () => {
    agent.invalidate();
    await agent.load();
    update({ force: true });
  });

  // A tab left open all night is stale in a way the interval cannot fix fast
  // enough to matter; recompute the moment it comes back into view.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    agent.invalidate();
    await agent.load();
    update({ force: true });
  });
}

boot();
