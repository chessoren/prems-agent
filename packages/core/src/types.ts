/**
 * The domain, as the database sees it.
 *
 * These types are hand-written rather than generated from the schema, and that
 * is a deliberate trade. Generated types describe every column of every table,
 * including the ones only the pipeline touches; what the matching code needs is
 * a much smaller vocabulary, stated once. When the schema and this file
 * disagree, the tests in `test/` are what notices.
 *
 * Money is integer euros everywhere. Surfaces are square metres and may be
 * fractional. Nothing here is optional-by-accident: a field is nullable only
 * where the sites themselves routinely omit it, which is most of them.
 */

export type PropertyType = 'flat' | 'house' | 'studio' | 'other';

export type EnergyRating = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** How much to trust a listing's coordinates. Many sites blur on purpose. */
export type GeoPrecision = 'exact' | 'street' | 'district' | 'city' | 'blurred';

/** How we can apply. A source that offers none of these cannot ship. */
export type ContactChannel = 'form_post' | 'email' | 'none';

export type SourceKind = 'portal' | 'agency_cms' | 'agency';

export interface Source {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly adapter: string;
  readonly baseUrl: string;
  readonly contactChannel: ContactChannel;
  readonly enabled: boolean;
  readonly pollIntervalSeconds: number;
  readonly rateLimitRpm: number;
  readonly requiresProxy: boolean;
}

/**
 * A listing as the matcher reads it.
 *
 * `totalRentEur` is the number every budget comparison uses. Sites disagree on
 * whether the headline price includes charges, so the raw pair is kept and the
 * total is what the rest of the system trusts.
 */
export interface Listing {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly url: string;

  readonly title: string | null;
  readonly description: string | null;
  readonly propertyType: PropertyType;
  readonly rooms: number | null;
  readonly surfaceM2: number | null;

  readonly rentEur: number;
  readonly chargesEur: number;
  readonly totalRentEur: number;

  readonly furnished: boolean | null;
  readonly floor: number | null;
  readonly hasElevator: boolean | null;
  readonly hasBalcony: boolean | null;
  readonly hasTerrace: boolean | null;
  readonly hasParking: boolean | null;
  readonly hasCellar: boolean | null;
  readonly dpe: EnergyRating | null;

  readonly availableFrom: string | null;

  readonly postcode: string | null;
  readonly citySlug: string | null;
  readonly inseeCode: string | null;
  readonly geoPrecision: GeoPrecision | null;

  readonly publishedAt: string | null;
  readonly firstSeenAt: string;
}

/**
 * What a client is looking for.
 *
 * `zones` holds INSEE or postcode strings because that is what the sites
 * themselves filter on - keeping the criteria in the sites' own vocabulary is
 * what lets a zone be pushed into the scrape query rather than filtered after.
 */
export interface SearchCriteria {
  readonly id: string;
  readonly userId: string;
  readonly active: boolean;

  readonly budgetMinEur: number | null;
  readonly budgetMaxEur: number;
  readonly surfaceMinM2: number | null;
  readonly surfaceMaxM2: number | null;
  readonly roomsMin: number | null;
  readonly roomsMax: number | null;
  readonly propertyTypes: readonly PropertyType[];
  readonly furnished: boolean | null;
  readonly zones: readonly string[];
  readonly dpeMax: EnergyRating | null;
  readonly mustHave: readonly Feature[];
  readonly moveInDate: string | null;
  readonly moveInAsap: boolean;

  readonly minScore: number;
  readonly maxApplicationsPerDay: number;
}

export type Feature = 'elevator' | 'balcony' | 'terrace' | 'parking' | 'cellar' | 'furnished';

/** Why a listing was rejected, in the client's own terms rather than a boolean. */
export type RejectionReason =
  | 'over_budget'
  | 'under_budget'
  | 'too_small'
  | 'too_large'
  | 'wrong_rooms'
  | 'wrong_type'
  | 'wrong_zone'
  | 'furnishing_mismatch'
  | 'energy_rating'
  | 'missing_feature'
  | 'available_too_late';

export interface HardFilterResult {
  readonly passed: boolean;
  readonly reasons: readonly RejectionReason[];
}

/**
 * A score, and every component that produced it.
 *
 * The breakdown is stored on the match row. A client asking "why this flat?"
 * deserves an answer, and a weighting that turns out to be wrong has to be
 * diagnosable after the fact rather than re-derived from memory.
 */
export interface ScoreBreakdown {
  readonly budget: number;
  readonly surface: number;
  readonly rooms: number;
  readonly freshness: number;
  readonly features: number;
  readonly energy: number;
  readonly semantic: number | null;
}

export interface MatchScore {
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}
