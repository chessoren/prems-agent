-- ---------------------------------------------------------------------------
-- Ce que l'agent réclame quand il lui manque quelque chose.
--
-- Une agence qui demande « avez-vous la pièce d'identité du garant ? » met
-- l'agent devant une information qu'il n'a pas. Jusqu'ici il répondait « je
-- vous le transmets dans la journée » — honnête, mais la demande se perdait :
-- personne n'était prévenu, et le fil s'arrêtait là.
--
-- Cette table est l'endroit où la demande atterrit. Elle est lisible par le
-- client, qui la voit dans l'onglet Agent, et refermée dès que le document
-- arrive. Ce n'est pas une file de tâches internes : c'est la conversation
-- entre l'agent et la personne au nom de qui il écrit.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  application_id uuid references public.applications (id) on delete cascade,
  -- Ce qui est demandé. `document` attend un fichier, `answer` attend une
  -- phrase, `decision` attend un oui ou un non.
  kind           text not null check (kind in ('document', 'answer', 'decision')),
  -- Pour un document, la catégorie attendue, alignée sur `documents.kind`.
  doc_kind       text check (doc_kind in ('identite', 'domicile', 'revenus', 'garant')),
  label          text not null,
  -- Pourquoi l'agent demande. Affiché tel quel : une demande sans raison est
  -- une corvée, une demande motivée est une étape.
  reason         text,
  status         text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  answer         text,
  document_id    uuid references public.documents (id) on delete set null,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index if not exists agent_requests_user_idx
  on public.agent_requests (user_id, status, created_at desc);

alter table public.agent_requests enable row level security;

-- Le client lit et referme les siennes. L'agent écrit avec la clé de service,
-- qui contourne la RLS : il n'a donc pas besoin d'une policy d'insertion, et
-- ne pas lui en donner évite qu'un navigateur puisse en fabriquer une.
drop policy if exists "own agent requests readable" on public.agent_requests;
create policy "own agent requests readable"
  on public.agent_requests for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own agent requests updatable" on public.agent_requests;
create policy "own agent requests updatable"
  on public.agent_requests for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Le journal de décision, tel que le client peut le lire.
--
-- `events` porte déjà tout ce que l'agent fait, mais mêlé à l'exploitation :
-- santé des sources, runs de scraping, alertes. Cette vue ne garde que ce qui
-- concerne une personne et se raconte, pour que l'onglet Agent n'ait pas à
-- connaître la liste des types internes.
-- ---------------------------------------------------------------------------
create or replace view public.agent_activity as
select
  e.id,
  e.user_id,
  e.type,
  e.subject_type,
  e.subject_id,
  e.payload,
  e.created_at
from public.events e
where e.user_id is not null
  and e.type not like 'source.%'
  and e.type not like 'scrape.%'
  and e.type not like 'composio.%';

alter view public.agent_activity set (security_invoker = on);
