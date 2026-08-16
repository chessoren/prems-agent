/**
 * The mailbox watcher.
 *
 * Applications leave from the client's own Gmail, so the agency's reply arrives
 * there too. This reads that mailbox, works out what came back, and turns an
 * offered visit into a calendar entry on both sides - Google's, and ours.
 *
 * Two boundaries are deliberate and neither is negotiable.
 *
 * It reads only what it needs. The Gmail query is scoped to threads with
 * agencies we actually wrote to, never the whole inbox. We are inside somebody's
 * private correspondence; the fact that the API would return everything is not a
 * reason to look at everything.
 *
 * It never sends on its own. Classification decides what a message *is*; a
 * reply to it is drafted and left for the client. An agent that answers an
 * agency unprompted can commit somebody to a viewing they cannot attend, and
 * the cost of being wrong is borne entirely by them.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db, logEvent } from './db.js';
import { canExecute, createCalendarEvent, fetchEmails } from './composio.js';

const LOCATION = 'europe-west9';
const MODEL = 'gemini-2.5-flash-lite';

async function accessToken(): Promise<string> {
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) },
    );
    if (r.ok) return ((await r.json()) as { access_token: string }).access_token;
  } catch {
    /* not on Cloud Run */
  }
  const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '', 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

export type ReplyKind = 'visit_offered' | 'refused' | 'question' | 'other';

export interface Classification {
  readonly kind: ReplyKind;
  /** Present only when a specific slot was proposed. */
  readonly visitStartISO: string | null;
  readonly visitLocation: string | null;
  readonly summary: string;
  readonly suggestedReply: string | null;
}

/**
 * What did the agency actually say?
 *
 * `visit_offered` is reserved for a concrete proposal. "Nous reviendrons vers
 * vous" is not a visit, and treating it as one would put a fiction in somebody's
 * calendar - which is worse than missing a real appointment, because they will
 * stop trusting the calendar.
 */
export async function classify(
  message: { from: string; subject: string; body: string },
  project: string,
  now = new Date(),
): Promise<Classification> {
  const prompt = `Tu analyses la réponse d'une agence immobilière à une candidature locative.

Date du jour : ${now.toISOString().slice(0, 10)}

Classe le message dans exactement une catégorie :
- "visit_offered" : UNIQUEMENT si une visite est proposée avec un créneau concret (date, ou date+heure). "Nous reviendrons vers vous" n'est PAS une visite.
- "refused" : le bien est loué, indisponible, ou la candidature est écartée.
- "question" : l'agence demande une information ou une pièce complémentaire.
- "other" : accusé de réception, message automatique, hors sujet.

Si et seulement si "visit_offered" avec un créneau : donne visitStartISO en ISO 8601 avec fuseau +02:00. Sinon null.
Si "question" : propose une réponse courte, polie, en français, que le candidat pourra relire. Sinon null.

Message :
De : ${message.from}
Objet : ${message.subject}
${message.body.slice(0, 3000)}

Réponds en JSON strict :
{"kind":"...","visitStartISO":null,"visitLocation":null,"summary":"...","suggestedReply":null}`;

  try {
    const token = await accessToken();
    const r = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 700,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) throw new Error(`vertex ${r.status}`);
    const j = (await r.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('réponse vide');
    const parsed = JSON.parse(text) as Partial<Classification>;

    const kind: ReplyKind =
      parsed.kind === 'visit_offered' ||
      parsed.kind === 'refused' ||
      parsed.kind === 'question'
        ? parsed.kind
        : 'other';

    // A date the model invented, or one in the past, is not a booking.
    let start: string | null = null;
    if (kind === 'visit_offered' && parsed.visitStartISO) {
      const t = Date.parse(parsed.visitStartISO);
      if (Number.isFinite(t) && t > now.getTime() - 3600_000) start = new Date(t).toISOString();
    }

    return {
      kind,
      visitStartISO: start,
      visitLocation: parsed.visitLocation ?? null,
      summary: (parsed.summary ?? '').slice(0, 500),
      suggestedReply: kind === 'question' ? (parsed.suggestedReply ?? null) : null,
    };
  } catch {
    // An unclassifiable message is 'other', never a guess. Guessing here writes
    // fiction into somebody's calendar.
    return {
      kind: 'other',
      visitStartISO: null,
      visitLocation: null,
      summary: 'non classé',
      suggestedReply: null,
    };
  }
}

/** Read one client's replies, classify them, and record what they mean. */
export async function watchInbox(userId: string, project: string): Promise<number> {
  const client = db();

  const { data: profile } = await client
    .from('profiles')
    .select('gmail_account_id, calendar_account_id, inbox_last_checked_at')
    .eq('id', userId)
    .maybeSingle();
  if (!profile?.gmail_account_id) return 0;

  // Only agencies we actually wrote to. This is the line between reading a
  // conversation we started and reading somebody's mail.
  const { data: sentTo } = await client
    .from('applications')
    .select('id, to_email, listing_id')
    .eq('user_id', userId)
    .eq('status', 'sent')
    .not('to_email', 'is', null)
    .limit(40);

  const byEmail = new Map((sentTo ?? []).map((a) => [String(a.to_email).toLowerCase(), a]));
  if (byEmail.size === 0) return 0;

  const since = profile.inbox_last_checked_at
    ? new Date(profile.inbox_last_checked_at as string)
    : new Date(Date.now() - 7 * 24 * 3600_000);

  const query =
    `(${[...byEmail.keys()].map((e) => `from:${e}`).join(' OR ')}) ` +
    `after:${Math.floor(since.getTime() / 1000)}`;

  const result = await fetchEmails(profile.gmail_account_id as string, query, 25);
  const messages = (result.data?.messages ?? []) as Array<Record<string, any>>;
  let handled = 0;

  for (const msg of messages) {
    const from = String(msg.sender ?? msg.from ?? '').toLowerCase();
    const key = [...byEmail.keys()].find((e) => from.includes(e));
    if (!key) continue;
    const application = byEmail.get(key)!;

    const messageId = String(msg.messageId ?? msg.id ?? '');
    const { data: seen } = await client
      .from('application_replies')
      .select('id')
      .eq('application_id', application.id as string)
      .eq('from_address', key)
      .eq('subject', String(msg.subject ?? ''))
      .maybeSingle();
    if (seen) continue;

    const verdict = await classify(
      {
        from,
        subject: String(msg.subject ?? ''),
        body: String(msg.messageText ?? msg.snippet ?? ''),
      },
      project,
    );

    await client.from('application_replies').insert({
      application_id: application.id as string,
      from_address: key,
      subject: String(msg.subject ?? '').slice(0, 500),
      body: String(msg.messageText ?? msg.snippet ?? '').slice(0, 20000),
      classified_as: verdict.kind,
      classifier: MODEL,
    });

    await client
      .from('applications')
      .update({ status: verdict.kind === 'visit_offered' ? 'visit_booked' : 'replied' })
      .eq('id', application.id as string);

    if (verdict.kind === 'visit_offered' && verdict.visitStartISO) {
      const start = new Date(verdict.visitStartISO);
      const end = new Date(start.getTime() + 30 * 60_000);

      // Ours first. The front end must be able to show the appointment even if
      // Google is unreachable, and a calendar that depends on a third party is
      // a calendar that is sometimes empty.
      const { data: created } = await client
        .from('calendar_events')
        .insert({
          user_id: userId,
          application_id: application.id as string,
          listing_id: application.listing_id as string,
          title: `Visite — ${verdict.visitLocation ?? 'appartement'}`,
          location: verdict.visitLocation,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          source: 'reply_parser',
        })
        .select('id')
        .single();

      const calendarAccount = (profile.calendar_account_id ?? profile.gmail_account_id) as string;
      try {
        const google = await createCalendarEvent(calendarAccount, {
          summary: `Visite appartement`,
          description: verdict.summary,
          location: verdict.visitLocation ?? '',
          startISO: start.toISOString(),
          endISO: end.toISOString(),
        });
        const googleId = (google.data?.id ?? google.data?.event_id) as string | undefined;
        if (googleId && created?.id) {
          await client
            .from('calendar_events')
            .update({ google_event_id: googleId })
            .eq('id', created.id as string);
        }
      } catch {
        /* ours is written; Google can be retried later */
      }

      await logEvent({
        userId,
        type: 'visit.booked',
        subjectType: 'application',
        subjectId: application.id as string,
        payload: { starts_at: start.toISOString(), location: verdict.visitLocation, from: key },
      });
    } else {
      await logEvent({
        userId,
        type: `reply.${verdict.kind}`,
        subjectType: 'application',
        subjectId: application.id as string,
        payload: {
          from: key,
          summary: verdict.summary,
          // Drafted, never sent. The client decides.
          suggested_reply: verdict.suggestedReply,
          message_id: messageId,
        },
      });
    }
    handled += 1;
  }

  await client
    .from('profiles')
    .update({ inbox_last_checked_at: new Date().toISOString() })
    .eq('id', userId);

  return handled;
}

/** Every client with a connected mailbox. Runs each morning. */
export async function watchAllInboxes(project: string): Promise<{ clients: number; replies: number }> {
  // Same preflight as the send path. This job runs once a morning, so a
  // permissions failure discovered here would otherwise cost a full day before
  // anyone saw why no reply was ever picked up.
  const preflight = await canExecute();
  if (!preflight.ok) {
    await logEvent({ type: 'composio.misconfigured', payload: { reason: preflight.reason, job: 'inbox' } });
    throw new Error(preflight.reason ?? 'Composio ne peut pas exécuter d\'outil');
  }

  const client = db();
  const { data: profiles } = await client
    .from('profiles')
    .select('id')
    .not('gmail_account_id', 'is', null)
    .limit(500);

  let replies = 0;
  for (const p of profiles ?? []) replies += await watchInbox(p.id as string, project);
  return { clients: (profiles ?? []).length, replies };
}
