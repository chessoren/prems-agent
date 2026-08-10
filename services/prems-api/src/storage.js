/**
 * Reading the document the caller just uploaded.
 *
 * The browser uploads straight to a private Supabase bucket, then sends this
 * service only the path. That keeps the file off this hop entirely and means
 * the service can enforce the one rule that matters:
 *
 *   a path is readable only if it begins with the caller's own user id.
 *
 * The storage policies already enforce that for the browser; repeating it here
 * matters because this service holds the service role key, which bypasses RLS.
 * Without this check, a valid token plus a guessed path would read someone
 * else's identity document.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const ALLOWED_BUCKETS = new Set(['identity-documents', 'proof-of-address']);

const admin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export class AccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

export async function readDocument({ bucket, path, userId }) {
  if (!ALLOWED_BUCKETS.has(bucket)) throw new AccessError('Bucket inconnu.');
  if (typeof path !== 'string' || !path) throw new AccessError('Chemin manquant.', 400);

  // Reject traversal before the prefix check, so `<uid>/../<other>/x` cannot
  // pass by looking like it starts with the caller's folder.
  if (path.includes('..') || path.startsWith('/')) throw new AccessError('Chemin invalide.', 400);
  if (!path.startsWith(`${userId}/`)) throw new AccessError('Ce document ne t’appartient pas.');

  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new AccessError('Document introuvable.', 404);

  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.byteLength > config.maxBytes) throw new AccessError('Document trop volumineux.', 413);

  return { bytes, mimeType: data.type || 'application/octet-stream' };
}

export { admin };
