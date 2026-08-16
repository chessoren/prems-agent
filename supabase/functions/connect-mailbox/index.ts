/**
 * Connecting a client's own mailbox and calendar.
 *
 * Prems sends applications *from the client's mailbox* and reads the agencies'
 * answers *in that mailbox*. That is what makes an agency receive a message
 * from a person rather than from a robot, and it is the only reason reply
 * interception works at all. So the connection belongs to each user, granted by
 * them, and never to an operator account.
 *
 * This runs on the server for one reason: the Composio key can execute tools on
 * any connected account in the workspace. It must not reach a browser. The
 * function is called with the client's Supabase JWT, which the platform
 * verifies before this code runs, so `sub` is an identity we can trust - and a
 * caller can therefore only ever connect a mailbox to their own account.
 */

const COMPOSIO_KEY = Deno.env.get('COMPOSIO_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const AUTH_CONFIG = {
  gmail: 'ac_BDCvl8Std_Rq',
  googlecalendar: 'ac_H4AoPOZxFKAL',
} as const;

const COLUMN = {
  gmail: 'gmail_account_id',
  googlecalendar: 'calendar_account_id',
} as const;

type Service = keyof typeof AUTH_CONFIG;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

/** The caller, from the JWT the platform already verified. */
function callerId(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const payload = JSON.parse(atob(header.slice(7).split('.')[1]));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

const composio = (path: string, init: RequestInit = {}) =>
  fetch(`https://backend.composio.dev/api/v3/${path}`, {
    ...init,
    headers: { 'x-api-key': COMPOSIO_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'méthode non autorisée' }, 405);

  const userId = callerId(request);
  if (!userId) return json({ error: 'non authentifié' }, 401);

  const { action, service } = await request.json().catch(() => ({}));
  const key = (service ?? 'gmail') as Service;
  if (!AUTH_CONFIG[key]) return json({ error: 'service inconnu' }, 400);

  /* ---------------------------------------------------------------------
   * Start: hand back a link to Google's consent screen.
   * ------------------------------------------------------------------- */
  if (action === 'start') {
    const r = await composio('connected_accounts/link', {
      method: 'POST',
      body: JSON.stringify({ auth_config_id: AUTH_CONFIG[key], user_id: userId }),
    });
    if (!r.ok) return json({ error: `composio: ${(await r.text()).slice(0, 200)}` }, 502);

    const created = await r.json();
    return json({ id: created.id, url: created.redirect_url ?? created.redirectUrl });
  }

  /* ---------------------------------------------------------------------
   * Finish: only write the id once Composio says the account is ACTIVE.
   *
   * An account exists in INITIALIZING from the moment the link is created,
   * and stays there if the person closes the Google tab. Writing the id
   * without checking would arm the send worker against a mailbox nobody ever
   * authorised: the application fails, retries, and dead-letters for a reason
   * that has nothing to do with the real cause.
   * ------------------------------------------------------------------- */
  if (action === 'finish') {
    // The account id is never taken from the caller.
    //
    // Two reasons. Composio's link endpoint no longer returns it at creation,
    // so the browser does not have one to send; and accepting one would let
    // anybody post somebody else's account id and have our worker read their
    // mail. It is looked up here instead, filtered by the caller's own uid -
    // which is the same value we set as Composio's `user_id` when the link was
    // created, so the scoping is enforced on both sides.
    const r = await composio(
      `connected_accounts?user_ids=${encodeURIComponent(userId)}&toolkit_slugs=${key}&limit=20`,
    );
    if (!r.ok) return json({ error: 'composio indisponible' }, 502);

    const items = (await r.json())?.items ?? [];
    const mine = items.filter((a: Record<string, any>) => a.user_id === userId);
    const account =
      mine.find((a: Record<string, any>) => a.status === 'ACTIVE') ?? mine[0] ?? null;

    if (!account) return json({ status: 'ABSENT', connected: false });
    if (account.status !== 'ACTIVE') return json({ status: account.status, connected: false });

    const accountId = account.id;

    const patch = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ [COLUMN[key]]: accountId }),
    });
    if (!patch.ok) return json({ error: `profil: ${(await patch.text()).slice(0, 200)}` }, 500);

    return json({ status: 'ACTIVE', connected: true });
  }

  return json({ error: 'action inconnue' }, 400);
});
