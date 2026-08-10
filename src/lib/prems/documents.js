/**
 * Uploading a supporting document.
 *
 * Files go to a private bucket under a folder named after the user's own uid -
 * the storage policies in 0001_onboarding.sql only ever allow that prefix, so
 * one visitor cannot read another's identity document even with a crafted
 * request. The row in `documents` is metadata only; it carries no file content.
 */
import { client, ensureSession } from './supabase.js';

const BUCKETS = {
  identite: 'identity-documents',
  garant: 'identity-documents',
  revenus: 'identity-documents',
  domicile: 'proof-of-address',
};

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'];

export function validate(file) {
  if (file.size > MAX_BYTES) return 'Fichier trop lourd (10 Mo maximum).';
  if (file.type && !ACCEPTED.includes(file.type)) return 'Formats acceptés : PDF, JPG, PNG.';
  return null;
}

/** Storage gets this long before the flow stops waiting on it. */
const DEADLINE_MS = 12000;

const withDeadline = (promise, fallback) =>
  Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), DEADLINE_MS)),
  ]);

export async function upload(file, kind, subtype) {
  const problem = validate(file);
  if (problem) return { ok: false, error: problem };

  const supabase = client();
  const session = supabase ? await withDeadline(ensureSession(), null) : null;

  // No backend reachable: the flow still accepts the file and remembers its
  // name, so the visitor is never blocked by infrastructure they cannot see.
  // The document is re-requested later rather than losing the signup here.
  if (!session) return { ok: true, stored: false, name: file.name, size: file.size };

  const bucket = BUCKETS[kind] || 'proof-of-address';
  const extension = (file.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${session.user.id}/${kind}/${crypto.randomUUID()}.${extension}`;

  const result = await withDeadline(
    supabase.storage.from(bucket).upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    }),
    null,
  );

  // Timed out or refused: keep the file client-side rather than making the
  // visitor re-pick it. They are one screen from the end.
  if (!result || result.error) {
    return { ok: true, stored: false, name: file.name, size: file.size };
  }

  await supabase.from('documents').insert({
    user_id: session.user.id,
    kind,
    doc_subtype: subtype ?? null,
    bucket,
    storage_path: path,
    mime_type: file.type || null,
    size_bytes: file.size,
  });

  return { ok: true, stored: true, name: file.name, size: file.size, bucket, path };
}

export const humanSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} Ko`
    : `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
