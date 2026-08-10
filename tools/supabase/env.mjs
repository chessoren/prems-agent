/**
 * Minimal .env reader.
 *
 * The project has no dependency on dotenv and does not need one: the file is a
 * flat KEY=VALUE list. Values already present in the real environment win, so
 * CI can inject secrets without a file on disk.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadEnv() {
  let text = '';
  try {
    text = readFileSync(resolve(ROOT, '.env'), 'utf8');
  } catch {
    /* no .env - rely on the ambient environment alone */
  }

  const env = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return { ...env, ...pick(process.env, Object.keys(env)) };
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key]) out[key] = source[key];
  return out;
}

export function require_(env, key) {
  const value = env[key];
  if (!value) {
    throw new Error(
      `${key} manquant. Copiez .env.example vers .env et renseignez-le, ` +
        `ou exportez la variable dans l'environnement.`,
    );
  }
  return value;
}

export { ROOT };
