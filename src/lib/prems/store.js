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
    const { error: searchError } = await supabase.from('searches').insert({
      user_id: uid,
      city: state.city,
      city_slug: state.citySlug,
      budget_max_eur: state.budget,
      property_type: state.propertyType || 'appartement',
      rooms: state.rooms,
      move_in_date: state.moveInAsap ? null : state.moveInDate,
      move_in_asap: state.moveInAsap,
    });
    if (searchError) console.warn('[prems] recherche non enregistrée :', searchError.message);
  }

  return true;
}
