/**
 * Bien'ici.
 *
 * The site's own front end calls `realEstateAds.json` with a single JSON blob
 * in a query parameter. It is unauthenticated, returns fully structured data,
 * and - the part that matters - accepts `sortBy: publicationDate`. That turns
 * "find what is new" into "read the top of the list until you reach what you
 * already have", which is the cheapest possible incremental crawl.
 *
 * Two behaviours were established by probing the live API rather than assumed,
 * and both shape the code below.
 *
 * 1. **Zone filters are silently ignored.** Passing `postalCodes` returns the
 *    same national total and results outside the requested list. There is no
 *    error - the filter simply does nothing. So zones are applied here, after
 *    the fetch, and the crawl reads more than it keeps. Anything that trusted
 *    the filter would quietly scrape the wrong country.
 * 2. **The corpus is agency CMS feeds.** Listing ids look like
 *    `immo-facile-61331072` and `netty-company39587uxo-appt-3768`: Bien'ici
 *    aggregates Immo-Facile, Netty and others. One source therefore reaches
 *    hundreds of agencies, and the CMS name is worth keeping - it is how we
 *    will later find the same agency's own site.
 */

import type { EnergyRating, GeoPrecision, PropertyType } from '@prems/core';
import type { FetchOptions, FetchResult, ScrapedListing, SourceAdapter } from './types.js';
import { inZones } from './types.js';

const ENDPOINT = 'https://www.bienici.com/realEstateAds.json';
const PAGE_SIZE = 100;

/** Sent because the endpoint is a front-end API and behaves better as one. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bienici.com/',
  Accept: 'application/json',
  'Accept-Language': 'fr-FR,fr;q=0.9',
} as const;

interface BienIciAd {
  id?: string;
  title?: string;
  description?: string;
  propertyType?: string;
  roomsQuantity?: number;
  bedroomsQuantity?: number;
  surfaceArea?: number;
  price?: number;
  rentWithoutCharges?: number;
  charges?: number;
  safetyDeposit?: number;
  agencyRentalFee?: number;
  isFurnished?: boolean;
  floor?: number;
  hasElevator?: boolean;
  hasBalcony?: boolean;
  hasTerrace?: boolean;
  hasCellar?: boolean;
  parkingPlacesQuantity?: number;
  energyClassification?: string;
  greenhouseGazClassification?: string;
  availableDate?: string;
  city?: string;
  postalCode?: string;
  district?: { name?: string };
  blurInfo?: { position?: { lat?: number; lon?: number }; type?: string };
  accountDisplayName?: string;
  customerId?: string;
  adCreatedByPro?: boolean;
  photos?: Array<{ url?: string }>;
  publicationDate?: string;
  modificationDate?: string;
}

const PROPERTY_TYPES: Readonly<Record<string, PropertyType>> = {
  flat: 'flat',
  house: 'house',
  loft: 'flat',
  townhouse: 'house',
};

function energy(value: string | undefined): EnergyRating | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return 'ABCDEFG'.includes(upper) && upper.length === 1 ? (upper as EnergyRating) : null;
}

/**
 * How much to trust the coordinates.
 *
 * Bien'ici publishes a `blurInfo` disc rather than a point for most listings.
 * Recording that as an exact position would let a client who asked for one
 * street be matched against something 500 m away.
 */
function precision(ad: BienIciAd): GeoPrecision | null {
  if (!ad.blurInfo?.position) return null;
  return ad.blurInfo.type === 'disk' ? 'blurred' : 'exact';
}

/**
 * Rent and charges, reconciled.
 *
 * `price` is sometimes the total and sometimes the rent excluding charges, and
 * the two other fields are inconsistently present. Preferring the explicit pair
 * and falling back to `price` is what keeps a budget comparison honest - the
 * schema stores both and derives the total.
 */
function money(ad: BienIciAd): { rentEur: number; chargesEur: number } | null {
  const charges = Math.max(0, Math.round(ad.charges ?? 0));
  const withoutCharges = ad.rentWithoutCharges ?? null;
  const price = ad.price ?? null;

  if (withoutCharges !== null && withoutCharges > 0) {
    return { rentEur: Math.round(withoutCharges), chargesEur: charges };
  }
  if (price !== null && price > 0) {
    // `price` here includes charges when charges are known, so subtract them
    // back out rather than double-counting in `total_rent_eur`.
    const base = charges > 0 && price > charges ? price - charges : price;
    return { rentEur: Math.round(base), chargesEur: charges };
  }
  return null;
}

function normalise(ad: BienIciAd): ScrapedListing | null {
  const externalId = ad.id;
  if (!externalId) return null;

  const amounts = money(ad);
  if (!amounts) return null; // A listing with no price cannot be matched on budget.

  const position = ad.blurInfo?.position;

  return {
    externalId,
    url: `https://www.bienici.com/annonce/location/${encodeURIComponent(externalId)}`,
    title: ad.title ?? null,
    description: ad.description ?? null,
    propertyType: PROPERTY_TYPES[ad.propertyType ?? ''] ?? 'other',
    rooms: ad.roomsQuantity ?? null,
    bedrooms: ad.bedroomsQuantity ?? null,
    surfaceM2: ad.surfaceArea ?? null,
    rentEur: amounts.rentEur,
    chargesEur: amounts.chargesEur,
    depositEur: ad.safetyDeposit != null ? Math.round(ad.safetyDeposit) : null,
    agencyFeesEur: ad.agencyRentalFee != null ? Math.round(ad.agencyRentalFee) : null,
    furnished: ad.isFurnished ?? null,
    floor: ad.floor ?? null,
    hasElevator: ad.hasElevator ?? null,
    hasBalcony: ad.hasBalcony ?? null,
    hasTerrace: ad.hasTerrace ?? null,
    hasParking: ad.parkingPlacesQuantity != null ? ad.parkingPlacesQuantity > 0 : null,
    hasCellar: ad.hasCellar ?? null,
    dpe: energy(ad.energyClassification),
    ges: energy(ad.greenhouseGazClassification),
    availableFrom: ad.availableDate ? ad.availableDate.slice(0, 10) : null,
    // Bien'ici never publishes a street for a blurred listing. The address is
    // reconstructed from what it does give, and the geocoder does the rest.
    addressRaw: [ad.district?.name, ad.postalCode, ad.city].filter(Boolean).join(' ') || null,
    street: null,
    postcode: ad.postalCode ?? null,
    city: ad.city ?? null,
    latitude: position?.lat ?? null,
    longitude: position?.lon ?? null,
    geoPrecision: precision(ad),
    agencyName: ad.accountDisplayName ?? null,
    agencyExternalId: ad.customerId ?? null,
    isProfessional: ad.adCreatedByPro ?? null,
    photos: (ad.photos ?? []).map((p) => p.url).filter((u): u is string => Boolean(u)),
    publishedAt: ad.publicationDate ?? null,
    raw: ad,
  };
}

export const bienici: SourceAdapter = {
  slug: 'bienici',

  async fetchRecent(options: FetchOptions): Promise<FetchResult> {
    const listings: ScrapedListing[] = [];
    let requests = 0;
    let from = 0;

    // Read down the list, newest first, and stop at the watermark. The page
    // cap is the safety net: a null or corrupted watermark must not turn one
    // poll into a crawl of a million listings.
    const maxPages = Math.ceil(options.maxListings / PAGE_SIZE);

    for (let page = 0; page < maxPages; page += 1) {
      const filters = {
        size: PAGE_SIZE,
        from,
        filterType: 'rent',
        propertyType: ['flat', 'house'],
        sortBy: 'publicationDate',
        sortOrder: 'desc',
      };

      const url = `${ENDPOINT}?filters=${encodeURIComponent(JSON.stringify(filters))}`;
      const response = await fetch(url, { headers: HEADERS, signal: options.signal });
      requests += 1;

      if (!response.ok) {
        throw new Error(`bienici: HTTP ${response.status} sur la page ${page + 1}`);
      }

      const body = (await response.json()) as { realEstateAds?: BienIciAd[] };
      const ads = body.realEstateAds ?? [];
      if (ads.length === 0) break;

      let reachedWatermark = false;

      for (const ad of ads) {
        const published = ad.publicationDate ? Date.parse(ad.publicationDate) : NaN;
        if (options.since && Number.isFinite(published) && published <= options.since.getTime()) {
          reachedWatermark = true;
          break;
        }

        const listing = normalise(ad);
        // Zones are applied here because the API's own filter does nothing.
        if (listing && inZones(listing.postcode, options.zones)) listings.push(listing);
      }

      if (reachedWatermark || ads.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    return { listings, requests };
  },
};

export { normalise as normaliseBienIciAd };
