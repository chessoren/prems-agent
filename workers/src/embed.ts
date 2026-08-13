/**
 * Embeddings and duplicate links: the enrichment pass.
 *
 * Runs after ingestion rather than inside it, and on its own schedule, because
 * both jobs here are expensive in a way scraping is not. An embedding costs a
 * Vertex call; recomputing one for a listing whose price moved by ten euros
 * would be paying real money for nothing. The scraper's content_hash already
 * decides what actually changed - this pass only looks at what it flagged.
 *
 * text-multilingual-embedding-002, 768 dimensions, verified against the live
 * endpoint. The corpus is French: text-embedding-004 is trained mostly on
 * English and would be the wrong tool sold as the newer one.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db, logEvent } from './db.js';

const LOCATION = 'europe-west9';
const MODEL = 'text-multilingual-embedding-002';
const BATCH = 25;

function serviceAccount(): { client_email: string; private_key: string; token_uri: string; project_id: string } {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  const inline = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (inline) return JSON.parse(inline);
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS ou GCP_SERVICE_ACCOUNT_JSON requis');
}

/**
 * A Vertex access token.
 *
 * On Cloud Run the metadata server hands one over directly, which is why the
 * job carries no key file. The signed-JWT path exists only for running this
 * locally against the same project.
 */
async function accessToken(): Promise<string> {
  const metadata =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  try {
    const r = await fetch(metadata, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) return ((await r.json()) as { access_token: string }).access_token;
  } catch {
    /* not on Cloud Run - fall through to the key */
  }

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error('authentification Vertex échouée');
  return j.access_token;
}

export async function embedTexts(texts: readonly string[], project: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const token = await accessToken();
  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // RETRIEVAL_DOCUMENT is the right task type: these are the things being
    // searched over, not the query. Using the default would quietly cost recall.
    body: JSON.stringify({
      instances: texts.map((content) => ({ content, task_type: 'RETRIEVAL_DOCUMENT' })),
    }),
  });
  if (!response.ok) throw new Error(`Vertex: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);

  const body = (await response.json()) as {
    predictions?: Array<{ embeddings?: { values?: number[] } }>;
  };
  return (body.predictions ?? []).map((p) => p.embeddings?.values ?? []);
}

/**
 * What a listing means, as one string.
 *
 * The description alone is unreliable - agencies pad it with boilerplate about
 * their own agency - so the structured facts lead. A client writing "lumineux,
 * proche métro, calme" should match on the description, but never at the cost
 * of the facts that make it the right apartment.
 */
function embeddingText(row: Record<string, unknown>): string {
  const parts = [
    row.property_type,
    row.rooms ? `${row.rooms} pièces` : null,
    row.surface_m2 ? `${row.surface_m2} m²` : null,
    row.city,
    row.district,
    row.furnished ? 'meublé' : 'non meublé',
    row.floor != null ? `étage ${row.floor}` : null,
    row.has_elevator ? 'ascenseur' : null,
    row.has_balcony ? 'balcon' : null,
    row.has_terrace ? 'terrasse' : null,
    row.dpe ? `DPE ${row.dpe}` : null,
    row.title,
    typeof row.description === 'string' ? row.description.slice(0, 1500) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export async function backfillEmbeddings(project: string, limit = 200): Promise<number> {
  const client = db();

  // Ask the database which listings lack an embedding rather than fetching a
  // page and filtering it here. The earlier version took the first N listings
  // and skipped the embedded ones, so once those N were done it returned
  // nothing forever while most of the catalogue stayed unembedded - a backfill
  // that reported success and did nothing.
  const { data: wanted } = await client.rpc('listings_needing_embedding', { want: limit });
  const ids = (wanted ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return 0;

  const { data: rows } = await client
    .from('listings')
    .select('id, property_type, rooms, surface_m2, city, district, furnished, floor, has_elevator, has_balcony, has_terrace, dpe, title, description')
    .in('id', ids);
  if (!rows?.length) return 0;

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const vectors = await embedTexts(slice.map((r) => embeddingText(r)), project);
    const payload = slice
      .map((row, index) => ({ row, vector: vectors[index] }))
      .filter((p) => p.vector && p.vector.length > 0)
      .map((p) => ({ listing_id: p.row.id as string, embedding: p.vector as number[], model: MODEL }));

    if (payload.length) {
      const { error } = await client.from('listing_embeddings').upsert(payload, { onConflict: 'listing_id' });
      if (!error) written += payload.length;
    }
  }
  return written;
}

/**
 * Record duplicates rather than delete them.
 *
 * The same flat reaching us twice is two rows with two URLs and possibly two
 * contact routes - and the one we can actually apply through may not be the one
 * we saw first. The oldest becomes canonical because it is the one whose
 * freshness score is honest.
 */
export async function linkDuplicates(): Promise<number> {
  const client = db();
  const { data } = await client.rpc('link_duplicate_listings');
  const linked = typeof data === 'number' ? data : 0;
  if (linked > 0) {
    await logEvent({ type: 'listings.duplicates_linked', payload: { linked } });
  }
  return linked;
}
