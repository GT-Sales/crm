-- Transitional bridge for the CanadaWide cutover (docs/HANDOFF.md, docs/PLAN.md §6).
--
-- CanadaWide's server now sends its internet and mobility leads to the backend
-- with a site key, instead of inserting into public.internet_leads and
-- public.mobility_leads with the public key (whose anon insert policies are then
-- dropped). Until staff move to the CRM screens in phase 2, the old Get Canada
-- Sim admin keeps working from those legacy tables, so every new CanadaWide lead
-- is copied there in the same transaction and under the same id: the lead and
-- its legacy row are one record, and the mobility ID-upload step, which still
-- writes public.mobility_id_uploads directly, links to the lead by that id.
--
-- The copy is insert-only and idempotent (`on conflict (id) do nothing`), so a
-- later import of the historical legacy rows into app.leads under their own
-- ids passes straight through. A database without the legacy tables (CI, local)
-- makes the trigger a no-op.
--
-- Remove the trigger and the function when the old Internet/Mobility Leads pages
-- are retired (phase 2 exit), in a new migration.

create function app.mirror_canadawide_legacy_lead() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  lead_form jsonb := new.payload -> 'payload';
begin
  if new.lead_type not in ('internet', 'mobility') then
    return new;
  end if;
  if not exists (
    select 1 from app.workspaces w where w.id = new.workspace_id and w.slug = 'canadawide'
  ) then
    return new;
  end if;

  if new.lead_type = 'internet' then
    if to_regclass('public.internet_leads') is null then
      return new;
    end if;
    insert into public.internet_leads (
      id, created_at, plan, plan_id, landing_city, full_name, date_of_birth, email, phone,
      street_address, apt_unit, city, postal_code, current_provider,
      preferred_installation_time, consent, consented_at
    ) values (
      new.id,
      new.created_at,
      lead_form ->> 'planLabel',
      lead_form ->> 'planId',
      lead_form ->> 'landingCity',
      new.full_name,
      (lead_form ->> 'dateOfBirth')::date,
      new.email,
      new.phone,
      lead_form ->> 'streetAddress',
      lead_form ->> 'aptUnit',
      lead_form ->> 'city',
      lead_form ->> 'postalCode',
      lead_form ->> 'currentProvider',
      lead_form ->> 'preferredInstallationTime',
      (lead_form ->> 'consent')::boolean,
      (lead_form ->> 'consentedAt')::timestamptz
    )
    on conflict (id) do nothing;
  else
    if to_regclass('public.mobility_leads') is null then
      return new;
    end if;
    -- The legacy plan_id column holds the plan as staff read it ("100 GB $40").
    insert into public.mobility_leads (
      id, created_at, plan_id, line_count, full_name, first_name, last_name, email, phone,
      current_provider, keep_number, sim_type, street_address, apt_unit, city, postal_code
    ) values (
      new.id,
      new.created_at,
      lead_form ->> 'planLabel',
      (lead_form ->> 'lineCount')::smallint,
      new.full_name,
      lead_form ->> 'firstName',
      lead_form ->> 'lastName',
      new.email,
      new.phone,
      lead_form ->> 'currentProvider',
      (lead_form ->> 'keepNumber')::boolean,
      lead_form ->> 'simType',
      lead_form ->> 'streetAddress',
      lead_form ->> 'aptUnit',
      lead_form ->> 'city',
      lead_form ->> 'postalCode'
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger leads_mirror_canadawide_legacy
  after insert on app.leads
  for each row
  execute function app.mirror_canadawide_legacy_lead();
