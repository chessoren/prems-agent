/**
 * Le produit est-il réellement armé ?
 *
 * « Ça marche » n'est pas une observation, c'est une conclusion — et jusqu'ici
 * elle demandait d'ouvrir cinq consoles. Ce script pose une question à la fois,
 * à la vraie chose, et rend un verdict : est-ce qu'une candidature peut partir
 * maintenant, et sinon, qu'est-ce qui manque exactement.
 *
 *   npm run preflight
 *
 * Chaque contrôle est indépendant. Ce qu'on ne peut pas vérifier faute
 * d'identifiant est marqué « — » et dit lequel il manque, jamais « ok ».
 * Un contrôle sauté n'est pas un contrôle passé : c'est la confusion entre les
 * deux qui fait croire un système prêt.
 */
import { execFileSync } from 'node:child_process';
import { loadEnv } from './supabase/env.mjs';
import { ensureCredentials } from './lib/gcp-credentials.mjs';

const env = loadEnv();
// A key supplied as an env var becomes a file ADC can read, once.
ensureCredentials(env);
const get = (key) => process.env[key] ?? env[key] ?? '';

const PROJECT = get('GCP_PROJECT_ID');
const REGION = get('GCP_REGION') || 'europe-west9';
const SUPABASE_URL = get('PUBLIC_SUPABASE_URL');
const SERVICE_ROLE = get('SUPABASE_SERVICE_ROLE_KEY');
const COMPOSIO_KEY = get('COMPOSIO_API_KEY');

/* ------------------------------------------------------------------ report */

const results = [];
const record = (state, area, what, detail) => {
  results.push({ state, area, what, detail });
  const mark = { ok: '✓', ko: '✗', skip: '—', warn: '!' }[state];
  console.log(`  ${mark}  ${what.padEnd(42)} ${detail}`);
};

const ok = (a, w, d) => record('ok', a, w, d);
const ko = (a, w, d) => record('ko', a, w, d);
const skip = (a, w, d) => record('skip', a, w, d);
const warn = (a, w, d) => record('warn', a, w, d);

const section = (title) => console.log(`\n${title}`);

/* ------------------------------------------------------------- supabase */

async function rest(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE,
      authorization: `Bearer ${SERVICE_ROLE}`,
      prefer: 'count=exact',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const range = response.headers.get('content-range');
  return { response, count: range ? Number(range.split('/')[1]) : null };
}

async function checkSupabase() {
  section('Base de données');
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    skip('db', 'Supabase', 'SUPABASE_SERVICE_ROLE_KEY manquant dans .env');
    return null;
  }

  let counts = {};
  for (const table of ['listings', 'matches', 'applications', 'messages', 'profiles']) {
    try {
      const { response, count } = await rest(`${table}?select=id&limit=1`);
      if (!response.ok) {
        ko('db', table, `HTTP ${response.status}`);
        continue;
      }
      counts[table] = count;
      ok('db', table, `${count ?? '?'} ligne(s)`);
    } catch (error) {
      ko('db', table, String(error.message ?? error).slice(0, 60));
    }
  }

  // The gate on the whole product: a profile with a mailbox attached.
  try {
    const { response, count } = await rest(
      'profiles?select=id&gmail_account_id=not.is.null&limit=1',
    );
    if (!response.ok) {
      ko('db', 'boîtes connectées', `HTTP ${response.status}`);
    } else if ((count ?? 0) > 0) {
      ok('db', 'boîtes connectées', `${count} — le produit peut candidater`);
    } else {
      ko(
        'db',
        'boîtes connectées',
        'AUCUNE — /app › Profil › Boîte mail › « Connecter ma boîte mail »',
      );
    }
  } catch (error) {
    ko('db', 'boîtes connectées', String(error.message ?? error).slice(0, 60));
  }

  return counts;
}

/* --------------------------------------------------------------- composio */

async function checkComposio() {
  section('Composio — la boîte du client');
  if (!COMPOSIO_KEY) {
    skip('composio', 'clé', 'COMPOSIO_API_KEY manquant dans .env');
    return;
  }

  // The same preflight the workers run. A read-only key lists every Gmail tool
  // happily and refuses to execute any of them, which surfaces as a confusing
  // 403 long after a mailbox was connected and everything looked ready.
  try {
    const response = await fetch('https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS', {
      method: 'POST',
      headers: { 'x-api-key': COMPOSIO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected_account_id: '__preflight__', arguments: { max_results: 1 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      if (body?.error?.slug === 'APIKey_InsufficientPermissions') {
        ko('composio', "droit d'exécution", 'clé en lecture seule — il manque tool_execution');
        return;
      }
    }
    ok('composio', "droit d'exécution", 'la clé peut exécuter des outils');
  } catch (error) {
    warn('composio', "droit d'exécution", `injoignable : ${String(error.message ?? error).slice(0, 40)}`);
  }
}

/* ---------------------------------------------------------- edge function */

async function checkEdgeFunction() {
  section('Fonction connect-mailbox — ce que le bouton appelle');
  if (!SUPABASE_URL) {
    skip('edge', 'connect-mailbox', 'PUBLIC_SUPABASE_URL manquant');
    return;
  }
  try {
    // Unauthenticated on purpose. A deployed function answers 401 "non
    // authentifié" from its own code; one that was never deployed answers 404.
    // The difference is the whole check.
    const response = await fetch(`${SUPABASE_URL}/functions/v1/connect-mailbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', service: 'gmail' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      ko('edge', 'connect-mailbox', 'non déployée — npx supabase functions deploy connect-mailbox');
    } else if (response.status === 401 || response.status === 403) {
      ok('edge', 'connect-mailbox', `déployée (${response.status} sans jeton, attendu)`);
    } else {
      warn('edge', 'connect-mailbox', `réponse inattendue : HTTP ${response.status}`);
    }
  } catch (error) {
    warn('edge', 'connect-mailbox', String(error.message ?? error).slice(0, 60));
  }
}

/* -------------------------------------------------------------- gcp / run */

function gcloud(args) {
  return execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function checkCloudRun() {
  section('Google Cloud — les jobs');
  if (!PROJECT) {
    skip('gcp', 'projet', 'GCP_PROJECT_ID manquant dans .env');
    return;
  }
  try {
    gcloud(['auth', 'print-access-token']);
  } catch {
    skip('gcp', 'authentification', 'aucun identifiant — gcloud auth application-default login');
    return;
  }

  let jobs = [];
  try {
    jobs = JSON.parse(
      gcloud(['run', 'jobs', 'list', `--project=${PROJECT}`, `--region=${REGION}`, '--format=json']),
    );
  } catch (error) {
    ko('gcp', 'Cloud Run Jobs', String(error.message ?? error).split('\n')[0].slice(0, 70));
    return;
  }

  const names = new Set(jobs.map((j) => j?.metadata?.name ?? j?.name));
  for (const expected of [
    'prems-scrape-bienici',
    'prems-enrich',
    'prems-match',
    'prems-apply',
    'prems-inbox',
    'prems-agencies',
  ]) {
    if (names.has(expected)) ok('gcp', expected, 'déployé');
    else ko('gcp', expected, `absent de ${REGION}`);
  }

  // Only the two jobs that talk to a model need Bedrock: its model ID, its
  // region, and credentials. A job without keys fails on its first agent turn.
  for (const job of jobs) {
    const name = job?.metadata?.name ?? job?.name;
    if (name !== 'prems-apply' && name !== 'prems-inbox') continue;
    const vars =
      job?.spec?.template?.template?.spec?.containers?.[0]?.env?.reduce(
        (acc, e) => ({ ...acc, [e.name]: e.value }),
        {},
      ) ?? {};
    const model = vars.BEDROCK_MODEL_ID ?? 'eu.anthropic.claude-opus-5 (défaut du code)';
    const region = vars.AWS_REGION ?? 'eu-west-3 (défaut du code)';
    const secrets = job?.spec?.template?.template?.spec?.containers?.[0]?.env ?? [];
    const hasKeys = secrets.some((e) => e.name === 'AWS_ACCESS_KEY_ID');
    if (!hasKeys) {
      ko('aws', `${name} · Bedrock`, 'AWS_ACCESS_KEY_ID absent du job — les agents ne peuvent pas appeler Bedrock');
    } else if (String(model).startsWith('global.')) {
      warn('aws', `${name} · modèle`, `${model} @ ${region} — aucune résidence UE`);
    } else {
      ok('aws', `${name} · modèle`, `${model} @ ${region}`);
    }
  }
}

/* ------------------------------------------------------------------- main */

console.log('\nPrems — le produit est-il armé ?');

await checkSupabase();
await checkComposio();
await checkEdgeFunction();
checkCloudRun();

const failed = results.filter((r) => r.state === 'ko');
const skipped = results.filter((r) => r.state === 'skip');
const warned = results.filter((r) => r.state === 'warn');

console.log('\n' + '─'.repeat(72));
if (failed.length === 0 && skipped.length === 0) {
  console.log('Tout répond. Une candidature peut partir.');
} else {
  if (failed.length) {
    console.log(`\n${failed.length} blocage(s) — à régler dans cet ordre :\n`);
    for (const f of failed) console.log(`  ✗  ${f.what} : ${f.detail}`);
  }
  if (skipped.length) {
    console.log(`\n${skipped.length} contrôle(s) non effectué(s), faute d'identifiant :\n`);
    for (const s of skipped) console.log(`  —  ${s.what} : ${s.detail}`);
    console.log('\n  Un contrôle sauté n\'est pas un contrôle passé.');
  }
}
if (warned.length) {
  console.log('');
  for (const w of warned) console.log(`  !  ${w.what} : ${w.detail}`);
}
console.log('');

process.exit(failed.length ? 1 : 0);
