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
 * English and would be the wrong tool sold as the newer one. The model is named
 * in `agent.ts` with every other model, so there is one file to read to know
 * what this system runs on.
 *
 * The call goes through the GenAI SDK. What that removed is forty lines that
 * signed a JWT by hand and exchanged it for a token — the third copy of the
 * same forty lines in this directory. Authentication is Application Default
 * Credentials now, which is what Cloud Run already hands the container.
 *
 * One capability went with them: `GCP_SERVICE_ACCOUNT_JSON`, a key pasted
 * inline into the environment. Nothing referenced it, and the replacement for
 * running this locally is `gcloud auth application-default login` — a path that
 * does not involve a private key sitting in a shell history.
 */
import { createHash } from 'node:crypto';
import { EMBEDDING_MODEL, genai } from './agent.js';
import { db, logEvent } from './db.js';

const BATCH = 25;

/**
 * `RETRIEVAL_DOCUMENT` for the things being searched over, `RETRIEVAL_QUERY`
 * for what someone is searching with. The pair is asymmetric by design in this
 * model family, and using one where the other belongs costs recall without
 * costing an error.
 */
type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export async function embedTexts(
  texts: readonly string[],
  project: string,
  taskType: TaskType = 'RETRIEVAL_DOCUMENT',
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await genai(project).models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [...texts],
    config: { taskType },
  });

  // One vector per input, in order. A short array here would silently pair a
  // listing with somebody else's embedding, so the caller checks the length.
  return (response.embeddings ?? []).map((e) => e.values ?? []);
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
      .map((p) => ({ listing_id: p.row.id as string, embedding: p.vector as number[], model: EMBEDDING_MODEL }));

    if (payload.length) {
      const { error } = await client.from('listing_embeddings').upsert(payload, { onConflict: 'listing_id' });
      if (!error) written += payload.length;
    }
  }
  return written;
}

/**
 * The other half of the semantic score, which never existed.
 *
 * `semantic_score` compares a listing's embedding to
 * `searches.free_text_embedding`. Nothing wrote that column - not this worker,
 * not the onboarding - so the 15% semantic term was null for every match ever
 * scored. Null is handled gracefully: the weight is redistributed over the
 * other terms. That is exactly why it went unnoticed for the whole build. No
 * error, no zero, no missing row - just a quarter of the ranking that had
 * quietly been switched off.
 *
 * It has cost nothing so far because no client has written free text yet. The
 * day one does is the day it would have started costing silently.
 */
export async function backfillSearchEmbeddings(project: string, limit = 50): Promise<number> {
  const client = db();

  const { data: wanted } = await client.rpc('searches_needing_embedding', { want: limit });
  const rows = (wanted ?? []) as Array<{ id: string; free_text: string }>;
  if (rows.length === 0) return 0;

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const vectors = await embedTexts(
      slice.map((r) => r.free_text),
      project,
      'RETRIEVAL_QUERY',
    );

    for (const [index, row] of slice.entries()) {
      const vector = vectors[index];
      if (!vector?.length) continue;
      // The hash, not a timestamp: `searches_touch` bumps `updated_at` on this
      // very write, so a time-based cursor would re-embed the same row every
      // run for ever. See 0012.
      const { error } = await client
        .from('searches')
        .update({
          free_text_embedding: vector,
          free_text_embedded_hash: createHash('md5').update(row.free_text).digest('hex'),
        })
        .eq('id', row.id);
      if (!error) written += 1;
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
