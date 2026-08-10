/**
 * Request authentication.
 *
 * Supabase signs access tokens with ES256 and publishes the public key at the
 * project's JWKS endpoint, so verification is local: no shared secret to leak,
 * no round-trip per request, and key rotation is picked up automatically
 * because jose refetches the key set when it sees an unknown `kid`.
 *
 * What this returns is the caller's user id. Everything downstream keys off it,
 * and that is what makes "you may only OCR your own document" enforceable.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';

const JWKS = createRemoteJWKSet(new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`), {
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
});

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

export async function authenticate(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new AuthError('Jeton d’authentification absent.');

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: config.supabase.issuer,
      // Supabase issues `authenticated` for signed-in users, including the
      // anonymous ones this flow creates on screen 5.
      audience: 'authenticated',
    });

    if (!payload.sub) throw new AuthError('Jeton sans sujet.');
    return { userId: payload.sub, isAnonymous: payload.is_anonymous === true };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('Jeton invalide ou expiré.');
  }
}
