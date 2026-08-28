-- Un envoi, un seul, même quand deux ouvriers regardent la même file.
--
-- Mesuré le 28 août : la même candidature est partie deux fois vers la même
-- agence, à une seconde d'intervalle, sur deux fils Gmail différents. Rien
-- n'était cassé dans `send_due` — il y avait simplement deux processus dedans
-- au même instant : la boucle de démonstration et le tick `prems-apply` qui
-- tourne toutes les deux minutes. Chacun a lu la file, y a vu la même ligne
-- `pending`, et l'a envoyée.
--
-- C'est précisément le défaut que le reste du module s'applique à éviter : deux
-- messages au même agent, pour le même appartement, de la même personne, c'est
-- exactement ce qui fait passer un candidat pour un robot. L'ordre d'écriture
-- (la ligne avant l'envoi) protégeait d'un crash ; il ne protégeait pas d'un
-- concurrent, parce que lire puis écrire n'est pas atomique.
--
-- La réservation l'est. Un statut intermédiaire, posé par un UPDATE conditionnel
-- qui ne peut réussir que pour un seul des deux appelants : celui qui obtient la
-- ligne envoie, l'autre voit zéro ligne et passe.
alter table public.applications
  drop constraint if exists applications_status_check;

alter table public.applications
  add constraint applications_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'replied', 'visit_booked', 'rejected'));

comment on column public.applications.status is
  'pending → sending (réservée par un ouvrier) → sent, puis replied / visit_booked / rejected. « sending » est un verrou, pas un état visible du produit.';

-- Quand la réservation a été posée. Il n'y a pas d'`updated_at` sur cette table,
-- et il en faut un ici : sans horodatage, une réservation abandonnée est
-- indiscernable d'une réservation en cours.
alter table public.applications
  add column if not exists sending_since timestamptz;

-- Une réservation qui ne se termine pas doit repartir.
--
-- Un conteneur tué entre la réservation et l'envoi laisserait la ligne en
-- « sending » pour toujours — une candidature perdue en silence, ce que ce
-- système ne fait jamais. Dix minutes couvrent très largement un envoi (mesuré
-- : deux à huit secondes, rédaction comprise).
create or replace function public.release_stale_sends()
returns integer
language sql
security definer
set search_path = public
as $$
  with freed as (
    update public.applications
    set status = 'pending'
    where status = 'sending'
      and coalesce(sending_since, created_at) < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer from freed;
$$;

comment on function public.release_stale_sends is
  'Rend à la file les candidatures réservées par un ouvrier qui n''a jamais fini.';
