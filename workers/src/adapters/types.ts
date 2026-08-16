/**
 * What every source has to provide, and nothing more.
 *
 * The interface is deliberately one method wide. Sources differ enormously in
 * how they paginate, what they call a page, and whether they can filter at all
 * - Bien'ici silently ignores a postcode filter and returns the whole country -
 * so trying to express those differences in a shared vocabulary produces an
 * abstraction that fits nobody. Instead each adapter is handed the zones and
 * the watermark and made responsible for returning recent listings, by whatever
 * means its site allows.
 *
 * An adapter never touches the database and never geocodes. It turns one site's
 * idea of an apartment into ours, and stops.
 */

import type { EnergyRating, GeoPrecision, PropertyType } from '@prems/core';

/** A listing as an adapter produces it: normalised, but not yet enriched. */
export interface ScrapedListing {
  readonly externalId: string;
  readonly url: string;

  readonly title: string | null;
  readonly description: string | null;
  readonly propertyType: PropertyType;
  readonly rooms: number | null;
  readonly bedrooms: number | null;
  readonly surfaceM2: number | null;

  readonly rentEur: number;
  readonly chargesEur: number;
  readonly depositEur: number | null;
  readonly agencyFeesEur: number | null;

  readonly furnished: boolean | null;
  readonly floor: number | null;
  readonly hasElevator: boolean | null;
  readonly hasBalcony: boolean | null;
  readonly hasTerrace: boolean | null;
  readonly hasParking: boolean | null;
  readonly hasCellar: boolean | null;
  readonly dpe: EnergyRating | null;
  readonly ges: EnergyRating | null;

  readonly availableFrom: string | null;

  readonly addressRaw: string | null;
  readonly street: string | null;
  readonly postcode: string | null;
  readonly city: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geoPrecision: GeoPrecision | null;

  readonly agencyName: string | null;
  readonly agencyExternalId: string | null;
  readonly isProfessional: boolean | null;
  readonly photos: readonly string[];

  readonly publishedAt: string | null;

  /** The untouched payload. Normalisation is a guess; this is the evidence. */
  readonly raw: unknown;
}

export interface FetchOptions {
  /** INSEE codes, postcodes or two-character departments. */
  readonly zones: readonly string[];
  /**
   * Stop once listings are older than this. The adapter is trusted to stop
   * early rather than paginate to the end of a site with a million listings.
   */
  readonly since: Date | null;
  /** A hard ceiling, so a bad watermark cannot turn one run into a full crawl. */
  readonly maxListings: number;
  readonly signal: AbortSignal;
}

export interface FetchResult {
  readonly listings: readonly ScrapedListing[];
  /** Requests actually made, for the run log and for tuning the rate limit. */
  readonly requests: number;
}

export interface SourceAdapter {
  readonly slug: string;
  fetchRecent(options: FetchOptions): Promise<FetchResult>;
}

/** True when a postcode falls inside one of the requested zones. */
export function inZones(postcode: string | null, zones: readonly string[]): boolean {
  if (zones.length === 0) return true;
  if (!postcode) return false;
  return zones.some((zone) => (zone.length === 2 ? postcode.startsWith(zone) : postcode === zone));
}
