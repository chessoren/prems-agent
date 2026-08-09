/**
 * Funnel instrumentation.
 *
 * One question per screen only pays off if you can see which question people
 * stop on. Every screen view, completion, skip and back-step is recorded
 * against a client-side session id, so the drop-off is measurable for
 * anonymous visitors too - which is most of them, on the screens that matter.
 *
 * Writes are fire-and-forget and insert-only: the table has no select policy,
 * so nothing here can read the funnel back out through the public API.
 */
import { client } from './supabase.js';

const KEY = 'prems.funnel.session';

function sessionId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const queue = [];
let flushing = false;

async function flush() {
  if (flushing || !queue.length) return;
  const supabase = client();
  if (!supabase) {
    queue.length = 0;
    return;
  }

  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    await supabase.from('funnel_events').insert(batch);
  } catch {
    /* analytics must never interrupt the flow */
  } finally {
    flushing = false;
    if (queue.length) flush();
  }
}

export function track(step, event = 'view') {
  queue.push({ session_id: sessionId(), step, event });
  // Batch within a tick so a screen change does not fire three round-trips.
  setTimeout(flush, 400);
}
