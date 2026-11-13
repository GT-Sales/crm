-- CanadaWide intake fallback -> CRM (2026-11-09, after the CRM was down for
-- about 8 minutes that day). Runbook: docs/RUNBOOKS/intake-fallback.md.
--
-- When the CRM intake is unreachable, times out or answers 5xx, CanadaWide's
-- lead routes keep the lead in the legacy public.internet_leads /
-- public.mobility_leads table under an id the website chose, through the
-- website's key-gated public.canadawide_fallback_lead (CanadaWide repo:
-- supabase/migrations/20261109090000_crm_intake_fallback.sql), and tell the
-- customer it worked. This function brings such rows into the CRM's
-- `canadawide` site, under their own id, like the historical import
-- (packages/db/sql/canadawide-legacy-import.sql, whose row mapping and contact
-- merge it repeats verbatim). pg_cron runs it every 5 minutes.
--
-- What it imports: a legacy row created between p_days ago and p_min_age ago
-- that has
--   * no app.leads row with its id: every lead the CRM's intake saved reached
--     the legacy tables through the 0002 mirror under the CRM's own id, so it
--     always has one and is never touched; and
--   * no completed CRM idempotency key `cw-lead:<its id>`: the website sends
--     that key with every intake call, so a lead the CRM did save although the
--     website gave up waiting (and kept a fallback copy) is recognised here by
--     the key's hash, and its fallback copy is left out. Keys are pruned after
--     7 days, which is why p_days stays below that.
-- Since audit CW-B1 the website also sends that id as the create's `leadId`
-- and the CRM creates the lead under it, so a late CRM save has the fallback
-- row's id and the first check already skips it (and the ID step, which names
-- that id, finds the CRM lead). The key check stays for website versions that
-- do not send `leadId`.
-- p_min_age gives an intake transaction that was still committing when the
-- website gave up (its timeout is 10 s) time to land before the check.
--
-- What it writes, per row: the contact (found or created by normalised email,
-- name and phone only filled where empty), the lead (`submitted`, its legacy
-- status as the stage, consent version `cw-intake-fallback`) and one
-- `lead.created` audit event by the "Old admin" actor labelled
-- `intake fallback sync`. No timeline entry: the lead stays New, like a lead
-- from the intake. Only inserts, `on conflict do nothing`: a second run, or a
-- run racing another, writes nothing twice and never changes a CRM lead.
--
-- Emails and automations: none. The website already sent the customer's
-- confirmation and the staff alert on the fallback path, exactly as it does
-- after a CRM save. CRM automation flows (lead_submitted, stage_entered and
-- their timers) are not fired for an imported lead, as for every import.
--
-- Returns the number of leads it imported. This file only defines the
-- function; the schedule is the commented block at the end.

create or replace function app.sync_canadawide_fallback(
  p_days integer default 3,
  p_min_age interval default interval '2 minutes'
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $import$
declare
  -- contracts LEGACY_IMPORT_ACTOR_ID: the admin shows it as "Old admin".
  v_actor constant uuid := '00000000-0000-4000-8000-00000000a001';
  v_workspace uuid;
  v_imported integer;
begin
  if p_days is null or p_days < 1 or p_days > 6 then
    raise exception 'p_days must be 1 to 6 (CRM idempotency keys are pruned after 7 days)';
  end if;
  if p_min_age is null or p_min_age < interval '0' then
    raise exception 'p_min_age must be zero or more';
  end if;
  -- One run at a time; a run that finds another still going skips its turn.
  if not pg_try_advisory_xact_lock(hashtext('app.sync_canadawide_fallback')) then
    return 0;
  end if;

  select id into v_workspace from app.workspaces where slug = 'canadawide';
  if v_workspace is null then
    raise exception 'the canadawide site does not exist';
  end if;
  if to_regclass('public.internet_leads') is null or to_regclass('public.mobility_leads') is null then
    raise exception 'the legacy lead tables do not exist';
  end if;

  drop table if exists cw_fallback_rows;
  -- canadawide-legacy-import.sql's row shape, for the rows the CRM lacks.
  create temporary table cw_fallback_rows on commit drop as
  select r.*
  from (
    select
      i.id,
      'internet'::text as lead_type,
      i.full_name,
      btrim(i.email) as email,
      i.phone,
      i.status as stage,
      i.created_at,
      i.deleted_at,
      jsonb_build_object('schemaVersion', 1, 'payload', jsonb_strip_nulls(jsonb_build_object(
        'planId', nullif(btrim(i.plan_id), ''),
        'planLabel', i.plan,
        'landingCity', nullif(btrim(i.landing_city), ''),
        'dateOfBirth', to_char(i.date_of_birth, 'YYYY-MM-DD'),
        'streetAddress', i.street_address,
        'aptUnit', nullif(btrim(i.apt_unit), ''),
        'city', i.city,
        'postalCode', nullif(btrim(i.postal_code), ''),
        'currentProvider', nullif(btrim(i.current_provider), ''),
        'preferredInstallationTime', nullif(btrim(i.preferred_installation_time), ''),
        'consent', i.consent,
        'consentedAt', to_char(i.consented_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ))) as form
    from public.internet_leads as i
    where i.created_at >= now() - make_interval(days => p_days)
      and i.created_at <= now() - p_min_age
    union all
    select
      m.id,
      'mobility'::text,
      m.full_name,
      btrim(m.email),
      m.phone,
      m.status,
      m.created_at,
      m.deleted_at,
      jsonb_build_object('schemaVersion', 1, 'payload', jsonb_strip_nulls(jsonb_build_object(
        'planLabel', nullif(btrim(m.plan_id), ''),
        'lineCount', m.line_count,
        'firstName', nullif(btrim(m.first_name), ''),
        'lastName', nullif(btrim(m.last_name), ''),
        'keepNumber', m.keep_number,
        'simType', m.sim_type,
        'currentProvider', nullif(btrim(m.current_provider), ''),
        'streetAddress', m.street_address,
        'aptUnit', nullif(btrim(m.apt_unit), ''),
        'city', m.city,
        'postalCode', m.postal_code
      )))
    from public.mobility_leads as m
    where m.created_at >= now() - make_interval(days => p_days)
      and m.created_at <= now() - p_min_age
  ) as r
  where not exists (select 1 from app.leads as l where l.id = r.id)
    -- The CRM saved this lead under its own id (website: lib/crm.ts
    -- crmLeadIdempotencyKey, `cw-lead:<id>`; the key is stored as its SHA-256).
    and not exists (
      select 1 from app.idempotency_keys as k
      where k.workspace_id = v_workspace
        and k.scope = 'lead_submission'
        and k.key_hash = encode(sha256(convert_to('cw-lead:' || r.id::text, 'UTF8')), 'hex')
        and k.lead_id is not null
    );

  if not exists (select 1 from cw_fallback_rows) then
    return 0;
  end if;

  insert into app.contacts as c (email, full_name, phone, country_code)
  select distinct on (lower(r.email)) lower(r.email), r.full_name, r.phone, 'CA'
  from cw_fallback_rows as r
  where position('@' in r.email) > 1
  order by lower(r.email), r.created_at desc
  on conflict (email) do update set
    full_name = coalesce(c.full_name, excluded.full_name),
    phone = coalesce(c.phone, excluded.phone),
    country_code = coalesce(c.country_code, excluded.country_code);

  -- The 0002 mirror fires for each insert and finds its legacy row: no-op.
  with inserted as (
    insert into app.leads (
      id, workspace_id, lead_type, status, stage, full_name, email, phone, country_code,
      contact_id, payload, attribution, consent_version, deleted_at, created_at, updated_at
    )
    select
      r.id, v_workspace, r.lead_type, 'submitted', r.stage, r.full_name, r.email, r.phone, 'CA',
      c.id, r.form, '{}'::jsonb, 'cw-intake-fallback', r.deleted_at, r.created_at, r.created_at
    from cw_fallback_rows as r
    left join app.contacts as c on c.email = lower(r.email)
    on conflict (id) do nothing
    returning id, lead_type, stage, contact_id
  ), audited as (
    insert into app.audit_events (
      workspace_id, actor_id, actor_label, action, entity, entity_id, request_id, after
    )
    select
      v_workspace, v_actor, 'intake fallback sync', 'lead.created', 'lead', n.id,
      gen_random_uuid(),
      jsonb_build_object(
        'status', 'submitted', 'stage', n.stage, 'leadType', n.lead_type,
        'contactId', n.contact_id, 'consentVersion', 'cw-intake-fallback',
        'source', 'intake_fallback'
      )
    from inserted as n
    returning 1
  )
  select count(*) into v_imported from audited;

  return v_imported;
end
$import$;

revoke all on function app.sync_canadawide_fallback(integer, interval) from public;

-- SCHEDULE (prepared, not applied: run after the function above exists).
-- Every 5 minutes. Its runs are in cron.job_run_details.
--   create extension if not exists pg_cron;
--   select cron.schedule('cw-intake-fallback-sync', '*/5 * * * *', 'select app.sync_canadawide_fallback()');
-- To stop it:
--   select cron.unschedule('cw-intake-fallback-sync');
