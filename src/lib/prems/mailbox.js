/**
 * Connecting the client's mailbox, from the browser's side.
 *
 * Nothing sensitive lives here: the Composio key stays in the `connect-mailbox`
 * edge function, which is called with the client's own Supabase JWT and can
 * therefore only ever attach a mailbox to the account that asked.
 *
 * This is the gate on the whole product. Prems applies *from the client's
 * mailbox* and reads the agencies' replies *in that mailbox*; with no mailbox,
 * `matches_ready_to_send` returns nothing and the agent detects without ever
 * acting. That is deliberate - an earlier version consumed the matches anyway
 * and lost 103 apartments on the day someone finally connected - but it means
 * this button is what turns the product on.
 */
import { client, ensureSession } from './supabase.js';

const FUNCTION = `${import.meta.env?.PUBLIC_SUPABASE_URL || 'https://budbfhrqdeghyufeizpv.supabase.co'}/functions/v1/connect-mailbox`;

async function call(body) {
  const session = await ensureSession();
  const token = session?.access_token;
  if (!token) throw new Error('session absente');

  const response = await fetch(FUNCTION, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`connect-mailbox: ${response.status}`);
  return response.json();
}

/** Where the person stands, read from their profile rather than from a flag. */
export async function status() {
  const supabase = client();
  if (!supabase) return { gmail: false, calendar: false };

  try {
    await ensureSession();
    const { data } = await supabase
      .from('profiles')
      .select('gmail_account_id, calendar_account_id')
      .maybeSingle();

    return {
      gmail: Boolean(data?.gmail_account_id),
      calendar: Boolean(data?.calendar_account_id),
    };
  } catch {
    return { gmail: false, calendar: false };
  }
}

/** Open Google's consent screen. Returns the window we opened, if any. */
export async function connect(service = 'gmail') {
  const { url } = await call({ action: 'start', service });
  if (!url) throw new Error('lien indisponible');
  return window.open(url, '_blank', 'noopener');
}

/**
 * Ask the server whether the authorisation went through.
 *
 * Polled rather than awaited on a redirect: Google's consent runs in another
 * tab, and there is no event here when it finishes. The server refuses to
 * write anything until Composio reports the account ACTIVE, so a person who
 * closes the tab halfway simply stays unconnected instead of ending up with a
 * mailbox the worker cannot actually use.
 */
export async function waitForConnection(service = 'gmail', { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await call({ action: 'finish', service });
      if (result.connected) return true;
    } catch {
      /* transient - keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}
