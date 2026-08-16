-- Two different questions were being answered by one number.
--
-- `searches.min_score` gated whether a match row was created at all. But that
-- threshold was set for a different decision - whether an apartment is worth
-- spending one of someone's applications on - and applying it at match time
-- means anything below it is never even shown.
--
-- Measured on a real listing (T4, Paris 15e, 1 995 €, against a search for
-- Paris / 4 pièces / 3 000 €), the same flat scores:
--
--     5 minutes old   0.823
--     1 hour old      0.718
--     2 days old      0.518
--
-- Freshness carries 27% of the score with a 90-minute half-life, by design:
-- the product exists to be first. The consequence is that the entire back
-- catalogue sits under a 0.55 gate, so a new client's home screen is empty
-- until a fresh listing happens to land in their criteria - roughly 7 a day
-- across the departments currently crawled.
--
-- An empty first screen is not honesty, it is a product that looks broken. So
-- the two decisions get two thresholds: show generously, apply strictly.

alter table public.settings
  add column if not exists display_min_score numeric(4, 3) not null default 0.350
    check (display_min_score >= 0 and display_min_score <= 1);

comment on column public.settings.display_min_score is
  'Seuil d''affichage : en dessous, aucun match n''est créé. Le seuil de candidature reste searches.min_score, appliqué à l''envoi.';

-- ===========================================================================
-- The application threshold, moved to where the application is decided.
--
-- Same shape as the per-listing cap (0012) and the subscription gate (0014):
-- the strict test belongs at the point where something is actually spent, not
-- at the point where something is merely noticed.
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
    join public.searches s on s.id = m.search_id
    left join public.agencies a
      on a.source_id = l.source_id and a.external_id = l.agency_external_id
    where m.status = 'new'
      and l.status = 'active'
      and p.gmail_account_id is not null
      -- Worth an application, not merely worth showing.
      and m.score >= s.min_score
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
  'Matches prêts à candidater : score au-dessus du seuil de la recherche, boîte connectée, abonnement actif, plafond par annonce non atteint. Ordre : priorité client, puis score.';

-- ===========================================================================
-- Offer the back catalogue again, exactly once.
--
-- Everything already matched was filtered at the old, stricter threshold, so
-- it has to pass the matcher again. But a bare `update listings set matched_at
-- = null` would re-run on every `db:migrate` and re-match the whole catalogue
-- each time - the unbounded-repair mistake that 0011 had to be corrected for.
--
-- A repair belongs to a moment, so this one records the moment it ran.
-- ===========================================================================
alter table public.settings
  add column if not exists display_threshold_applied_at timestamptz;

do $$
begin
  if (select display_threshold_applied_at from public.settings where id = 1) is null then
    update public.listings set matched_at = null where status = 'active';
    update public.settings set display_threshold_applied_at = now() where id = 1;
  end if;
end $$;
