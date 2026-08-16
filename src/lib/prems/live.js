/**
 * What the agent actually did, read from the database.
 *
 * This replaces a projection. Until now the app computed its own feed from the
 * demo catalogue and a clock derived from each listing's id: statuses,
 * timings, agency replies and message threads were all deterministic fiction,
 * because the front end was built before the tables existed. They exist now -
 * `matches`, `applications`, `application_replies`, `calendar_events`, all
 * under RLS and all written by workers that run whether or not anyone has the
 * site open.
 *
 * The shape returned here is the one the four tabs already consume, so nothing
 * above this file had to change. What changed is that every field is now a
 * fact somebody can be held to.
 *
 * Security note: there is no `user_id` filter in any query below, and that is
 * deliberate. Every table is under row-level security scoped to `auth.uid()`,
 * so the filter is applied by Postgres and cannot be forgotten here. A filter
 * written in the browser would be a second, weaker copy of a rule that already
 * exists in the only place it can be enforced.
 */
import { client, ensureSession } from './supabase.js';

/**
 * A listing is only readable through a match that belongs to you.
 *
 * Direct reads of `listings` return zero rows by design - the catalogue is the
 * asset. The join is what RLS lets through.
 */
const SELECT = `
  id, score, status, skipped_reason, created_at, score_breakdown,
  listings (
    id, title, city, district, street, postcode, property_type, rooms,
    surface_m2, rent_eur, charges_eur, total_rent_eur, dpe, furnished,
    photos, url, agency_name, published_at, first_seen_at
  )
`;

/** The card's accent colour. Decorative, and stable per listing. */
function hue(id) {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/** Rows come back nested; the UI speaks one flat listing. */
function toListing(row) {
  return {
    id: row.id,
    title: row.title,
    city: row.city,
    district: row.district,
    street: row.street,
    postcode: row.postcode,
    property_type: row.property_type,
    rooms: row.rooms,
    surface_m2: row.surface_m2 == null ? null : Number(row.surface_m2),
    rent_eur: row.rent_eur,
    charges_eur: row.charges_eur,
    total_rent_eur: row.total_rent_eur,
    dpe: row.dpe,
    furnished: row.furnished,
    photos: row.photos ?? [],
    url: row.url,
    agency: row.agency_name,
    hue: hue(row.id),
  };
}

const time = (value) => (value ? Date.parse(value) : null);

/**
 * The lifecycle, as the interface names it.
 *
 * Derived from what exists rather than stored twice: an application that has
 * left is `contact_envoye`, a reply offering a visit is `creneaux_proposes`, a
 * calendar entry is a confirmed visit until it is in the past. Storing a status
 * alongside these rows would give us two answers that can disagree, and the
 * stored one would be the one that is wrong.
 */
function lifecycle({ match, application, replies, visit }, now) {
  if (match.status === 'skipped') return 'ecarte';

  const refused = replies.some((r) => r.classified_as === 'refused');
  if (refused) return 'refuse';

  if (visit) {
    const starts = time(visit.starts_at);
    return starts && starts > now ? 'visite_confirmee' : 'visite_passee';
  }

  if (replies.some((r) => r.classified_as === 'visit_offered')) return 'creneaux_proposes';
  if (replies.length > 0) return 'reponse_recue';

  if (application?.sent_at) return 'contact_envoye';
  if (application) return 'contact_en_cours';

  return 'nouveau';
}

/**
 * Everything the four tabs need, in one pass.
 *
 * Four queries rather than one join: the tabs read different tables, and a
 * single nested select would make a failure in the least important of them -
 * the calendar, say - able to empty the home screen.
 */
export async function load(now = Date.now()) {
  const supabase = client();
  if (!supabase) return null;

  try {
    const session = await ensureSession();
    if (!session) return null;

    const [matchRes, appRes, replyRes, visitRes] = await Promise.all([
      supabase.from('matches').select(SELECT).order('created_at', { ascending: false }).limit(200),
      supabase
        .from('applications')
        .select('id, match_id, listing_id, status, subject, body, sent_at, created_at, to_email, dead_letter, dead_letter_reason')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('application_replies')
        .select('id, application_id, received_at, from_address, subject, body, classified_as')
        .order('received_at', { ascending: true })
        .limit(400),
      supabase
        .from('calendar_events')
        .select('id, listing_id, application_id, title, location, starts_at, ends_at, google_event_id')
        .order('starts_at', { ascending: true })
        .limit(100),
    ]);

    const matches = matchRes.data ?? [];
    if (matchRes.error) return null;

    const applications = appRes.data ?? [];
    const allReplies = replyRes.data ?? [];
    const visits = visitRes.data ?? [];

    const appByMatch = new Map(applications.map((a) => [a.match_id, a]));
    const repliesByApp = new Map();
    for (const reply of allReplies) {
      const list = repliesByApp.get(reply.application_id) ?? [];
      list.push(reply);
      repliesByApp.set(reply.application_id, list);
    }
    const visitByListing = new Map(visits.map((v) => [v.listing_id, v]));

    const projected = matches
      .filter((row) => row.listings)
      // A client's own second search finding the same flat is recorded, not
      // shown: they already have it through the search that scored higher.
      .filter((row) => row.skipped_reason !== 'duplicate_of_your_other_search')
      .map((row) => {
        const listing = toListing(row.listings);
        const application = appByMatch.get(row.id) ?? null;
        const replies = application ? (repliesByApp.get(application.id) ?? []) : [];
        const visit = visitByListing.get(listing.id) ?? null;

        return {
          id: listing.id,
          matchId: row.id,
          listing,
          score: Math.round(Number(row.score) * 100),
          breakdown: row.score_breakdown ?? null,
          detectedAt: time(row.created_at) ?? time(row.listings.first_seen_at),
          contactedAt: time(application?.sent_at),
          repliedAt: time(replies[0]?.received_at),
          slots: [],
          visitAt: time(visit?.starts_at),
          visit,
          application,
          replies,
          status: lifecycle({ match: row, application, replies, visit }, now),
          skippedReason: row.skipped_reason ?? null,
        };
      })
      .sort((a, b) => b.score - a.score || (b.detectedAt ?? 0) - (a.detectedAt ?? 0));

    return {
      matches: projected,
      visits: projected.filter((m) => m.visitAt),
      threads: projected.filter((m) => m.application),
      counts: {
        visites: projected.filter(
          (m) => m.status === 'creneaux_proposes' || m.status === 'visite_confirmee',
        ).length,
        messages: projected.filter((m) => m.replies.length > 0).length,
      },
    };
  } catch {
    // A read failure must not blank the app; the caller keeps what it had.
    return null;
  }
}

/**
 * Push the whole feed when anything the workers write changes.
 *
 * The pipeline runs on its own schedule and the person may be looking at the
 * screen when a match lands. `events` is published in Realtime for exactly
 * this, and re-reading is cheaper to reason about than patching a local copy
 * from a change payload.
 */
export function watch(onChange) {
  const supabase = client();
  if (!supabase) return () => {};

  const channel = supabase
    .channel('prems-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events' }, onChange)
    .subscribe();

  return () => supabase.removeChannel(channel);
}
