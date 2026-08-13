-- Phase 6: the machinery around sending an application.
--
-- The research that preceded this changed the design, so the reasoning is
-- recorded here rather than lost in a commit message.
--
-- Both HTTP routes to an agency are closed. Bien'ici's own contact endpoint
-- answers 401 without a logged-in account, and the agency sites that do accept
-- an anonymous POST - la-boite-immo, and the WordPress builds most of them run
-- on - all carry reCAPTCHA. Neither is a matter of finding the right endpoint.
--
-- Email closes both, and it is the only channel that also satisfies the three
-- things the product needs at once: no account on the portal, sent from the
-- client's own mailbox rather than ours, and a reply that lands back in that
-- same mailbox where the watcher is already looking. The form POST stays in the
-- enum because some source will eventually allow it; it is simply not the road
-- the MVP travels.

-- ===========================================================================
-- Agencies, resolved once and reused.
--
-- Bien'ici publishes a phone number and withholds the email - deliberately,
-- since the contact form behind an account is their product. Only 10% of
-- listings leak an address, usually inside the description text. The other 90%
-- expose the agency's own domain through `agencyFeeUrl`, and agencies publish
-- a contact address on their own site.
--
-- So the address is resolved per agency, not per listing: one lookup serves
-- every apartment that agency will ever post, and a failed lookup is worth
-- remembering so it is not retried on every listing.
-- ===========================================================================
create table if not exists public.agencies (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid references public.sources (id) on delete cascade,
  external_id   text,
  name          text,
  domain        text,
  email         text,
  phone         text,
  -- `pending` has never been looked up, `failed` has and produced nothing.
  -- Without the distinction, every listing from an unreachable agency would
  -- trigger a fresh crawl of a site that has no address to give.
  email_status  text not null default 'pending'
                check (email_status in ('pending', 'found', 'failed', 'manual')),
  looked_up_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint agencies_source_external_key unique (source_id, external_id)
);

create index if not exists agencies_pending_idx
  on public.agencies (email_status, looked_up_at nulls first)
  where email_status = 'pending';

alter table public.agencies enable row level security;

-- ===========================================================================
-- The outbound queue.
--
-- `applications` already exists from 0002. What it lacked was everything that
-- makes a send survivable: a scheduled time, a retry count that backs off, and
-- somewhere for a message to land when it has failed too often.
-- ===========================================================================
alter table public.applications
  add column if not exists to_email        text,
  add column if not exists scheduled_at    timestamptz not null default now(),
  add column if not exists next_attempt_at timestamptz,
  -- The Composio connected-account the message went out through. Stored per
  -- application because a client can reconnect a different mailbox, and a
  -- reply has to be traced to the mailbox that actually sent it.
  add column if not exists gmail_account_id text,
  add column if not exists dossier_url     text,
  add column if not exists dead_letter     boolean not null default false,
  add column if not exists dead_letter_reason text;

create index if not exists applications_due_idx
  on public.applications (next_attempt_at nulls first)
  where status in ('pending', 'failed') and not dead_letter;

-- ===========================================================================
-- Rate limits, as a question rather than a counter.
--
-- Counters drift. Asking the log how many messages actually went out cannot.
--
-- The per-agency limit is the one that protects the client rather than us: an
-- agent who receives four applications from the same person in a morning reads
-- it as a bot, and that costs exactly the credibility the product sells.
-- ===========================================================================
create or replace function public.may_send(p_user_id uuid, p_agency_email text)
returns table (allowed boolean, reason text)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (select * from public.settings where id = 1),
  today as (
    select count(*) as n from public.applications
    where user_id = p_user_id and sent_at > now() - interval '1 day'
  ),
  active as (
    select count(*) as n from public.applications a, cfg
    where a.user_id = p_user_id and a.status in ('sent', 'pending')
      and a.sent_at > now() - (interval '1 day' * cfg.active_application_days)
  ),
  agency as (
    select count(*) as n from public.applications
    where user_id = p_user_id and to_email = p_agency_email
      and sent_at > now() - interval '7 days'
  ),
  cap as (
    select coalesce(min(s.max_applications_per_day), 15) as daily
    from public.searches s where s.user_id = p_user_id and s.active
  )
  select
    case
      when (select n from today)  >= (select daily from cap)                then false
      when (select n from active) >= (select max_active_applications from cfg) then false
      when (select n from agency) >= 2                                      then false
      else true
    end,
    case
      when (select n from today)  >= (select daily from cap)                then 'daily_cap'
      when (select n from active) >= (select max_active_applications from cfg) then 'too_many_active'
      when (select n from agency) >= 2                                      then 'agency_cooldown'
      else null
    end;
$$;

comment on function public.may_send is
  'Trois plafonds : quotidien par client, candidatures actives, et 2 max par agence sur 7 jours. Interrogé au moment de l''envoi, jamais mis en cache.';

-- Matches waiting to become an application: scored, not yet queued, and for a
-- listing we can actually reach.
create or replace function public.matches_ready_to_send(want integer default 50)
returns table (match_id uuid, user_id uuid, listing_id uuid, agency_email text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, m.listing_id, coalesce(l.agency_email, a.email)
  from public.matches m
  join public.listings l on l.id = m.listing_id
  left join public.agencies a
    on a.source_id = l.source_id and a.external_id = l.agency_external_id
  where m.status = 'new'
    and l.status = 'active'
    and coalesce(l.agency_email, a.email) is not null
    and not exists (select 1 from public.applications ap where ap.match_id = m.id)
  order by m.score desc, m.created_at asc
  limit want;
$$;

-- What the pipeline can and cannot reach, end to end. The number that matters
-- is not how many listings we hold but how many we could actually apply for.
create or replace view public.funnel as
select
  (select count(*) from public.listings where status = 'active')                    as listings,
  (select count(*) from public.listings where status = 'active' and agency_email is not null) as contactable,
  (select count(*) from public.matches where status = 'new')                        as matches_new,
  (select count(*) from public.applications where status = 'sent')                  as sent,
  (select count(*) from public.applications where dead_letter)                      as dead_lettered,
  (select count(*) from public.application_replies)                                 as replies;

revoke all on public.funnel from anon, authenticated;
