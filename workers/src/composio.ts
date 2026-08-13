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

/** Execute one Composio tool against one connected account. */
export async function execute(
  slug: string,
  connectedAccountId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return call<ToolResult>(`/tools/execute/${slug}`, {
    method: 'POST',
    body: JSON.stringify({ connected_account_id: connectedAccountId, arguments: args }),
  });
}

export interface SendArgs {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Prems is blind-copied so replies can be classified without reading the rest of the inbox. */
  readonly bcc?: string;
  readonly attachmentUrl?: string | null;
}

export async function sendEmail(connectedAccountId: string, args: SendArgs): Promise<ToolResult> {
  // The dossier travels as a link, never as an attachment. DossierFacile is the
  // French state's own verified tenancy file: a link is what agencies already
  // recognise, it stays current if the client updates it, and it keeps the
  // sensitive documents out of an outbox we do not control.
  const body = args.attachmentUrl
    ? `${args.body}\n\nMon dossier de location (DossierFacile, vérifié) :\n${args.attachmentUrl}`
    : args.body;

  return execute('GMAIL_SEND_EMAIL', connectedAccountId, {
    recipient_email: args.to,
    subject: args.subject,
    body,
    ...(args.bcc ? { bcc: [args.bcc] } : {}),
    is_html: false,
  });
}

/** Recent messages, for the reply watcher. */
export async function fetchEmails(
  connectedAccountId: string,
  query: string,
  max = 25,
): Promise<ToolResult> {
  return execute('GMAIL_FETCH_EMAILS', connectedAccountId, {
    query,
    max_results: max,
    verbose: true,
  });
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
): Promise<ToolResult> {
  return execute('GOOGLECALENDAR_CREATE_EVENT', connectedAccountId, {
    summary: event.summary,
    description: event.description ?? '',
    location: event.location ?? '',
    start_datetime: event.startISO,
    event_duration_hour: 0,
    event_duration_minutes: Math.max(
      15,
      Math.round((Date.parse(event.endISO) - Date.parse(event.startISO)) / 60000),
    ),
  });
}
