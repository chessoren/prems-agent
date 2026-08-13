-- Cross-listing duplicate linking, in SQL.
--
-- This lives in the database rather than in the worker because it is a set
-- operation over the whole catalogue: "for every hash with more than one row,
-- point the newer ones at the oldest". Pulling that into a worker would mean
-- reading the catalogue out and writing it back to do what one statement does.
--
-- The oldest row is canonical. Not the newest, and not arbitrarily: the oldest
-- is the one whose published_at is the real first appearance, and freshness is
-- the heaviest term in the match score. Making a republication canonical would
-- hand it a freshness it did not earn.

create or replace function public.link_duplicate_listings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  linked integer;
begin
  with groups as (
    select
      id,
      dedup_hash,
      first_value(id) over (
        partition by dedup_hash
        order by coalesce(published_at, first_seen_at), id
      ) as canonical
    from public.listings
    where dedup_hash is not null and status = 'active'
  ),
  pairs as (
    select canonical as canonical_id, id as duplicate_id
    from groups
    where id <> canonical
  ),
  inserted as (
    insert into public.listing_duplicates (canonical_id, duplicate_id, score, method)
    select canonical_id, duplicate_id, 1.0, 'hash' from pairs
    on conflict (canonical_id, duplicate_id) do nothing
    returning 1
  )
  select count(*) into linked from inserted;

  -- Point the duplicates at their canonical row so a single join reaches the
  -- whole cluster, and the matcher can skip anything that is not canonical.
  update public.listings l
     set canonical_id = p.canonical_id
    from (
      select canonical_id, duplicate_id from public.listing_duplicates
    ) p
   where l.id = p.duplicate_id and l.canonical_id is distinct from p.canonical_id;

  return linked;
end;
$$;

-- Only the canonical row of a cluster should ever be matched. Expressed as a
-- partial index so the matcher's filter costs nothing.
create index if not exists listings_canonical_idx
  on public.listings (city_slug, rooms, total_rent_eur)
  where status = 'active' and canonical_id is null;

-- Which listings still need an embedding.
--
-- The first version of the backfill selected the first N listings and skipped
-- the ones already embedded. Once those N were done it returned nothing forever,
-- and the rest of the catalogue was never reached - a backfill that reports
-- success while doing nothing. Asking the database for the difference is both
-- correct and one query instead of two.
create or replace function public.listings_needing_embedding(want integer default 200)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select l.id
  from public.listings l
  left join public.listing_embeddings e on e.listing_id = l.id
  where l.status = 'active' and e.listing_id is null
  order by l.published_at desc nulls last
  limit want;
$$;
