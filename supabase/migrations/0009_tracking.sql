-- Phase 7: the record the interface will read, and the alarm nobody has to remember to check.
--
-- `events` has existed since 0002 and every layer already writes to it. What
-- was missing is the part that makes it usable: a single query a client can
-- subscribe to, and a definition of "a scraper has quietly died" that does not
-- depend on somebody running a diagnostic by hand.

-- ===========================================================================
-- One client's story, in one query.
--
-- This is the deliverable: the next session's UI is a subscription to this and
-- nothing else. It joins the three things an event might refer to so the
-- interface never has to follow a foreign key to render a line.
-- ===========================================================================
create or replace view public.client_feed as
select
  e.id,
  e.user_id,
  e.type,
  e.created_at,
  e.payload,
  l.id            as listing_id,
  l.title         as listing_title,
  l.city          as listing_city,
  l.total_rent_eur,
  l.surface_m2,
  l.rooms,
  l.url           as listing_url,
  l.agency_name,
  m.score         as match_score,
  a.status        as application_status,
  a.sent_at       as application_sent_at
from public.events e
left join public.matches      m on m.id = e.subject_id and e.subject_type = 'match'
left join public.applications a on a.id = e.subject_id and e.subject_type = 'application'
left join public.listings     l
       on l.id = coalesce(m.listing_id, a.listing_id, (e.payload->>'listing_id')::uuid)
order by e.created_at desc;

-- The view inherits nothing from RLS on its own, so it is locked and the
-- interface reads `events` directly - which *is* under RLS, scoped to
-- auth.uid(). A convenience view must not become the hole in the policy.
revoke all on public.client_feed from anon, authenticated;

-- ===========================================================================
-- Alerting: silence, detected without anyone looking.
--
-- The expensive failure is not a crash. It is a scraper that stops producing
-- while the site keeps working and the client keeps paying. `source_health`
-- already computes the condition; this turns it into a row in the event log,
-- which is the thing that already has somewhere to go.
--
-- Fires once per hour per source at most: an alarm that repeats every minute
-- is an alarm people learn to ignore.
-- ===========================================================================
create or replace function public.raise_health_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  raised integer := 0;
  r record;
begin
  for r in
    select slug, is_stale, produced_nothing_24h, unreachable_but_enabled, last_ok_at
    from public.source_health
    where enabled and (is_stale or produced_nothing_24h or unreachable_but_enabled)
  loop
    -- One alert per source per hour, whatever the number of conditions.
    if not exists (
      select 1 from public.events
      where type = 'source.alert'
        and payload->>'source' = r.slug
        and created_at > now() - interval '1 hour'
    ) then
      insert into public.events (user_id, type, subject_type, payload)
      values (
        null,
        'source.alert',
        'source',
        jsonb_build_object(
          'source', r.slug,
          'is_stale', r.is_stale,
          'produced_nothing_24h', r.produced_nothing_24h,
          'unreachable_but_enabled', r.unreachable_but_enabled,
          'last_ok_at', r.last_ok_at
        )
      );
      raised := raised + 1;
    end if;
  end loop;
  return raised;
end;
$$;

-- Runs in the database rather than in a worker: an alert about the pipeline
-- being down should not depend on the pipeline being up.
select cron.schedule(
  'prems-health-alerts',
  '*/10 * * * *',
  $$select public.raise_health_alerts()$$
) where not exists (select 1 from cron.job where jobname = 'prems-health-alerts');

-- ===========================================================================
-- Replies, and the calendar.
--
-- The mailbox watcher reads the client's inbox, classifies what came back, and
-- - when a visit is offered - has to put it somewhere. `calendar_events` is
-- ours, so the front end has a source that does not require Google to answer.
-- ===========================================================================
create table if not exists public.calendar_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  application_id    uuid references public.applications (id) on delete set null,
  listing_id        uuid references public.listings (id) on delete set null,
  title             text not null,
  location          text,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  -- The id Google gave it, so a later edit updates rather than duplicates.
  google_event_id   text,
  source            text not null default 'reply_parser'
                    check (source in ('reply_parser', 'manual', 'agency')),
  created_at        timestamptz not null default now(),
  constraint calendar_events_span check (ends_at > starts_at)
);

create index if not exists calendar_events_user_idx
  on public.calendar_events (user_id, starts_at);

alter table public.calendar_events enable row level security;

drop policy if exists "own calendar readable" on public.calendar_events;
create policy "own calendar readable"
  on public.calendar_events for select to authenticated
  using ((select auth.uid()) = user_id);

-- Where the watcher got to, per mailbox. Without it, every morning's pass
-- re-reads and re-classifies the same thread, and the LLM bill is charged for
-- rediscovering what it already knew.
alter table public.profiles
  add column if not exists inbox_last_checked_at timestamptz,
  add column if not exists calendar_account_id   text;

-- Realtime for the two tables an interface subscribes to. RLS is what keeps a
-- subscription scoped to one person; this only makes the stream exist.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'applications')
    then
      alter publication supabase_realtime add table public.applications;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calendar_events')
    then
      alter publication supabase_realtime add table public.calendar_events;
    end if;
  end if;
end $$;
