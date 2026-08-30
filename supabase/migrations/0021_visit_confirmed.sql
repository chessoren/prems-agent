-- Proposer n'est pas confirmer.
--
-- `classified_as` n'avait pas d'état pour « l'agence a confirmé le rendez-vous ».
-- Une agence qui écrivait « je peux vous proposer lundi 10h ou mardi 14h » était
-- rangée dans `visit_offered`, et le worker en tirait une visite : un rendez-vous
-- posé dans l'agenda de quelqu'un que personne n'avait accepté. Observé en
-- démonstration le 30 août — deux créneaux proposés devenus un « 31 août 10h00 »
-- confirmé avant même que le candidat ait répondu, sur un créneau qu'il ne
-- pouvait pas honorer.
--
-- Les deux états sont désormais distincts, et seul le second atteint l'agenda.
alter table public.application_replies
  drop constraint if exists application_replies_classified_as_check;

alter table public.application_replies
  add constraint application_replies_classified_as_check
  check (classified_as in ('visit_offered', 'visit_confirmed', 'refused', 'question', 'other'));

comment on column public.application_replies.classified_as is
  'visit_offered = des créneaux sont proposés, la conversation continue. visit_confirmed = un rendez-vous précis est arrêté ; c''est le seul état qui écrit dans l''agenda.';
