/**
 * The scrape entrypoint.
 *
 * One process, one source, one run. Cloud Scheduler decides when; this decides
 * what. Which source is chosen by `SOURCE_SLUG`, so the same image serves every
 * adapter and adding a source is a row in `sources` plus a scheduler job, not a
 * new deployment.
 *
 * The run is recorded before it starts and closed however it ends. A scraper
 * that fails silently is the most expensive failure in this system - the site
 * keeps working, the client keeps paying, and nothing arrives - so the failure
 * path is written with the same care as the success path.
 */

import { modelBanner } from './agent.js';
import { ADAPTERS } from './adapters/registry.js';
import { db, logEvent } from './db.js';
import { backfillEmbeddings, backfillSearchEmbeddings, linkDuplicates } from './embed.js';
import { ingest } from './ingest.js';
import { matchPending } from './match.js';
import { closeLostMatches, queueApplications, sendDue, sendOutbox } from './apply.js';
import { watchAllInboxes } from './inbox.js';
import { runDemoLoop } from './demo.js';
import { resolveAgencies } from './agency.js';

/** A run must not outlive its schedule, or two of them overlap. */
const RUN_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Enrichment: embeddings and duplicate links.
 *
 * A separate mode on the same image rather than a step inside the scrape. Its
 * work is expensive per item and its cadence is different - a listing needs
 * embedding once, not every time we confirm it still exists - and a Vertex
 * outage must never be able to stop listings being collected.
 */
async function enrich(): Promise<void> {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error('GCP_PROJECT_ID manquant');

  const started = Date.now();
  const linked = await linkDuplicates();
  const embedded = await backfillEmbeddings(project, Number(process.env.ENRICH_LIMIT ?? 200));
  // The client's side of the semantic score. Cheap - there are as many of these
  // as there are searches - and it was missing entirely until 0012.
  const criteria = await backfillSearchEmbeddings(project, Number(process.env.SEARCH_ENRICH_LIMIT ?? 50));
  console.log(
    `enrich: ${embedded} embedding(s), ${criteria} critère(s) vectorisé(s), ` +
      `${linked} doublon(s) lié(s), ${Date.now() - started} ms`,
  );
}

async function main(): Promise<void> {
  if (process.env.MODE === 'enrich') return enrich();
  if (process.env.MODE === 'agencies') {
    const started = Date.now();
    const r = await resolveAgencies(Number(process.env.AGENCY_LIMIT ?? 25));
    console.log(
      `agencies: ${r.tried} sondée(s), ${r.found} adresse(s) trouvée(s), ` +
        `${r.propagated} annonce(s) débloquée(s), ${Date.now() - started} ms`,
    );
    return;
  }
  // La démonstration : le cycle entier en boucle serrée, pour qu'on n'attende
  // pas huit heures devant un public. Voir demo.ts — rien du comportement de
  // l'agent ne change, seule sa cadence.
  if (process.env.MODE === 'demo') {
    const project = process.env.GCP_PROJECT_ID;
    if (!project) throw new Error('GCP_PROJECT_ID manquant');
    console.log(modelBanner());
    return runDemoLoop(project);
  }

  if (process.env.MODE === 'inbox') {
    const project = process.env.GCP_PROJECT_ID;
    if (!project) throw new Error('GCP_PROJECT_ID manquant');
    // Which model, in which region, and what that means for the data. Logged on
    // every run: a residency decision visible only in a source file is one
    // nobody re-examines.
    console.log(modelBanner());
    const started = Date.now();
    const { clients, replies } = await watchAllInboxes(project);
    console.log(`inbox: ${clients} boîte(s) lue(s), ${replies} réponse(s) traitée(s), ${Date.now() - started} ms`);
    return;
  }
  if (process.env.MODE === 'apply') {
    const project = process.env.GCP_PROJECT_ID;
    if (!project) throw new Error('GCP_PROJECT_ID manquant');
    console.log(modelBanner());
    const started = Date.now();
    const queued = await queueApplications(Number(process.env.QUEUE_LIMIT ?? 50));
    const { sent, failed } = await sendDue(project, Number(process.env.SEND_LIMIT ?? 20));
    // Only now can a runner-up be told somebody was served: after the send, not
    // before it. Closing them at match time is what burned 61 candidates for
    // applications that were never made.
    const closed = await closeLostMatches();
    // Follow-ups leave on the same tick as first applications: a reply the
    // client wrote in the interface must not wait for the morning inbox pass.
    const outbox = await sendOutbox(Number(process.env.OUTBOX_LIMIT ?? 20));
    console.log(
      `apply: ${queued} mise(s) en file, ${sent} envoyée(s), ${failed} en échec, ` +
        `${outbox.sent} relance(s), ${closed} non servi(s) clos, ${Date.now() - started} ms`,
    );
    return;
  }
  if (process.env.MODE === 'match') {
    const started = Date.now();
    const { listings, matches } = await matchPending(Number(process.env.MATCH_LIMIT ?? 200));
    console.log(`match: ${listings} annonce(s) examinée(s), ${matches} match(s), ${Date.now() - started} ms`);
    return;
  }

  const slug = process.env.SOURCE_SLUG;
  if (!slug) throw new Error('SOURCE_SLUG manquant');

  const adapter = ADAPTERS[slug];
  if (!adapter) throw new Error(`Aucun adaptateur pour la source « ${slug} »`);

  const client = db();

  const { data: source, error: sourceError } = await client
    .from('sources')
    .select('id, slug, enabled')
    .eq('slug', slug)
    .single();

  if (sourceError || !source) throw new Error(`Source « ${slug} » absente de la base`);
  if (!source.enabled) {
    console.log(`source ${slug} désactivée, rien à faire`);
    return;
  }

  // Zones follow demand: the union of what active clients asked for, or
  // Île-de-France when there are none. Computed in the database so every
  // worker and every future scheduler agrees on one answer.
  const { data: zoneData } = await client.rpc('active_scrape_zones');
  const zones: string[] = Array.isArray(zoneData) ? zoneData : [];

  // The watermark: the most recent publication we already hold. The adapter
  // reads down its own newest-first list until it reaches this and stops.
  const { data: newest } = await client
    .from('listings')
    .select('published_at')
    .eq('source_id', source.id)
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // The watermark is deliberately rewound before it is used.
  //
  // Bien'ici stamps publication times in batches: up to 28 listings share one
  // timestamp to the millisecond, because a feed import gives them all the same
  // one. An adapter that stops at "published <= watermark" therefore drops the
  // entire remainder of a batch the moment a run happens to end on it - not
  // once, but permanently, because the next run's watermark is that same
  // timestamp. Measured before the fix: 720 listings across only 438 distinct
  // timestamps, and a median detection latency of 41 minutes against a 60
  // second poll.
  //
  // Rewinding costs one cheap re-read per run - a re-seen listing matches on
  // content_hash and becomes a single UPDATE of last_seen_at - and the unique
  // constraint makes it impossible for the overlap to duplicate anything.
  const WATERMARK_REWIND_MS = 30 * 60 * 1000;
  const since = newest?.published_at
    ? new Date(Date.parse(newest.published_at as string) - WATERMARK_REWIND_MS)
    : null;

  const { data: run } = await client
    .from('scrape_runs')
    .insert({ source_id: source.id, status: 'running', zones })
    .select('id')
    .single();

  const runId = run?.id as number | undefined;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

  try {
    const { listings, requests } = await adapter.fetchRecent({
      zones,
      since,
      // A first run has no watermark, so the ceiling is what stops it reading
      // the whole site. Subsequent runs stop long before reaching it.
      maxListings: since ? 500 : 1000,
      signal: controller.signal,
    });

    const result = await ingest(source.id as string, slug, listings, controller.signal);

    await client
      .from('scrape_runs')
      .update({
        status: 'ok',
        finished_at: new Date().toISOString(),
        items_seen: listings.length,
        items_new: result.inserted,
        items_updated: result.updated,
        duration_ms: Date.now() - started,
      })
      .eq('id', runId!);

    console.log(
      `${slug}: ${listings.length} vues, ${result.inserted} nouvelles, ` +
        `${result.updated} mises à jour, ${result.skipped} inchangées, ` +
        `${requests} requête(s), ${Date.now() - started} ms`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (runId) {
      await client
        .from('scrape_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - started,
          error: message.slice(0, 2000),
        })
        .eq('id', runId);
    }

    // Announced as an event too: the run log is for the operator, the event
    // log is what alerting and the interface read.
    await logEvent({
      type: 'source.scrape_failed',
      subjectType: 'source',
      subjectId: source.id as string,
      payload: { source: slug, error: message.slice(0, 500) },
    });

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  // A non-zero exit is what makes Cloud Run Jobs mark the execution failed,
  // which is what any alerting will key on.
  process.exit(1);
});
