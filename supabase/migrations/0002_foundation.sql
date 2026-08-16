-- Prems: the production schema.
--
-- 0001 built what the onboarding needed: who the visitor is, what they are
-- looking for, and a seeded catalogue to make the "aha" screen real. This
-- migration builds the machine behind it - the part that has to run whether or
-- not anyone has the site open.
--
-- Four rules shape everything below.
--
-- 1. The pipeline is append-mostly. A listing is seen, not owned: scrapers
--    write, nothing else does, and `last_seen_at` is how a listing dies rather
--    than a DELETE. Losing a scrape run must never lose history.
-- 2. Workers hold the service role and bypass RLS entirely. Every policy here
--    exists for the browser, and the browser is only ever allowed to see rows
--    that belong to the person holding the session.
-- 3. Money is integer euros, never floats. Rent comparisons decide whether we
--    apply on someone's behalf; a rounding error is a wrong application.
-- 4. Anything the product promises has a row that proves it happened. The
--    event log is not instrumentation bolted on afterwards - it is the record
--    the interface will read back, so it is written from the start.
--
-- Everything is idempotent: re-running this file is the deployment mechanism.

-- ===========================================================================
-- The seeded catalogue moves aside.
--
-- 0001 called it `listings` because it was the only catalogue there was. The
-- real one arrives below and deserves the name; the demo inventory keeps the
-- onboarding's "aha" screen honest until scraped data can feed it, and is
-- dropped the day it does. Detected by `hue`, which only the seed table has.
-- ===========================================================================
do $$
begin
  if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'listings' and column_name = 'hue')
     and not exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'demo_listings')
  then
    alter table public.listings rename to demo_listings;
  end if;
end $$;

-- ===========================================================================
-- Sources: the registry of everywhere we look.
--
-- A row per site, not per scraper class: two agency sites on the same CMS are
-- two sources sharing one adapter. `poll_interval_seconds` lives here rather
-- than in Cloud Scheduler so cadence is data we can tune without a deploy.
--
-- `contact_channel` is the gate that decides whether a source is worth having
-- at all: a site we can read but cannot apply to shows the client apartments
-- they cannot get, which is worse than not showing them.
-- ===========================================================================
create table if not exists public.sources (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text        not null unique,
  name                  text        not null,
  kind                  text        not null check (kind in ('portal', 'agency_cms', 'agency')),
  adapter               text        not null,
  base_url              text        not null,
  -- How we apply. 'form_post' and 'email' are shippable; 'none' means the
  -- source is read-only and must stay disabled for the MVP.
  contact_channel       text        not null default 'none'
                        check (contact_channel in ('form_post', 'email', 'none')),
  enabled               boolean     not null default false,
  poll_interval_seconds integer     not null default 300 check (poll_interval_seconds >= 30),
  -- Politeness, per source. Exceeding a site's tolerance is how a working
  -- scraper becomes a blocked one.
  rate_limit_rpm        integer     not null default 30 check (rate_limit_rpm > 0),
  requires_proxy        boolean     not null default false,
  config                jsonb       not null default '{}'::jsonb,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on column public.sources.enabled is
  'A source is only polled when enabled. Sources whose contact_channel is none must stay disabled: we do not show apartments we cannot apply to.';

-- ===========================================================================
-- Scrape runs: one row per execution, written even when it fails.
--
-- A scraper that breaks silently is the most expensive failure in this system:
-- the site keeps working, the client keeps paying, and nothing arrives. The
-- run log is what makes that visible, so it records the failure path as
-- carefully as the success path.
-- ===========================================================================
create table if not exists public.scrape_runs (
  id            bigserial   primary key,
  source_id     uuid        not null references public.sources (id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text        not null default 'running'
                check (status in ('running', 'ok', 'partial', 'failed')),
  items_seen    integer     not null default 0,
  items_new     integer     not null default 0,
  items_updated integer     not null default 0,
  http_status   integer,
  duration_ms   integer,
  error         text,
  zones         text[]      not null default '{}'::text[]
);

create index if not exists scrape_runs_source_idx
  on public.scrape_runs (source_id, started_at desc);

-- Finding the sources that have stopped producing is the query that matters,
-- so it gets its own partial index rather than a scan over every run.
create index if not exists scrape_runs_failures_idx
  on public.scrape_runs (source_id, started_at desc)
  where status in ('failed', 'partial');

-- ===========================================================================
-- Listings: what the scrapers find.
--
-- `external_id` is the site's own identifier and is unique per source - that
-- pair, not the URL, is the identity, because URLs carry tracking parameters
-- and get rewritten. `dedup_hash` is the cross-source identity: the same flat
-- posted by one agency to four portals should be one apartment to the client.
--
-- `raw` keeps the untouched payload. Normalisation is a guess about a format
-- we do not control, and keeping the original is what lets a parsing mistake
-- be repaired by a backfill instead of a re-scrape that comes too late.
-- ===========================================================================
create table if not exists public.listings (
  id                uuid        primary key default gen_random_uuid(),
  source_id         uuid        not null references public.sources (id) on delete cascade,
  external_id       text        not null,
  url               text        not null,

  title             text,
  description       text,
  property_type     text        not null default 'flat'
                    check (property_type in ('flat', 'house', 'studio', 'other')),
  rooms             smallint    check (rooms between 0 and 30),
  bedrooms          smallint    check (bedrooms between 0 and 30),
  surface_m2        numeric(7, 2) check (surface_m2 > 0),

  -- Rent excluding charges, charges, and the sum. Sites disagree about which
  -- of the three they publish, so all three are stored and the total is
  -- derived - the client's budget is always a budget on the total.
  rent_eur          integer     not null check (rent_eur >= 0),
  charges_eur       integer     not null default 0 check (charges_eur >= 0),
  total_rent_eur    integer     generated always as (rent_eur + charges_eur) stored,
  deposit_eur       integer     check (deposit_eur >= 0),
  agency_fees_eur   integer     check (agency_fees_eur >= 0),

  furnished         boolean,
  floor             smallint,
  has_elevator      boolean,
  has_balcony       boolean,
  has_terrace       boolean,
  has_parking       boolean,
  has_cellar        boolean,
  dpe               char(1)     check (dpe in ('A','B','C','D','E','F','G')),
  ges               char(1)     check (ges in ('A','B','C','D','E','F','G')),

  available_from    date,

  address_raw       text,
  street            text,
  postcode          text,
  city              text,
  city_slug         text,
  insee_code        text,
  district          text,
  -- Many sites blur the exact position on purpose. `geo_precision` records
  -- how much to trust the point, so a 500 m blur is never matched against a
  -- client who asked for one specific street.
  geo               geography(Point, 4326),
  geo_precision     text        check (geo_precision in ('exact', 'street', 'district', 'city', 'blurred')),

  agency_name       text,
  agency_external_id text,
  is_professional   boolean,
  photos            jsonb       not null default '[]'::jsonb,

  published_at      timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  status            text        not null default 'active'
                    check (status in ('active', 'gone', 'rejected')),

  -- Cross-source identity, and a cheap "did anything change" check so an
  -- unchanged listing costs one UPDATE of last_seen_at and no re-embedding.
  dedup_hash        text,
  content_hash      text,
  canonical_id      uuid        references public.listings (id) on delete set null,

  raw               jsonb       not null default '{}'::jsonb,

  constraint listings_source_external_key unique (source_id, external_id)
);

-- The hard filter runs on every new listing against every active search, so
-- it is the one query worth indexing precisely. Partial on active rows: a gone
-- listing is never matched, and the index should not carry it.
create index if not exists listings_hard_filter_idx
  on public.listings (city_slug, rooms, total_rent_eur, available_from)
  where status = 'active';

create index if not exists listings_geo_idx
  on public.listings using gist (geo)
  where status = 'active';

create index if not exists listings_fresh_idx
  on public.listings (published_at desc nulls last)
  where status = 'active';

create index if not exists listings_dedup_idx
  on public.listings (dedup_hash)
  where dedup_hash is not null;

create index if not exists listings_source_seen_idx
  on public.listings (source_id, last_seen_at desc);

-- ===========================================================================
-- Embeddings, kept out of the listings row.
--
-- A vector is large, rewritten on a different schedule than the listing, and
-- irrelevant to every hard-filter query. Storing it beside the columns those
-- queries scan would make the common path pay for the rare one.
--
-- 768 dimensions matches text-multilingual-embedding-002, which is the right
-- model here because the corpus is French.
-- ===========================================================================
create table if not exists public.listing_embeddings (
  listing_id uuid        primary key references public.listings (id) on delete cascade,
  embedding  vector(768) not null,
  model      text        not null,
  created_at timestamptz not null default now()
);

-- IVFFlat needs training data to be worth building and is counter-productive
-- on an empty table, so the index is created once the corpus justifies it.
-- Until then a sequential scan over a few thousand rows is faster anyway.
-- See docs/RUNBOOK.md, "Vector index".

-- ===========================================================================
-- Duplicates: recorded, not deleted.
--
-- The same flat on four portals is four rows, because each carries a different
-- URL and a different contact channel - and the one we can actually apply
-- through may not be the one we saw first. Collapsing them at write time would
-- throw away the alternative routes.
-- ===========================================================================
create table if not exists public.listing_duplicates (
  canonical_id uuid        not null references public.listings (id) on delete cascade,
  duplicate_id uuid        not null references public.listings (id) on delete cascade,
  score        numeric(4, 3) not null check (score between 0 and 1),
  method       text        not null check (method in ('hash', 'semantic', 'manual')),
  created_at   timestamptz not null default now(),
  primary key (canonical_id, duplicate_id),
  constraint listing_duplicates_distinct check (canonical_id <> duplicate_id)
);

-- ===========================================================================
-- Search criteria.
--
-- 0001's `searches` held the four onboarding answers. Matching needs more than
-- that, so the table grows rather than being replaced - the onboarding writes
-- the same four columns it always did, and everything added here is optional
-- with a sensible default.
--
-- `zones` is text codes (INSEE or postcode) rather than a polygon: it is what
-- the sites themselves filter by, so a zone list can be pushed down into the
-- scrape query instead of being applied after the fact.
-- ===========================================================================
alter table public.searches
  add column if not exists budget_min_eur     integer,
  add column if not exists surface_min_m2     numeric(7, 2),
  add column if not exists surface_max_m2     numeric(7, 2),
  add column if not exists rooms_min          smallint,
  add column if not exists rooms_max          smallint,
  add column if not exists property_types     text[]      not null default '{}'::text[],
  add column if not exists furnished          boolean,
  add column if not exists zones              text[]      not null default '{}'::text[],
  add column if not exists dpe_max            char(1),
  add column if not exists must_have          text[]      not null default '{}'::text[],
  add column if not exists free_text          text,
  add column if not exists free_text_embedding vector(768),
  add column if not exists active             boolean     not null default true,
  -- The rate limit that protects the client's own reputation. An inbox full of
  -- applications from one person on the same morning reads as a bot to an
  -- agent, which costs exactly the credibility the product is selling.
  add column if not exists max_applications_per_day smallint not null default 15,
  add column if not exists min_score          numeric(4, 3) not null default 0.55,
  add column if not exists updated_at         timestamptz not null default now();

create index if not exists searches_active_idx
  on public.searches (active, city_slug)
  where active;

-- ===========================================================================
-- The client's file.
--
-- Q17: the dossier is a DossierFacile link, not a pile of uploads. That is a
-- deliberate simplification and a good one - DossierFacile is the French
-- state's own verified tenancy file, agencies already recognise it, and it
-- means the sensitive documents live there rather than here.
-- ===========================================================================
alter table public.profiles
  add column if not exists email                  text,
  add column if not exists dossierfacile_url      text,
  add column if not exists dossierfacile_verified boolean not null default false,
  -- Composio's connected-account id for this person's Gmail. Applications are
  -- sent from their own mailbox, so replies land where they expect them.
  add column if not exists gmail_account_id       text,
  add column if not exists notify_email           boolean not null default true,
  add column if not exists notify_push            boolean not null default true;

-- ===========================================================================
-- Consent.
--
-- Applying to a flat in someone's name, from their own mailbox, needs their
-- explicit and provable instruction. The row is the proof, so it records what
-- was agreed to and which wording was shown - a mandate nobody can reconstruct
-- is not a mandate.
-- ===========================================================================
create table if not exists public.consents (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  kind         text        not null
               check (kind in ('auto_apply', 'data_processing', 'mailbox_access')),
  text_version text        not null,
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);

create index if not exists consents_user_idx on public.consents (user_id, kind, granted_at desc);

-- ===========================================================================
-- Matches.
--
-- The unique constraint is the whole safety story: it is what guarantees a
-- client is never shown, and never applies to, the same apartment twice - even
-- if the matcher runs twice on the same listing, which it will.
-- ===========================================================================
create table if not exists public.matches (
  id             uuid        primary key default gen_random_uuid(),
  search_id      uuid        not null references public.searches (id) on delete cascade,
  user_id        uuid        not null references auth.users (id) on delete cascade,
  listing_id     uuid        not null references public.listings (id) on delete cascade,
  score          numeric(4, 3) not null check (score between 0 and 1),
  -- Every component that produced the score, kept so a client asking "why this
  -- flat?" gets an answer, and so a bad weighting can be diagnosed after the
  -- fact rather than guessed at.
  score_breakdown jsonb      not null default '{}'::jsonb,
  semantic_score numeric(4, 3),
  status         text        not null default 'new'
                 check (status in ('new', 'queued', 'applied', 'skipped', 'failed')),
  skipped_reason text,
  created_at     timestamptz not null default now(),
  constraint matches_unique_pair unique (search_id, listing_id)
);

create index if not exists matches_user_idx on public.matches (user_id, created_at desc);
create index if not exists matches_pending_idx on public.matches (status, created_at)
  where status in ('new', 'queued');

-- ===========================================================================
-- Applications.
--
-- One row per attempt to reach an agency, created before the send rather than
-- after it. A crash between "sent" and "recorded" would otherwise produce a
-- second application to the same agent, which is the single most damaging
-- thing this system can do to a client.
-- ===========================================================================
create table if not exists public.applications (
  id                  uuid        primary key default gen_random_uuid(),
  match_id            uuid        not null unique references public.matches (id) on delete cascade,
  user_id             uuid        not null references auth.users (id) on delete cascade,
  listing_id          uuid        not null references public.listings (id) on delete cascade,
  channel             text        not null check (channel in ('form_post', 'email')),
  status              text        not null default 'pending'
                      check (status in ('pending', 'sent', 'failed', 'replied', 'visit_booked', 'rejected')),
  subject             text,
  body                text,
  -- Sent from the client's own mailbox, blind-copied to Prems so replies can
  -- be classified without ever reading the rest of their inbox.
  from_address        text,
  bcc_address         text        not null default 'prems@getmira.run',
  provider_message_id text,
  attempts            smallint    not null default 0,
  last_error          text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists applications_user_idx on public.applications (user_id, created_at desc);
create index if not exists applications_retry_idx on public.applications (status, created_at)
  where status in ('pending', 'failed');

-- The daily cap in `searches.max_applications_per_day` is enforced against
-- this index.
create index if not exists applications_daily_idx on public.applications (user_id, sent_at)
  where sent_at is not null;

create table if not exists public.application_replies (
  id             uuid        primary key default gen_random_uuid(),
  application_id uuid        not null references public.applications (id) on delete cascade,
  received_at    timestamptz not null default now(),
  from_address   text,
  subject        text,
  body           text,
  classified_as  text        check (classified_as in ('visit_offered', 'refused', 'question', 'other')),
  classifier     text,
  created_at     timestamptz not null default now()
);

create index if not exists application_replies_app_idx
  on public.application_replies (application_id, received_at desc);

-- ===========================================================================
-- Events: the record the interface will read back.
--
-- Q21. Append-only, one row per thing that happened to a client, written by
-- every layer of the pipeline. The next session's UI is a live view over this
-- table and nothing else - which is why it exists now, before there is anything
-- to view: a log started later cannot describe what already happened.
-- ===========================================================================
create table if not exists public.events (
  id           bigserial   primary key,
  user_id      uuid        references auth.users (id) on delete cascade,
  type         text        not null,
  subject_type text        check (subject_type in ('listing', 'match', 'application', 'search', 'source', 'reply')),
  subject_id   uuid,
  payload      jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists events_user_idx on public.events (user_id, created_at desc);
create index if not exists events_type_idx on public.events (type, created_at desc);

-- ===========================================================================
-- Which zones to scrape.
--
-- Q9: the crawl follows demand. With clients, we scrape the union of the zones
-- they asked for; with none, we scrape Île-de-France so the catalogue is warm
-- before the first person arrives rather than empty on their first morning.
-- ===========================================================================
create or replace function public.active_scrape_zones()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(
      (select array_agg(distinct z)
         from public.searches s, unnest(s.zones) as z
        where s.active),
      '{}'::text[]),
    -- Île-de-France, by department. The adapters expand these to whatever
    -- granularity each site expects.
    array['75', '77', '78', '91', '92', '93', '94', '95']
  );
$$;

-- ===========================================================================
-- Row level security.
--
-- Workers use the service role and bypass all of this. Every policy below
-- describes what a browser session may see, and the answer is always "only
-- rows that are yours".
-- ===========================================================================
alter table public.sources             enable row level security;
alter table public.scrape_runs         enable row level security;
alter table public.listings            enable row level security;
alter table public.listing_embeddings  enable row level security;
alter table public.listing_duplicates  enable row level security;
alter table public.consents            enable row level security;
alter table public.matches             enable row level security;
alter table public.applications        enable row level security;
alter table public.application_replies enable row level security;
alter table public.events              enable row level security;

-- sources, scrape_runs, embeddings and duplicates carry no policy at all:
-- RLS with zero policies denies everything, which is exactly right for tables
-- only the pipeline touches.

-- A listing is visible once it has been matched to you. The catalogue itself
-- is the asset here, so it is not readable wholesale - but an apartment the
-- system decided to show you plainly must be.
drop policy if exists "matched listings readable" on public.listings;
create policy "matched listings readable"
  on public.listings for select to authenticated
  using (exists (
    select 1 from public.matches m
    where m.listing_id = listings.id and m.user_id = (select auth.uid())));

drop policy if exists "own matches readable" on public.matches;
create policy "own matches readable"
  on public.matches for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own applications readable" on public.applications;
create policy "own applications readable"
  on public.applications for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own replies readable" on public.application_replies;
create policy "own replies readable"
  on public.application_replies for select to authenticated
  using (exists (
    select 1 from public.applications a
    where a.id = application_replies.application_id and a.user_id = (select auth.uid())));

drop policy if exists "own events readable" on public.events;
create policy "own events readable"
  on public.events for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own consents readable" on public.consents;
create policy "own consents readable"
  on public.consents for select to authenticated
  using ((select auth.uid()) = user_id);

-- Granting consent is the one write a browser makes here. Revoking is a write
-- too, and must stay possible at any time.
drop policy if exists "own consents insertable" on public.consents;
create policy "own consents insertable"
  on public.consents for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "own consents revocable" on public.consents;
create policy "own consents revocable"
  on public.consents for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ===========================================================================
-- updated_at, wired to the trigger 0001 already defines.
-- ===========================================================================
drop trigger if exists sources_touch on public.sources;
create trigger sources_touch before update on public.sources
  for each row execute function public.touch_updated_at();

drop trigger if exists searches_touch on public.searches;
create trigger searches_touch before update on public.searches
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- Realtime. The interface subscribes to its own events and its own matches;
-- RLS above is what keeps that subscription scoped to one person.
-- ===========================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events')
    then
      alter publication supabase_realtime add table public.events;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches')
    then
      alter publication supabase_realtime add table public.matches;
    end if;
  end if;
end $$;
