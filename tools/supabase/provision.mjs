/**
 * Provision the Supabase project: auth settings, then the SQL migrations.
 *
 * Idempotent by construction - the migrations use `create ... if not exists`
 * and `drop policy if exists`, so re-running this after editing a migration is
 * the normal workflow rather than a recovery step.
 *
 *   npm run db:provision
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, require_, ROOT } from './env.mjs';

const env = loadEnv();
const ref = require_(env, 'SUPABASE_PROJECT_REF');
const token = require_(env, 'SUPABASE_ACCESS_TOKEN');

const API = `https://api.supabase.com/v1/projects/${ref}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Auth configuration the flow depends on.
 *
 * Anonymous sign-in is what lets screen 5 create a real, RLS-protected user
 * without sending an SMS: the visitor gets a genuine auth.uid(), the phone
 * number is stored on the profile, and the day Twilio is connected the same
 * account is upgraded in place with linkIdentity rather than recreated.
 */
async function configureAuth() {
  const siteUrl = env.PUBLIC_SITE_URL || 'http://localhost:4321';
  const allow = [
    'http://localhost:4321',
    'http://localhost:4321/**',
    ...(env.PUBLIC_SITE_URL ? [env.PUBLIC_SITE_URL, `${env.PUBLIC_SITE_URL}/**`] : []),
  ];

  await api('/config/auth', {
    method: 'PATCH',
    body: {
      external_anonymous_users_enabled: true,
      site_url: siteUrl,
      uri_allow_list: [...new Set(allow)].join(','),
      // Anonymous sign-in is an unauthenticated write endpoint, so it is the
      // one surface worth rate limiting hard even before captcha is on.
      rate_limit_anonymous_users: 30,
    },
  });
  console.log('auth: sessions anonymes activées, redirections autorisées');
}

async function runMigrations() {
  const dir = resolve(ROOT, 'supabase/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const query = readFileSync(resolve(dir, file), 'utf8');
    await api('/database/query', { method: 'POST', body: { query } });
    console.log(`migration: ${file} appliquée`);
  }
}

await configureAuth();
await runMigrations();
console.log('\nProvisionnement terminé.');
