/**
 * The database, from a worker's side.
 *
 * Workers hold the service role and therefore bypass every RLS policy. That is
 * the point - the pipeline writes tables no browser may even read - and it is
 * also why this module is the only place the key is touched.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} manquant dans l'environnement`);
  return value;
}

let instance: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (instance) return instance;
  instance = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return instance;
}

/**
 * Append to the event log.
 *
 * Never awaited by callers on the critical path and never allowed to throw: the
 * log describes the work, it does not gate it. Losing one line is acceptable;
 * failing a scrape because the log was briefly unavailable is not.
 */
export async function logEvent(event: {
  userId?: string | null;
  type: string;
  subjectType?: 'listing' | 'match' | 'application' | 'search' | 'source' | 'reply';
  subjectId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db()
      .from('events')
      .insert({
        user_id: event.userId ?? null,
        type: event.type,
        subject_type: event.subjectType ?? null,
        subject_id: event.subjectId ?? null,
        payload: event.payload ?? {},
      });
  } catch {
    /* see above */
  }
}
