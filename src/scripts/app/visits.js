/**
 * Tab 2 - Visites.
 *
 * This is where the fourth layer of the architecture becomes visible: the
 * agency answers in prose, the agent turns that prose into slots, and the slots
 * show up here as something to tap.
 *
 * The tab is a queue before it is a calendar. What is confirmed can wait to be
 * looked at; what needs an answer cannot, so it sits above the calendar in its
 * own block rather than being one colour among others in a grid. A calendar
 * shows you time. A queue shows you work.
 *
 * The week/month split is done in CSS from a single render rather than by
 * measuring the viewport in JavaScript: a resize across the breakpoint then
 * costs nothing, and there is no state to lose.
 */
import * as agent from '../../lib/prems/agent.js';
import * as store from '../../lib/prems/store.js';
import {
  h,
  appIcon,
  button,
  statusBadge,
  sectionTitle,
  sheet,
  empty,
  toast,
} from './ui.js';

const DAY = 86_400_000;

const startOfWeek = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/* -------------------------------------------------------------------------
 * Availability
 *
 * A grid of day x moment. Deliberately coarse: nobody knows on a Tuesday which
 * exact quarter-hour they can visit in nine days, and asking for that precision
 * produces either a wrong answer or an abandoned form. Four moments a day is
 * enough for an agency to propose something that works.
 * ------------------------------------------------------------------------- */
function availabilityGrid({ onSave, compact = false }) {
  const selected = new Set(agent.get().availability);

  const counter = h('p', { class: 'pm-avail__count' });
  const save = button('Enregistrer mes disponibilités', { variant: 'accent' });

  const refresh = () => {
    const n = selected.size;
    counter.textContent = n
      ? `${n} créneau${n > 1 ? 'x' : ''} sélectionné${n > 1 ? 's' : ''}`
      : 'Sélectionne au moins deux créneaux dans la semaine.';
    save.disabled = n < 2;
    save.setAttribute('aria-disabled', String(n < 2));
  };

  const grid = h(
    'div',
    { class: 'pm-avail__grid', role: 'group', 'aria-label': 'Créneaux de disponibilité' },
    h(
      'div',
      { class: 'pm-avail__row pm-avail__row--head' },
      h('span', { class: 'pm-avail__corner' }),
      agent.SLOTS.map((slot) =>
        h(
          'span',
          { class: 'pm-avail__col', title: slot.range },
          h('span', { class: 'pm-avail__col-label' }, slot.label),
          h('span', { class: 'pm-avail__col-range' }, slot.range),
        ),
      ),
    ),
    agent.DAYS.map((day) =>
      h(
        'div',
        { class: 'pm-avail__row' },
        h('span', { class: 'pm-avail__day' }, day.short),
        agent.SLOTS.map((slot) => {
          const id = `${day.id}-${slot.id}`;
          const cell = h('button', {
            class: 'pm-avail__cell',
            type: 'button',
            'data-selected': String(selected.has(id)),
            'aria-pressed': String(selected.has(id)),
            'aria-label': `${day.label} ${slot.label}, ${slot.range}`,
            onClick: () => {
              const on = !selected.has(id);
              if (on) selected.add(id);
              else selected.delete(id);
              cell.dataset.selected = String(on);
              cell.setAttribute('aria-pressed', String(on));
              refresh();
            },
          });
          return cell;
        }),
      ),
    ),
  );

  save.addEventListener('click', () => {
    if (selected.size < 2) return;
    const first = !agent.hasAvailability();
    agent.saveAvailability([...selected]);
    toast(
      first
        ? 'C’est parti. Ton agent commence à contacter les agences.'
        : 'Disponibilités mises à jour.',
    );
    onSave?.();
  });

  refresh();

  return h(
    'div',
    { class: `pm-avail${compact ? ' pm-avail--compact' : ''}` },
    grid,
    counter,
    save,
  );
}

/* -------------------------------------------------------------------------
 * The queue: slots waiting for an answer
 * ------------------------------------------------------------------------- */
function pendingCard(match) {
  const { listing } = match;

  return h(
    'article',
    { class: 'pm-pending' },
    h(
      'header',
      { class: 'pm-pending__head' },
      h(
        'div',
        {},
        h('p', { class: 'pm-pending__title' }, `${listing.district} · ${listing.rent_eur} €`),
        h(
          'p',
          { class: 'pm-pending__sub' },
          `${listing.surface_m2} m² · ${listing.agency} a répondu ${agent.ago(match.repliedAt)}`,
        ),
      ),
      statusBadge('creneaux_proposes'),
    ),
    h(
      'div',
      { class: 'pm-pending__slots' },
      match.slots.map((slot) =>
        h(
          'button',
          {
            class: 'pm-slot',
            type: 'button',
            onClick: () => {
              agent.act(match.id, { chosenSlot: slot.iso });
              toast(`Visite confirmée le ${agent.formatDate(slot.at)} à ${agent.formatTime(slot.at)}.`);
            },
          },
          h('span', { class: 'pm-slot__day' }, agent.formatDate(slot.at)),
          h('span', { class: 'pm-slot__time' }, agent.formatTime(slot.at)),
        ),
      ),
    ),
    h(
      'p',
      { class: 'pm-pending__note' },
      'Un tap suffit — l’agent confirme à l’agence et te met un rappel.',
    ),
  );
}

/* -------------------------------------------------------------------------
 * Post-visit feedback
 *
 * Two buttons, because the answer to "how did it go" that matters is binary:
 * either the file goes to the landlord tonight, or the agent moves on. Asking
 * for a rating out of five would collect nothing anyone acts on.
 * ------------------------------------------------------------------------- */
function reviewCard(match) {
  const { listing } = match;

  const answer = (value) => {
    agent.act(match.id, { feedback: value, feedbackAt: new Date().toISOString() });
    toast(
      value === 'oui'
        ? 'Dossier complet envoyé au bailleur. On te tient au courant.'
        : 'Noté. L’agent se concentre sur les autres pistes.',
    );
  };

  return h(
    'article',
    { class: 'pm-review' },
    h('p', { class: 'pm-review__title' }, `Tu as visité ${listing.district} — ${listing.rent_eur} €`),
    h(
      'p',
      { class: 'pm-review__sub' },
      `${agent.formatDate(match.visitAt)} à ${agent.formatTime(match.visitAt)}. Comment ça s’est passé ?`,
    ),
    h(
      'div',
      { class: 'pm-review__actions' },
      h(
        'button',
        { class: 'pm-review__btn pm-review__btn--yes', type: 'button', onClick: () => answer('oui') },
        appIcon('thumbUp', 18),
        'Intéressé — envoyer mon dossier',
      ),
      h(
        'button',
        { class: 'pm-review__btn', type: 'button', onClick: () => answer('non') },
        appIcon('thumbDown', 18),
        'Pas intéressé',
      ),
    ),
  );
}

/* -------------------------------------------------------------------------
 * The visit sheet
 * ------------------------------------------------------------------------- */
function openVisit(match) {
  const { listing } = match;
  const draft = store.get();

  sheet({
    title: 'Ta visite',
    body: () =>
      h(
        'div',
        { class: 'pm-visit' },
        h(
          'p',
          { class: 'pm-visit__when' },
          `${agent.formatDate(match.visitAt)} à ${agent.formatTime(match.visitAt)}`,
        ),
        statusBadge(match.status),
        h(
          'dl',
          { class: 'pm-visit__list' },
          h('dt', {}, 'Adresse'),
          h('dd', {}, `${listing.street}, ${listing.district}, ${listing.city}`),
          h('dt', {}, 'Le bien'),
          h(
            'dd',
            {},
            `${listing.property_type} · ${listing.surface_m2} m² · ${listing.rooms} pièces · ` +
              `${listing.rent_eur} € + ${listing.charges_eur} € de charges`,
          ),
          h('dt', {}, 'Agence'),
          h('dd', {}, listing.agency),
          h('dt', {}, 'Ton dossier'),
          h(
            'dd',
            {},
            draft.addressProofName
              ? 'Complet et transmis à l’agence avant la visite.'
              : 'Complet. Il partira au bailleur si tu es intéressé.',
          ),
        ),
        h(
          'p',
          { class: 'pm-visit__reminder' },
          appIcon('bell', 15),
          'Rappel programmé la veille à 19 h et le matin même à 8 h.',
        ),
        h(
          'div',
          { class: 'pm-visit__actions' },
          h(
            'a',
            {
              class: 'ob-btn ob-btn--light',
              href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                `${listing.street} ${listing.city}`,
              )}`,
              target: '_blank',
              rel: 'noopener',
            },
            h('span', { class: 'ob-btn__inner' }, appIcon('pin', 17), 'Ouvrir l’itinéraire'),
          ),
        ),
      ),
  });
}

/* -------------------------------------------------------------------------
 * Calendar
 * ------------------------------------------------------------------------- */
const visitsOn = (visits, date) => visits.filter((v) => sameDay(new Date(v.visitAt), date));

function weekView(visits) {
  const today = new Date();
  const start = startOfWeek(today);

  return h(
    'div',
    { class: 'pm-cal pm-cal--week' },
    h(
      'p',
      { class: 'pm-cal__caption' },
      `Semaine du ${start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`,
    ),
    h(
      'div',
      { class: 'pm-cal__week' },
      agent.DAYS.map((day, index) => {
        const date = new Date(start.getTime() + index * DAY);
        const dayVisits = visitsOn(visits, date);

        return h(
          'div',
          {
            class: `pm-cal__day${sameDay(date, today) ? ' is-today' : ''}${
              dayVisits.length ? ' has-visit' : ''
            }`,
          },
          h('span', { class: 'pm-cal__dow' }, day.short),
          h('span', { class: 'pm-cal__num' }, String(date.getDate())),
          h(
            'div',
            { class: 'pm-cal__chips' },
            dayVisits.map((visit) =>
              h(
                'button',
                { class: 'pm-cal__chip', type: 'button', onClick: () => openVisit(visit) },
                agent.formatTime(visit.visitAt),
              ),
            ),
          ),
        );
      }),
    ),
  );
}

function monthView(visits) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const start = startOfWeek(first);
  const cells = [];

  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getTime() + i * DAY);
    const dayVisits = visitsOn(visits, date);
    const outside = date.getMonth() !== today.getMonth();

    cells.push(
      h(
        'div',
        {
          class: `pm-cal__cell${outside ? ' is-outside' : ''}${
            sameDay(date, today) ? ' is-today' : ''
          }${dayVisits.length ? ' has-visit' : ''}`,
        },
        h('span', { class: 'pm-cal__num' }, String(date.getDate())),
        h(
          'div',
          { class: 'pm-cal__chips' },
          dayVisits.map((visit) =>
            h(
              'button',
              { class: 'pm-cal__chip', type: 'button', onClick: () => openVisit(visit) },
              `${agent.formatTime(visit.visitAt)} · ${visit.listing.district}`,
            ),
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    { class: 'pm-cal pm-cal--month' },
    h(
      'p',
      { class: 'pm-cal__caption' },
      today.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
    ),
    h(
      'div',
      { class: 'pm-cal__dows' },
      agent.DAYS.map((day) => h('span', {}, day.short)),
    ),
    h('div', { class: 'pm-cal__month' }, cells),
  );
}

/* -------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */
export default function renderVisits(ctx) {
  const model = ctx.model;
  const wrap = h('div', { class: 'pm-page' });

  /* No availability yet: the picker is the entire tab. Showing an empty
   * calendar above it would bury the one thing there is to do. */
  if (!model.started) {
    wrap.append(
      h(
        'section',
        { class: 'pm-gate pm-gate--inline' },
        h('h2', { class: 'pm-gate__title' }, 'Quand peux-tu visiter ?'),
        h(
          'p',
          { class: 'pm-gate__text' },
          'Coche tes créneaux habituels. L’agent ne proposera aux agences que ces moments-là, ' +
            'et confirmera pour toi sans te redemander.',
        ),
      ),
      availabilityGrid({ onSave: () => ctx.go('accueil') }),
    );
    return wrap;
  }

  if (model.pendingSlots.length) {
    wrap.append(
      sectionTitle('En attente de ta réponse', `${model.pendingSlots.length} à traiter`),
      h('div', { class: 'pm-queue' }, model.pendingSlots.map(pendingCard)),
    );
  }

  if (model.toReview.length) {
    wrap.append(
      sectionTitle('Tes visites passées'),
      h('div', { class: 'pm-queue' }, model.toReview.map(reviewCard)),
    );
  }

  const upcoming = model.visits.filter((v) => v.status === 'visite_confirmee');

  wrap.append(sectionTitle('Ton calendrier', upcoming.length ? `${upcoming.length} visite${upcoming.length > 1 ? 's' : ''} confirmée${upcoming.length > 1 ? 's' : ''}` : null));

  if (!model.visits.length && !model.pendingSlots.length) {
    wrap.append(
      empty({
        icon: 'calendar',
        title: 'Aucune visite pour l’instant.',
        text:
          'Dès qu’une agence répond, ses créneaux apparaissent ici en haut de page. Tu choisis ' +
          'en un tap, l’agent confirme et programme les rappels.',
      }),
    );
  } else {
    wrap.append(weekView(model.visits), monthView(model.visits));
  }

  if (upcoming.length) {
    wrap.append(
      h(
        'div',
        { class: 'pm-upcoming' },
        upcoming.map((visit) =>
          h(
            'button',
            { class: 'pm-upcoming__row', type: 'button', onClick: () => openVisit(visit) },
            h(
              'span',
              { class: 'pm-upcoming__when' },
              `${agent.formatDate(visit.visitAt)} · ${agent.formatTime(visit.visitAt)}`,
            ),
            h(
              'span',
              { class: 'pm-upcoming__what' },
              `${visit.listing.district} — ${visit.listing.rent_eur} €`,
            ),
            h('span', { class: 'pm-upcoming__chevron', html: '›' }),
          ),
        ),
      ),
    );
  }

  wrap.append(
    sectionTitle('Mes disponibilités'),
    h(
      'p',
      { class: 'pm-foot-note' },
      'Modifie-les quand tu veux : les prochains créneaux proposés suivront immédiatement.',
    ),
    availabilityGrid({ compact: true }),
  );

  return wrap;
}
