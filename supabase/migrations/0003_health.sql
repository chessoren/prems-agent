-- Source health, as a view rather than a query someone has to remember.
--
-- The failure this exists for is the one that costs the most and shows the
-- least: a scraper stops producing while the site keeps working and the client
-- keeps paying. Nothing errors, nothing pages, and the first signal is a
-- customer asking why they have not heard from us in three days.
--
-- The view is deliberately blunt about it. `is_stale` does not mean "a run
-- failed" - a failed run is loud and easy. It means "no run has finished in
-- three poll intervals", which is what silence actually looks like.

create or replace view public.source_health as
with runs as (
  select
    r.source_id,
    max(r.started_at)                                                     as last_run_at,
    max(r.started_at) filter (where r.status = 'ok')                      as last_ok_at,
    count(*) filter (where r.started_at > now() - interval '24 hours')    as runs_24h,
    count(*) filter (where r.status = 'failed'
                       and r.started_at > now() - interval '24 hours')    as failures_24h,
    sum(r.items_new) filter (where r.started_at > now() - interval '24 hours') as new_24h,
    -- The median would be better and is not worth a percentile scan here;
    -- the average over a day is enough to notice a source getting slower.
    round(avg(r.duration_ms) filter (where r.started_at > now() - interval '24 hours')) as avg_ms_24h
  from public.scrape_runs r
  group by r.source_id
),
listings as (
  select
    l.source_id,
    count(*)                                                           as total,
    count(*) filter (where l.status = 'active')                        as active,
    max(l.published_at)                                                as freshest_published_at,
    count(*) filter (where l.first_seen_at > now() - interval '24 hours') as discovered_24h
  from public.listings l
  group by l.source_id
)
select
  s.slug,
  s.name,
  s.enabled,
  s.contact_channel,
  s.poll_interval_seconds,

  r.last_run_at,
  r.last_ok_at,
  coalesce(r.runs_24h, 0)     as runs_24h,
  coalesce(r.failures_24h, 0) as failures_24h,
  coalesce(r.new_24h, 0)      as new_listings_24h,
  r.avg_ms_24h,

  coalesce(l.total, 0)          as listings_total,
  coalesce(l.active, 0)         as listings_active,
  coalesce(l.discovered_24h, 0) as discovered_24h,
  l.freshest_published_at,

  -- Silence, not failure. Three intervals rather than one, so a single slow
  -- run does not raise an alarm nobody will trust the second time.
  (r.last_ok_at is null
   or r.last_ok_at < now() - (interval '1 second' * 3 * s.poll_interval_seconds)) as is_stale,

  -- A source that runs cleanly and finds nothing for a day is the subtler
  -- failure: the crawl still works, but the site changed what it serves.
  (coalesce(r.runs_24h, 0) > 0 and coalesce(r.new_24h, 0) = 0) as produced_nothing_24h,

  -- Reading a source we cannot apply through wastes the crawl and, worse,
  -- shows clients apartments they have no way to get.
  (s.enabled and s.contact_channel = 'none') as unreachable_but_enabled

from public.sources s
left join runs r     on r.source_id = s.id
left join listings l on l.source_id = s.id
order by s.slug;

comment on view public.source_health is
  'Santé par source. is_stale = silence (aucun run OK depuis 3 intervalles), pas échec. Voir docs/RUNBOOK.md.';

-- The view reads tables that carry RLS and no policy, so it is reachable only
-- with the service role - which is correct: this is an operator's view, not a
-- client's. Revoking explicitly rather than relying on that being obvious.
revoke all on public.source_health from anon, authenticated;
