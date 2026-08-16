/**
 * These tests are about behaviour the product depends on, not coverage.
 *
 * Each one states a rule that, if it broke, would be invisible in a screenshot
 * and expensive in production: applying to something out of budget, ranking a
 * stale listing above a fresh one, or merging two different apartments.
 */
import { describe, expect, it } from 'vitest';
import { cosineSimilarity, dedupHash, normaliseAddress } from '../src/dedup.js';
import { hardFilter, scoreMatch } from '../src/match.js';
import type { Listing, SearchCriteria } from '../src/types.js';

const NOW = new Date('2026-08-10T12:00:00Z');

function listing(overrides: Partial<Listing> = {}): Listing {
  const rent = overrides.rentEur ?? 1000;
  const charges = overrides.chargesEur ?? 100;
  return {
    id: 'l1',
    sourceId: 's1',
    externalId: 'x1',
    url: 'https://example.test/1',
    title: 'Appartement',
    description: null,
    propertyType: 'flat',
    rooms: 2,
    surfaceM2: 40,
    rentEur: rent,
    chargesEur: charges,
    totalRentEur: rent + charges,
    furnished: false,
    floor: 3,
    hasElevator: true,
    hasBalcony: null,
    hasTerrace: null,
    hasParking: null,
    hasCellar: null,
    dpe: 'C',
    availableFrom: '2026-09-01',
    postcode: '75011',
    citySlug: 'paris',
    inseeCode: '75111',
    geoPrecision: 'street',
    publishedAt: NOW.toISOString(),
    firstSeenAt: NOW.toISOString(),
    ...overrides,
  };
}

function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    id: 'c1',
    userId: 'u1',
    active: true,
    budgetMinEur: null,
    budgetMaxEur: 1200,
    surfaceMinM2: 30,
    surfaceMaxM2: null,
    roomsMin: 2,
    roomsMax: null,
    propertyTypes: [],
    furnished: null,
    zones: [],
    dpeMax: null,
    mustHave: [],
    moveInDate: null,
    moveInAsap: true,
    minScore: 0.55,
    maxApplicationsPerDay: 15,
    ...overrides,
  };
}

describe('hardFilter', () => {
  it('compares the budget against rent plus charges, not rent alone', () => {
    // 1150 + 100 is over a 1200 ceiling even though the headline rent is under.
    // Sites publish whichever of the two flatters them, so this is the single
    // most likely way to apply to something the client cannot afford.
    const result = hardFilter(listing({ rentEur: 1150, chargesEur: 100 }), criteria());
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('over_budget');
  });

  it('lets an unknown surface through', () => {
    // The site's silence is not the apartment's fault; the score penalises it.
    expect(hardFilter(listing({ surfaceM2: null }), criteria()).passed).toBe(true);
  });

  it('reads a two-character zone as a department', () => {
    const inParis = hardFilter(listing(), criteria({ zones: ['75'] }));
    const inLyon = hardFilter(
      listing({ postcode: '69003', inseeCode: '69383' }),
      criteria({ zones: ['75'] }),
    );
    expect(inParis.passed).toBe(true);
    expect(inLyon.reasons).toContain('wrong_zone');
  });

  it('allows a month of slack on the availability date', () => {
    const soon = criteria({ moveInAsap: false, moveInDate: '2026-09-01' });
    expect(hardFilter(listing({ availableFrom: '2026-09-20' }), soon).passed).toBe(true);
    expect(hardFilter(listing({ availableFrom: '2026-11-15' }), soon).reasons).toContain(
      'available_too_late',
    );
  });

  it('collects every reason rather than stopping at the first', () => {
    const result = hardFilter(
      listing({ rentEur: 3000, surfaceM2: 9, rooms: 1 }),
      criteria({ roomsMin: 3 }),
    );
    expect(result.reasons.length).toBeGreaterThan(2);
  });
});

describe('scoreMatch', () => {
  it('ranks a fresh listing above an identical stale one', () => {
    // The entire product rests on this ordering.
    const fresh = scoreMatch(listing(), criteria(), { now: NOW });
    const stale = scoreMatch(
      listing({ publishedAt: '2026-08-09T12:00:00Z', firstSeenAt: '2026-08-09T12:00:00Z' }),
      criteria(),
      { now: NOW },
    );
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it('halves the freshness component every ninety minutes', () => {
    const older = new Date(NOW.getTime() + 90 * 60_000);
    const { breakdown } = scoreMatch(listing(), criteria(), { now: older });
    expect(breakdown.freshness).toBeCloseTo(0.5, 2);
  });

  it('redistributes the semantic weight instead of scoring a missing one as zero', () => {
    // A client who wrote no free text must still be able to reach a high score,
    // or minScore quietly stops meaning what it says.
    const withoutText = scoreMatch(listing(), criteria(), { now: NOW });
    const withPerfectText = scoreMatch(listing(), criteria(), { now: NOW, semanticScore: 1 });
    expect(withoutText.score).toBeGreaterThan(0.7);
    expect(withPerfectText.score).toBeGreaterThan(withoutText.score);
  });

  it('prefers the cheaper of two otherwise identical listings', () => {
    const cheap = scoreMatch(listing({ rentEur: 700 }), criteria(), { now: NOW });
    const dear = scoreMatch(listing({ rentEur: 1050 }), criteria(), { now: NOW });
    expect(cheap.score).toBeGreaterThan(dear.score);
  });

  it('keeps the score inside [0, 1] whatever the inputs', () => {
    const absurd = scoreMatch(listing({ rentEur: 0, chargesEur: 0, surfaceM2: 5000 }), criteria(), {
      now: NOW,
      semanticScore: 42,
    });
    expect(absurd.score).toBeGreaterThanOrEqual(0);
    expect(absurd.score).toBeLessThanOrEqual(1);
  });
});

describe('dedup', () => {
  it('normalises the abbreviations French sites disagree about', () => {
    expect(normaliseAddress('12 Bd Saint-Germain')).toBe(normaliseAddress('12 boulevard st germain'));
  });

  it('treats small price and surface differences as the same apartment', () => {
    const base = { postcode: '75011', street: '10 rue Oberkampf', rooms: 2 };
    const a = dedupHash({ ...base, surfaceM2: 40.4, totalRentEur: 1102 });
    const b = dedupHash({ ...base, surfaceM2: 40, totalRentEur: 1098 });
    expect(a).toBe(b);
  });

  it('keeps genuinely different apartments apart', () => {
    const base = { postcode: '75011', street: '10 rue Oberkampf', rooms: 2 };
    const a = dedupHash({ ...base, surfaceM2: 40, totalRentEur: 1100 });
    const b = dedupHash({ ...base, surfaceM2: 62, totalRentEur: 1100 });
    expect(a).not.toBe(b);
  });

  it('refuses to hash when there is not enough to identify anything', () => {
    // A false merge loses an apartment the client could have had, which is
    // strictly worse than carrying a duplicate.
    expect(dedupHash({ postcode: null, street: null, surfaceM2: null, totalRentEur: 1100, rooms: 2 }))
      .toBeNull();
  });

  it('computes cosine similarity and survives degenerate vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe('budget curve', () => {
  it('still rewards a bargain over a listing at the ceiling', () => {
    const bargain = scoreMatch(listing({ rentEur: 500, chargesEur: 0 }), criteria(), { now: NOW });
    const atCeiling = scoreMatch(listing({ rentEur: 1200, chargesEur: 0 }), criteria(), { now: NOW });
    expect(bargain.breakdown.budget).toBe(1);
    expect(atCeiling.breakdown.budget).toBeCloseTo(0.5, 2);
    expect(bargain.score).toBeGreaterThan(atCeiling.score);
  });

  it('does not let an affordable flat fall below the default minScore', () => {
    // The regression that motivated the curve: a listing at the budget ceiling
    // is affordable by definition, and must not be filtered out for it.
    const atCeiling = scoreMatch(listing({ rentEur: 1200, chargesEur: 0 }), criteria(), { now: NOW });
    expect(atCeiling.score).toBeGreaterThan(criteria().minScore);
  });
});
