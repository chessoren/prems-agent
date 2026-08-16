/**
 * Apply every migration, in order, against the project in .env.
 *
 * There is no migration ledger and deliberately so: each file is written to be
 * idempotent, which makes "apply everything" the same operation as "apply what
 * is missing". A ledger would add a second source of truth about the schema,
 * and the one that drifts is always the ledger.
 *
 * Run with `npm run db:migrate`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, ROOT } from './env.mjs';

const env = loadEnv();
const API = `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}`;

if (!env.SUPABASE_ACCESS_TOKEN || !env.SUPABASE_PROJECT_REF) {
  console.error('SUPABASE_ACCESS_TOKEN et SUPABASE_PROJECT_REF sont requis dans .env');
  process.exit(1);
}

async function query(sql) {
  const response = await fetch(`${API}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 600)}`);
  return text;
}

const dir = resolve(ROOT, 'supabase/migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const started = Date.now();
  try {
    await query(readFileSync(resolve(dir, file), 'utf8'));
    console.log(`  ✓ ${file}  (${Date.now() - started} ms)`);
  } catch (error) {
    console.error(`  ✗ ${file}\n${error.message}`);
    process.exit(1);
  }
}

console.log(`\n${files.length} migration(s) appliquée(s).`);
