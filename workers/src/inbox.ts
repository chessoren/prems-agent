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
 * It answers only inside stated limits. Classification decides what a message
 * *is*; whether to reply to it is a second decision, taken by an agent with
 * tools (`negotiate.ts`) behind three gates the model cannot argue with — a
 * refusal ends the thread, a cap ends a loop, and an operator switch ends both.
 * An agent that answers an agency unprompted can commit somebody to a viewing
 * they cannot attend, and the cost of being wrong is borne entirely by them.
 */
import { LlmAgent } from '@google/adk';
import { z } from 'zod';

import { MODEL, gemini, runAgentJson } from './agent.js';
import { db, logEvent } from './db.js';
import { canExecute, createCalendarEvent, fetchEmails } from './composio.js';
import { readableAvailability, writeReply } from './negotiate.js';

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
 * The four categories, and the line between them.
 *
 * `visit_offered` is reserved for a concrete proposal. "Nous reviendrons vers
 * vous" is not a visit, and treating it as one would put a fiction in somebody's
 * calendar - which is worse than missing a real appointment, because they will
 * stop trusting the calendar.
 */
const CLASSIFIER_INSTRUCTION = `Tu analyses la réponse d'une agence immobilière à une candidature locative.

Classe le message dans exactement une catégorie :
- "visit_offered" : UNIQUEMENT si une visite est proposée avec un créneau concret (date, ou date+heure). "Nous reviendrons vers vous" n'est PAS une visite.
- "refused" : le bien est loué, indisponible, ou la candidature est écartée.
- "question" : l'agence demande une information ou une pièce complémentaire.
- "other" : accusé de réception, message automatique, hors sujet.

Si et seulement si "visit_offered" avec un créneau : donne visitStartISO en ISO 8601 avec fuseau +02:00. Sinon null.
Si "question" : propose une réponse courte, polie, en français, que le candidat pourra relire. Sinon null.`;

const ClassificationSchema = z.object({
  kind: z.enum(['visit_offered', 'refused', 'question', 'other']),
  visitStartISO: z.string().nullable().describe('ISO 8601 avec fuseau, ou null.'),
  visitLocation: z.string().nullable().describe("L'adresse de la visite, ou null."),
  summary: z.string().describe('Une phrase : ce que dit le message.'),
  suggestedReply: z.string().nullable().describe('Une réponse à faire relire, ou null.'),
});

/** Built once per process. No tools: reading a message is not an errand. */
let classifier: { project: string; agent: LlmAgent } | null = null;

function replyClassifier(project: string): LlmAgent {
  if (classifier?.project === project) return classifier.agent;
  const agent = new LlmAgent({
    name: 'prems_reply_classifier',
    model: gemini(project),
    description: "Décide ce qu'une agence immobilière vient de répondre à une candidature.",
    instruction: CLASSIFIER_INSTRUCTION,
    generateContentConfig: { temperature: 0.1, maxOutputTokens: 700 },
    outputSchema: ClassificationSchema,
  });
  classifier = { project, agent };
  return agent;
}

/**
 * What did the agency actually say?
 *
 * The schema is enforced by the API rather than requested in prose, so a
 * malformed answer is no longer one of the ways this fails. Everything that
 * remains — a date that does not parse, a date in the past, a category the
 * model made up — is checked here, because a response schema constrains the
 * shape of an answer and says nothing about whether it is true.
 */
export async function classify(
  message: { from: string; subject: string; body: string },
  project: string,
  now = new Date(),
): Promise<Classification> {
  const parsed = await runAgentJson<Partial<Classification>>({
    agent: replyClassifier(project),
    prompt: `Date du jour : ${now.toISOString().slice(0, 10)}

De : ${message.from}
Objet : ${message.subject}
${message.body.slice(0, 3000)}`,
    timeoutMs: 20_000,
  });

  // An unclassifiable message is 'other', never a guess. Guessing here writes
  // fiction into somebody's calendar.
  if (!parsed) {
    return {
      kind: 'other',
      visitStartISO: null,
      visitLocation: null,
      summary: 'non classé',
      suggestedReply: null,
    };
  }

  const kind: ReplyKind =
    parsed.kind === 'visit_offered' || parsed.kind === 'refused' || parsed.kind === 'question'
      ? parsed.kind
      : 'other';

  // A date the model invented, or one in the past, is not a booking. The schema
  // constrains the shape of the answer; it says nothing about whether the date
  // in it is real.
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
}


/**
 * Answer the agency, on the client's behalf, within stated limits.
 *
 * Queued into `messages` rather than sent from here. One outbox means one place
 * a send can fail, one retry policy, and one thread in the interface - and it
 * makes a reply the client writes themselves indistinguishable, on the way out,
 * from one the agent wrote.
 *
 * Three refusals to act, each with a cost behind it:
 *  - A refusal ends the thread. Arguing with an agency that has said no is how
 *    a client's own address stops being delivered.
 *  - A capped number of agent replies per thread. A negotiation that loops is
 *    worse than one that stops.
 *  - Nothing at all if the operator has turned autonomous replies off.
 */
async function maybeReply(args: {
  client: ReturnType<typeof db>;
  userId: string;
  project: string;
  application: Record<string, any>;
  verdict: Classification;
  profile: Record<string, any>;
  agencyMessage: string;
  threadId: string | null;
  subject: string;
}): Promise<void> {
  const { client, userId, project, application, verdict, profile } = args;

  if (verdict.kind === 'refused') return;

  const { data: cfg } = await client
    .from('settings')
    .select('agent_replies_enabled, max_agent_replies_per_thread')
    .eq('id', 1)
    .single();
  if (!cfg?.agent_replies_enabled) return;

  const { data: already } = await client.rpc('agent_reply_count', {
    p_application_id: application.id as string,
  });
  if (Number(already ?? 0) >= Number(cfg.max_agent_replies_per_thread ?? 4)) {
    await logEvent({
      userId,
      type: 'reply.handed_back',
      subjectType: 'application',
      subjectId: application.id as string,
      payload: { reason: 'plafond de relances atteint' },
    });
    return;
  }

  // The thread so far, so the reply does not repeat what has already been said.
  const { data: history } = await client
    .from('messages')
    .select('author, body')
    .eq('application_id', application.id as string)
    .order('created_at', { ascending: true })
    .limit(8);

  const { data: listing } = await client
    .from('listings')
    .select('city, rooms, total_rent_eur')
    .eq('id', application.listing_id as string)
    .maybeSingle();

  const decision = await writeReply(
    {
      agencyMessage: args.agencyMessage,
      history: (history ?? []).map((m) => `${m.author}: ${String(m.body).slice(0, 600)}`),
      availability: (profile.availability as string[]) ?? [],
      firstName: profile.first_name as string | null,
      lastName: profile.last_name as string | null,
      city: (listing?.city as string) ?? null,
      rooms: (listing?.rooms as number) ?? null,
      rentEur: (listing?.total_rent_eur as number) ?? null,
      hasDossier: Boolean(profile.dossierfacile_url),
      employment: (profile.employment_status as string) ?? null,
      monthlyIncomeEur: profile.monthly_income_cents
        ? Math.round((profile.monthly_income_cents as number) / 100)
        : null,
      kind: verdict.kind,
      // Ce qui permet à l'agent de lire l'agenda et d'écrire une demande.
      calendarAccountId: (profile.calendar_account_id as string) ?? null,
      userId,
      applicationId: application.id as string,
    },
    project,
  );
  if (!decision.body) return;

  await client.from('messages').insert({
    user_id: userId,
    application_id: application.id as string,
    listing_id: application.listing_id as string,
    direction: 'out',
    author: 'agent',
    subject: args.subject.startsWith('Re:') ? args.subject : `Re: ${args.subject}`,
    body: decision.body,
    gmail_thread_id: args.threadId,
    status: 'pending',
  });

  await logEvent({
    userId,
    type: 'reply.sent_by_agent',
    subjectType: 'application',
    subjectId: application.id as string,
    payload: {
      kind: verdict.kind,
      // Recorded so "why did it propose Tuesday?" has an answer that is not a
      // guess about what the model was thinking: the availability it could have
      // read, and the tools it actually called to read it.
      availability: readableAvailability((profile.availability as string[]) ?? []),
      tool_calls: decision.toolCalls,
      // Ce que l'agent a réclamé au client, s'il a réclamé quelque chose.
      asked_for: decision.asked,
      // Écrit tel quel dans le journal que lit l'onglet Agent.
      read_calendar: decision.toolCalls.includes('check_calendar_conflicts'),
    },
  });
}

/** Read one client's replies, classify them, and record what they mean. */
export async function watchInbox(userId: string, project: string): Promise<number> {
  const client = db();

  const { data: profile } = await client
    .from('profiles')
    .select('gmail_account_id, calendar_account_id, inbox_last_checked_at, availability, first_name, last_name, dossierfacile_url, employment_status, monthly_income_cents')
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

  const result = await fetchEmails(profile.gmail_account_id as string, query, 25, userId);
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

    // The conversation, as the Messages tab reads it. Recorded before anything
    // is decided about it: a message that arrived is a fact, whatever we go on
    // to make of it.
    await client.from('messages').insert({
      user_id: userId,
      application_id: application.id as string,
      listing_id: application.listing_id as string,
      direction: 'in',
      author: 'agency',
      subject: String(msg.subject ?? '').slice(0, 500),
      body: String(msg.messageText ?? msg.snippet ?? '').slice(0, 20000),
      gmail_message_id: messageId || null,
      gmail_thread_id: String(msg.threadId ?? '') || null,
      status: 'received',
    });

    await client
      .from('applications')
      .update({ status: verdict.kind === 'visit_offered' ? 'visit_booked' : 'replied' })
      .eq('id', application.id as string);

    // Answer it, unless it was a refusal or the thread has gone on too long.
    //
    // Queued rather than sent from here: it goes into the same outbox the
    // client's own replies use, so there is exactly one path out of this
    // system and one place where a send can fail.
    await maybeReply({
      client, userId, project, application, verdict, profile,
      agencyMessage: String(msg.messageText ?? msg.snippet ?? ''),
      threadId: String(msg.threadId ?? '') || null,
      subject: String(msg.subject ?? ''),
    });

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

      // No falling back to the Gmail connection.
      //
      // It used to read `calendar_account_id ?? gmail_account_id`, on the
      // assumption that one Google account is one Google account. It is not:
      // the Gmail connection is authorised for Gmail scopes only, and
      // GOOGLECALENDAR_CREATE_EVENT against it answers 403
      // ACCESS_TOKEN_SCOPE_INSUFFICIENT. Verified against a real connected
      // mailbox - the fallback could never have worked, only failed noisily on
      // the day a first visit was confirmed.
      //
      // Our own `calendar_events` row is already written above, so the visit is
      // never lost: only the copy in Google's calendar waits for that specific
      // authorisation.
      const calendarAccount = profile.calendar_account_id as string | null;
      if (!calendarAccount) {
        await logEvent({
          userId,
          type: 'calendar.not_connected',
          subjectType: 'application',
          subjectId: application.id as string,
          payload: { starts_at: start.toISOString() },
        });
      }
      try {
        if (!calendarAccount) throw new Error('agenda non connecté');
        const google = await createCalendarEvent(
          calendarAccount,
          {
            summary: `Visite appartement`,
            description: verdict.summary,
            location: verdict.visitLocation ?? '',
            startISO: start.toISOString(),
            endISO: end.toISOString(),
          },
          userId,
        );
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
