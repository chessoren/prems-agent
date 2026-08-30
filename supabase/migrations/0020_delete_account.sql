-- Repartir de zéro, depuis l'interface.
--
-- Supprimer un compte demande le rôle de service : `auth.users` n'est pas
-- accessible au client, et c'est très bien ainsi. Une fonction `security
-- definer` bornée à `auth.uid()` donne exactement ce pouvoir-là et rien de
-- plus — on ne peut pas s'en servir pour effacer le compte d'un autre, puisque
-- l'identité n'est pas un paramètre.
--
-- Le reste part en cascade : profil, recherches, matchs, candidatures, fils,
-- messages, visites. C'est déjà la règle des clés étrangères, vérifiée en
-- supprimant douze comptes le 30 août — toutes les tables sont retombées à
-- zéro sans une seule ligne orpheline.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'aucune session';
  end if;

  delete from auth.users where id = me;
end;
$$;

comment on function public.delete_my_account is
  'Supprime le compte de l''appelant et, par cascade, toutes ses données. Bornée à auth.uid() : elle ne peut atteindre personne d''autre.';

revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;
