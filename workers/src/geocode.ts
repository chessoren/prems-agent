/**
 * Geocoding, via the Base Adresse Nationale.
 *
 * `api-adresse.data.gouv.fr` is the French state's own address database: free,
 * unauthenticated, and materially better on French addresses than any paid
 * global geocoder. It also returns the INSEE code, which is what the zone
 * filters actually key on - a paid API would have given us coordinates and
 * left us to look the code up separately.
 *
 * Every failure here is soft. A listing without coordinates is still a listing
 * the client can have; refusing to store it because a geocoder timed out would
 * be the pipeline punishing the client for someone else's outage.
 */

const ENDPOINT = 'https://api-adresse.data.gouv.fr/search/';

export interface GeocodeResult {
  readonly latitude: number;
  readonly longitude: number;
  readonly street: string | null;
  readonly postcode: string | null;
  readonly city: string | null;
  readonly inseeCode: string | null;
  readonly precision: 'exact' | 'street' | 'district' | 'city';
}

interface BanFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    type?: string;
    name?: string;
    postcode?: string;
    city?: string;
    citycode?: string;
    score?: number;
  };
}

/** BAN's result types, mapped onto how much the point can be trusted. */
const PRECISION: Readonly<Record<string, GeocodeResult['precision']>> = {
  housenumber: 'exact',
  street: 'street',
  locality: 'district',
  municipality: 'city',
};

export async function geocode(
  query: string,
  options: { readonly postcode?: string | null; readonly signal?: AbortSignal } = {},
): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return null;

  const params = new URLSearchParams({ q: trimmed, limit: '1' });
  // Postcode is a filter, not part of the query: BAN weights it properly and
  // it stops "12 rue de la Paix" resolving to the wrong town.
  if (options.postcode) params.set('postcode', options.postcode);

  try {
    const response = await fetch(`${ENDPOINT}?${params}`, {
      headers: { Accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { features?: BanFeature[] };
    const feature = body.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!feature || !coordinates) return null;

    const properties = feature.properties ?? {};

    // A weak match is worse than none: it puts a listing in the wrong place
    // with full confidence, and the matcher has no way to tell.
    if ((properties.score ?? 0) < 0.4) return null;

    return {
      longitude: coordinates[0],
      latitude: coordinates[1],
      street: properties.name ?? null,
      postcode: properties.postcode ?? null,
      city: properties.city ?? null,
      inseeCode: properties.citycode ?? null,
      precision: PRECISION[properties.type ?? ''] ?? 'city',
    };
  } catch {
    return null;
  }
}
