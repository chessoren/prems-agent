/**
 * Generate the demo inventory and load it into Supabase.
 *
 *   npm run db:seed
 *
 * ~100 listings per city, so that any (city, rooms, budget, date) combination a
 * visitor can express on screens 1-4 still returns a full set of matches. The
 * generator is seeded, so the same catalogue comes out every run - a listing a
 * user saw yesterday is still there today.
 *
 * It also writes public/data/listings.json. That file is the offline fallback:
 * if Supabase is unreachable the "aha moment" still works, which matters
 * because it is the one screen that must never fail.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, require_, ROOT } from './env.mjs';
import { CITIES, AGENCIES, FEATURES } from './cities.mjs';

const PER_CITY = 100;

/** Deterministic PRNG - same catalogue on every run. */
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260809);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (min, max) => min + Math.floor(rnd() * (max - min + 1));

/** Surface envelope per room count, in m². */
const SURFACE = {
  1: [16, 33],
  2: [28, 50],
  3: [45, 74],
  4: [64, 98],
  5: [85, 130],
};

/** Rooms are not uniformly distributed on the rental market. */
const ROOM_WEIGHTS = [
  [1, 0.26],
  [2, 0.32],
  [3, 0.24],
  [4, 0.13],
  [5, 0.05],
];

const DPE_WEIGHTS = [
  ['B', 0.05],
  ['C', 0.19],
  ['D', 0.32],
  ['E', 0.26],
  ['F', 0.13],
  ['G', 0.05],
];

function weighted(pairs) {
  let roll = rnd();
  for (const [value, weight] of pairs) {
    if (roll < weight) return value;
    roll -= weight;
  }
  return pairs[pairs.length - 1][0];
}

function propertyType(rooms, furnished) {
  if (rooms === 1) return 'studio';
  if (rooms >= 4 && rnd() < 0.22) return 'maison';
  if (rooms >= 3 && furnished && rnd() < 0.18) return 'colocation';
  return 'appartement';
}

/** Dates spread over the next four months, biased towards "soon". */
function availableFrom(today) {
  const skew = rnd() ** 1.7; // more listings available in the next few weeks
  const date = new Date(today);
  date.setDate(date.getDate() + Math.floor(skew * 120));
  return date.toISOString().slice(0, 10);
}

function buildListings() {
  const today = new Date();
  const out = [];

  for (const city of CITIES) {
    for (let i = 0; i < PER_CITY; i++) {
      const [districtIndex, [district, streets]] = [
        Math.floor(rnd() * city.districts.length),
        city.districts[Math.floor(rnd() * city.districts.length)],
      ];
      const rooms = weighted(ROOM_WEIGHTS);
      const [minM2, maxM2] = SURFACE[rooms];
      const surface = between(minM2, maxM2);
      const furnished = rnd() < 0.42;

      // Rent follows the city's €/m², nudged by furnishing, energy rating and a
      // per-listing spread. Small surfaces rent for more per m² than large ones,
      // which is what keeps studio prices believable.
      const dpe = weighted(DPE_WEIGHTS);
      const smallSurfacePremium = 1 + Math.max(0, (40 - surface) / 40) * 0.22;
      const furnishedPremium = furnished ? 1.12 : 1;
      const energyDiscount = 'ABCDEFG'.indexOf(dpe) >= 4 ? 0.94 : 1;
      const spread = 0.88 + rnd() * 0.26;

      const rent = Math.round(
        (city.eurPerM2 * surface * smallSurfacePremium * furnishedPremium * energyDiscount * spread) /
          10,
      ) * 10;

      const featureCount = between(2, 5);
      const features = [...new Set(Array.from({ length: featureCount }, () => pick(FEATURES)))];

      out.push({
        city: city.name,
        city_slug: city.slug,
        district,
        street: `${between(1, 180)} ${pick(streets)}`,
        property_type: propertyType(rooms, furnished),
        rooms,
        surface_m2: surface,
        rent_eur: rent,
        charges_eur: Math.round((surface * (rnd() * 1.6 + 1.1)) / 5) * 5,
        floor: rnd() < 0.12 ? 0 : between(1, 7),
        dpe,
        furnished,
        available_from: availableFrom(today),
        features,
        agency: pick(AGENCIES),
        // Drives the procedural preview artwork, so a given district always
        // reads with the same colour family across the grid.
        hue: (districtIndex * 37 + city.slug.length * 11) % 360,
      });
    }
  }
  return out;
}

async function upload(listings, env) {
  const url = require_(env, 'PUBLIC_SUPABASE_URL');
  const key = require_(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };

  // `demo_listings` throughout. This function deletes its whole target table
  // before writing, and since 0002 the name `listings` belongs to the scraped
  // catalogue - pointing this at it would wipe production every time someone
  // regenerated the demo data.
  //
  // Replace wholesale: the generator is deterministic, so re-seeding should
  // converge on exactly one copy of the catalogue rather than stack duplicates.
  const wipe = await fetch(`${url}/rest/v1/demo_listings?id=not.is.null`, {
    method: 'DELETE',
    headers,
  });
  if (!wipe.ok) throw new Error(`purge -> HTTP ${wipe.status}\n${await wipe.text()}`);

  const BATCH = 200;
  for (let i = 0; i < listings.length; i += BATCH) {
    const batch = listings.slice(i, i + BATCH);
    const res = await fetch(`${url}/rest/v1/demo_listings`, {
      method: 'POST',
      headers: { ...headers, prefer: 'return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`insert -> HTTP ${res.status}\n${(await res.text()).slice(0, 500)}`);
    process.stdout.write(`\r  chargées : ${Math.min(i + BATCH, listings.length)}/${listings.length}`);
  }
  process.stdout.write('\n');
}

const env = loadEnv();
const listings = buildListings();

mkdirSync(resolve(ROOT, 'public/data'), { recursive: true });
writeFileSync(resolve(ROOT, 'public/data/listings.json'), JSON.stringify(listings));
console.log(`${listings.length} annonces générées sur ${CITIES.length} villes`);
console.log('public/data/listings.json écrit (repli hors-ligne)');

await upload(listings, env);
console.log('Catalogue chargé dans Supabase.');
