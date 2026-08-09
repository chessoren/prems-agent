/**
 * The Supabase client, created once and only when it is actually needed.
 *
 * Two deliberate properties:
 *
 * - It never throws on a missing configuration. `client()` returns null, and
 *   every caller has a local fallback. An onboarding flow that white-screens
 *   because an env var is absent is worse than one that quietly keeps the
 *   answers on the device.
 * - Only PUBLIC_* values are read, so nothing secret can reach the bundle. The
 *   publishable key is meant to be public; RLS is what protects the data.
 */
import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.PUBLIC_SUPABASE_URL;
const KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

let instance;

export function client() {
  if (instance !== undefined) return instance;

  if (!URL || !KEY) {
    instance = null;
    return instance;
  }

  instance = createClient(URL, KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'prems.auth',
    },
  });
  return instance;
}

export const isConfigured = () => Boolean(URL && KEY);

/**
 * Sign in without any credential.
 *
 * This is what makes screen 5 work while SMS is switched off: the visitor gets
 * a real auth.uid(), so RLS applies and the answers are genuinely theirs rather
 * than parked in localStorage. When Twilio is connected, the same account is
 * upgraded in place with `updateUser({ phone })` - the visitor is not asked to
 * start over, and nothing already uploaded is orphaned.
 */
export async function ensureSession() {
  const supabase = client();
  if (!supabase) return null;

  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;

  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.warn('[prems] session anonyme indisponible :', error.message);
    return null;
  }
  return created.session;
}
