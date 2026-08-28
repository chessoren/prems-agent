/**
 * Application Default Credentials, from an environment variable.
 *
 * ADC wants `GOOGLE_APPLICATION_CREDENTIALS` to be a *path*, which is awkward
 * in the one place a key is most likely to arrive: an environment variable set
 * on a container that has no filesystem to prepare. So if `GCP_SERVICE_ACCOUNT_JSON`
 * holds the key itself, materialise it once and point ADC at it.
 *
 * The file is written to the OS temp directory with owner-only permissions and
 * never into the repository — a key in a working tree is a key one `git add -A`
 * away from being published.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TARGET = join(tmpdir(), 'prems-gcp-adc.json');

/**
 * Returns the path ADC will use, or null when no credential was supplied.
 *
 * Called for its side effect on `process.env`, so anything downstream —
 * google-auth-library, the gcloud CLI — picks it up without being told.
 */
export function ensureCredentials(env = {}) {
  const existing = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  if (existing && existsSync(existing)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = existing;
    return existing;
  }

  const inline = process.env.GCP_SERVICE_ACCOUNT_JSON ?? env.GCP_SERVICE_ACCOUNT_JSON;
  if (!inline) return null;

  let parsed;
  try {
    parsed = JSON.parse(inline);
  } catch {
    throw new Error(
      'GCP_SERVICE_ACCOUNT_JSON n’est pas du JSON valide. Collez le fichier de clé entier, accolades comprises.',
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON ne ressemble pas à une clé de compte de service.');
  }

  writeFileSync(TARGET, inline, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = TARGET;
  return TARGET;
}
