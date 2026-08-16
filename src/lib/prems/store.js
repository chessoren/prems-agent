/**
 * The onboarding draft.
 *
 * Screens 1-4 are answered before any account exists, so the answers have to
 * live somewhere that survives a refresh but requires no identity. They are
 * kept on the device and flushed to Supabase the moment a session appears on
 * screen 5. Nothing is lost if the visitor drops out and comes back.
 *
 * The draft is also the single source of truth for resuming: reload mid-flow
 * and you land on the screen you left, with your answers still in the fields.
 */
import { client, ensureSession } from './supabase.js';

const KEY = 'prems.onboarding.v1';

const EMPTY = {
  step: 'hook',
  city: null,
  citySlug: null,
  postcode: null,
  budget: 1000,
  propertyType: null,
  rooms: null,
  moveInDate: null,
  moveInAsap: false,
  phone: null,
  employment: null,
  incomeCents: null,
  needsGuarantor: false,
  guarantorName: null,
  guarantorRelation: null,
  guarantorIncomeCents: null,
  firstName: null,
  lastName: null,
  birthDate: null,
  idType: null,
  idNumber: null,
  addressProofType: null,
  addressProofName: null,
  matchCount: 0,
  completedAt: null,
};

let state = load();

function load() {
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
    /* private browsing, quota - the flow still works for this session */
  }
}

export const get = () => state;

export function set(patch) {
  state = { ...state, ...patch };
  persist();
  return state;
}

export function reset() {
  state = { ...EMPTY };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Monthly income in euros, or null. Stored in cents to keep the ratio exact. */
export const incomeEuros = () =>
  state.incomeCents == null ? null : Math.round(state.incomeCents / 100);

/**
 * Push the draft to Supabase. Called once a session exists, and again whenever
 * a later screen adds something worth keeping.
 *
 * Failures are logged, never surfaced: a network blip must not block someone
 * from reaching the next question. The draft stays on the device either way,
 * so a later flush picks up whatever this one missed.
 */
export async function sync() {
  const supabase = client();
  if (!supabase) return false;

  const session = await ensureSession();
  if (!session) return false;
  const uid = session.user.id;

  const profile = {
    id: uid,
    phone: state.phone,
    first_name: state.firstName,
    last_name: state.lastName,
    birth_date: state.birthDate,
    id_document_type: state.idType,
    id_document_number: state.idNumber,
    employment_status: state.employment,
    monthly_income_cents: state.incomeCents,
    needs_guarantor: state.needsGuarantor,
    guarantor_name: state.guarantorName,
    guarantor_relation: state.guarantorRelation,
    guarantor_income_cents: state.guarantorIncomeCents,
    completed_at: state.completedAt,
  };

  const { error } = await supabase.from('profiles').upsert(profile, { onConflict: 'id' });
  if (error) {
    console.warn('[prems] profil non synchronisé :', error.message);
    return false;
  }

  if (state.citySlug && state.rooms) {
    const row = { user_id: uid, ...criteria() };

    // Update the existing search rather than adding one.
    //
    // This used to insert unconditionally, and `sync()` is called on several
    // screens - so completing the flow left two or three identical searches on
    // the same account. In production that produced 493 duplicate matches: the
    // same apartment found twice by the same person, competing against itself
    // for the per-listing cap.
    const { data: existing } = await supabase
      .from('searches')
      .select('id')
      .eq('user_id', uid)
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const { error: searchError } = existing?.id
      ? await supabase.from('searches').update(row).eq('id', existing.id)
      : await supabase.from('searches').insert(row);

    if (searchError) console.warn('[prems] recherche non enregistrée :', searchError.message);
  }

  return true;
}

/**
 * The draft, translated into what the matcher actually reads.
 *
 * These are two different vocabularies and nobody had joined them, so until
 * now only the budget crossed over. The flow collected a city, a room count
 * and a property type; the matcher reads `zones`, `rooms_min` / `rooms_max`
 * and `property_types`, and found all three empty. Measured on the live
 * account that asked for *Paris, 4 pièces*: the top matches were
 * Rueil-Malmaison 2 pièces and Saint-Germain-en-Laye 1 pièce.
 *
 * `hardFilter` skips a criterion entirely when its field is empty, which is
 * why this failed silently instead of returning nothing.
 */
export function criteria() {
  return {
    city: state.city,
    city_slug: state.citySlug,
    budget_max_eur: state.budget,
    property_type: state.propertyType || 'appartement',
    rooms: state.rooms,
    move_in_date: state.moveInAsap ? null : state.moveInDate,
    move_in_asap: state.moveInAsap,
    zones: zones(),
    ...roomBounds(),
    property_types: propertyTypes(),
  };
}

/**
 * Where to search, as the matcher understands it.
 *
 * A two-character zone is read as a department and a five-character one as an
 * exact postcode. The department is the right unit here: the flow captures one
 * postcode per commune, and matching it exactly would keep Paris 15e out of a
 * search for "Paris" (75001), and two thirds of Rennes out of a search for
 * Rennes. Erring wide costs a few irrelevant matches, which the score pushes
 * down; erring narrow costs the apartment, silently.
 */
function zones() {
  const postcode = state.postcode ? String(state.postcode).replace(/\D/g, '') : '';
  return postcode.length >= 2 ? [postcode.slice(0, 2)] : [];
}

/**
 * "T4 et plus" is the only open-ended option on the screen, so it is the only
 * one without an upper bound. The others promise an exact size and are held to
 * it - the score already rewards a near miss, and a hard filter that quietly
 * widens is how someone asking for a T2 ends up reading about studios.
 */
function roomBounds() {
  const rooms = Number(state.rooms);
  if (!Number.isFinite(rooms) || rooms <= 0) return { rooms_min: null, rooms_max: null };
  return rooms >= 4
    ? { rooms_min: 4, rooms_max: null }
    : { rooms_min: rooms, rooms_max: rooms };
}

/** The flow says studio/appartement/indifferent; the catalogue says flat/house. */
function propertyTypes() {
  switch (state.propertyType) {
    case 'studio':
    case 'appartement':
      return ['flat'];
    // "T4 et plus" is announced as "grand appartement ou maison", so it must
    // not exclude houses.
    default:
      return [];
  }
}
