-- Three defects found by reading what the running system actually produced,
-- not by reading the code that produces it.
--
-- All three share a shape: a decision taken at the wrong moment. The matcher
-- decided who "was served" before anything could be sent, the alerting decided
-- a permanent configuration was an incident, and both looked correct in
-- isolation.

-- ===========================================================================
-- 1. A client must not lose an apartment to themselves.
--
-- Measured on live data: 147 matches carried `served_higher_priority_client`,
-- and 86 of them - 59% - were a client losing to their own second search. One
-- user holds two active searches; a listing satisfying both produced two
-- candidate rows with the same user and the same priority, and the per-listing
-- cap served one and told the other that somebody else had priority.
--
-- The message was false, and `skipped_reason` is shown to the client.
--
-- Worse is what it hides. The cut is `slice(0, applications_per_listing)` over
-- rows ordered by priority, and rows from one client are adjacent because
-- their priority is identical. Raise the cap to 2 and a client with two
-- searches takes *both* slots, starving the very rotation the cap exists to
-- create. The cap counts rows; it was always meant to count clients.
--
-- The worker now collapses candidates per client before the cut. This repairs
-- the rows the old behaviour wrote.
-- ===========================================================================
update public.matches m
   set skipped_reason = 'duplicate_of_your_other_search'
 where m.status = 'skipped'
   and m.skipped_reason = 'served_higher_priority_client'
   and exists (
     select 1 from public.matches w
     where w.listing_id = m.listing_id
       and w.user_id    = m.user_id
       and w.id <> m.id
       and w.status <> 'skipped'
   );

-- ===========================================================================
-- 2. Nobody was served, so nothing was lost to a higher priority.
--
-- The remaining skips are genuine cross-client ones - and every one of them is
-- still untrue, because not a single application has ever been sent. The
-- winner's match sits at `new`, waiting for a mailbox that is not connected
-- yet, while the runners-up were burned permanently the moment the listing
-- arrived.
--
-- This is the same defect as the dead-lettering fixed in 0011, in a different
-- costume: a terminal decision taken against an outcome that had not happened.
--
-- Give them back. A skip is only earned once an application actually exists.
-- ===========================================================================
update public.matches m
   set status = 'new', skipped_reason = null
 where m.status = 'skipped'
   and m.skipped_reason = 'served_higher_priority_client'
   and not exists (
     select 1 from public.applications a
     where a.listing_id = m.listing_id
       and a.sent_at is not null
   );

-- A row that is not skipped must not carry a reason for having been skipped.
--
-- Seven rows in the live table read `status = 'new'` with
-- `skipped_reason = 'served_higher_priority_client'`, and the interface renders
-- that reason. The matcher's upsert sets `status` and says nothing about
-- `skipped_reason`, so a skipped row that later won kept the old sentence. It
-- could only happen while a listing was matched more than once, which is the
-- era 0006 ended - hence seven, and no more since.
--
-- The worker now clears the column explicitly. This tidies what it left.
update public.matches
   set skipped_reason = null
 where status <> 'skipped' and skipped_reason is not null;

-- ===========================================================================
-- 3. The per-listing cap moves to where the scarce thing is allocated.
--
-- The scarce resource is not a match row, it is an application. Enforcing the
-- cap at match time spends it against a send that may never happen; enforcing
-- it at queue time spends it against a send that is about to.
--
-- This also puts fairness back where the specification put it: "on sert
-- d'abord celui qui a le score de priorité le plus haut". Serving is the
-- application. The previous ordering here was `score desc` - relevance, not
-- priority - so the queue could quietly undo the rotation the matcher had just
-- computed. Priority leads now, and score breaks its ties.
--
-- `client_priority` is computed once per candidate client rather than once per
-- row: it walks 30 days of applications, and calling it inside an ORDER BY
-- over a thousand matches would do that a thousand times.
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
      -- The precondition, checked before anything is consumed (0011).
      and p.gmail_account_id is not null
      and coalesce(l.agency_email, a.email) is not null
      and not exists (select 1 from public.applications ap where ap.match_id = m.id)
      -- One client never applies twice for the same apartment, whichever of
      -- their searches found it.
      and not exists (
        select 1 from public.applications ap
        where ap.listing_id = m.listing_id and ap.user_id = m.user_id
      )
      -- The cap, counted in applications that are still standing. A
      -- dead-lettered one never reached the agency, so it must not hold a slot
      -- shut against the next client in line.
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
  'Matches prêts à devenir une candidature, dans l''ordre de priorité client puis de score. Le plafond par annonce est appliqué ici, pas au moment du match.';

-- ===========================================================================
-- Closing the losers, once there is something they actually lost to.
--
-- Called by the apply job after queuing. A match stays `new` - still eligible,
-- still rescuable if the winner's send fails - until an application for that
-- listing has genuinely left the building. Then, and only then, the statement
-- "somebody with higher priority was served" becomes true and is written down.
-- ===========================================================================
-- Bring the existing rows to the state the fixed matcher would have produced.
--
-- 493 (client, listing) pairs carry two `new` matches, from the two searches of
-- the one client who has two. The matcher no longer creates them and the index
-- below makes them harmless, but leaving them means the queue rediscovers and
-- defuses 493 landmines one at a time. Same rule as the worker: the
-- best-scoring search keeps the apartment, ties broken by age so the outcome
-- does not depend on row order.
with ranked as (
  select id,
         row_number() over (
           partition by user_id, listing_id
           order by score desc, created_at asc, id
         ) as rank
  from public.matches
  where status = 'new'
)
update public.matches m
   set status = 'skipped', skipped_reason = 'duplicate_of_your_other_search'
  from ranked r
 where r.id = m.id
   and r.rank > 1;

-- ===========================================================================
-- The guarantee that no worker logic can lose.
--
-- Leaving every eligible client at `new` instead of cutting at match time
-- surfaced a hazard that the cut had been hiding: one client with two searches
-- now has two `new` rows for the same apartment, and `matches_ready_to_send`
-- returns both in the same batch. The "already applied for this listing"
-- predicate is evaluated once, when the batch is read - so it sees neither
-- insert, and the worker writes two applications to the same agent, for the
-- same flat, from the same person.
--
-- That is the single most damaging thing this system can do to a client: it is
-- exactly what makes a human look like a bot, and it is what the whole
-- application worker was written to avoid.
--
-- The worker is fixed to track the batch, but a rule this expensive to break
-- does not belong only in a worker. Partial, so that a dead-lettered
-- application - one that never reached anybody - does not block a genuine
-- second attempt once the address is corrected.
-- ===========================================================================
create unique index if not exists applications_one_per_client_listing
  on public.applications (user_id, listing_id)
  where not dead_letter;

-- The set itself, named once so the two branches below cannot drift apart.
create or replace function public.lost_matches()
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.matches m
  where m.status = 'new'
    and m.listing_id in (
      select ap.listing_id
      from public.applications ap
      where ap.sent_at is not null and not ap.dead_letter
      group by ap.listing_id
      having count(*) >= (select applications_per_listing from public.settings where id = 1)
    )
    and not exists (select 1 from public.applications ap where ap.match_id = m.id);
$$;

create or replace function public.close_lost_matches()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  closed integer;
begin
  -- `notify_unserved_matches` keeps the meaning it was written with: whether a
  -- client who matched but was not served hears about it. True keeps the row,
  -- which is also what makes the rotation auditable; false removes it, and the
  -- listing is already marked considered so it cannot come back.
  if (select notify_unserved_matches from public.settings where id = 1) then
    with upd as (
      update public.matches
         set status = 'skipped', skipped_reason = 'served_higher_priority_client'
       where id in (select id from public.lost_matches())
      returning 1
    ) select count(*) into closed from upd;
  else
    with del as (
      delete from public.matches
       where id in (select id from public.lost_matches())
      returning 1
    ) select count(*) into closed from del;
  end if;

  return closed;
end;
$$;

-- ===========================================================================
-- 4. An alarm that rings every hour for a condition nobody will act on.
--
-- 22 `source.alert` events in 24 hours, every one of them firing on
-- `unreachable_but_enabled` for bienici - which is true, permanent, known, and
-- decided: we read that source and reach its agencies by email because its own
-- contact endpoint requires an account.
--
-- Two things are wrong with that.
--
-- The first is fatigue: an alarm that is always ringing is an alarm nobody
-- reads, and it will be ringing on the morning a scraper actually dies.
--
-- The second is concrete. The old deduplication was one alert per source per
-- hour *whatever the condition*, so the standing configuration alert consumed
-- the hour's slot. A scraper going silent at :10 raised nothing until the next
-- window - up to an hour of delay, then indistinguishable from the other 22.
--
-- Deduplicating per condition fixes the masking. Muting fixes the fatigue, and
-- is recorded on the source itself rather than hidden in the alerting code, so
-- "what are we deliberately not alerting on?" is a query.
-- ===========================================================================
alter table public.sources
  add column if not exists muted_alerts text[] not null default '{}';

comment on column public.sources.muted_alerts is
  'Conditions de source_health volontairement non alertées, parce que connues et acceptées. Vider la colonne pour réentendre l''alarme.';

create or replace function public.raise_health_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  raised integer := 0;
  r record;
  cond text;
  active_conditions text[];
begin
  for r in
    select h.slug, h.is_stale, h.produced_nothing_24h, h.unreachable_but_enabled,
           h.last_ok_at, s.muted_alerts
    from public.source_health h
    join public.sources s on s.slug = h.slug
    where h.enabled
      and (h.is_stale or h.produced_nothing_24h or h.unreachable_but_enabled)
  loop
    active_conditions := array_remove(array[
      case when r.is_stale                then 'is_stale'                else null end,
      case when r.produced_nothing_24h    then 'produced_nothing_24h'    else null end,
      case when r.unreachable_but_enabled then 'unreachable_but_enabled' else null end
    ], null);

    foreach cond in array active_conditions loop
      continue when cond = any (r.muted_alerts);

      -- One alert per source *and condition* per hour. Keyed on the condition
      -- so a real outage is never swallowed by a standing one.
      if not exists (
        select 1 from public.events
        where type = 'source.alert'
          and payload->>'source'    = r.slug
          and payload->>'condition' = cond
          and created_at > now() - interval '1 hour'
      ) then
        insert into public.events (user_id, type, subject_type, payload)
        values (
          null, 'source.alert', 'source',
          jsonb_build_object(
            'source', r.slug,
            'condition', cond,
            'last_ok_at', r.last_ok_at
          )
        );
        raised := raised + 1;
      end if;
    end loop;
  end loop;
  return raised;
end;
$$;

comment on function public.raise_health_alerts is
  'Une alerte par source et par condition, au plus une fois par heure. Les conditions listées dans sources.muted_alerts sont ignorées.';

-- Bien'ici is read-only by decision, not by accident: its contact endpoint
-- answers 401 without an account, so applications go to the agency by email.
-- Un-mute this the day `contact_channel` becomes anything other than 'none' -
-- or simply let it un-mute itself, since the condition disappears with it.
update public.sources
   set muted_alerts = array['unreachable_but_enabled']
 where slug = 'bienici'
   and contact_channel = 'none'
   and not ('unreachable_but_enabled' = any (muted_alerts));

-- ===========================================================================
-- 5. The semantic score has never had anything to score against.
--
-- `semantic_score` reads `searches.free_text_embedding`. Nothing has ever
-- written that column - not the worker, not the onboarding. The weight is
-- redistributed when it is null, so the system produced plausible scores and
-- no error, and 15% of the ranking simply did not exist.
--
-- It costs nothing today because no client has written free text yet. It would
-- have cost silently on the day one did, which is the expensive version.
--
-- Same shape as `listings_needing_embedding`: the database answers which rows
-- are missing, rather than the worker fetching a page and filtering it - the
-- mistake that made the listing backfill report success while writing nothing.
-- ===========================================================================
-- Staleness is decided by content, not by clocks.
--
-- The obvious version stores an `embedded_at` timestamp and re-embeds when
-- `updated_at` is newer. It cannot work here: `searches_touch` sets
-- `updated_at` on every UPDATE, including the one that writes the vector, and
-- the worker's own clock is a second clock that can disagree with the server's.
-- The two together turn "re-embed when the text changed" into "re-embed every
-- five minutes, for ever, billing Vertex each time" - a loop with no error and
-- no visible symptom but the invoice.
--
-- A hash of the text answers the same question and has no clock in it.
alter table public.searches
  add column if not exists free_text_embedded_hash text;

comment on column public.searches.free_text_embedded_hash is
  'md5 du free_text au moment où l''embedding a été calculé. Diffère du texte courant = à recalculer.';

-- Deleting the text must delete the vector.
--
-- `semantic_score` gates on `free_text_embedding is not null`, not on
-- `free_text`. So a client who clears their free text would go on being scored
-- against the sentence they just deleted, for ever, with nothing in the
-- interface to suggest it. The worker cannot fix this - it only ever looks at
-- rows that *have* text - so it belongs where the write happens.
create or replace function public.clear_stale_search_embedding()
returns trigger
language plpgsql
as $$
begin
  if new.free_text is distinct from old.free_text then
    new.free_text_embedding := null;
    new.free_text_embedded_hash := null;
  end if;
  return new;
end;
$$;

drop trigger if exists searches_clear_embedding on public.searches;
create trigger searches_clear_embedding
  before update of free_text on public.searches
  for each row execute function public.clear_stale_search_embedding();

create or replace function public.searches_needing_embedding(want integer default 50)
returns table (id uuid, free_text text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.free_text
  from public.searches s
  where s.active
    and s.free_text is not null
    and length(btrim(s.free_text)) > 0
    and (
      s.free_text_embedding is null
      -- Hashed raw, exactly as the worker hashes it. A normalisation applied on
      -- one side only (btrim here, .trim() there) would make the hashes never
      -- agree, which is the same infinite loop wearing a different hat.
      or s.free_text_embedded_hash is distinct from md5(s.free_text)
    )
  order by s.updated_at desc
  limit want;
$$;
