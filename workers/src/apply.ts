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
import { sendEmail } from './composio.js';
import { writeDraft, type DraftInput } from './draft.js';

/** Backoff between attempts. Five failures and the message is dead-lettered. */
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
 */
export async function queueApplications(limit = 50): Promise<number> {
  const client = db();
  const { data } = await client.rpc('matches_ready_to_send', { want: limit });
  const ready = (data ?? []) as Ready[];
  let queued = 0;

  for (const row of ready) {
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
      await client.from('matches').update({ status: 'queued' }).eq('id', row.match_id);
      queued += 1;
    }
  }
  return queued;
}

/**
 * Send what is due.
 *
 * A client with no connected mailbox is not an error and not a retry: there is
 * nothing to fix by trying again, so it is dead-lettered immediately with a
 * reason a human can act on.
 */
export async function sendDue(project: string, limit = 20): Promise<{ sent: number; failed: number }> {
  const client = db();
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
    const { data: profile } = await client
      .from('profiles')
      .select('first_name, last_name, employment_status, monthly_income_cents, needs_guarantor, dossierfacile_url, gmail_account_id')
      .eq('id', app.user_id as string)
      .maybeSingle();

    if (!profile?.gmail_account_id) {
      await client
        .from('applications')
        .update({
          dead_letter: true,
          dead_letter_reason: 'aucune boîte Gmail connectée pour ce client',
          status: 'failed',
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

    const draft = await writeDraft(input, project);
    const attempts = ((app.attempts as number) ?? 0) + 1;

    try {
      const result = await sendEmail(profile.gmail_account_id as string, {
        to: app.to_email as string,
        subject: draft.subject,
        body: `${draft.body}\n\n${listing?.url ?? ''}`.trim(),
        bcc: (app.bcc_address as string) ?? 'prems@getmira.run',
        attachmentUrl: (profile.dossierfacile_url as string) ?? null,
      });

      if (result.successful === false) throw new Error(result.error ?? 'envoi refusé par Composio');

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

      await client.from('matches').update({ status: 'applied' }).eq('id', app.match_id as string);

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
