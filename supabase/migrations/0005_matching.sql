-- Phase 5: matching, and fairness.
--
-- Every listing that arrives is offered to the clients it fits, in an order
-- that deliberately favours whoever has been served least recently. The rules
-- governing that order were specified in prose and not yet settled in detail,
-- so they live in `settings` as numbers rather than in the code as constants:
-- changing the policy is an UPDATE, not a deployment. The defaults below are
-- recommendations, and every one of them is documented with what it costs to
-- get wrong.

-- ===========================================================================
-- Policy, as data.
-- ===========================================================================
create table if not exists public.settings (
  id integer primary key default 1 check (id = 1),

  -- How many clients one listing is applied for.
  --
  -- 1 is the recommendation and the reason the rotation works at all: it is
  -- what forces the next listing to go to somebody else. It is also what
  -- protects the relationship with the agency, which receives one credible
  -- application rather than ten identical ones for the same flat on the same
  -- morning. Raising it above 1 trades both away for volume.
  applications_per_listing integer not null default 1
    check (applications_per_listing between 1 and 10),

  -- The priority debt: each application costs one point, and the debt halves
  -- every `priority_half_life_hours`. A client served three times this morning
  -- comes back to the front by tomorrow. Shorter means faster rotation and
  -- lumpier service; longer means smoother but slower recovery.
  priority_half_life_hours numeric(6, 2) not null default 12
    check (priority_half_life_hours > 0),

  -- "Active" applications, which cap how many irons a client has in the fire.
  -- Both halves matter: without the age window, a client whose five agencies
  -- never reply is blocked for ever, which is the failure mode of every naive
  -- version of this rule.
  max_active_applications integer not null default 5 check (max_active_applications > 0),
  active_application_days integer not null default 7 check (active_application_days > 0),

  -- Where a new client starts. `true` puts them at the front, which buys a good
  -- first impression at the cost of pushing back people who have been waiting.
  new_client_starts_at_top boolean not null default true,

  -- Whether clients who matched but were not served still hear about it.
  notify_unserved_matches boolean not null default true,

  updated_at timestamptz not null default now()
);

insert into public.settings (id) values (1) on conflict (id) do nothing;

alter table public.settings enable row level security;

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- Priority.
--
-- Not stored, derived. A stored score is a number that drifts from the events
-- that justify it; computing it from `applications` means it cannot disagree
-- with what actually happened.
-- ===========================================================================
create or replace function public.client_priority(p_user_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    0,
    1 - coalesce((
      select sum(power(0.5, extract(epoch from (now() - a.sent_at)) / 3600.0 / s.priority_half_life_hours))
      from public.applications a, public.settings s
      where a.user_id = p_user_id
        and a.sent_at is not null
        and a.sent_at > now() - interval '30 days'
    ), 0) / 10.0
  );
$$;

comment on function public.client_priority is
  'Priorité dans [0,1]. Part de 1, décroît avec les candidatures récentes, remonte avec le temps. Dérivée, jamais stockée.';

-- ===========================================================================
-- Who is eligible for this listing, and in what order.
--
-- The hard filter runs first and entirely in SQL over indexed columns: it is
-- the cheapest thing here and it removes the most. Only what survives is
-- scored, and only what is scored is ranked by priority.
--
-- Relevance gates fairness rather than competing with it: a client whose match
-- falls below their own `min_score` is not a candidate at all, so a mediocre
-- fit can never take an apartment that is somebody else's excellent one.
-- ===========================================================================
create or replace function public.eligible_clients(p_listing_id uuid)
returns table (
  search_id uuid,
  user_id uuid,
  priority numeric,
  active_applications integer
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (select * from public.settings where id = 1),
  listing as (
    select * from public.listings
    where id = p_listing_id and status = 'active' and canonical_id is null
  )
  select
    s.id,
    s.user_id,
    public.client_priority(s.user_id),
    (
      select count(*)::integer from public.applications a, cfg
      where a.user_id = s.user_id
        and a.status in ('sent', 'pending')
        and a.sent_at > now() - (interval '1 day' * cfg.active_application_days)
    )
  from public.searches s, listing l, cfg
  where s.active
    -- Budget is always on the total. Sites publish whichever of rent and
    -- charges flatters them; the client's ceiling is what they actually pay.
    and l.total_rent_eur <= s.budget_max_eur
    and (s.budget_min_eur is null or l.total_rent_eur >= s.budget_min_eur)
    and (s.surface_min_m2 is null or l.surface_m2 is null or l.surface_m2 >= s.surface_min_m2)
    and (s.surface_max_m2 is null or l.surface_m2 is null or l.surface_m2 <= s.surface_max_m2)
    and (s.rooms_min is null or l.rooms is null or l.rooms >= s.rooms_min)
    and (s.rooms_max is null or l.rooms is null or l.rooms <= s.rooms_max)
    and (cardinality(s.property_types) = 0 or l.property_type = any (s.property_types))
    and (s.furnished is null or l.furnished is null or l.furnished = s.furnished)
    and (
      cardinality(s.zones) = 0
      or exists (
        select 1 from unnest(s.zones) z
        where (length(z) = 2 and (l.postcode like z || '%' or l.insee_code like z || '%'))
           or l.postcode = z or l.insee_code = z
      )
    )
    -- Never the same apartment twice for the same search. The constraint on
    -- `matches` enforces it too; this keeps the work from being done at all.
    and not exists (
      select 1 from public.matches m
      where m.search_id = s.id and m.listing_id = l.id
    )
    -- Not over the daily cap, and not holding too many open applications.
    and (
      select count(*) from public.applications a
      where a.user_id = s.user_id and a.sent_at > now() - interval '1 day'
    ) < s.max_applications_per_day
    and (
      select count(*) from public.applications a, cfg
      where a.user_id = s.user_id
        and a.status in ('sent', 'pending')
        and a.sent_at > now() - (interval '1 day' * cfg.active_application_days)
    ) < cfg.max_active_applications
  order by 3 desc, s.created_at asc;
$$;

-- Semantic similarity, when both sides have an embedding. Null when either is
-- missing, so the scorer can redistribute the weight rather than score a zero.
create or replace function public.semantic_score(p_listing_id uuid, p_search_id uuid)
returns numeric
language sql
stable
security definer
-- `extensions` is on the path because pgvector lives there: the `<=>` operator
-- is invisible to a function pinned to `public` alone, and the failure is a
-- missing-operator error rather than anything that mentions vectors.
set search_path = public, extensions
as $$
  select round((1 - (e.embedding <=> s.free_text_embedding))::numeric, 3)
  from public.listing_embeddings e, public.searches s
  where e.listing_id = p_listing_id
    and s.id = p_search_id
    and s.free_text_embedding is not null;
$$;

-- The hard filter's working set. Without this, every new listing scans every
-- search; with it, only the plausible ones are touched.
create index if not exists searches_matching_idx
  on public.searches (active, budget_max_eur, rooms_min)
  where active;

-- Listings the matcher has not considered yet. Newest first: a fresh listing
-- matched late is worth less than one matched now, and if the queue ever backs
-- up it should drain from the end that still matters.
create or replace function public.listings_needing_match(want integer default 200)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select l.id from public.listings l
  where l.status = 'active' and l.canonical_id is null
    and not exists (select 1 from public.matches m where m.listing_id = l.id)
  order by l.published_at desc nulls last
  limit want;
$$;
