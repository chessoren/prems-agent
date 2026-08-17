/**
 * Tab 1 - Accueil / Mes matchs.
 *
 * The default tab, and the one that has to answer "what happened since I last
 * looked" in the first second. A feed of cards, one per matched flat, ordered
 * by relevance and then by freshness.
 *
 * Three decisions shape it:
 *
 * - Every card carries the time it was found. "Détecté il y a 4 min" is the
 *   single most differentiating thing this product can say, and saying it on
 *   every card is cheaper and more convincing than any copy about speed.
 * - Dismissing is a first-class action, not a hidden menu item. What gets
 *   dismissed feeds the implicit criteria, and when a pattern emerges the app
 *   says so out loud - a silent model that learns is indistinguishable from
 *   one that does not.
 * - The empty state is the agent's log. Nothing is a worse first session than
 *   a blank page, and the honest alternative to "no results" is a visible
 *   account of the work being done.
 */
import * as agent from '../../lib/prems/agent.js';
import * as store from '../../lib/prems/store.js';
import { h, appIcon, button, statusBadge, artwork, sectionTitle, empty, toast } from './ui.js';
import { photoHue } from '../onboarding/ui.js';
import { STATUS } from '../../lib/prems/agent.js';

/* -------------------------------------------------------------------------
 * The gate
 *
 * Before any availability is known the agent is deliberately idle, and the
 * home tab's job is to make the one required action unmissable and explain why
 * it exists. "Give us your availability" without a reason reads as a form;
 * with the reason it reads as the first move in a plan.
 * ------------------------------------------------------------------------- */
function gateCard(ctx) {
  return h(
    'section',
    { class: 'pm-gate' },
    h('span', { class: 'pm-gate__step' }, 'Étape 1 sur 1'),
    h('h2', { class: 'pm-gate__title' }, 'Dis-nous quand tu peux visiter.'),
    h(
      'p',
      { class: 'pm-gate__text' },
      'C’est la seule chose qui manque pour lancer ton agent. Il contacte les agences en ' +
        'ton nom et négocie les créneaux directement — il a donc besoin de savoir quand tu ' +
        'es libre, sinon il décroche des visites auxquelles tu ne peux pas aller.',
    ),
    h(
      'p',
      { class: 'pm-gate__text' },
      'Deux minutes maintenant, et tu n’auras plus jamais à répondre à une agence.',
    ),
    button('Choisir mes disponibilités', {
      variant: 'accent',
      arrow: true,
      onClick: () => ctx.go('visites'),
    }),
  );
}

/* -------------------------------------------------------------------------
 * The agent's log
 *
 * Timestamped lines, newest first, with a pulsing head. This is what turns
 * waiting into evidence of work: the sources being polled, the size of the
 * catalogue under watch, each detection and each message sent.
 * ------------------------------------------------------------------------- */
function logPanel(model) {
  const lines = agent.logs(model);
  const draft = store.get();

  return h(
    'section',
    { class: 'pm-log' },
    h(
      'header',
      { class: 'pm-log__head' },
      h('span', { class: 'pm-log__pulse', 'aria-hidden': 'true' }),
      h('span', { class: 'pm-log__title' }, 'Ton agent en direct'),
      h('span', { class: 'pm-log__city' }, draft.city || ''),
    ),
    h(
      'ol',
      { class: 'pm-log__list' },
      lines.slice(0, 8).map((line, index) =>
        h(
          'li',
          { class: `pm-log__line pm-log__line--${line.tone}`, style: { animationDelay: `${index * 70}ms` } },
          h('span', { class: 'pm-log__time' }, agent.ago(line.at)),
          h('span', { class: 'pm-log__text' }, line.text),
        ),
      ),
    ),
  );
}

/* -------------------------------------------------------------------------
 * A match card
 * ------------------------------------------------------------------------- */
const ACTIONS = {
  creneaux_proposes: { label: 'Choisis ton créneau', tab: 'visites', variant: 'accent' },
  visite_confirmee: { label: 'Voir la visite', tab: 'visites', variant: 'light' },
  visite_passee: { label: 'Comment ça s’est passé ?', tab: 'visites', variant: 'accent' },
};

function matchCard(match, ctx) {
  const { listing } = match;
  const status = STATUS[match.status];
  const action = ACTIONS[match.status];

  /**
   * The listing's own photograph, with the generated artwork underneath it.
   *
   * Stacked rather than swapped: the artwork paints immediately and the image
   * covers it when it decodes, so the card never shows a grey rectangle. If the
   * URL 404s - the portal drops files when a listing is withdrawn - the image
   * removes itself and the artwork is simply what remains.
   */
  function photo(item) {
    const art = artwork(photoHue(item.hue ?? item.rent_eur), 'pm-match__art');
    const first = Array.isArray(item.photos) ? item.photos[0] : null;
    if (!first) return art;

    const img = h('img', {
      class: 'pm-match__img',
      src: first,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      // Hotlinked from the portal's CDN; do not leak which client is looking.
      referrerpolicy: 'no-referrer',
      onError: (event) => event.currentTarget.remove(),
    });

    return h('div', { class: 'pm-match__frame' }, art, img);
  }

  const card = h(
    'article',
    { class: 'pm-match', 'data-status': match.status },
    h(
      'div',
      { class: 'pm-match__photo' },
      /* The real photograph, when the source gave us one.
       *
       * 808 of the 832 listings carry them, eight on average. The generated
       * artwork stays as the fallback for the rest and for the moment before
       * the image arrives - an empty grey box while a photo loads reads as a
       * broken card, and a card that breaks is one nobody clicks.
       *
       * `onerror` matters as much as the src: these are hotlinked from the
       * portal's CDN, and a photo pulled after a listing is withdrawn should
       * degrade to the artwork rather than to a broken-image icon. */
      photo(listing),
      h('span', { class: 'pm-match__score', title: 'Score de pertinence' }, `${match.score}%`),
    ),
    h(
      'div',
      { class: 'pm-match__body' },
      /* In the body rather than floated over the artwork: the photo column is
       * 118px on a phone and "Dossier envoyé au bailleur" is far wider than
       * that, so a floating badge covered the price it sits next to. */
      statusBadge(match.status),
      h(
        'div',
        { class: 'pm-match__head' },
        h('p', { class: 'pm-match__price' }, `${listing.rent_eur.toLocaleString('fr-FR')} €`),
        h('p', { class: 'pm-match__meta' }, `${listing.surface_m2} m² · ${listing.rooms} pièces`),
      ),
      h('p', { class: 'pm-match__district' }, `${listing.district} · ${listing.agency}`),
      h(
        'p',
        { class: 'pm-match__detected' },
        appIcon('clock', 13),
        `Détecté ${agent.ago(match.detectedAt)}`,
      ),
      h('p', { class: 'pm-match__detail' }, status.detail),
      h(
        'div',
        { class: 'pm-match__actions' },
        action
          ? button(action.label, {
              variant: action.variant,
              onClick: () => ctx.go(action.tab),
            })
          : null,
        h(
          'button',
          {
            class: 'pm-match__dismiss',
            type: 'button',
            onClick: () => dismiss(match),
          },
          'Pas intéressé',
        ),
      ),
    ),
  );

  attachSwipe(card, match);
  return card;
}

/**
 * Dismiss, with an undo rather than a confirmation.
 *
 * A confirmation dialog on an action taken dozens of times is a tax; an undo
 * costs nothing when the person meant it. The toast also reports what the
 * matcher learned, which is the only moment the implicit criteria are visible.
 */
function dismiss(match) {
  agent.dismiss(match.listing);

  const learned = agent.learnedDislikes();
  const relevant = learned.find((trait) => trait.test(match.listing));

  toast(
    relevant
      ? `Écarté. On montrera moins ${relevant.label}.`
      : 'Écarté. Ton score de pertinence est ajusté.',
    {
      action: 'Annuler',
      onAction: () => agent.undismiss(match.listing.id),
    },
  );
}

/**
 * Swipe to dismiss, on touch only.
 *
 * The button below does the same job and is the only path with a pointer -
 * a mouse drag on a card is not a gesture anyone tries. Horizontal intent is
 * measured against vertical before the card moves at all, or scrolling the
 * feed would fling cards sideways.
 */
function attachSwipe(card, match) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let locked = null;

  card.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      dx = 0;
      locked = null;
      card.style.transition = 'none';
    },
    { passive: true },
  );

  card.addEventListener(
    'touchmove',
    (event) => {
      const touch = event.touches[0];
      const moveX = touch.clientX - startX;
      const moveY = touch.clientY - startY;

      if (locked === null) {
        if (Math.abs(moveX) < 8 && Math.abs(moveY) < 8) return;
        locked = Math.abs(moveX) > Math.abs(moveY) * 1.4 ? 'x' : 'y';
      }
      if (locked !== 'x') return;

      dx = moveX;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 42}deg)`;
      card.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 320));
    },
    { passive: true },
  );

  card.addEventListener('touchend', () => {
    card.style.transition = '';
    if (locked === 'x' && Math.abs(dx) > 96) {
      card.style.transform = `translateX(${dx > 0 ? 500 : -500}px)`;
      card.style.opacity = '0';
      setTimeout(() => dismiss(match), 160);
      return;
    }
    card.style.transform = '';
    card.style.opacity = '';
  });
}

/* -------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */
export default function renderMatches(ctx) {
  const model = ctx.model;
  const draft = store.get();
  const wrap = h('div', { class: 'pm-page' });

  /* Before availability: the gate first, then the log so the idleness is
   * explained rather than merely stated. */
  if (!model.started) {
    wrap.append(
      gateCard(ctx),
      logPanel(model),
      h(
        'p',
        { class: 'pm-foot-note' },
        `On surveille déjà ${agent.SOURCES.join(', ')} en continu. Dès que tes créneaux sont ` +
          'enregistrés, l’agent commence à écrire aux agences.',
      ),
    );
    return wrap;
  }

  if (!model.matches.length) {
    const scanned = model.poolSize
      ? `${model.poolSize.toLocaleString('fr-FR')} annonces`
      : 'les annonces';

    wrap.append(
      empty({
        icon: 'radar',
        title: 'L’agent tourne.',
        text:
          `On scanne ${scanned} en continu sur ${agent.SOURCES.join(', ')} pour toi à ` +
          `${draft.city || 'ta ville'}. Le premier match arrive généralement sous 24 h — ` +
          'tu recevras une notification, tu n’as pas à rester ici.',
      }),
      logPanel(model),
    );
    return wrap;
  }

  const actionable = model.matches.filter((m) => m.status === 'creneaux_proposes').length;

  wrap.append(
    sectionTitle(
      `${model.matches.length} match${model.matches.length > 1 ? 's' : ''}`,
      actionable ? `${actionable} en attente de toi` : 'triés par pertinence',
    ),
  );

  if (model.dislikes.length) {
    wrap.append(
      h(
        'p',
        { class: 'pm-learned' },
        appIcon('sparkle', 15),
        `Compris : on montre moins ${model.dislikes.map((d) => d.label).join(' et ')}.`,
      ),
    );
  }

  wrap.append(
    h('div', { class: 'pm-feed' }, model.matches.map((match) => matchCard(match, ctx))),
    logPanel(model),
  );

  return wrap;
}
