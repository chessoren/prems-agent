-- Do not queue an application for a client who has no mailbox connected.
--
-- The previous design checked at send time and dead-lettered on failure, with
-- the reasoning that no retry creates a mailbox. That reasoning was right and
-- the conclusion was wrong: a *reconnection* fixes it, and a dead letter is
-- permanent. Within twenty minutes of deploying, 103 matches had been consumed
-- into dead-lettered applications - 103 apartments that would have stayed lost
-- on the day the client finally connected their Gmail.
--
-- Checking at queue time leaves the match untouched and eligible. The listing
-- ages out on its own, which is honest: an apartment found while the client was
-- not yet set up is not one we could have applied for.

create or replace function public.matches_ready_to_send(want integer default 50)
returns table (match_id uuid, user_id uuid, listing_id uuid, agency_email text)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, m.listing_id, coalesce(l.agency_email, a.email)
  from public.matches m
  join public.listings l on l.id = m.listing_id
  join public.profiles p on p.id = m.user_id
  left join public.agencies a
    on a.source_id = l.source_id and a.external_id = l.agency_external_id
  where m.status = 'new'
    and l.status = 'active'
    -- The precondition, checked before anything is consumed.
    and p.gmail_account_id is not null
    and coalesce(l.agency_email, a.email) is not null
    and not exists (select 1 from public.applications ap where ap.match_id = m.id)
  order by m.score desc, m.created_at asc
  limit want;
$$;

-- Give back what the earlier design took. These applications were never sent,
-- so deleting them restores the match to 'new' rather than inventing history.
delete from public.applications
 where dead_letter
   and sent_at is null
   and dead_letter_reason like '%Gmail%';

-- Bounded in time, and that bound is the point.
--
-- Migrations here are re-applied in full on every run, which is fine for a
-- statement that describes an invariant and wrong for one that describes an
-- incident. Unbounded, this repair kept firing long after the incident it
-- repaired: it erased *every* skip reason in the table on each migrate,
-- including the legitimate ones written later at queue time (`daily_cap`,
-- `agency_cooldown`) and the corrections made in 0012, which run after it and
-- found nothing left to correct.
--
-- A repair belongs to a moment. This one belongs to the afternoon of the 14th.
update public.matches m
   set status = 'new', skipped_reason = null
 where m.status in ('queued', 'skipped')
   and m.created_at < timestamptz '2026-08-15 00:00:00+00'
   and not exists (select 1 from public.applications a where a.match_id = m.id);
