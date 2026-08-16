/**
 * The only thing that may grant a subscription.
 *
 * Before this, the plan came from a query parameter on the redirect Stripe
 * sends someone back with - `/app?checkout=fondateur` - and was written to
 * localStorage. Anyone could type that URL and take the 100 € offer for
 * nothing, and the person who actually paid lost it as soon as they cleared
 * their browser. Entitlement cannot be granted by the party it governs.
 *
 * So the grant moves here, behind a signature only Stripe can produce.
 *
 * Deployed on the Prems project. There is an older `stripe-webhook` on a
 * *different* Supabase project (Mira's) subscribed to the same Stripe account -
 * it credits a balance there and knows nothing about this table. Both endpoints
 * receive every event and each ignores what is not its own.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

/** Plans we sell, by the metadata key set on each payment link. */
const PLANS = new Set(['soldat', 'fondateur', 'commando', 'investisseur']);

/* -------------------------------------------------------------------------
 * Signature
 *
 * Verified by hand rather than with the SDK: it is twenty lines of Web Crypto,
 * and it is the one part of this file that must not be wrong.
 *
 * Two things beyond the HMAC itself matter. The timestamp is checked so a
 * captured payload cannot be replayed a week later, and the comparison is
 * constant-time so the signature cannot be recovered one byte at a time by
 * timing the response.
 * ------------------------------------------------------------------------- */
const TOLERANCE_SECONDS = 300;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verify(payload: string, header: string | null): Promise<boolean> {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, ...rest] = p.split('=');
      return [k.trim(), rest.join('=')];
    }),
  );

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Stripe may send several v1 signatures during a secret rotation.
  return header
    .split(',')
    .filter((p) => p.trim().startsWith('v1='))
    .some((p) => constantTimeEqual(p.trim().slice(3), expected));
}

/* -------------------------------------------------------------------------
 * Database, over PostgREST with the service role. No client library for one
 * insert, and the service role is what lets it write a table the browser key
 * cannot.
 * ------------------------------------------------------------------------- */
async function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Which account paid.
 *
 * `client_reference_id` is the account uuid, set on the checkout URL by the
 * app, and it is exact. The fallbacks exist because a payment that cannot be
 * attached to anyone is the worst outcome here - the person has been charged
 * and has nothing to show for it - so a phone number or an email is worth
 * trying before giving up.
 */
async function resolveUser(session: Record<string, any>): Promise<string | null> {
  const reference = session.client_reference_id;
  if (typeof reference === 'string' && /^[0-9a-f-]{36}$/i.test(reference)) return reference;

  const phone = session.customer_details?.phone ?? null;
  if (phone) {
    const r = await db(`profiles?phone=eq.${encodeURIComponent(phone)}&select=id&limit=1`);
    const rows = await r.json();
    if (rows?.[0]?.id) return rows[0].id;
  }

  const email = session.customer_details?.email ?? null;
  if (email) {
    const r = await db(`profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
    const rows = await r.json();
    if (rows?.[0]?.id) return rows[0].id;
  }

  return null;
}

async function onCheckoutCompleted(session: Record<string, any>): Promise<Response> {
  // A session that is not paid yet (async payment methods) grants nothing.
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return new Response('ignoré: non payé', { status: 200 });
  }

  const plan = session.metadata?.prems_plan;
  if (!plan || !PLANS.has(plan)) {
    // Another product on the same Stripe account. Not our event.
    return new Response('ignoré: hors Prems', { status: 200 });
  }

  const userId = await resolveUser(session);
  if (!userId) {
    // Deliberately a 200: retrying will not conjure an account, and a failing
    // endpoint would make Stripe retry this forever. Recorded so it can be
    // reconciled by hand - somebody has paid.
    await db('events', {
      method: 'POST',
      body: JSON.stringify({
        type: 'billing.unattributed',
        subject_type: 'subscription',
        payload: {
          session: session.id,
          amount: session.amount_total,
          email: session.customer_details?.email ?? null,
          plan,
        },
      }),
    });
    return new Response('paiement non rattaché, enregistré', { status: 200 });
  }

  const row = {
    user_id: userId,
    plan,
    status: 'active',
    stripe_customer_id: session.customer ?? null,
    stripe_subscription_id: session.subscription ?? null,
    stripe_session_id: session.id,
    // `fondateur` is a one-off with no renewal: no period end means it does not
    // expire, which is what was sold.
    current_period_end: null,
  };

  // Idempotent: Stripe retries until it gets a 2xx, so the same session can
  // arrive more than once.
  const r = await db('subscriptions?on_conflict=stripe_session_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });

  if (!r.ok) return new Response(`échec écriture: ${await r.text()}`, { status: 500 });

  await db('events', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      type: 'subscription.started',
      subject_type: 'subscription',
      payload: { plan, amount: session.amount_total, session: session.id },
    }),
  });

  return new Response('abonnement actif', { status: 200 });
}

/** A renewal keeps a weekly plan alive; its absence is what ends it. */
async function onInvoicePaid(invoice: Record<string, any>): Promise<Response> {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return new Response('ignoré: hors abonnement', { status: 200 });

  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  await db(`subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'active',
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    }),
  });
  return new Response('renouvelé', { status: 200 });
}

async function onSubscriptionChanged(sub: Record<string, any>, canceled: boolean): Promise<Response> {
  await db(`subscriptions?stripe_subscription_id=eq.${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: canceled ? 'canceled' : sub.status === 'past_due' ? 'past_due' : 'active',
      cancel_at_period_end: Boolean(sub.cancel_at_period_end),
      canceled_at: canceled ? new Date().toISOString() : null,
      current_period_end: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
    }),
  });
  return new Response('mis à jour', { status: 200 });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('méthode non autorisée', { status: 405 });

  const payload = await request.text();
  if (!(await verify(payload, request.headers.get('stripe-signature')))) {
    return new Response('signature invalide', { status: 400 });
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response('corps illisible', { status: 400 });
  }

  const object = event.data?.object ?? {};

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return onCheckoutCompleted(object);
    case 'invoice.paid':
      return onInvoicePaid(object);
    case 'customer.subscription.updated':
      return onSubscriptionChanged(object, false);
    case 'customer.subscription.deleted':
      return onSubscriptionChanged(object, true);
    default:
      return new Response('ignoré', { status: 200 });
  }
});
