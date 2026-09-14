/**
 * The application worker.
 *
 * Turns a match into a message in an agency's inbox, or into a recorded reason
 * why not. Never into silence.
 *
 * The ordering is the safety property: the application row is written *before*
 * the send, not after. A crash between "Gmail accepted it" and "we wrote it
 * down" would otherwise produce a second application to the same agent - the
 * single most damaging thing this system can do to a client, because it is
 * exactly what makes a human look like a bot.
 */
import { db, logEvent } from './db.js';
import { canExecute, sendEmail } from './composio.js';
import { writeDraft, type DraftInput } from './draft.js';

/**
 * Backoff between attempts. Five failures and the message is dead-lettered.
 *
 * Dead-lettering is for a message that cannot succeed - a rejected address, a
 * malformed send. It is never for a precondition the client can still satisfy.
 */
const BACKOFF_MINUTES = [1, 5, 30, 180, 720] as const;
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

interface Ready {
  match_id: string;
  user_id: string;
  listing_id: string;
  agency_email: string;
}

function nextAttemptAt(attempts: number): string {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, MAX_ATTEMPTS - 1)] ?? 720;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Queue applications for matches that are ready.
 *
 * Queuing and sending are separate passes on purpose: a row exists, visible and
 * inspectable, before anything leaves the building.
 *
 * `source` names the function that decides which matches qualify, and that is
 * the only thing the demonstration changes. `matches_ready_to_send_demo` (0018)
 * has the same signature and the same guards, restricted to the fabricated
 * source - so the code below, the rate limits, the writing and the sending are
 * shared to the line between a demonstration and a Tuesday afternoon.
 */
export async function queueApplications(
  limit = 50,
  source: 'matches_ready_to_send' | 'matches_ready_to_send_demo' = 'matches_ready_to_send',
): Promise<number> {
  const client = db();
  const { data } = await client.rpc(source, { want: limit });
  const ready = (data ?? []) as Ready[];
  let queued = 0;

  // The batch sees its own inserts.
  //
  // `matches_ready_to_send` evaluates "has this client already applied for this
  // listing?" once, when the batch is read. A client holding two searches that
  // both match one apartment therefore appears twice in the same batch, and
  // without this both rows become applications - two messages to the same agent
  // about the same flat from the same person. A unique index (0012) makes it
  // impossible; this makes it a skip with a reason rather than a crash.
  const claimed = new Set<string>();

  for (const row of ready) {
    const pair = `${row.user_id}:${row.listing_id}`;
    if (claimed.has(pair)) {
      await client
        .from('matches')
        .update({ status: 'skipped', skipped_reason: 'duplicate_of_your_other_search' })
        .eq('id', row.match_id);
      continue;
    }

    const { data: gate } = await client.rpc('may_send', {
      p_user_id: row.user_id,
      p_agency_email: row.agency_email,
    });
    const verdict = Array.isArray(gate) ? gate[0] : gate;

    if (!verdict?.allowed) {
      // Not a failure - a limit doing its job. Recorded so "why did nothing go
      // out for me today?" has an answer.
      await client
        .from('matches')
        .update({ status: 'skipped', skipped_reason: verdict?.reason ?? 'rate_limited' })
        .eq('id', row.match_id);
      continue;
    }

    const { error } = await client.from('applications').insert({
      match_id: row.match_id,
      user_id: row.user_id,
      listing_id: row.listing_id,
      channel: 'email',
      status: 'pending',
      to_email: row.agency_email,
      scheduled_at: new Date().toISOString(),
    });

    if (!error) {
      claimed.add(pair);
      await client.from('matches').update({ status: 'queued' }).eq('id', row.match_id);
      queued += 1;
    }
  }
  return queued;
}

/**
 * The outbox: every follow-up, whoever wrote it.
 *
 * The agent's replies and the client's own go out through exactly the same
 * path. That is the point - one place a send can fail, one retry policy, one
 * record of what left. A client taking over a thread in the Prems interface is
 * writing a row in the same table the agent writes, and the agency cannot tell
 * the difference because there is none: both leave from the same mailbox, on
 * the same thread, over the same name.
 */
export async function sendOutbox(limit = 20): Promise<{ sent: number; failed: number }> {
  const client = db();
  const { data } = await client.rpc('messages_to_send', { want: limit });
  const queue = (data ?? []) as Array<{
    message_id: string;
    user_id: string;
    application_id: string;
    to_email: string;
    subject: string | null;
    body: string;
    gmail_thread_id: string | null;
    gmail_account_id: string;
  }>;

  let sent = 0;
  let failed = 0;

  for (const message of queue) {
    try {
      const result = await sendEmail(
        message.gmail_account_id,
        {
          to: message.to_email,
          subject: message.subject ?? 'Re: votre annonce',
          body: message.body,
          bcc: 'prems@getmira.run',
          threadId: message.gmail_thread_id,
        },
        message.user_id,
      );
      if (result.successful === false) throw new Error(result.error ?? 'envoi refusé');

      const data = (result.data ?? {}) as Record<string, any>;
      const response = (data.response_data ?? data) as Record<string, any>;

      await client
        .from('messages')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          gmail_message_id: response.id ?? null,
          gmail_thread_id: response.threadId ?? message.gmail_thread_id,
        })
        .eq('id', message.message_id);

      await logEvent({
        userId: message.user_id,
        type: 'message.sent',
        subjectType: 'application',
        subjectId: message.application_id,
        payload: { to: message.to_email },
      });
      sent += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Attempts are counted on the row so `messages_to_send` stops offering a
      // message that has failed five times, without a second bookkeeping table.
      const { data: current } = await client
        .from('messages')
        .select('attempts')
        .eq('id', message.message_id)
        .single();
      const attempts = Number(current?.attempts ?? 0) + 1;

      await client
        .from('messages')
        .update({
          attempts,
          last_error: reason.slice(0, 500),
          status: attempts >= 5 ? 'failed' : 'pending',
        })
        .eq('id', message.message_id);
      failed += 1;
    }
  }

  return { sent, failed };
}

/**
 * Tell the runners-up, once there is something they actually lost to.
 *
 * A match stays `new` - eligible, and rescuable if the winner's send fails -
 * until an application for that listing has genuinely left the building. Only
 * then is "somebody with higher priority was served" a true sentence, and only
 * then is it written down.
 */
export async function closeLostMatches(): Promise<number> {
  const client = db();
  const { data } = await client.rpc('close_lost_matches');
  return typeof data === 'number' ? data : 0;
}

/**
 * Send what is due.
 *
 * A client with no connected mailbox is not an error and not a retry: there is
 * nothing to fix by trying again, so it is dead-lettered immediately with a
 * reason a human can act on.
 */
export async function sendDue(limit = 20): Promise<{ sent: number; failed: number }> {
  const client = db();

  // Fail loudly, before touching a single application. A read-only Composio key
  // refuses every send while answering every listing call, so without this the
  // first symptom is a 403 on a real client's application.
  const preflight = await canExecute();
  if (!preflight.ok) {
    await logEvent({ type: 'composio.misconfigured', payload: { reason: preflight.reason } });
    throw new Error(preflight.reason ?? "Composio ne peut pas exécuter d'outil");
  }
  // Les réservations qu'un conteneur tué aurait laissées en plan. Rendues à la
  // file avant de la lire, sinon elles y resteraient invisibles.
  await client.rpc('release_stale_sends');

  const now = new Date().toISOString();

  const { data: due } = await client
    .from('applications')
    .select('*')
    .in('status', ['pending', 'failed'])
    .eq('dead_letter', false)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  let sent = 0;
  let failed = 0;

  for (const app of due ?? []) {
    // Réserver la ligne avant de la travailler.
    //
    // Lire la file puis envoyer n'est pas atomique, et il y a régulièrement deux
    // processus dans cette boucle : le tick `prems-apply` toutes les deux
    // minutes, et la boucle de démonstration. Mesuré le 28 août : la même
    // candidature partie deux fois vers la même agence à une seconde
    // d'intervalle, sur deux fils Gmail distincts — exactement ce que tout ce
    // module s'emploie à rendre impossible.
    //
    // L'UPDATE conditionnel tranche : PostgreSQL sérialise les deux écritures,
    // le premier obtient la ligne, le second ne voit plus le statut qu'il
    // exigeait et repart avec zéro ligne. Pas de verrou applicatif, pas de bail
    // à renouveler. `release_stale_sends` (0019) rend à la file celles qu'un
    // conteneur tué aurait laissées réservées.
    const { data: claimed } = await client
      .from('applications')
      .update({ status: 'sending', sending_since: new Date().toISOString() })
      .eq('id', app.id as string)
      .in('status', ['pending', 'failed'])
      .select('id');
    if (!claimed?.length) continue;

    const { data: profile } = await client
      .from('profiles')
      .select(
        'first_name, last_name, employment_status, monthly_income_cents, needs_guarantor, dossierfacile_url, gmail_account_id',
      )
      .eq('id', app.user_id as string)
      .maybeSingle();

    if (!profile?.gmail_account_id) {
      // Defence in depth: matches_ready_to_send already excludes clients with
      // no mailbox, so reaching here means one was disconnected after queuing.
      //
      // Deliberately NOT dead-lettered. An earlier version did, on the
      // reasoning that no retry creates a mailbox - true, but a reconnection
      // does, and a dead letter is permanent. It consumed 103 matches in
      // twenty minutes: 103 apartments that would have stayed lost on the day
      // the client finally connected their Gmail.
      await client
        .from('applications')
        .update({
          status: 'failed',
          last_error: 'aucune boîte Gmail connectée',
          next_attempt_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
        })
        .eq('id', app.id as string);
      await logEvent({
        userId: app.user_id as string,
        type: 'application.blocked',
        subjectType: 'application',
        subjectId: app.id as string,
        payload: { reason: 'gmail_not_connected' },
      });
      failed += 1;
      continue;
    }

    const { data: listing } = await client
      .from('listings')
      .select('title, city, rooms, surface_m2, total_rent_eur, agency_name, url')
      .eq('id', app.listing_id as string)
      .single();

    const input: DraftInput = {
      firstName: profile.first_name as string | null,
      lastName: profile.last_name as string | null,
      employment: profile.employment_status as string | null,
      monthlyIncomeEur: profile.monthly_income_cents
        ? Math.round((profile.monthly_income_cents as number) / 100)
        : null,
      hasGuarantor: Boolean(profile.needs_guarantor),
      city: (listing?.city as string) ?? null,
      rooms: (listing?.rooms as number) ?? null,
      surfaceM2: listing?.surface_m2 ? Number(listing.surface_m2) : null,
      rentEur: (listing?.total_rent_eur as number) ?? 0,
      title: (listing?.title as string) ?? null,
      agencyName: (listing?.agency_name as string) ?? null,
      hasDossier: Boolean(profile.dossierfacile_url),
    };

    const draft = await writeDraft(input);
    const attempts = ((app.attempts as number) ?? 0) + 1;

    try {
      const result = await sendEmail(
        profile.gmail_account_id as string,
        {
          to: app.to_email as string,
          subject: draft.subject,
          body: `${draft.body}\n\n${listing?.url ?? ''}`.trim(),
          bcc: (app.bcc_address as string) ?? 'prems@getmira.run',
          attachmentUrl: (profile.dossierfacile_url as string) ?? null,
        },
        app.user_id as string,
      );

      if (result.successful === false) throw new Error(result.error ?? 'envoi refusé par Composio');

      // The first message of the thread, in the conversation the Messages tab
      // reads. Written here rather than inferred later: the interface must be
      // able to show what was actually sent, not a reconstruction of it.
      const responseData = (result.data ?? {}) as Record<string, any>;
      const gmail = (responseData.response_data ?? responseData) as Record<string, any>;
      await client.from('messages').insert({
        user_id: app.user_id as string,
        application_id: app.id as string,
        listing_id: app.listing_id as string,
        direction: 'out',
        author: 'agent',
        subject: draft.subject,
        body: draft.body,
        gmail_message_id: gmail.id ?? null,
        gmail_thread_id: gmail.threadId ?? null,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      await client
        .from('applications')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          subject: draft.subject,
          body: draft.body,
          attempts,
          gmail_account_id: profile.gmail_account_id,
          dossier_url: profile.dossierfacile_url ?? null,
          provider_message_id: (result.data?.id as string) ?? null,
          last_error: null,
        })
        .eq('id', app.id as string);

      await client
        .from('matches')
        .update({ status: 'applied' })
        .eq('id', app.match_id as string);

      await logEvent({
        userId: app.user_id as string,
        type: 'application.sent',
        subjectType: 'application',
        subjectId: app.id as string,
        payload: {
          to: app.to_email,
          subject: draft.subject,
          listing_url: listing?.url,
          with_dossier: Boolean(profile.dossierfacile_url),
        },
      });
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attempts >= MAX_ATTEMPTS;

      await client
        .from('applications')
        .update({
          status: 'failed',
          attempts,
          last_error: message.slice(0, 1000),
          next_attempt_at: exhausted ? null : nextAttemptAt(attempts),
          dead_letter: exhausted,
          dead_letter_reason: exhausted ? `${MAX_ATTEMPTS} tentatives échouées` : null,
        })
        .eq('id', app.id as string);

      await logEvent({
        userId: app.user_id as string,
        type: exhausted ? 'application.dead_lettered' : 'application.retry',
        subjectType: 'application',
        subjectId: app.id as string,
        payload: { attempts, error: message.slice(0, 300) },
      });
      failed += 1;
    }
  }

  return { sent, failed };
}
