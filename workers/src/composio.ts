/**
 * Composio: the client's own mailbox and calendar, reachable from a worker.
 *
 * Applications are sent from the client's Gmail rather than from a Prems
 * address, and that is not a stylistic choice. It is what makes the agency's
 * reply land in the client's own inbox - which is the only place a reply can be
 * watched without asking anyone to forward anything - and it is what makes the
 * message read as a person writing rather than a service blasting.
 *
 * Every call is scoped to a connected account. A worker that could reach a
 * mailbox without naming whose it is would be one bug away from sending a
 * client's application from someone else's address.
 */

const BASE = 'https://backend.composio.dev/api/v3';

function apiKey(): string {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error('COMPOSIO_API_KEY manquant');
  return key;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`composio ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface ToolResult {
  successful?: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Execute one Composio tool against one connected account.
 *
 * `user_id` is not optional, whatever the shape of the object suggests. Sending
 * only `connected_account_id` is answered with a 400 and
 * `ActionExecute_ConnectedAccountEntityIdRequired` - which means every
 * application would have failed, retried five times on a growing backoff, and
 * dead-lettered, on a fault no retry could ever fix.
 *
 * Found by sending a real message through a real connected mailbox rather than
 * by reading the code, which had looked correct since it was written. It is the
 * same value we set when the link was created, so it is always the Prems
 * account uuid.
 */
export async function execute(
  slug: string,
  connectedAccountId: string,
  args: Record<string, unknown>,
  userId?: string | null,
): Promise<ToolResult> {
  return call<ToolResult>(`/tools/execute/${slug}`, {
    method: 'POST',
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      ...(userId ? { user_id: userId } : {}),
      arguments: args,
    }),
  });
}

/**
 * Can this key actually do anything?
 *
 * Composio keys are scoped, and a read-only key answers every listing call
 * happily while refusing every execution. Discovered the hard way: the key
 * supplied for this project lists Gmail's 61 tools and returns 403
 * `tool_execution` on all of them. Without this check the failure surfaces as a
 * confusing 403 on the first real application, long after the mailbox was
 * connected and everything looked ready.
 *
 * Checked against a deliberately invalid account id, so nothing can be sent:
 * a permissions failure answers 403 before the account is ever looked up.
 */
export async function canExecute(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const response = await fetch(`${BASE}/tools/execute/GMAIL_FETCH_EMAILS`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connected_account_id: '__preflight__',
        arguments: { max_results: 1 },
      }),
    });
    if (response.status !== 403) return { ok: true, reason: null };

    const body = (await response.json()) as { error?: { slug?: string; message?: string } };
    if (body.error?.slug === 'APIKey_InsufficientPermissions') {
      return {
        ok: false,
        reason:
          'la clé Composio est en lecture seule : il lui manque le droit "tool_execution". ' +
          'Aucun e-mail ne peut être envoyé ni lu tant qu\'elle n\'est pas élargie.',
      };
    }
    return { ok: true, reason: null };
  } catch (error) {
    // A network failure is not a permissions failure; do not block on it.
    return { ok: true, reason: null };
  }
}

export interface SendArgs {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Prems is blind-copied so replies can be classified without reading the rest of the inbox. */
  readonly bcc?: string;
  readonly attachmentUrl?: string | null;
  /** Reply on an existing Gmail thread instead of opening a new one. */
  readonly threadId?: string | null;
}

export async function sendEmail(
  connectedAccountId: string,
  args: SendArgs,
  userId?: string | null,
): Promise<ToolResult> {
  // The dossier travels as a link, never as an attachment. DossierFacile is the
  // French state's own verified tenancy file: a link is what agencies already
  // recognise, it stays current if the client updates it, and it keeps the
  // sensitive documents out of an outbox we do not control.
  const body = args.attachmentUrl
    ? `${args.body}\n\nMon dossier de location (DossierFacile, vérifié) :\n${args.attachmentUrl}`
    : args.body;

  return execute(
    'GMAIL_SEND_EMAIL',
    connectedAccountId,
    {
      recipient_email: args.to,
      subject: args.subject,
      body,
      ...(args.bcc ? { bcc: [args.bcc] } : {}),
      // Without this every follow-up opens a new thread, and the agent has to
      // reconcile four separate conversations about one apartment.
      ...(args.threadId ? { thread_id: args.threadId } : {}),
      is_html: false,
    },
    userId,
  );
}

/** Recent messages, for the reply watcher. */
export async function fetchEmails(
  connectedAccountId: string,
  query: string,
  max = 25,
  userId?: string | null,
): Promise<ToolResult> {
  return execute(
    'GMAIL_FETCH_EMAILS',
    connectedAccountId,
    { query, max_results: max, verbose: true },
    userId,
  );
}

export async function createCalendarEvent(
  connectedAccountId: string,
  event: {
    summary: string;
    description?: string;
    location?: string;
    startISO: string;
    endISO: string;
  },
  userId?: string | null,
): Promise<ToolResult> {
  return execute(
    'GOOGLECALENDAR_CREATE_EVENT',
    connectedAccountId,
    {
      summary: event.summary,
      description: event.description ?? '',
      location: event.location ?? '',
      start_datetime: event.startISO,
      event_duration_hour: 0,
      event_duration_minutes: Math.max(
        15,
        Math.round((Date.parse(event.endISO) - Date.parse(event.startISO)) / 60000),
      ),
    },
    userId,
  );
}
