/**
 * Which model answers, from which region — asked, not assumed.
 *
 * This exists because the same mistake was made twice in this repository. A 404
 * on `gemini-3-flash-lite` was read as "the 3.x family does not exist", which
 * kept the workers two generations behind; and the region a model is served
 * from has been taken from documentation that says less than it appears to.
 * Both are one HTTP call away from being facts.
 *
 *   npm run gcp:models                # probe every candidate pair
 *   npm run gcp:models -- --strict    # exit 1 unless the configured pair answers
 *   npm run gcp:models -- --dry-run   # print the endpoints, call nothing
 *
 * Needs Application Default Credentials and the Vertex AI API enabled:
 *
 *   gcloud auth application-default login
 *   gcloud services enable aiplatform.googleapis.com --project <id>
 */
import { loadEnv } from './supabase/env.mjs';
import { ensureCredentials } from './lib/gcp-credentials.mjs';

const env = loadEnv();
// A key supplied as an env var becomes a file ADC can read, once.
ensureCredentials(env);
const value = (key, fallback) => process.env[key] ?? env[key] ?? fallback;

const PROJECT = value('GCP_PROJECT_ID');
if (!PROJECT) {
  console.error('GCP_PROJECT_ID manquant. Renseignez-le dans .env ou exportez-le.');
  process.exit(2);
}

const MODEL = value('GCP_MODEL', 'gemini-3.7-flash');
const MODEL_LOCATION = value('GCP_MODEL_LOCATION', 'global');
const EMBEDDING_MODEL = 'text-multilingual-embedding-002';
const REGION = value('GCP_REGION', 'europe-west9');

/**
 * The pairs worth knowing about, not every pair that exists.
 *
 * The configured one first, then the fallback that keeps data in the EU, then
 * the two that would be convenient if they worked — a Gemini served from Paris
 * would remove the whole residency question.
 */
const CANDIDATES = dedupe([
  { model: MODEL, location: MODEL_LOCATION, note: 'configuré' },
  { model: 'gemini-3.7-flash', location: 'global', note: 'le plus récent' },
  { model: 'gemini-3.7-flash', location: 'europe-west3', note: 'UE, si un jour' },
  { model: 'gemini-3.5-flash', location: 'europe-west3', note: 'repli UE, le plus récent' },
  { model: 'gemini-2.5-flash', location: REGION, note: 'repli Paris, avec les jobs' },
  { model: EMBEDDING_MODEL, location: REGION, note: 'embeddings' },
]);

/** The configured pair is usually one of the others; probe each one once. */
function dedupe(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.model}@${candidate.location}`;
    if (!seen.has(key)) seen.set(key, { ...candidate, key });
  }
  return [...seen.values()];
}

/** `global` has no regional prefix; every other location does. */
const host = (location) =>
  location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;

/** Embedding models take `:predict` with instances; Gemini takes `:generateContent`. */
const isEmbedding = (model) => model.includes('embedding');

function url({ model, location }) {
  const verb = isEmbedding(model) ? 'predict' : 'generateContent';
  return (
    `https://${host(location)}/v1/projects/${PROJECT}` +
    `/locations/${location}/publishers/google/models/${model}:${verb}`
  );
}

function body({ model }) {
  return isEmbedding(model)
    ? { instances: [{ content: 'ping', task_type: 'RETRIEVAL_QUERY' }] }
    : {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      };
}

/**
 * A token, from ADC.
 *
 * `google-auth-library` rather than shelling out to gcloud: the workers
 * authenticate the same way, so a failure here is a failure there, and finding
 * that out from this script is much cheaper than finding it out from a job that
 * runs every two minutes.
 */
async function token() {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('ADC ne rend aucun jeton');
  return token;
}

/**
 * What a status code means here, in the only terms that matter.
 *
 * The 400 case is the one that cost time. `eu-aiplatform.googleapis.com` — the
 * European multi-region, which exists for Document AI — is not a Vertex AI host
 * at all, and answers 400 "Invalid hostname". Reading that as "the model is
 * probably absent" sent us looking for the wrong thing entirely, so it now says
 * what it is.
 */
function verdict(status, text) {
  if (status === 200) return { ok: true, say: 'répond' };
  if (status === 404) return { ok: false, say: 'modèle absent de cette région' };
  if (status === 400 && /invalid hostname/i.test(text)) {
    return { ok: false, say: "cette région n'existe pas pour Vertex AI" };
  }
  if (status === 403) {
    const denied = /aiplatform|permission/i.test(text);
    return { ok: false, say: denied ? 'droits manquants (aiplatform.user ?)' : 'refusé' };
  }
  if (status === 401) return { ok: false, say: 'authentification refusée' };
  if (status === 429) return { ok: false, say: 'quota — le modèle existe pourtant' };
  if (status === 400) return { ok: false, say: `requête refusée : ${firstMessage(text)}` };
  return { ok: false, say: `HTTP ${status}` };
}

if (process.argv.includes('--dry-run')) {
  console.log(`\nProjet ${PROJECT} — endpoints, sans appel :\n`);
  for (const candidate of CANDIDATES) console.log(`  ${url(candidate)}`);
  console.log('');
  process.exit(0);
}

/** The API's own explanation, when it has one worth repeating. */
function firstMessage(text) {
  try {
    return String(JSON.parse(text)?.error?.message ?? '').slice(0, 60) || 'sans détail';
  } catch {
    return 'sans détail';
  }
}

const bearer = await token().catch((error) => {
  console.error(`\nAuthentification impossible : ${error.message}\n`);
  console.error('  gcloud auth application-default login');
  console.error('  # ou GOOGLE_APPLICATION_CREDENTIALS=<clé.json>\n');
  process.exit(2);
});

console.log(`\nProjet ${PROJECT}\n`);

const rows = [];

for (const candidate of CANDIDATES) {
  let status = 0;
  let text = '';
  try {
    const response = await fetch(url(candidate), {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(candidate)),
      signal: AbortSignal.timeout(20_000),
    });
    status = response.status;
    text = (await response.text()).slice(0, 400);
  } catch (error) {
    text = String(error.message ?? error);
  }

  const { ok, say } = verdict(status, text);
  rows.push({ ...candidate, ok, say, status });
  console.log(
    `  ${ok ? '✓' : '✗'}  ${candidate.key.padEnd(46)} ${String(status || '—').padEnd(5)} ${say}` +
      (candidate.note ? `   (${candidate.note})` : ''),
  );
}

const configured = rows.find((r) => r.key === `${MODEL}@${MODEL_LOCATION}`);
const euOption = rows.find((r) => r.ok && r.location !== 'global' && !isEmbedding(r.model));
const residency = euOption ? `résidence ${euOption.location}` : 'aucun repli régional ne répond';

console.log('');
if (configured?.ok) {
  console.log(`Configuré : ${configured.key} — répond.`);
  if (MODEL_LOCATION === 'global') {
    console.log('⚠  Endpoint global : aucune résidence des données, traitement mondial.');
    if (euOption) {
      console.log(
        `   Repli disponible (${residency}) : ` +
          `GCP_MODEL=${euOption.model} GCP_MODEL_LOCATION=${euOption.location}`,
      );
    }
  }
} else {
  console.log(`✗  Configuré : ${MODEL}@${MODEL_LOCATION} — ${configured?.say ?? 'non testé'}.`);
  const alternative = rows.find((r) => r.ok && !isEmbedding(r.model));
  if (alternative) {
    console.log(
      `   Ce qui répond : GCP_MODEL=${alternative.model} GCP_MODEL_LOCATION=${alternative.location}`,
    );
  }
}
console.log('');

if (process.argv.includes('--strict') && !configured?.ok) process.exit(1);
