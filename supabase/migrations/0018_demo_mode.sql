-- Phase 12 : ce qu'il faut pour montrer le produit en deux minutes.
--
-- Rien ici ne change le comportement de l'agent. Deux fonctions seulement, et
-- toutes deux enfermées dans la source `demo-agency` — celle des annonces
-- fabriquées pour la démonstration. Le pipeline de production continue de lire
-- exactement les mêmes règles qu'avant.
--
-- Pourquoi une seconde fonction plutôt qu'un drapeau de plus dans `settings` :
-- un drapeau global aurait ouvert d'un coup les 256 annonces réelles en attente,
-- c'est-à-dire des messages partis vers de vraies agences depuis la vraie boîte
-- du client, pendant une répétition. La portée est la garantie.

-- ===========================================================================
-- Les matchs de démonstration prêts à partir.
--
-- Même corps que `matches_ready_to_send` (0014/0015) à deux différences près :
--   1. restreint à la source `demo-agency` ;
--   2. sans la condition d'abonnement.
--
-- Le point 2 n'est pas une faveur : les paiements sont désactivés côté
-- interface (`PAYMENTS_ENABLED = false`), donc plus personne ne peut souscrire,
-- donc `has_active_subscription` est faux pour tout le monde. Laisser la
-- condition ici reviendrait à interdire la démonstration au nom d'un péage
-- qu'on a soi-même fermé. Le péage reste debout pour les annonces réelles, où
-- il protège quelque chose.
-- ===========================================================================
create or replace function public.matches_ready_to_send_demo(want integer default 20)
returns table (match_id uuid, user_id uuid, listing_id uuid, agency_email text)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (select * from public.settings where id = 1)
  select m.id, m.user_id, m.listing_id, l.agency_email
  from public.matches m
  join public.listings l on l.id = m.listing_id
  join public.sources  s on s.id = l.source_id
  join public.profiles p on p.id = m.user_id
  where s.slug = 'demo-agency'
    and m.status = 'new'
    and l.status = 'active'
    -- Sans boîte connectée il n'y a rien à envoyer et personne pour recevoir
    -- la réponse : c'est la même règle qu'en production (0011).
    and p.gmail_account_id is not null
    and l.agency_email is not null
    and not exists (select 1 from public.applications ap where ap.match_id = m.id)
    and not exists (
      select 1 from public.applications ap
      where ap.listing_id = m.listing_id and ap.user_id = m.user_id
    )
    and (
      select count(*) from public.applications ap
      where ap.listing_id = m.listing_id and not ap.dead_letter
    ) < (select applications_per_listing from cfg)
  order by m.score desc, m.created_at asc
  limit want;
$$;

comment on function public.matches_ready_to_send_demo is
  'Comme matches_ready_to_send, mais limitée à la source demo-agency et sans condition d''abonnement. Aucune annonce réelle ne peut en sortir.';

-- ===========================================================================
-- Remettre la démonstration à zéro.
--
-- Trois des plafonds de `may_send` comptent des candidatures passées, et deux
-- se déclenchent précisément parce qu'on a répété : `agency_cooldown` refuse
-- au-delà de deux messages vers la même adresse en sept jours, `too_many_active`
-- au-delà de cinq candidatures ouvertes. Sans remise à zéro, la troisième
-- répétition d'une démonstration ne montre plus rien — et c'est en général
-- celle qui a lieu devant le public.
--
-- La suppression est volontairement large *et* volontairement étroite : elle
-- efface toute la source de démonstration (les cascades emportent matchs,
-- candidatures, fils et réponses), et elle ne peut rien atteindre d'autre,
-- puisqu'elle part du slug.
-- ===========================================================================
create or replace function public.demo_reset()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with gone as (
    delete from public.listings l
    using public.sources s
    where s.id = l.source_id and s.slug = 'demo-agency'
    returning l.id
  )
  select count(*) into removed from gone;
  return removed;
end;
$$;

comment on function public.demo_reset is
  'Efface les annonces de démonstration et, par cascade, leurs matchs et candidatures. Ne touche à aucune source réelle.';

revoke all on function public.matches_ready_to_send_demo(integer) from anon, authenticated;
revoke all on function public.demo_reset() from anon, authenticated;
