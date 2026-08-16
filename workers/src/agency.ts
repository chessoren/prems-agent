/**
 * Resolving an agency's email from its own website.
 *
 * Contactability is the ceiling on the product: an apartment we can see and
 * cannot write to is worth nothing to a client. Bien'ici publishes a phone and
 * withholds the address, so the address has to come from the agency itself -
 * which publishes one, because it wants to be contacted.
 *
 * Politeness is not optional here. These are small businesses' own servers, and
 * we visit each one a handful of times, once, and never again once we have an
 * answer. A failed lookup is recorded so it is not retried on every listing
 * that agency posts.
 */
import { db, logEvent } from './db.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Where a French agency puts its contact address, in order of likelihood. */
const PATHS = ['/contact', '/contact.html', '/nous-contacter', '/', '/mentions-legales'] as const;

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Addresses that are not the agency.
 *
 * The CMS vendor's own support address appears in the footer of every site it
 * powers - writing to it would send hundreds of clients' applications to a
 * software company. That is the mistake this list exists to prevent.
 */
const NOT_AN_AGENCY =
  /(sentry|wixpress|@example|no-?reply|noreply|postmaster|webmaster@|@w3\.org|@schema\.org|@immo-facile|@netty\.|@laboiteimmo|@apimo|@hektor|@sarbacane|@mailchimp|@googlemail)/i;

/**
 * Mailboxes that exist for a different purpose.
 *
 * `rgpd@` and `dpo@` are data-protection contacts. A rental application sent
 * there is both useless to the client and a small act of rudeness towards a
 * mailbox that handles legal requests.
 */
const WRONG_DEPARTMENT = /^(rgpd|dpo|privacy|donnees|legal|juridique|recrutement|rh|facturation|compta)@/i;

/**
 * Form placeholders, which are not addresses at all.
 *
 * A contact form's `placeholder="exemple@domaine.fr"` sits in the HTML looking
 * exactly like the thing we came for. The second run of this resolver stored
 * four of them. They are the example the site shows a human, and writing to one
 * reaches nobody - silently, since it is a plausible domain that simply bounces.
 */
const PLACEHOLDER =
  /^(exemple|example|votre|your|nom|name|email|mail|adresse|address|prenom|test|user|utilisateur|monmail|abc|xyz|john\.?doe|jean\.?dupont)@|@(domaine|domain|exemple|example|fournisseur|monsite|mydomain|site|societe|email|mail|test|adresse)\./i;

/**
 * Retina image filenames match an email regex.
 *
 * `mobile-century21_hero-6@2x.webp` is a picture, and the first run of this
 * resolver happily stored several of them as agency addresses. The regex is not
 * wrong - `@` followed by a dotted suffix is genuinely ambiguous - so the
 * discriminator has to be the suffix: an email ends in a TLD, never in a file
 * extension, and no real TLD is a digit-led token like `2x`.
 */
const FILE_SUFFIX =
  /\.(webp|png|jpe?g|gif|svg|avif|bmp|ico|css|js|woff2?|ttf|eot|mp4|webm|pdf|zip)$/i;

function looksLikeEmail(candidate: string): boolean {
  if (FILE_SUFFIX.test(candidate)) return false;
  const [local, domain] = candidate.split('@');
  if (!local || !domain) return false;
  const tld = domain.split('.').pop() ?? '';
  // A TLD is letters only and at least two of them. "2x" is not a country.
  return /^[a-z]{2,24}$/i.test(tld) && domain.includes('.');
}

/** Prefer a mailbox that reads like a business address over a personal one. */
function pick(candidates: readonly string[], domain: string): string | null {
  const clean = [...new Set(candidates.map((e) => e.toLowerCase()))].filter(
    (e) =>
      looksLikeEmail(e) &&
      !NOT_AN_AGENCY.test(e) &&
      !WRONG_DEPARTMENT.test(e) &&
      !PLACEHOLDER.test(e) &&
      e.length < 90,
  );
  if (clean.length === 0) return null;

  const bare = domain.replace(/^www\./, '');
  // An address on the agency's own domain is the agency's. One on gmail.com
  // might still be theirs - many small agencies use one - so it is kept, just
  // ranked below.
  const sameDomain = clean.filter((e) => e.endsWith(`@${bare}`));
  const pool = sameDomain.length > 0 ? sameDomain : clean;

  const preferred = ['contact@', 'info@', 'agence@', 'accueil@', 'location@', 'gestion@'];
  for (const prefix of preferred) {
    const hit = pool.find((e) => e.startsWith(prefix));
    if (hit) return hit;
  }
  return pool[0] ?? null;
}

export { pick as pickForTest };

export async function resolveOne(
  agencyId: string,
  domain: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const found: string[] = [];

  for (const path of PATHS) {
    try {
      const response = await fetch(`https://${domain}${path}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: signal ?? AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;

      const html = (await response.text()).slice(0, 400_000);

      // mailto: first - an address a site links is an address it wants used,
      // unlike one that happens to appear in a script or a tracking pixel.
      for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
        if (m[1]) found.push(m[1]);
      }
      for (const m of html.matchAll(EMAIL)) found.push(m[0]);

      if (pick(found, domain)) break;
    } catch {
      /* one path failing is not the agency failing */
    }
  }

  return pick(found, domain);
}

export async function resolveAgencies(limit = 25): Promise<{ tried: number; found: number; propagated: number }> {
  const client = db();
  const { data } = await client.rpc('agencies_needing_email', { want: limit });
  const agencies = (data ?? []) as Array<{ id: string; domain: string; name: string }>;

  let found = 0;
  for (const agency of agencies) {
    const email = await resolveOne(agency.id, agency.domain);
    await client
      .from('agencies')
      .update({
        email,
        email_status: email ? 'found' : 'failed',
        looked_up_at: new Date().toISOString(),
      })
      .eq('id', agency.id);
    if (email) found += 1;
  }

  // One statement pushes every newly-found address onto that agency's listings.
  const { data: propagated } = await client.rpc('propagate_agency_emails');
  const count = typeof propagated === 'number' ? propagated : 0;

  if (found > 0 || count > 0) {
    await logEvent({
      type: 'agencies.resolved',
      payload: { tried: agencies.length, found, listings_unlocked: count },
    });
  }

  return { tried: agencies.length, found, propagated: count };
}
