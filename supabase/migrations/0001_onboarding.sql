-- Prems onboarding schema.
--
-- Two rules shape everything below:
--
-- 1. Screens 1-4 happen BEFORE the account exists. Nothing here can require a
--    user id at that point, so the client keeps a local draft and flushes it
--    once the anonymous session is created on screen 5.
-- 2. Identity documents and payslips are sensitive personal data. Nothing is
--    world-readable, every table carries RLS, and buckets are private with
--    per-user path isolation.

-- ---------------------------------------------------------------------------
-- The demo inventory behind the "aha moment".
-- Readable by anyone (including the anonymous visitor on screen 4) because the
-- preview is deliberately shown before signup. Writable only by the service
-- role, which no browser ever holds.
--
-- Originally called `listings`. Migration 0002 renamed it and gave that name to
-- the scraped catalogue, whose rows are emphatically NOT world-readable - so
-- the name is spelled out here too. Leaving this file pointing at `listings`
-- would have re-applied the "publicly readable" policy below to the production
-- table on the next run, which is a data leak dressed as a no-op.
-- ---------------------------------------------------------------------------
create table if not exists public.demo_listings (
  id              uuid primary key default gen_random_uuid(),
  city            text        not null,
  city_slug       text        not null,
  district        text        not null,
  street          text        not null,
  property_type   text        not null check (property_type in ('studio', 'appartement', 'maison', 'colocation')),
  rooms           smallint    not null check (rooms between 1 and 6),
  surface_m2      smallint    not null check (surface_m2 > 0),
  rent_eur        integer     not null check (rent_eur > 0),
  charges_eur     integer     not null default 0,
  floor           smallint,
  dpe             char(1)     check (dpe in ('A','B','C','D','E','F','G')),
  furnished       boolean     not null default false,
  available_from  date        not null,
  features        text[]      not null default '{}',
  agency          text        not null,
  hue             smallint    not null default 24,   -- drives the procedural preview art
  created_at      timestamptz not null default now()
);

create index if not exists demo_listings_match_idx
  on public.demo_listings (city_slug, rooms, rent_eur, available_from);

alter table public.demo_listings enable row level security;

drop policy if exists "listings are publicly readable" on public.demo_listings;
create policy "listings are publicly readable"
  on public.demo_listings for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Profiles: one row per auth user, created on first sign-in.
-- Income is stored in cents to keep the solvency ratio exact.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  phone                 text,
  first_name            text,
  last_name             text,
  birth_date            date,
  id_document_type      text check (id_document_type in ('cni', 'passeport', 'titre_sejour')),
  id_document_number    text,
  employment_status     text check (employment_status in ('cdi', 'independant', 'etudiant', 'retraite', 'sans_emploi')),
  monthly_income_cents  bigint check (monthly_income_cents >= 0),
  needs_guarantor       boolean not null default false,
  guarantor_name        text,
  guarantor_relation    text,
  guarantor_income_cents bigint check (guarantor_income_cents >= 0),
  push_subscription     jsonb,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "own profile readable" on public.profiles;
create policy "own profile readable"
  on public.profiles for select to authenticated using (auth.uid() = id);

drop policy if exists "own profile insertable" on public.profiles;
create policy "own profile insertable"
  on public.profiles for insert to authenticated with check (auth.uid() = id);

drop policy if exists "own profile updatable" on public.profiles;
create policy "own profile updatable"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- Searches: the answers to screens 1-4, flushed from the local draft.
-- ---------------------------------------------------------------------------
create table if not exists public.searches (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  city           text not null,
  city_slug      text not null,
  budget_max_eur integer not null check (budget_max_eur > 0),
  property_type  text not null,
  rooms          smallint not null,
  move_in_date   date,
  move_in_asap   boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists searches_user_idx on public.searches (user_id, created_at desc);

alter table public.searches enable row level security;

drop policy if exists "own searches readable" on public.searches;
create policy "own searches readable"
  on public.searches for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own searches insertable" on public.searches;
create policy "own searches insertable"
  on public.searches for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own searches updatable" on public.searches;
create policy "own searches updatable"
  on public.searches for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Documents: metadata only. The file itself lives in a private bucket, and the
-- storage path is always "<user id>/<...>" so the policies below can isolate it.
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('identite', 'domicile', 'revenus', 'garant')),
  doc_subtype   text,
  bucket        text not null,
  storage_path  text not null,
  mime_type     text,
  size_bytes    integer,
  created_at    timestamptz not null default now(),
  -- Retention: sensitive documents are purged 90 days after upload unless the
  -- tenancy application is still live. Enforced by the scheduled job below.
  expires_at    timestamptz not null default (now() + interval '90 days')
);

create index if not exists documents_user_idx on public.documents (user_id, kind);

alter table public.documents enable row level security;

drop policy if exists "own documents readable" on public.documents;
create policy "own documents readable"
  on public.documents for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own documents insertable" on public.documents;
create policy "own documents insertable"
  on public.documents for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own documents deletable" on public.documents;
create policy "own documents deletable"
  on public.documents for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Funnel analytics: one row per screen reached. The entire point of a
-- one-question-per-screen flow is being able to see exactly where people stop,
-- so this is written for anonymous visitors too, keyed by a client-side id.
-- Insert-only: nobody can read the funnel back through the public API.
-- ---------------------------------------------------------------------------
create table if not exists public.funnel_events (
  id         bigserial primary key,
  session_id uuid not null,
  user_id    uuid references auth.users (id) on delete set null,
  step       text not null,
  event      text not null check (event in ('view', 'complete', 'skip', 'back')),
  created_at timestamptz not null default now()
);

create index if not exists funnel_events_session_idx on public.funnel_events (session_id, created_at);

alter table public.funnel_events enable row level security;

drop policy if exists "funnel events are write only" on public.funnel_events;
create policy "funnel events are write only"
  on public.funnel_events for insert
  to anon, authenticated
  with check (true);

-- ---------------------------------------------------------------------------
-- Private storage buckets, with per-user path isolation.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('identity-documents', 'identity-documents', false, 10485760,
   array['image/jpeg', 'image/png', 'image/heic', 'application/pdf']),
  ('proof-of-address', 'proof-of-address', false, 10485760,
   array['image/jpeg', 'image/png', 'image/heic', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A user may only touch objects under a folder named after their own uid.
drop policy if exists "own folder readable" on storage.objects;
create policy "own folder readable"
  on storage.objects for select to authenticated
  using (
    bucket_id in ('identity-documents', 'proof-of-address')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own folder writable" on storage.objects;
create policy "own folder writable"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('identity-documents', 'proof-of-address')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own folder deletable" on storage.objects;
create policy "own folder deletable"
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('identity-documents', 'proof-of-address')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Keep updated_at honest.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
