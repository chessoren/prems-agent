-- The agency's own address, promoted out of the raw payload.
--
-- This column is the answer to a research question that turned out to reframe
-- the whole of phase 6. Both HTTP routes to an agency are closed:
--
--   * Bien'ici's POST /api/contactRequests returns 401 without a logged-in
--     account, so applying through the portal means operating an account.
--   * Agency sites that do accept an anonymous POST - la-boite-immo, and the
--     WordPress builds most of them run - all carry reCAPTCHA on the form.
--
-- Email closes both. It needs no account on the portal, no captcha is involved,
-- it can be sent from the client's own mailbox rather than ours, and - the part
-- that matters most downstream - the agency's reply lands in that same mailbox,
-- which is where the reply-watching agent will already be looking.
--
-- Extracted rather than parsed at read time: a regex over the raw JSONB on
-- every match would be the most expensive thing in the hot path, for a value
-- that never changes once the listing is written.
alter table public.listings
  add column if not exists agency_email text;

-- Backfill from what has already been collected.
update public.listings
   -- `substring` rather than `regexp_matches`: the latter is set-returning and
   -- Postgres refuses it in an UPDATE.
   set agency_email = lower(substring(raw::text from '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'))
 where agency_email is null
   and raw::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}';

-- Addresses that belong to the portal or to a tracker are not the agency, and
-- writing to them either bounces or reaches the wrong party.
update public.listings
   set agency_email = null
 where agency_email is not null
   and agency_email ~* '(bienici|no-?reply|postmaster|sentry|wixpress|example\.)';

create index if not exists listings_contactable_idx
  on public.listings (agency_email)
  where status = 'active' and agency_email is not null;

-- How much of the catalogue we can actually reach. Being able to see an
-- apartment and not being able to apply for it is worse than not seeing it.
create or replace view public.contactability as
select
  s.slug                                                          as source,
  count(*)                                                        as listings,
  count(*) filter (where l.agency_email is not null)              as with_email,
  round(100.0 * count(*) filter (where l.agency_email is not null) / nullif(count(*), 0), 1) as pct_reachable
from public.listings l
join public.sources s on s.id = l.source_id
where l.status = 'active'
group by s.slug;

revoke all on public.contactability from anon, authenticated;
