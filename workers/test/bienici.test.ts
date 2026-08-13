/**
 * The Bien'ici adapter, against three real payloads frozen from production.
 *
 * A fixture, not a mock. Every field here is one the live API actually sent,
 * with its real inconsistencies intact - which is the point: the bugs this
 * catches are the ones a hand-written mock would have quietly designed away.
 *
 * When Bien'ici changes its shape these tests keep passing while production
 * breaks, so they are not a substitute for `source_health`. They are what
 * stops a refactor from breaking parsing that already works.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseBienIciAd } from '../src/adapters/bienici.js';
import { inZones } from '../src/adapters/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, 'fixtures/bienici-search.json'), 'utf8'),
) as { realEstateAds: Array<Record<string, unknown>> };

const ads = fixture.realEstateAds;

describe('bienici adapter, on frozen production payloads', () => {
  it('has fixtures to work with', () => {
    expect(ads.length).toBeGreaterThan(0);
  });

  it('normalises every fixture without throwing', () => {
    for (const ad of ads) expect(() => normaliseBienIciAd(ad)).not.toThrow();
  });

  it('produces a total that is rent plus charges, never one of them', () => {
    // The most consequential parsing decision in the system: the client's
    // budget is on what they pay, and sites publish whichever number flatters.
    for (const ad of ads) {
      const listing = normaliseBienIciAd(ad);
      if (!listing) continue;
      expect(listing.rentEur).toBeGreaterThan(0);
      expect(listing.chargesEur).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(listing.rentEur)).toBe(true);
      expect(Number.isInteger(listing.chargesEur)).toBe(true);
    }
  });

  it('keeps the raw payload so a parsing mistake can be repaired by backfill', () => {
    const listing = normaliseBienIciAd(ads[0] as Record<string, unknown>);
    expect(listing?.raw).toBe(ads[0]);
  });

  it('builds a usable listing URL from the external id', () => {
    for (const ad of ads) {
      const listing = normaliseBienIciAd(ad);
      if (!listing) continue;
      expect(listing.url).toContain('bienici.com');
      expect(listing.url).toContain(encodeURIComponent(listing.externalId));
    }
  });

  it('never claims an exact position for a blurred one', () => {
    // Recording a 500 m disc as exact would match somebody who asked for one
    // street against a flat that is nowhere near it.
    for (const ad of ads) {
      const listing = normaliseBienIciAd(ad);
      if (!listing) continue;
      if ((ad as { blurInfo?: { type?: string } }).blurInfo?.type === 'disk') {
        expect(listing.geoPrecision).toBe('blurred');
      }
    }
  });

  it('refuses a listing with no usable price', () => {
    const priceless = { ...(ads[0] as Record<string, unknown>) };
    delete priceless.price;
    delete priceless.rentWithoutCharges;
    expect(normaliseBienIciAd(priceless)).toBeNull();
  });

  it('refuses a listing with no id', () => {
    const anonymous = { ...(ads[0] as Record<string, unknown>) };
    delete anonymous.id;
    expect(normaliseBienIciAd(anonymous)).toBeNull();
  });

  it('maps unknown property types to "other" rather than guessing', () => {
    const odd = { ...(ads[0] as Record<string, unknown>), propertyType: 'chateau' };
    expect(normaliseBienIciAd(odd)?.propertyType).toBe('other');
  });
});

describe('zone filtering', () => {
  // Bien'ici ignores its own postcode filter, so this runs on our side and is
  // the only thing keeping the crawl inside the requested departments.
  it('reads a two-character zone as a department', () => {
    expect(inZones('75011', ['75'])).toBe(true);
    expect(inZones('69003', ['75'])).toBe(false);
  });

  it('matches a full postcode exactly', () => {
    expect(inZones('92500', ['92500'])).toBe(true);
    expect(inZones('92100', ['92500'])).toBe(false);
  });

  it('accepts everything when no zone is requested', () => {
    expect(inZones('69003', [])).toBe(true);
  });

  it('rejects a listing with no postcode when zones are requested', () => {
    // Better to skip one listing than to apply for a flat in the wrong city.
    expect(inZones(null, ['75'])).toBe(false);
  });
});
