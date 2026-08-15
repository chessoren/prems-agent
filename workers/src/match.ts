/**
 * The matcher.
 *
 * Runs per listing, not per client. That direction is the whole architecture:
 * one scrape serves everybody, and a new listing asks "who wants this?" rather
 * than every client asking "is there anything new?". It is what keeps cost
 * O(listings) instead of O(clients x listings).
 *
 * The eligibility query, the priority order and the caps all live in SQL - see
 * 0005_matching.sql. This decides how many of the eligible clients are actually
 * served, scores them, and writes the record.
 */
import { scoreMatch, type Listing, type SearchCriteria } from '@prems/core';
import { db, logEvent } from './db.js';

interface Eligible {
  search_id: string;
  user_id: string;
  priority: number;
  active_applications: number;
}

/** Rows come back snake_case; the scorer speaks the domain. */
function toListing(r: Record<string, any>): Listing {
  return {
    id: r.id, sourceId: r.source_id, externalId: r.external_id, url: r.url,
    title: r.title, description: r.description, propertyType: r.property_type,
    rooms: r.rooms, surfaceM2: r.surface_m2 == null ? null : Number(r.surface_m2),
    rentEur: r.rent_eur, chargesEur: r.charges_eur, totalRentEur: r.total_rent_eur,
    furnished: r.furnished, floor: r.floor, hasElevator: r.has_elevator,
    hasBalcony: r.has_balcony, hasTerrace: r.has_terrace, hasParking: r.has_parking,
    hasCellar: r.has_cellar, dpe: r.dpe, availableFrom: r.available_from,
    postcode: r.postcode, citySlug: r.city_slug, inseeCode: r.insee_code,
    geoPrecision: r.geo_precision, publishedAt: r.published_at, firstSeenAt: r.first_seen_at,
  };
}

function toCriteria(r: Record<string, any>): SearchCriteria {
  return {
    id: r.id, userId: r.user_id, active: r.active,
    budgetMinEur: r.budget_min_eur, budgetMaxEur: r.budget_max_eur,
    surfaceMinM2: r.surface_min_m2 == null ? null : Number(r.surface_min_m2),
    surfaceMaxM2: r.surface_max_m2 == null ? null : Number(r.surface_max_m2),
    roomsMin: r.rooms_min, roomsMax: r.rooms_max,
    propertyTypes: r.property_types ?? [], furnished: r.furnished,
    zones: r.zones ?? [], dpeMax: r.dpe_max, mustHave: r.must_have ?? [],
    moveInDate: r.move_in_date, moveInAsap: r.move_in_asap,
    minScore: Number(r.min_score), maxApplicationsPerDay: r.max_applications_per_day,
  };
}

/**
 * One row per client, not per search.
 *
 * A client holding two active searches produced two candidate rows with the
 * same user and the same priority. The old cut took the first and told the
 * second that a higher-priority *client* had been served - false, and shown to
 * the client. Measured on live data before the fix: 86 of 147 skips were a
 * client losing to themselves.
 *
 * The subtler cost was in the cap. `applications_per_listing` counts rows, and
 * a client's rows are adjacent because their priority is identical - so at a
 * cap of 2, one client with two searches took both slots and starved the
 * rotation the cap exists to create.
 *
 * Their own best-scoring search wins: that is the criteria the flat actually
 * fits. Order is otherwise preserved, because `eligible_clients` already
 * returned it by priority and that ordering is the fairness guarantee.
 */
export function collapsePerClient<T extends { c: { user_id: string }; score: number }>(
  scored: readonly T[],
): { served: T[]; alsoRan: T[] } {
  const best = new Map<string, T>();
  const order: string[] = [];
  const alsoRan: T[] = [];

  for (const s of scored) {
    const held = best.get(s.c.user_id);
    if (!held) {
      best.set(s.c.user_id, s);
      order.push(s.c.user_id);
    } else if (s.score > held.score) {
      best.set(s.c.user_id, s);
      alsoRan.push(held);
    } else {
      alsoRan.push(s);
    }
  }

  return { served: order.map((u) => best.get(u)!), alsoRan };
}

/**
 * Match one listing. Returns how many clients were served.
 *
 * Clients below their own `min_score` are dropped before the cut, so relevance
 * gates fairness rather than competing with it: a mediocre fit can never take
 * an apartment that is somebody else's excellent one.
 */
export async function matchListing(listingId: string, now = new Date()): Promise<number> {
  const client = db();

  const { data: listingRow } = await client.from('listings').select('*').eq('id', listingId).single();
  if (!listingRow) return 0;

  // Mark it considered up front, whatever the outcome. A listing nobody is
  // eligible for produces no match rows, and without this it would return to
  // the queue on every run and keep the newest listings waiting behind it.
  const markConsidered = () =>
    client.from('listings').update({ matched_at: new Date().toISOString() }).eq('id', listingId);
  const listing = toListing(listingRow);

  const { data: eligible } = await client.rpc('eligible_clients', { p_listing_id: listingId });
  const candidates = (eligible ?? []) as Eligible[];
  if (candidates.length === 0) {
    await markConsidered();
    return 0;
  }

  const { data: searchRows } = await client
    .from('searches').select('*').in('id', candidates.map((c) => c.search_id));
  const searches = new Map((searchRows ?? []).map((s) => [s.id as string, s]));

  const scored: Array<{ c: Eligible; score: number; breakdown: unknown }> = [];
  for (const candidate of candidates) {
    const row = searches.get(candidate.search_id);
    if (!row) continue;
    const criteria = toCriteria(row);

    const { data: semantic } = await client.rpc('semantic_score', {
      p_listing_id: listingId,
      p_search_id: candidate.search_id,
    });

    const result = scoreMatch(listing, criteria, {
      now,
      semanticScore: typeof semantic === 'number' ? semantic : null,
    });
    if (result.score < criteria.minScore) continue;
    scored.push({ c: candidate, score: result.score, breakdown: result.breakdown });
  }

  // Every remaining client is recorded as a candidate, in priority order, and
  // nobody is cut here. The per-listing cap is spent at queue time instead -
  // see 0012. The scarce thing is an application, not a match row, and cutting
  // against a send that has not happened is what burned 61 runners-up for
  // applications that were never made.
  const { served, alsoRan } = collapsePerClient(scored);

  for (const s of served) {
    const { data: match } = await client
      .from('matches')
      .upsert({
        search_id: s.c.search_id, user_id: s.c.user_id, listing_id: listingId,
        score: s.score, score_breakdown: s.breakdown as Record<string, unknown>,
        // Cleared explicitly. An upsert that sets `status` and leaves
        // `skipped_reason` alone turns a previously-skipped row into a `new`
        // one still carrying "somebody else was served" - seven rows in the
        // live table were in exactly that state, left over from the era before
        // 0006 when the same listing could be matched twice.
        status: 'new', skipped_reason: null,
      }, { onConflict: 'search_id,listing_id' })
      .select('id').single();

    await logEvent({
      userId: s.c.user_id, type: 'match.created', subjectType: 'match',
      subjectId: match?.id as string,
      payload: { listing_id: listingId, score: s.score, priority: s.c.priority, url: listing.url },
    });
  }

  // A client's own second search, recorded rather than dropped: "why is this
  // flat listed twice?" has an answer, and the row keeps the score that search
  // would have given it.
  for (const s of alsoRan) {
    await client.from('matches').upsert({
      search_id: s.c.search_id, user_id: s.c.user_id, listing_id: listingId,
      score: s.score, score_breakdown: s.breakdown as Record<string, unknown>,
      status: 'skipped', skipped_reason: 'duplicate_of_your_other_search',
    }, { onConflict: 'search_id,listing_id' });
  }

  await markConsidered();
  return served.length;
}

/** Match everything that has never been matched. */
export async function matchPending(limit = 200): Promise<{ listings: number; matches: number }> {
  const client = db();
  const { data } = await client.rpc('listings_needing_match', { want: limit });
  const ids = (data ?? []).map((r: { id: string }) => r.id);
  let matches = 0;
  for (const id of ids) matches += await matchListing(id);
  return { listings: ids.length, matches };
}
