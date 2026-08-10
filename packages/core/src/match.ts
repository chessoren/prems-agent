/**
 * Matching: the hard filter, then the score.
 *
 * Two stages, in this order, for a reason that is about cost rather than
 * elegance. The hard filter is pure arithmetic over indexed columns and throws
 * away the overwhelming majority of pairs; the score is only ever computed for
 * what survives, and the embedding comparison only for what the score keeps.
 * Inverting that order would mean embedding every listing against every client.
 *
 * Everything here is a pure function of its arguments - no clock, no database,
 * no network. `now` is passed in because freshness decays with time and a test
 * that cannot fix the clock cannot test freshness at all.
 */

import type {
  EnergyRating,
  Feature,
  HardFilterResult,
  Listing,
  MatchScore,
  RejectionReason,
  ScoreBreakdown,
  SearchCriteria,
} from './types.js';

const ENERGY_ORDER: readonly EnergyRating[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

/**
 * Weights, stated once.
 *
 * Freshness carries more than any single comfort criterion, and that is the
 * product's whole thesis: against a flat that is a slightly better fit but four
 * hours old, the one posted a minute ago is the one the client can still get.
 * A perfect match nobody can reach is worth nothing.
 */
const WEIGHTS = {
  budget: 0.2,
  surface: 0.13,
  rooms: 0.1,
  freshness: 0.27,
  features: 0.1,
  energy: 0.05,
  semantic: 0.15,
} as const;

/** Freshness reaches half its value at this age. */
const FRESHNESS_HALF_LIFE_MINUTES = 90;

function featureOf(listing: Listing, feature: Feature): boolean | null {
  switch (feature) {
    case 'elevator':
      return listing.hasElevator;
    case 'balcony':
      return listing.hasBalcony;
    case 'terrace':
      return listing.hasTerrace;
    case 'parking':
      return listing.hasParking;
    case 'cellar':
      return listing.hasCellar;
    case 'furnished':
      return listing.furnished;
  }
}

/**
 * The cheap pass. Everything here is a fact, not a preference: failing any of
 * it means the listing is not a candidate at all.
 *
 * Unknown values pass. A site that omits the surface should not cost the client
 * the apartment - the score below is where an unknown is penalised, gently.
 */
export function hardFilter(listing: Listing, criteria: SearchCriteria): HardFilterResult {
  const reasons: RejectionReason[] = [];

  if (listing.totalRentEur > criteria.budgetMaxEur) reasons.push('over_budget');
  if (criteria.budgetMinEur !== null && listing.totalRentEur < criteria.budgetMinEur) {
    reasons.push('under_budget');
  }

  if (listing.surfaceM2 !== null) {
    if (criteria.surfaceMinM2 !== null && listing.surfaceM2 < criteria.surfaceMinM2) {
      reasons.push('too_small');
    }
    if (criteria.surfaceMaxM2 !== null && listing.surfaceM2 > criteria.surfaceMaxM2) {
      reasons.push('too_large');
    }
  }

  if (listing.rooms !== null) {
    const belowMin = criteria.roomsMin !== null && listing.rooms < criteria.roomsMin;
    const aboveMax = criteria.roomsMax !== null && listing.rooms > criteria.roomsMax;
    if (belowMin || aboveMax) reasons.push('wrong_rooms');
  }

  if (criteria.propertyTypes.length > 0 && !criteria.propertyTypes.includes(listing.propertyType)) {
    reasons.push('wrong_type');
  }

  // A zone matches on the INSEE code or on the postcode, and a two-character
  // entry is read as a department - "75" has to mean all of Paris, because that
  // is how both clients and the sites themselves talk about it.
  if (criteria.zones.length > 0) {
    const codes = [listing.inseeCode, listing.postcode].filter((c): c is string => Boolean(c));
    const inZone =
      codes.length === 0 ||
      criteria.zones.some((zone) =>
        codes.some((code) => (zone.length === 2 ? code.startsWith(zone) : code === zone)),
      );
    if (!inZone) reasons.push('wrong_zone');
  }

  if (criteria.furnished !== null && listing.furnished !== null) {
    if (criteria.furnished !== listing.furnished) reasons.push('furnishing_mismatch');
  }

  if (criteria.dpeMax !== null && listing.dpe !== null) {
    if (ENERGY_ORDER.indexOf(listing.dpe) > ENERGY_ORDER.indexOf(criteria.dpeMax)) {
      reasons.push('energy_rating');
    }
  }

  for (const feature of criteria.mustHave) {
    if (featureOf(listing, feature) === false) {
      reasons.push('missing_feature');
      break;
    }
  }

  // Availability is a hard fact when both dates are known, with a month of
  // slack: agencies routinely publish a date they then negotiate.
  if (!criteria.moveInAsap && criteria.moveInDate !== null && listing.availableFrom !== null) {
    const wanted = Date.parse(criteria.moveInDate);
    const available = Date.parse(listing.availableFrom);
    if (Number.isFinite(wanted) && Number.isFinite(available)) {
      const slackMs = 31 * 24 * 60 * 60 * 1000;
      if (available > wanted + slackMs) reasons.push('available_too_late');
    }
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * Headroom against the budget. Paying less is genuinely better, but only up to
 * a point.
 *
 * The first version of this decayed linearly to zero at the ceiling, which
 * scored a listing at 92% of budget at 0.08 and dragged its total below
 * `minScore`. That is wrong: the hard filter has already established the flat
 * is affordable, and something a client can afford is not nearly-worthless
 * because it is not also a bargain. The curve now saturates at half the budget
 * and still awards 0.5 at the ceiling.
 */
function budgetScore(listing: Listing, criteria: SearchCriteria): number {
  if (criteria.budgetMaxEur <= 0) return 0;
  const ratio = listing.totalRentEur / criteria.budgetMaxEur;
  return clamp01(1.5 - ratio);
}

/**
 * Surface, relative to what was asked for.
 *
 * Bigger than the minimum is better, with diminishing returns: 40 m² when 30
 * were asked is a real win, 90 m² is not three times the win. An unknown
 * surface scores neutral rather than zero - the site's silence is not the
 * apartment's fault.
 */
function surfaceScore(listing: Listing, criteria: SearchCriteria): number {
  if (listing.surfaceM2 === null) return 0.5;
  const floor = criteria.surfaceMinM2 ?? 0;
  if (floor <= 0) return 0.6;
  const excess = (listing.surfaceM2 - floor) / floor;
  return clamp01(0.5 + Math.tanh(Math.max(excess, 0) * 1.5) * 0.5);
}

function roomsScore(listing: Listing, criteria: SearchCriteria): number {
  if (listing.rooms === null) return 0.5;
  const target = criteria.roomsMin ?? listing.rooms;
  const delta = Math.abs(listing.rooms - target);
  return clamp01(1 - delta * 0.25);
}

/**
 * Freshness: exponential decay from publication.
 *
 * This is the number that encodes the product. A listing with no publication
 * date falls back to when we first saw it, which for a working scraper is
 * within a poll interval of the truth.
 */
function freshnessScore(listing: Listing, now: Date): number {
  const stamp = listing.publishedAt ?? listing.firstSeenAt;
  const published = Date.parse(stamp);
  if (!Number.isFinite(published)) return 0.5;
  const ageMinutes = (now.getTime() - published) / 60_000;
  if (ageMinutes <= 0) return 1;
  return clamp01(Math.pow(0.5, ageMinutes / FRESHNESS_HALF_LIFE_MINUTES));
}

/**
 * Features the client did not demand but would like.
 *
 * Only `mustHave` entries are counted, and only as a bonus - the hard filter
 * has already removed anything that definitively lacks one. What is scored here
 * is the difference between "confirmed present" and "not stated", because a
 * site that does not mention a lift usually has no lift.
 */
function featureScore(listing: Listing, criteria: SearchCriteria): number {
  if (criteria.mustHave.length === 0) return 0.7;
  let total = 0;
  for (const feature of criteria.mustHave) {
    const value = featureOf(listing, feature);
    total += value === true ? 1 : value === null ? 0.4 : 0;
  }
  return clamp01(total / criteria.mustHave.length);
}

function energyScore(listing: Listing): number {
  if (listing.dpe === null) return 0.5;
  const index = ENERGY_ORDER.indexOf(listing.dpe);
  return clamp01(1 - index / (ENERGY_ORDER.length - 1));
}

/**
 * The final score.
 *
 * `semanticScore` is the cosine similarity between the listing's description
 * and the client's free-text criteria, or null when either is missing. When it
 * is null its weight is redistributed over the other components rather than
 * counted as zero - otherwise every client who wrote nothing would see every
 * score capped at 0.85, and `minScore` would quietly stop meaning anything.
 */
export function scoreMatch(
  listing: Listing,
  criteria: SearchCriteria,
  options: { readonly now: Date; readonly semanticScore?: number | null },
): MatchScore {
  const semantic = options.semanticScore ?? null;

  const breakdown: ScoreBreakdown = {
    budget: budgetScore(listing, criteria),
    surface: surfaceScore(listing, criteria),
    rooms: roomsScore(listing, criteria),
    freshness: freshnessScore(listing, options.now),
    features: featureScore(listing, criteria),
    energy: energyScore(listing),
    semantic,
  };

  const parts: Array<readonly [number, number]> = [
    [breakdown.budget, WEIGHTS.budget],
    [breakdown.surface, WEIGHTS.surface],
    [breakdown.rooms, WEIGHTS.rooms],
    [breakdown.freshness, WEIGHTS.freshness],
    [breakdown.features, WEIGHTS.features],
    [breakdown.energy, WEIGHTS.energy],
  ];
  if (semantic !== null) parts.push([clamp01(semantic), WEIGHTS.semantic]);

  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  const weighted = parts.reduce((sum, [value, weight]) => sum + value * weight, 0);

  return { score: round3(weighted / totalWeight), breakdown };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { WEIGHTS, FRESHNESS_HALF_LIFE_MINUTES };
