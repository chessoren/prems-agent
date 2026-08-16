-- The criteria the flow collected, and the matcher never read.
--
-- Two vocabularies had grown side by side without ever being joined. The
-- onboarding wrote `city`, `rooms` and `property_type`; the matcher reads
-- `zones`, `rooms_min` / `rooms_max` and `property_types`. `hardFilter` skips
-- any criterion whose field is empty, so nothing errored and nothing returned
-- zero - the budget simply became the only thing that mattered.
--
-- Measured on the live account that asked for *Paris, 4 pièces*: top matches
-- were Rueil-Malmaison 2 pièces, Saint-Germain-en-Laye 1 pièce, Nanterre 3
-- pièces, Paris 17e 1 pièce.
--
-- The client now writes both shapes (`src/lib/prems/store.js`). This repairs
-- the rows written before it did, and it is safe to re-run: it only fills
-- columns that are still empty, so a client who has since edited their
-- criteria by hand is never overwritten.

-- ---------------------------------------------------------------------------
-- Where. Department, from the postcode the flow already stores on the row's
-- city. Two characters, because a five-character zone is an exact postcode and
-- would keep Paris 15e out of a search for "Paris" (75001).
-- ---------------------------------------------------------------------------
update public.searches s
   set zones = array[substring(l.postcode from 1 for 2)]
  from (
    select distinct on (city_slug) city_slug, postcode
    from public.listings
    where postcode is not null
    order by city_slug, first_seen_at desc
  ) l
 where s.zones = '{}'
   and s.city_slug is not null
   and l.city_slug = s.city_slug;

-- Paris, Lyon and Marseille are stored per arrondissement in the catalogue, so
-- the join above misses the bare city slug. They are also the three cities
-- where getting this wrong costs the most.
update public.searches
   set zones = case city_slug
                 when 'paris'     then array['75']
                 when 'lyon'      then array['69']
                 when 'marseille' then array['13']
               end
 where zones = '{}'
   and city_slug in ('paris', 'lyon', 'marseille');

-- ---------------------------------------------------------------------------
-- How big. "T4 et plus" is the only open-ended option on the screen and so the
-- only one left without an upper bound.
-- ---------------------------------------------------------------------------
update public.searches
   set rooms_min = case when rooms >= 4 then 4 else rooms end,
       rooms_max = case when rooms >= 4 then null else rooms end
 where rooms is not null
   and rooms_min is null
   and rooms_max is null;

-- ---------------------------------------------------------------------------
-- What kind. The flow says studio/appartement/indifferent, the catalogue says
-- flat/house. "T4 et plus" is announced as "grand appartement ou maison", so
-- indifferent must stay unrestricted rather than become a guess.
-- ---------------------------------------------------------------------------
update public.searches
   set property_types = array['flat']
 where property_types = '{}'
   and property_type in ('studio', 'appartement');

-- ===========================================================================
-- A search that restricts nothing must not restrict everyone else.
--
-- `active_scrape_zones()` unions the zones of active searches. An empty array
-- means "anywhere" to `hardFilter` but contributed *nothing* to that union, so
-- a client wanting the whole region was silently overruled by any client
-- naming four departments - and the crawl shrank from eight departments to
-- four. The two readings of the same empty array have to agree.
--
-- Unrestricted now contributes the full default set, which is what it means.
-- ===========================================================================
create or replace function public.active_scrape_zones()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  with default_zones as (
    select array['75', '77', '78', '91', '92', '93', '94', '95']::text[] as z
  ),
  named as (
    select array_agg(distinct z) as z
    from public.searches s, unnest(s.zones) as z
    where s.active
  ),
  unrestricted as (
    -- At least one active client asked for no restriction at all.
    select exists (
      select 1 from public.searches
      where active and (zones is null or zones = '{}')
    ) as present
  )
  select case
    when (select present from unrestricted)
      then (select z from default_zones)
    else coalesce(nullif((select z from named), '{}'::text[]),
                  (select z from default_zones))
  end;
$$;

comment on function public.active_scrape_zones is
  'Union des zones demandées. Une recherche sans zone signifie « partout » et rend le jeu complet, pas un tableau vide.';
