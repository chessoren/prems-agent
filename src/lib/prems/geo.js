/**
 * City autocomplete.
 *
 * Backed by geo.api.gouv.fr - the French government's official commune
 * register. No key, no quota worth worrying about, no vendor, and it knows
 * every commune including the ones a commercial places API ranks poorly.
 * Results are boosted by population, so "sain" offers Saint-Étienne before
 * Saint-Aubin-des-Bois.
 *
 * The very first question of the flow is the worst possible place to hang on a
 * slow network, so the request is given a hard deadline and falls back to the
 * cities the inventory actually covers. A visitor on a flaky connection still
 * gets a working field; they just see fewer suggestions.
 */
const ENDPOINT = 'https://geo.api.gouv.fr/communes';
const DEADLINE_MS = 1200;

/** Cities the inventory covers, used for ranking and as the offline fallback. */
const COVERED = [
  { name: 'Paris', slug: 'paris', postcode: '75001' },
  { name: 'Marseille', slug: 'marseille', postcode: '13001' },
  { name: 'Lyon', slug: 'lyon', postcode: '69001' },
  { name: 'Toulouse', slug: 'toulouse', postcode: '31000' },
  { name: 'Nice', slug: 'nice', postcode: '06000' },
  { name: 'Nantes', slug: 'nantes', postcode: '44000' },
  { name: 'Montpellier', slug: 'montpellier', postcode: '34000' },
  { name: 'Strasbourg', slug: 'strasbourg', postcode: '67000' },
  { name: 'Bordeaux', slug: 'bordeaux', postcode: '33000' },
  { name: 'Lille', slug: 'lille', postcode: '59000' },
  { name: 'Rennes', slug: 'rennes', postcode: '35000' },
];

const COVERED_SLUGS = new Set(COVERED.map((entry) => entry.slug));

export const slugify = (name) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const cache = new Map();

/** The covered cities whose name starts with the term. Never fails. */
function localMatches(term) {
  const needle = slugify(term);
  return COVERED.filter((entry) => entry.slug.startsWith(needle)).map((entry) => ({
    ...entry,
    code: null,
    population: 0,
    covered: true,
  }));
}

export async function search(query, { signal } = {}) {
  const term = query.trim();
  if (term.length < 2) return [];
  if (cache.has(term)) return cache.get(term);

  const url =
    `${ENDPOINT}?nom=${encodeURIComponent(term)}` +
    '&fields=nom,code,codesPostaux,population&boost=population&limit=6';

  // Two reasons to give up: the caller moved on (a newer keystroke), or the
  // network is too slow to be useful. Only the first should yield nothing -
  // the second should still show the visitor something they can pick.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  const onCallerAbort = () => deadline.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const res = await fetch(url, { signal: deadline.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const results = raw.map((commune) => {
      const slug = slugify(commune.nom);
      return {
        name: commune.nom,
        slug,
        code: commune.code,
        postcode: commune.codesPostaux?.[0] ?? null,
        population: commune.population ?? 0,
        covered: COVERED_SLUGS.has(slug),
      };
    });

    cache.set(term, results);
    return results;
  } catch {
    // The caller abandoning this keystroke is the one case where showing
    // nothing is right: a newer request is already in flight.
    if (signal?.aborted) return [];
    return localMatches(term);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
