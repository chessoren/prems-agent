-- A listing has to record that it was considered, not merely that it matched.
--
-- The first version of `listings_needing_match` asked for listings with no row
-- in `matches`. That silently assumed every listing produces at least one - but
-- a listing nobody is eligible for produces none, so it stayed in the queue for
-- ever and was re-examined on every run. Observed in production: the backlog
-- went 320 -> 316 in two minutes while each run dutifully "examined" 200
-- listings, almost all of them the same ones as the run before.
--
-- The cost was not correctness - nothing was matched twice, the unique
-- constraint saw to that - but the queue could never drain, and the newest
-- listings sat behind a wall of unmatchable ones. On a product whose entire
-- claim is speed, that is the expensive kind of quiet.
alter table public.listings
  add column if not exists matched_at timestamptz;

-- Anything already carrying a match has demonstrably been considered.
update public.listings l
   set matched_at = now()
 where l.matched_at is null
   and exists (select 1 from public.matches m where m.listing_id = l.id);

create or replace function public.listings_needing_match(want integer default 200)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select l.id from public.listings l
  where l.status = 'active' and l.canonical_id is null and l.matched_at is null
  order by l.published_at desc nulls last
  limit want;
$$;

-- The queue, as an index: newest first among the unconsidered.
create index if not exists listings_unmatched_idx
  on public.listings (published_at desc nulls last)
  where status = 'active' and canonical_id is null and matched_at is null;
