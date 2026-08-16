/**
 * The state of the search, seen from the client.
 *
 * This is the model behind the four tabs: the matches the agent found, where
 * each one is in its lifecycle, the visits that came out of them, the message
 * threads, and everything the person has done in response.
 *
 * ---------------------------------------------------------------------------
 * Where the data comes from
 * ---------------------------------------------------------------------------
 * From the database. `matches`, `applications`, `application_replies` and
 * `calendar_events` are written by workers that run every minute in Cloud Run,
 * whether or not anyone has the site open, and `live.js` reads them.
 *
 * This file was written before those tables existed, and until then it
 * projected the agent's half of the model from the demo catalogue and a clock
 * derived from each listing's id. That projection is still here, below
 * `deriveProjected`, and it now serves exactly one case: somebody who has not
 * finished the flow, so has no criteria and no rows. Anyone with a real feed
 * gets the real one.
 *
 * The split the projection was built around turned out to be the right one and
 * survives unchanged: everything the *person* does - dismissals, chosen slots,
 * feedback, read marks, notification preferences - stays on the device. That
 * half was never fiction.
 */
import * as store from './store.js';
import * as live from './live.js';
import { match as matchListings } from './listings.js';

const KEY = 'prems.app.v1';

/* -------------------------------------------------------------------------
 * Persisted state - the part that is genuinely the user's
 * ------------------------------------------------------------------------- */
const EMPTY = {
  /** Weekly availability for visits: `['mar-18', 'sam-10']`. */
  availability: [],
  availabilitySavedAt: null,
  /** listing id -> { at, traits } — feeds the implicit criteria below. */
  dismissed: {},
  /** listing id -> { chosenSlot, feedback, manual, readAt, replies } */
  actions: {},
  notifications: { push: true, sms: false, email: true, frequency: 'instant' },
  /** Set when a checkout redirect lands back on the app. */
  plan: null,
  planSince: null,
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private browsing - the session still works, it just will not resume */
  }
}

const listeners = new Set();

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const get = () => state;

export function set(patch) {
  state = { ...state, ...patch };
  persist();
  for (const fn of listeners) fn(state);
  return state;
}

export function reset() {
  state = { ...EMPTY };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn(state);
}

/* -------------------------------------------------------------------------
 * Determinism
 *
 * Every timing below is derived from the listing id, so the same flat is
 * always found at the same minute and always gets the same agency reply. A
 * random draw would move the whole feed on every reload, which reads as a bug
 * long before it reads as liveliness.
 * ------------------------------------------------------------------------- */
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < String(value).length; i++) {
    h ^= String(value).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** A stable pseudo-random number in [0, 1) for a given id and salt. */
const rand = (id, salt) => (hash(`${id}:${salt}`) % 10000) / 10000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* -------------------------------------------------------------------------
 * The gate: availability
 *
 * The agent does not start until it knows when the person can visit. That is
 * not a product gimmick - an agent that books a viewing nobody can attend
 * burns the one thing it cannot rebuild, which is the agency's willingness to
 * answer. It also gives the empty first session a task instead of a wait.
 * ------------------------------------------------------------------------- */
export const DAYS = [
  { id: 'lun', label: 'Lundi', short: 'Lun' },
  { id: 'mar', label: 'Mardi', short: 'Mar' },
  { id: 'mer', label: 'Mercredi', short: 'Mer' },
  { id: 'jeu', label: 'Jeudi', short: 'Jeu' },
  { id: 'ven', label: 'Vendredi', short: 'Ven' },
  { id: 'sam', label: 'Samedi', short: 'Sam' },
  { id: 'dim', label: 'Dimanche', short: 'Dim' },
];

export const SLOTS = [
  { id: 'matin', label: 'Matin', range: '9h — 12h', hour: 10 },
  { id: 'midi', label: 'Midi', range: '12h — 14h', hour: 12, minute: 30 },
  { id: 'aprem', label: 'Après-midi', range: '14h — 18h', hour: 15 },
  { id: 'soir', label: 'Soir', range: '18h — 20h', hour: 18, minute: 30 },
];

export const hasAvailability = () => state.availability.length > 0;

export function saveAvailability(slots) {
  set({
    availability: slots,
    // Preserved once set: the agent's clock starts the first time, and
    // editing availability later must not restart the search from zero.
    availabilitySavedAt: state.availabilitySavedAt || new Date().toISOString(),
  });
}

/** When the agent started working, in ms. */
const startedAt = () =>
  state.availabilitySavedAt ? new Date(state.availabilitySavedAt).getTime() : null;

/* -------------------------------------------------------------------------
 * The lifecycle
 * ------------------------------------------------------------------------- */
export const STATUS = {
  nouveau: {
    id: 'nouveau',
    label: 'Nouveau',
    tone: 'new',
    detail: 'Détecté à l’instant — on prépare le message.',
  },
  contact_envoye: {
    id: 'contact_envoye',
    label: 'Contact envoyé',
    tone: 'working',
    detail: 'L’agent a écrit à l’agence. On attend la réponse.',
  },
  creneaux_proposes: {
    id: 'creneaux_proposes',
    label: 'Créneaux proposés',
    tone: 'action',
    detail: 'L’agence propose des dates. À toi de choisir.',
  },
  visite_confirmee: {
    id: 'visite_confirmee',
    label: 'Visite confirmée',
    tone: 'confirmed',
    detail: 'C’est calé. Rappel la veille et le matin même.',
  },
  visite_passee: {
    id: 'visite_passee',
    label: 'Visite passée',
    tone: 'action',
    detail: 'Dis-nous comment ça s’est passé.',
  },
  dossier_envoye: {
    id: 'dossier_envoye',
    label: 'Dossier envoyé au bailleur',
    tone: 'working',
    detail: 'Ton dossier complet est parti. Réponse sous 48 h en général.',
  },
  accepte: {
    id: 'accepte',
    label: 'Accepté',
    tone: 'won',
    detail: 'Le bailleur retient ta candidature.',
  },
  refuse: {
    id: 'refuse',
    label: 'Refusé',
    tone: 'lost',
    detail: 'Pas retenu cette fois — l’agent continue sur les autres.',
  },

  /* Two states the real pipeline has and a projection never did. A message
   * exists as a row before it leaves - queued behind a rate limit, or behind a
   * mailbox that is not connected yet - and an agency can reply something that
   * is neither a refusal nor a proposed slot. Showing "contact envoyé" for
   * either would be a claim we cannot back. */
  contact_en_cours: {
    id: 'contact_en_cours',
    label: 'Message en préparation',
    tone: 'working',
    detail: 'L’agent a rédigé la candidature. Départ imminent.',
  },
  reponse_recue: {
    id: 'reponse_recue',
    label: 'Réponse reçue',
    tone: 'action',
    detail: 'L’agence a répondu. À lire dans Messages.',
  },
};

/* How long each stage lasts before the next one becomes possible. */
const TO_CONTACT = 2 * MINUTE;
const TO_REPLY = 42 * MINUTE;

/**
 * Implicit criteria, learned from what gets dismissed.
 *
 * Three traits are tracked because they are the three that people reject
 * silently and would never think to state up front: the ground floor, the top
 * floor without a lift, and a bad energy rating. Two dismissals sharing a
 * trait is enough to start down-ranking it - one is noise, three is too slow
 * to be felt inside a single session.
 */
const TRAITS = {
  rdc: {
    id: 'rdc',
    test: (l) => l.floor === 0,
    label: 'les rez-de-chaussée',
  },
  dpe_faible: {
    id: 'dpe_faible',
    test: (l) => ['E', 'F', 'G'].includes(l.dpe),
    label: 'les DPE E, F et G',
  },
  sans_meuble: {
    id: 'sans_meuble',
    test: (l) => l.furnished === false,
    label: 'les non meublés',
  },
  meuble: {
    id: 'meuble',
    test: (l) => l.furnished === true,
    label: 'les meublés',
  },
};

const traitsOf = (listing) =>
  Object.values(TRAITS)
    .filter((trait) => trait.test(listing))
    .map((trait) => trait.id);

/** Traits rejected at least twice, with the wording used to say so out loud. */
export function learnedDislikes() {
  const counts = {};
  for (const entry of Object.values(state.dismissed)) {
    for (const id of entry.traits || []) counts[id] = (counts[id] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, n]) => n >= 2)
    .map(([id, n]) => ({ ...TRAITS[id], count: n }))
    .filter((t) => t.label);
}

export function dismiss(listing) {
  set({
    dismissed: {
      ...state.dismissed,
      [listing.id]: { at: new Date().toISOString(), traits: traitsOf(listing) },
    },
  });
}

export function undismiss(listingId) {
  const next = { ...state.dismissed };
  delete next[listingId];
  set({ dismissed: next });
}

const actionFor = (id) => state.actions[id] || {};

export function act(listingId, patch) {
  set({
    actions: {
      ...state.actions,
      [listingId]: { ...actionFor(listingId), ...patch },
    },
  });
}

/* -------------------------------------------------------------------------
 * Relevance
 * ------------------------------------------------------------------------- */
/**
 * How well a flat fits, 0-100.
 *
 * Budget headroom and the right number of rooms carry most of the weight,
 * because those are the two answers people give with conviction. The learned
 * dislikes then subtract - which is what makes dismissing three ground floors
 * visibly change the order of the feed rather than just hiding three cards.
 */
function score(listing, criteria, dislikes) {
  let value = 40;

  const budget = criteria.budget || listing.rent_eur;
  const ratio = listing.rent_eur / budget;
  if (ratio <= 0.8) value += 22;
  else if (ratio <= 0.9) value += 18;
  else if (ratio <= 1) value += 13;
  else if (ratio <= 1.1) value -= 4;
  else value -= 14;

  if (criteria.rooms) {
    const gap = Math.abs((listing.rooms || 0) - criteria.rooms);
    value += gap === 0 ? 16 : gap === 1 ? 5 : -12;
  }

  if (criteria.propertyType && criteria.propertyType !== 'indifferent') {
    value += listing.property_type === criteria.propertyType ? 7 : -9;
  }

  if (['A', 'B'].includes(listing.dpe)) value += 6;
  else if (listing.dpe === 'C') value += 3;
  else if (['E', 'F', 'G'].includes(listing.dpe)) value -= 4;

  /* Everything above is coarse by design - four bands and a room count - so
   * without this the whole feed lands on two or three identical numbers and
   * the score stops meaning anything. The jitter is derived from the listing
   * id, so it separates flats without ever moving one between reloads. */
  value += rand(listing.id, 'score') * 6 - 3;

  for (const disliked of dislikes) {
    if (disliked.test(listing)) value -= 12 + Math.min(disliked.count, 4) * 3;
  }

  return Math.max(12, Math.min(98, Math.round(value)));
}

/* -------------------------------------------------------------------------
 * Proposed slots
 *
 * An agency answers with dates, and the dates it offers are drawn from the
 * availability the person gave - that is the entire reason the app asks for it
 * before starting. Two or three options, never one: a single date is an
 * ultimatum, and more than three is a scheduling exercise.
 * ------------------------------------------------------------------------- */
function nextOccurrence(slotId, after, skipWeeks = 0) {
  const [dayId, partId] = slotId.split('-');
  const dayIndex = DAYS.findIndex((d) => d.id === dayId);
  const part = SLOTS.find((s) => s.id === partId) || SLOTS[0];
  if (dayIndex < 0) return null;

  const date = new Date(after);
  // JS weeks start on Sunday; ours start on Monday.
  const current = (date.getDay() + 6) % 7;
  let delta = (dayIndex - current + 7) % 7;
  if (delta === 0) delta = 7;
  date.setDate(date.getDate() + delta + skipWeeks * 7);
  date.setHours(part.hour, part.minute || 0, 0, 0);
  return date;
}

function proposedSlots(listing, repliedAt, now) {
  const available = state.availability.length ? state.availability : ['mer-aprem', 'sam-matin'];
  const offset = hash(listing.id) % available.length;
  const rotated = [...available.slice(offset), ...available.slice(0, offset)];

  /* Anchored on whichever is later, the reply or now. An agency that answered
   * on Monday offered dates from Monday, and by Thursday the first of them has
   * gone - offering it anyway would let someone book a visit in the past, which
   * the lifecycle would then immediately mark as already held. */
  const from = Math.max(repliedAt, now);

  return rotated
    .slice(0, 3)
    .map((slotId, index) => nextOccurrence(slotId, from, index === 2 ? 1 : 0))
    .filter(Boolean)
    .map((date) => ({ iso: date.toISOString(), at: date.getTime() }))
    .sort((a, b) => a.at - b.at);
}

/* -------------------------------------------------------------------------
 * Derivation
 * ------------------------------------------------------------------------- */
/**
 * Turn a listing into a match: when it was found, where it is in the
 * lifecycle, and what the person is expected to do about it.
 */
function project(listing, index, criteria, dislikes, now, start) {
  const action = actionFor(listing.id);

  /* Detection is staggered so the feed fills the way a real stream would: the
   * first inside a few minutes, then irregularly over the following days. A
   * uniform gap looks generated at a glance. */
  const spread = 6 * MINUTE + rand(listing.id, 'gap') * 30 * HOUR;
  const detectedAt = start + index * 40 * MINUTE + spread;
  if (detectedAt > now) return null; // not found yet

  const age = now - detectedAt;
  const contactedAt = detectedAt + TO_CONTACT;

  /* Not every agency answers, and pretending otherwise would make the one
   * screen that shows waiting look broken when it is working correctly. */
  const replies = rand(listing.id, 'reply') < 0.72;
  const repliedAt = contactedAt + TO_REPLY + rand(listing.id, 'delay') * 6 * HOUR;

  const slots = replies && now >= repliedAt ? proposedSlots(listing, repliedAt, now) : [];

  let status = 'nouveau';
  let visitAt = null;

  if (age >= TO_CONTACT) status = 'contact_envoye';
  if (slots.length) status = 'creneaux_proposes';

  if (action.chosenSlot) {
    visitAt = new Date(action.chosenSlot).getTime();
    status = now < visitAt ? 'visite_confirmee' : 'visite_passee';
  }

  if (action.feedback === 'non') status = 'refuse';
  if (action.feedback === 'oui') {
    status = 'dossier_envoye';
    const decidedAt = (action.feedbackAt ? new Date(action.feedbackAt).getTime() : now) + 2 * DAY;
    if (now >= decidedAt) status = rand(listing.id, 'verdict') < 0.35 ? 'accepte' : 'refuse';
  }

  return {
    listing,
    id: listing.id,
    score: score(listing, criteria, dislikes),
    detectedAt,
    contactedAt,
    repliedAt: slots.length ? repliedAt : null,
    slots,
    status,
    visitAt,
    action,
    /* The thread exists from the moment the agent writes, which is what makes
     * "on s'en occupe" verifiable rather than a claim. */
    hasThread: age >= TO_CONTACT,
  };
}

let cache = null;

/**
 * Drop the catalogue so the next `load()` re-queries it.
 *
 * Called when the criteria change from the profile tab. Editing a budget has
 * to re-run the search immediately - being sent back through thirteen
 * onboarding screens to change one number is exactly the friction that makes
 * people leave a criterion wrong instead of fixing it.
 */
export function invalidate() {
  cache = null;
}

/**
 * Load the catalogue once, then project it on every render.
 *
 * The listings come from the same matcher the onboarding "aha" screen used, so
 * the flats in the app are the flats the person was shown before signing up.
 */
export async function load() {
  if (cache) return cache;

  // The real feed first, always.
  //
  // Everything below this point is the projection that stood in for a backend
  // that did not exist when this file was written. It now does: the matcher
  // runs every minute in Cloud Run and writes `matches`, whether or not anyone
  // has the site open. The projection survives only as the answer for someone
  // who has not finished the flow yet - no session, no criteria, no rows.
  const real = await live.load();
  if (real && real.matches.length > 0) {
    cache = { listings: real.matches.map((m) => m.listing), poolSize: real.matches.length, live: real };
    return cache;
  }

  const draft = store.get();
  if (!draft.citySlug) {
    cache = { listings: [], poolSize: 0 };
    return cache;
  }

  const result = await matchListings({
    citySlug: draft.citySlug,
    budget: draft.budget,
    rooms: draft.rooms || 2,
    propertyType: draft.propertyType,
    moveInDate: draft.moveInAsap ? null : draft.moveInDate,
  });

  cache = { listings: result.listings, poolSize: result.poolSize };
  return cache;
}

/**
 * The whole model, for a given instant.
 *
 * Sorted by relevance first and freshness second, which is the order the
 * product promises: the best fit leads, and between two equally good fits the
 * one found five minutes ago wins.
 */
export function derive(now = Date.now()) {
  if (cache?.live) return deriveLive(cache.live, now);
  return deriveProjected(now);
}

/**
 * The model, built from rows.
 *
 * Same shape as the projection below, because the tabs consume it and none of
 * them should have to know which one they got. The difference is what the
 * fields mean: `contactedAt` is when a message actually left, not when a hash
 * said it would.
 *
 * What the person does stays local - dismissals, chosen slots, feedback, read
 * marks - exactly as it was. That half was always real.
 */
function deriveLive(model, now) {
  const dislikes = learnedDislikes();

  const matches = model.matches
    .filter((m) => !state.dismissed[m.id])
    .map((m) => ({ ...m, action: actionFor(m.id), hasThread: Boolean(m.application) }));

  const byId = new Map(matches.map((m) => [m.id, m]));
  const visits = matches.filter((m) => m.visitAt);

  const pendingSlots = matches.filter((m) => m.status === 'creneaux_proposes');
  const toReview = visits.filter((m) => m.visitAt < now && !m.action.feedback);
  const threads = matches
    .filter((m) => m.hasThread)
    .sort((a, b) => (b.repliedAt ?? b.contactedAt ?? 0) - (a.repliedAt ?? a.contactedAt ?? 0));

  const unread = threads.filter((m) => {
    const last = m.repliedAt;
    return last && (!m.action.readAt || new Date(m.action.readAt).getTime() < last);
  });

  return {
    matches,
    pendingSlots,
    visits,
    toReview,
    threads,
    unread,
    poolSize: byId.size,
    dislikes,
    // The agent is running the moment the pipeline has produced anything for
    // this person, which is a fact about the database rather than about a
    // button they pressed on this device.
    started: true,
    startedAt: state.availabilitySavedAt ? new Date(state.availabilitySavedAt).getTime() : null,
    live: true,
    badges: {
      visites: pendingSlots.length + toReview.length,
      messages: unread.length,
    },
  };
}

function deriveProjected(now = Date.now()) {
  const start = startedAt();
  const draft = store.get();
  const dislikes = learnedDislikes();
  const criteria = {
    budget: draft.budget,
    rooms: draft.rooms,
    propertyType: draft.propertyType,
  };

  const listings = cache?.listings || [];

  const matches = start
    ? listings
        .filter((listing) => !state.dismissed[listing.id])
        .map((listing, index) => project(listing, index, criteria, dislikes, now, start))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || b.detectedAt - a.detectedAt)
    : [];

  const pendingSlots = matches.filter((m) => m.status === 'creneaux_proposes');
  const visits = matches
    .filter((m) => m.visitAt && (m.status === 'visite_confirmee' || m.status === 'visite_passee'))
    .sort((a, b) => a.visitAt - b.visitAt);
  const toReview = matches.filter((m) => m.status === 'visite_passee' && !m.action.feedback);

  const threads = matches
    .filter((m) => m.hasThread)
    .sort((a, b) => lastMessageAt(b, now) - lastMessageAt(a, now));

  const unread = threads.filter((m) => {
    const last = lastAgencyMessageAt(m);
    return last && (!m.action.readAt || new Date(m.action.readAt).getTime() < last);
  });

  return {
    matches,
    pendingSlots,
    visits,
    toReview,
    threads,
    unread,
    poolSize: cache?.poolSize || 0,
    dislikes,
    started: Boolean(start),
    startedAt: start,
    badges: {
      visites: pendingSlots.length + toReview.length,
      messages: unread.length,
    },
  };
}

/* -------------------------------------------------------------------------
 * Messages
 *
 * Rendered from the lifecycle rather than stored: every message the agent
 * sends corresponds to a transition that already happened, so keeping a
 * separate copy would only let the two drift apart.
 * ------------------------------------------------------------------------- */
const formatDate = (ms) =>
  new Date(ms).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

const formatTime = (ms) =>
  new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function thread(match) {
  const draft = store.get();
  const name = [draft.firstName, draft.lastName].filter(Boolean).join(' ') || 'le locataire';
  const income = draft.incomeCents ? Math.round(draft.incomeCents / 100) : null;
  const listing = match.listing;
  const messages = [];

  messages.push({
    from: 'agent',
    at: match.contactedAt,
    body:
      `Bonjour, je vous contacte pour le ${listing.property_type} de ${listing.surface_m2} m² ` +
      `${listing.district}, à ${listing.rent_eur} € par mois. Je représente ${name}, dont le ` +
      `dossier est complet et conforme au décret n° 2015-1437` +
      (income ? `, avec ${income} € nets mensuels` : '') +
      `. Le dossier peut vous être transmis immédiatement. Quelles disponibilités avez-vous ` +
      `pour une visite ?`,
  });

  if (match.slots.length) {
    messages.push({
      from: 'agence',
      at: match.repliedAt,
      body:
        `Bonjour, merci pour votre message. Nous pouvons organiser une visite ` +
        match.slots.map((s) => `le ${formatDate(s.at)} à ${formatTime(s.at)}`).join(', ou ') +
        `. Dites-nous ce qui vous convient. Cordialement, ${listing.agency}.`,
    });
  }

  if (match.action.chosenSlot) {
    const at = new Date(match.action.chosenSlot).getTime();
    messages.push({
      from: match.action.manual ? 'moi' : 'agent',
      at: at - 3 * DAY < match.repliedAt ? match.repliedAt + 4 * MINUTE : match.repliedAt + 4 * MINUTE,
      body: `Parfait, nous retenons le ${formatDate(at)} à ${formatTime(at)}. Merci beaucoup.`,
    });
  }

  if (match.status === 'dossier_envoye' || match.status === 'accepte' || match.status === 'refuse') {
    if (match.action.feedbackAt) {
      messages.push({
        from: 'agent',
        at: new Date(match.action.feedbackAt).getTime() + 6 * MINUTE,
        body:
          `Suite à la visite, ${name} confirme son intérêt. Vous trouverez ci-joint le dossier ` +
          `complet : pièce d'identité, justificatifs de revenus, justificatif de domicile` +
          (draft.needsGuarantor ? ', et le dossier du garant' : '') +
          `. Nous restons à votre disposition.`,
      });
    }
  }

  return messages.sort((a, b) => a.at - b.at);
}

const lastMessageAt = (match, now) => {
  const messages = thread(match);
  return messages.length ? messages[messages.length - 1].at : now;
};

function lastAgencyMessageAt(match) {
  const agency = thread(match).filter((m) => m.from === 'agence');
  return agency.length ? agency[agency.length - 1].at : null;
}

/* -------------------------------------------------------------------------
 * The agent's log
 *
 * What an empty first session shows instead of nothing. Every line is a real
 * statement about the system described in the docs - the sources being polled,
 * the catalogue size, the outreach - and each is timestamped, because a log
 * without times is a decoration.
 * ------------------------------------------------------------------------- */
export const SOURCES = ['leboncoin', 'SeLoger', 'PAP', 'Jinka'];

export function logs(model, now = Date.now()) {
  const draft = store.get();
  const city = draft.city || 'ta ville';
  const lines = [];

  if (!model.started) {
    lines.push({ at: now, text: 'En attente de tes disponibilités pour démarrer.', tone: 'wait' });
    return lines;
  }

  lines.push({ at: model.startedAt, text: `Recherche ouverte à ${city}.`, tone: 'ok' });
  lines.push({
    at: model.startedAt + 4000,
    text: `Connexion aux sources : ${SOURCES.join(', ')}.`,
    tone: 'ok',
  });

  for (const m of [...model.matches].sort((a, b) => a.detectedAt - b.detectedAt).slice(-6)) {
    lines.push({
      at: m.detectedAt,
      text: `Annonce détectée — ${m.listing.district}, ${m.listing.rent_eur} €, ${m.listing.surface_m2} m².`,
      tone: 'ok',
    });
    if (m.status !== 'nouveau') {
      lines.push({
        at: m.contactedAt,
        text: `Message envoyé à ${m.listing.agency}.`,
        tone: 'ok',
      });
    }
    if (m.repliedAt) {
      lines.push({
        at: m.repliedAt,
        text: `Réponse de ${m.listing.agency} — créneaux reçus.`,
        tone: 'action',
      });
    }
  }

  const scanned = model.poolSize || 0;
  lines.push({
    at: now,
    text: `${scanned.toLocaleString('fr-FR')} annonces surveillées en continu à ${city}.`,
    tone: 'pulse',
  });

  return lines.filter((l) => l.at <= now).sort((a, b) => b.at - a.at);
}

/* -------------------------------------------------------------------------
 * Relative time - "détecté il y a 4 min"
 * ------------------------------------------------------------------------- */
export function ago(ms, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'hier' : `il y a ${days} jours`;
}

export { formatDate, formatTime };
