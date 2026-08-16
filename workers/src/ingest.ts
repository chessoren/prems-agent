/**
 * Ingestion: everything between "an adapter returned listings" and "the row is
 * in the database and the event log knows about it".
 *
 * Shared by every source, so an adapter never has to think about geocoding,
 * dedup hashes, upsert semantics or the run log.
 *
 * The ordering matters and is not arbitrary: the listing is written first, and
 * enrichment that depends on a network call happens around it rather than
 * before it. A geocoder outage must cost us a coordinate, never a listing.
 */

import { dedupHash } from '@prems/core';
import { createHash } from 'node:crypto';
import { db, logEvent } from './db.js';
import { geocode } from './geocode.js';
import type { ScrapedListing } from './adapters/types.js';

export interface IngestResult {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

/**
 * A cheap "has anything actually changed" fingerprint.
 *
 * Most polls re-see listings that have not moved. Comparing this before writing
 * turns the common case into one UPDATE of `last_seen_at` instead of a full row
 * rewrite plus a re-embedding that would cost real money at Vertex prices.
 */
function contentHash(listing: ScrapedListing): string {
  return createHash('sha256')
    .update(
      [
        listing.rentEur,
        listing.chargesEur,
        listing.surfaceM2 ?? '',
        listing.rooms ?? '',
        listing.availableFrom ?? '',
        listing.description?.length ?? 0,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * Geocode, but only when it buys something.
 *
 * A listing that already carries an exact position needs nothing. One with a
 * blurred disc still benefits, because BAN returns the INSEE code the zone
 * filters key on - which no amount of coordinates would have given us.
 */
async function enrich(
  listing: ScrapedListing,
  signal: AbortSignal,
): Promise<{
  latitude: number | null;
  longitude: number | null;
  precision: string | null;
  street: string | null;
  inseeCode: string | null;
}> {
  const fallback = {
    latitude: listing.latitude,
    longitude: listing.longitude,
    precision: listing.geoPrecision,
    street: listing.street,
    inseeCode: null as string | null,
  };

  if (!listing.addressRaw) return fallback;

  const result = await geocode(listing.addressRaw, {
    postcode: listing.postcode,
    signal,
  });
  if (!result) return fallback;

  // Keep the site's own coordinates when they are exact - it knows where the
  // building is better than a geocoder reading a district name does.
  const keepOwn = listing.geoPrecision === 'exact' && listing.latitude !== null;

  return {
    latitude: keepOwn ? listing.latitude : result.latitude,
    longitude: keepOwn ? listing.longitude : result.longitude,
    precision: keepOwn ? listing.geoPrecision : result.precision,
    street: listing.street ?? result.street,
    inseeCode: result.inseeCode,
  };
}

/**
 * How many listings are enriched at once.
 *
 * The first run took 144 seconds for 204 listings against a 60 second poll
 * interval - runs would have overlapped before the source was ever deployed.
 * Almost all of that was waiting on one BAN request at a time.
 *
 * Eight is chosen to be quick without being rude: BAN is a free public service
 * run by the French state, and hammering it is both impolite and the fastest
 * way to be rate-limited off it.
 */
const ENRICH_CONCURRENCY = 8;

/** Run `worker` over `items`, at most `limit` at a time, preserving nothing. */
async function pooled<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
}

export async function ingest(
  sourceId: string,
  sourceSlug: string,
  listings: readonly ScrapedListing[],
  signal: AbortSignal,
): Promise<IngestResult> {
  const client = db();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Which of these do we already have? One query rather than one per listing.
  const externalIds = listings.map((l) => l.externalId);
  const { data: existingRows } = await client
    .from('listings')
    .select('id, external_id, content_hash')
    .eq('source_id', sourceId)
    .in('external_id', externalIds.slice(0, 1000));

  const existing = new Map((existingRows ?? []).map((r) => [r.external_id as string, r]));

  await pooled(listings, ENRICH_CONCURRENCY, async (listing) => {
    const hash = contentHash(listing);
    const previous = existing.get(listing.externalId);

    if (previous && previous.content_hash === hash) {
      // Unchanged. Touch the freshness marker and move on - this is how a
      // listing stays alive without being rewritten on every poll.
      await client
        .from('listings')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', previous.id);
      skipped += 1;
      return;
    }

    const geo = await enrich(listing, signal);

    const row = {
      source_id: sourceId,
      external_id: listing.externalId,
      url: listing.url,
      title: listing.title,
      description: listing.description,
      property_type: listing.propertyType,
      rooms: listing.rooms,
      bedrooms: listing.bedrooms,
      surface_m2: listing.surfaceM2,
      rent_eur: listing.rentEur,
      charges_eur: listing.chargesEur,
      deposit_eur: listing.depositEur,
      agency_fees_eur: listing.agencyFeesEur,
      furnished: listing.furnished,
      floor: listing.floor,
      has_elevator: listing.hasElevator,
      has_balcony: listing.hasBalcony,
      has_terrace: listing.hasTerrace,
      has_parking: listing.hasParking,
      has_cellar: listing.hasCellar,
      dpe: listing.dpe,
      ges: listing.ges,
      available_from: listing.availableFrom,
      address_raw: listing.addressRaw,
      street: geo.street,
      postcode: listing.postcode,
      city: listing.city,
      insee_code: geo.inseeCode,
      district: null,
      geo:
        geo.latitude !== null && geo.longitude !== null
          ? `SRID=4326;POINT(${geo.longitude} ${geo.latitude})`
          : null,
      geo_precision: geo.precision,
      agency_name: listing.agencyName,
      agency_external_id: listing.agencyExternalId,
      is_professional: listing.isProfessional,
      photos: listing.photos,
      published_at: listing.publishedAt,
      last_seen_at: new Date().toISOString(),
      status: 'active',
      dedup_hash: dedupHash({
        postcode: listing.postcode,
        street: geo.street,
        surfaceM2: listing.surfaceM2,
        totalRentEur: listing.rentEur + listing.chargesEur,
        rooms: listing.rooms,
      }),
      content_hash: hash,
      raw: listing.raw as Record<string, unknown>,
    };

    // `onConflict` on (source_id, external_id) is what makes a re-run of the
    // same poll idempotent - the constraint, not the code, is the guarantee.
    const { data, error } = await client
      .from('listings')
      .upsert(row, { onConflict: 'source_id,external_id' })
      .select('id')
      .single();

    if (error) {
      skipped += 1;
      return;
    }

    if (previous) {
      updated += 1;
    } else {
      inserted += 1;
      // Only genuinely new listings are announced. An event per re-seen
      // listing would drown the log that the interface is going to read.
      await logEvent({
        type: 'listing.discovered',
        subjectType: 'listing',
        subjectId: data.id as string,
        payload: {
          source: sourceSlug,
          city: listing.city,
          postcode: listing.postcode,
          rent: listing.rentEur + listing.chargesEur,
          surface: listing.surfaceM2,
          rooms: listing.rooms,
          url: listing.url,
        },
      });
    }
  });

  return { inserted, updated, skipped };
}
