-- Getting paid, and being able to prove it.
--
-- Four live Stripe payment links exist and work. What did not exist was any
-- record on our side of who had paid: the plan was granted by a query
-- parameter on the redirect (`/app?checkout=fondateur`), written to
-- localStorage. That gives the founder offer away to anyone who types the URL,
-- and loses it for the person who actually paid the moment they clear their
-- browser or open the app on their phone.
--
-- Entitlement has to live where it cannot be edited by the person it governs.

-- `events.subject_type` is a closed list, and billing was not on it. The
-- webhook's log write therefore failed with a 400 while the subscription
-- itself was created - caught by testing a signed event end to end and finding
-- the row present and the event absent. The write is deliberately non-fatal in
-- the function (failing there would make Stripe retry and re-grant), which is
-- exactly why the constraint has to be right here.
alter table public.events drop constraint if exists events_subject_type_check;
alter table public.events add constraint events_subject_type_check
  check (subject_type in ('listing', 'match', 'application', 'search', 'source', 'reply', 'subscription'));

create table if not exists public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,

  plan                   text not null check (plan in ('soldat', 'fondateur', 'commando', 'investisseur')),
  status                 text not null default 'active'
                         check (status in ('active', 'past_due', 'canceled')),

  -- What Stripe calls it, so a refund, a dispute or a support question can be
  -- traced from either side without guessing.
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_session_id      text,

  -- `fondateur` is a one-off payment with no renewal, so it has no period end.
  -- A weekly plan does, and it is what `is_active` reads.
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,

  started_at             timestamptz not null default now(),
  canceled_at            timestamptz,
  updated_at             timestamptz not null default now(),

  -- Stripe retries a webhook until it gets a 2xx, so the same session can
  -- arrive several times. This makes the second delivery a no-op instead of a
  -- second subscription.
  constraint subscriptions_session_key unique (stripe_session_id)
);

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id, status);

alter table public.subscriptions enable row level security;

-- Readable by its owner, writable by nobody holding a browser key. Only the
-- webhook - which runs with the service role - creates or changes a row.
drop policy if exists "own subscription readable" on public.subscriptions;
create policy "own subscription readable"
  on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- Is this person entitled, right now?
--
-- Derived from the rows rather than cached on the profile: a cached flag and a
-- Stripe status drift apart, and the one that is wrong is always the cache.
--
-- `fondateur` carries no period end by design - it runs until the lease is
-- signed - so a null end date means "still valid", not "expired".
-- ===========================================================================
create or replace function public.has_active_subscription(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user_id
      and status = 'active'
      and (current_period_end is null or current_period_end > now())
  );
$$;

-- ===========================================================================
-- What a subscription actually buys.
--
-- The app stays open: the matches, the flats found, the reasons - all of it is
-- visible without paying, because that is the argument for paying. What the
-- subscription buys is the agent acting on your behalf: applying to agencies
-- from your mailbox.
--
-- This is a policy, so it lives in `settings` as data. Flip it to gate the
-- whole product instead.
-- ===========================================================================
alter table public.settings
  add column if not exists require_subscription_to_apply boolean not null default true;

comment on column public.settings.require_subscription_to_apply is
  'true = seules les candidatures sont réservées aux abonnés, l''app reste ouverte. false = rien n''est réservé.';

-- ===========================================================================
-- The gate, applied where the money is spent rather than where it is shown.
--
-- Same reasoning as the per-listing cap in 0012: enforce at the point of
-- allocation. A match belonging to someone who has not paid stays `new` and
-- stays theirs - it is not consumed, not dead-lettered, and it becomes
-- sendable the moment they subscribe.
-- ===========================================================================
create or replace function public.matches_ready_to_send(want integer default 50)
returns table (match_id uuid, user_id uuid, listing_id uuid, agency_email text)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (select * from public.settings where id = 1),
  candidates as (
    select m.id, m.user_id, m.listing_id, m.score, m.created_at,
           coalesce(l.agency_email, a.email) as agency_email
    from public.matches m
    join public.listings l on l.id = m.listing_id
    join public.profiles p on p.id = m.user_id
    left join public.agencies a
      on a.source_id = l.source_id and a.external_id = l.agency_external_id
    where m.status = 'new'
      and l.status = 'active'
      and p.gmail_account_id is not null
      and coalesce(l.agency_email, a.email) is not null
      and (
        not (select require_subscription_to_apply from cfg)
        or public.has_active_subscription(m.user_id)
      )
      and not exists (select 1 from public.applications ap where ap.match_id = m.id)
      and not exists (
        select 1 from public.applications ap
        where ap.listing_id = m.listing_id and ap.user_id = m.user_id
      )
      and (
        select count(*) from public.applications ap
        where ap.listing_id = m.listing_id and not ap.dead_letter
      ) < (select applications_per_listing from cfg)
  ),
  priorities as (
    select c.user_id, public.client_priority(c.user_id) as priority
    from (select distinct user_id from candidates) c
  )
  select c.id, c.user_id, c.listing_id, c.agency_email
  from candidates c
  join priorities pr on pr.user_id = c.user_id
  order by pr.priority desc, c.score desc, c.created_at asc
  limit want;
$$;

comment on function public.matches_ready_to_send is
  'Matches prêts à candidater : boîte connectée, abonnement actif, plafond par annonce non atteint. Ordre : priorité client, puis score.';

-- ===========================================================================
-- What the app reads to know what it may offer.
--
-- One row, always present even for someone who has never paid, so the
-- interface never has to distinguish "no subscription" from "query failed".
-- ===========================================================================
create or replace view public.my_subscription as
select
  u.id                                            as user_id,
  s.plan,
  s.status,
  s.current_period_end,
  s.cancel_at_period_end,
  s.started_at,
  public.has_active_subscription(u.id)            as is_active
from auth.users u
left join lateral (
  select * from public.subscriptions
  where user_id = u.id
  order by (status = 'active') desc, started_at desc
  limit 1
) s on true
where u.id = (select auth.uid());

grant select on public.my_subscription to authenticated;

-- Realtime, so the app flips from "abonnez-vous" to "actif" while the person is
-- still looking at the screen they came back to from Stripe.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'subscriptions')
    then
      alter publication supabase_realtime add table public.subscriptions;
    end if;
  end if;
end $$;
