-- The conversation, and the availability that drives it.
--
-- Three things were missing for the agent to actually negotiate a viewing.
--
-- It did not know when the client was free. Availability lived in the
-- browser's localStorage, which a worker running in Cloud Run at eight in the
-- morning cannot read. So the agent could ask for a visit but never propose a
-- time, which is the sentence that actually books one.
--
-- It had nowhere to keep what was said. `applications` held the first message
-- and `application_replies` held incoming ones; a follow-up the agent wrote had
-- no home at all. The Messages tab could therefore never show a conversation,
-- only its first line and the answers to it.
--
-- And a reply written by the client in the Prems interface had no way out. It
-- has one now: it lands in the same outbox the agent uses, and leaves as an
-- e-mail on the same Gmail thread.

-- ===========================================================================
-- When the client can visit.
--
-- Stored as the slot ids the interface already speaks (`mar-18`, `sam-10`), so
-- the calendar tab writes exactly what it renders. Seven days x four windows is
-- a small enough space that a text array beats a table nobody would ever join.
-- ===========================================================================
alter table public.profiles
  add column if not exists availability text[] not null default '{}',
  add column if not exists availability_saved_at timestamptz;

comment on column public.profiles.availability is
  'Créneaux hebdomadaires de visite, ids de l''interface : mar-18, sam-10. Lus par l''agent pour proposer une date.';

-- ===========================================================================
-- Everything said, in both directions.
--
-- One row per message, whoever wrote it. The alternative - keeping outgoing
-- messages on `applications` and incoming ones on `application_replies` - is
-- what made a thread impossible to render in order.
-- ===========================================================================
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  application_id  uuid not null references public.applications (id) on delete cascade,
  listing_id      uuid references public.listings (id) on delete set null,

  direction       text not null check (direction in ('out', 'in')),
  -- Who actually wrote it. The interface must be able to say "written by your
  -- agent" on a message that went out over the client's own name, because at
  -- the moment they take over a thread they need to know what has already been
  -- said for them.
  author          text not null check (author in ('agent', 'client', 'agency')),

  subject         text,
  body            text not null,

  -- Gmail's own identifiers, so a follow-up lands on the same thread instead of
  -- starting a new one an agent has to reconcile by hand.
  gmail_message_id text,
  gmail_thread_id  text,

  -- Outgoing messages are queued and sent by the worker; incoming ones arrive
  -- already 'received'.
  status          text not null default 'received'
                  check (status in ('pending', 'sent', 'failed', 'received')),
  attempts        integer not null default 0,
  last_error      text,

  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  -- The same agency message must not be stored twice when the watcher re-reads
  -- a thread it has already seen.
  constraint messages_gmail_unique unique (application_id, gmail_message_id)
);

create index if not exists messages_thread_idx
  on public.messages (application_id, created_at);

create index if not exists messages_outbox_idx
  on public.messages (status, created_at)
  where status = 'pending' and direction = 'out';

alter table public.messages enable row level security;

drop policy if exists "own messages readable" on public.messages;
create policy "own messages readable"
  on public.messages for select to authenticated
  using ((select auth.uid()) = user_id);

-- The client may add to their own conversation, and only that.
--
-- Constrained hard: they cannot forge a message from the agency, cannot mark
-- one already sent, and cannot write into somebody else's thread. This is the
-- one table the browser is allowed to write, so it is the one that has to be
-- pinned down.
drop policy if exists "own reply writable" on public.messages;
create policy "own reply writable"
  on public.messages for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and direction = 'out'
    and author = 'client'
    and status = 'pending'
    and exists (
      select 1 from public.applications a
      where a.id = application_id and a.user_id = (select auth.uid())
    )
  );

-- ===========================================================================
-- How far the agent may go on its own.
--
-- A negotiation that loops is worse than one that stops: an agency receiving a
-- sixth automated reply stops answering the client at all. The cap is data, so
-- it can be lowered the first time a thread misbehaves.
-- ===========================================================================
alter table public.settings
  add column if not exists agent_replies_enabled boolean not null default true,
  add column if not exists max_agent_replies_per_thread integer not null default 4;

comment on column public.settings.agent_replies_enabled is
  'false = l''agent classe et rédige mais n''envoie jamais de réponse lui-même.';

-- ===========================================================================
-- The outbox: what the worker has to send, in thread order.
-- ===========================================================================
create or replace function public.messages_to_send(want integer default 20)
returns table (
  message_id uuid,
  user_id uuid,
  application_id uuid,
  to_email text,
  subject text,
  body text,
  gmail_thread_id text,
  gmail_account_id text
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, m.application_id, a.to_email, m.subject, m.body,
         -- Reply on the thread the application started, whichever message of it
         -- we happen to be answering.
         coalesce(m.gmail_thread_id, (
           select mm.gmail_thread_id from public.messages mm
           where mm.application_id = m.application_id and mm.gmail_thread_id is not null
           order by mm.created_at limit 1
         )),
         p.gmail_account_id
  from public.messages m
  join public.applications a on a.id = m.application_id
  join public.profiles p on p.id = m.user_id
  where m.direction = 'out'
    and m.status = 'pending'
    and m.attempts < 5
    and p.gmail_account_id is not null
    and a.to_email is not null
  order by m.created_at
  limit want;
$$;

-- ===========================================================================
-- One thread, ready to render.
--
-- The interface reads `messages` directly - it is under RLS - but the worker
-- needs the count of its own replies to respect the cap, and asking the
-- database is cheaper than counting in the worker and being wrong.
-- ===========================================================================
create or replace function public.agent_reply_count(p_application_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.messages
  where application_id = p_application_id and direction = 'out' and author = 'agent';
$$;

-- Realtime: a message appearing in the tab while the person is reading it is
-- the whole point of showing the conversation rather than a status.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages')
    then
      alter publication supabase_realtime add table public.messages;
    end if;
  end if;
end $$;

-- ===========================================================================
-- Backfill: the first message of applications sent before this table existed.
--
-- The `on conflict` clause is not the guard it looks like. It keys on
-- (application_id, gmail_message_id), and the synthetic `seed-<id>` never
-- collides with the real Gmail id the worker writes - so on the second
-- `db:migrate` this inserted a duplicate of every message the worker had since
-- recorded, and the Messages tab showed each one twice. Caught in the live
-- table: three applications, six rows.
--
-- Which is the same defect 0011 had to be corrected for, made twice. The rule
-- earned the hard way: a migration statement that repairs *data* must name the
-- condition that makes it unnecessary, because it will run again.
--
-- Here that condition is simply "this application has no message yet".
-- ===========================================================================
insert into public.messages (
  user_id, application_id, listing_id, direction, author, subject, body,
  gmail_message_id, status, created_at, sent_at
)
select a.user_id, a.id, a.listing_id, 'out', 'agent', a.subject, a.body,
       'seed-' || a.id::text, 'sent', a.created_at, a.sent_at
from public.applications a
where a.body is not null
  and a.sent_at is not null
  and not exists (select 1 from public.messages m where m.application_id = a.id);

-- Remove the duplicates the unguarded version created: a seeded copy is only
-- ever legitimate when it is the single message of its thread.
delete from public.messages seeded
 where seeded.gmail_message_id = 'seed-' || seeded.application_id::text
   and exists (
     select 1 from public.messages other
     where other.application_id = seeded.application_id
       and other.id <> seeded.id
   );
