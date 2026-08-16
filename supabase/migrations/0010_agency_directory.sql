-- Populate the agency directory from what the scraper already collected.
--
-- Contactability is the ceiling on the whole product: an apartment we can see
-- and cannot write to is worth nothing to a client. It sits at 10% because
-- Bien'ici publishes a phone and withholds the email. But 405 of 722 listings
-- carry `agencyFeeUrl`, which points at the agency's own domain - and an agency
-- publishes a contact address on its own site.
--
-- One row per agency, not per listing: an address resolved once serves every
-- apartment that agency will ever post, and a failure is worth remembering so
-- an unreachable agency is not re-crawled for each of its listings.

insert into public.agencies (source_id, external_id, name, domain, email, email_status)
select distinct on (l.source_id, coalesce(l.agency_external_id, l.agency_name))
  l.source_id,
  coalesce(l.agency_external_id, l.agency_name),
  l.agency_name,
  -- The domain, stripped of the CDN hosts that are the CMS rather than the
  -- agency. Writing to files.netty.immo reaches a file server, not an agent.
  nullif(
    regexp_replace(
      coalesce(substring(l.raw->>'agencyFeeUrl' from 'https?://(?:www\.)?([^/]+)'), ''),
      '^(media\.immo-facile|files\.netty|bareme\.iadfrance)\..*$', ''
    ), ''),
  l.agency_email,
  case when l.agency_email is not null then 'found' else 'pending' end
from public.listings l
where coalesce(l.agency_external_id, l.agency_name) is not null
on conflict (source_id, external_id) do update
  set email = coalesce(public.agencies.email, excluded.email),
      domain = coalesce(public.agencies.domain, excluded.domain),
      name = coalesce(public.agencies.name, excluded.name),
      email_status = case
        when public.agencies.email is not null or excluded.email is not null then 'found'
        else public.agencies.email_status
      end;

-- An agency with no domain cannot be looked up. Marking it failed now keeps it
-- out of the queue instead of being skipped over on every pass.
update public.agencies
   set email_status = 'failed', looked_up_at = now()
 where email_status = 'pending' and (domain is null or domain = '');

-- Which agencies are worth a lookup, most-listings-first: resolving the agency
-- that posts forty apartments unlocks forty, resolving one that posted once
-- unlocks one.
create or replace function public.agencies_needing_email(want integer default 25)
returns table (id uuid, domain text, name text, listings bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.domain, a.name, count(l.id)
  from public.agencies a
  left join public.listings l
    on l.source_id = a.source_id
   and coalesce(l.agency_external_id, l.agency_name) = a.external_id
   and l.status = 'active'
  where a.email_status = 'pending'
    and a.domain is not null and a.domain <> ''
  group by a.id, a.domain, a.name
  order by count(l.id) desc
  limit want;
$$;

-- Once an agency has an address, every listing of theirs inherits it.
create or replace function public.propagate_agency_emails()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare updated integer;
begin
  update public.listings l
     set agency_email = a.email
    from public.agencies a
   where a.source_id = l.source_id
     and coalesce(l.agency_external_id, l.agency_name) = a.external_id
     and a.email is not null
     and l.agency_email is null;
  get diagnostics updated = row_count;
  return updated;
end;
$$;
