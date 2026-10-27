-- CanadaWide's old admin -> the CRM: every row of public.internet_leads and
-- public.mobility_leads becomes an app.leads row of the `canadawide` site
-- under its own id, with its contact, its note and its reminder.
--
-- Run as the project's `postgres` role (Supabase SQL editor, the Supabase MCP
-- `execute_sql`, or psql with MIGRATION_DATABASE_URL). It writes only to the
-- `app` schema and reads `public`, never the other way round. Runbook:
-- docs/RUNBOOKS/legacy-import.md.
--
-- Re-runnable, and meant to be re-run until staff move to the CRM (the old
-- admin stays in use until then):
--   * leads: inserted once; later runs carry the old admin's stage and trash
--     over, but never onto a lead anyone has already worked in the CRM
--     (any timeline entry not written by this import, other than opening
--     the lead);
--   * contacts: found or created by normalised email; an existing contact's
--     name and phone are only filled where empty, never overwritten;
--   * the note: one timeline entry per distinct text, so an edited note in
--     the old admin adds an entry instead of rewriting history;
--   * the reminder: one task per lead, refreshed while the CRM has not
--     touched it, cancelled when the old admin clears it;
--   * the "New" badge: every lead this import brought over is opened, by
--     the old admin; one that came through the CRM's intake stays New.
-- Ids are derived from the legacy ids (version-4 shaped), so a re-run finds
-- what an earlier one wrote.
--
-- Not imported: mobility ID uploads (documents and SINs wait for storage keys
-- and the SIN-sealing key, docs/PLAN.md §5.9) and anything outside these two
-- tables.

create or replace function pg_temp.cw_legacy_uuid(seed text) returns uuid
language sql immutable as $function$
  select (
    substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' ||
    substr(h, 18, 3) || '-' || substr(h, 21, 12)
  )::uuid
  from (select md5(seed) as h) as hashed
$function$;

do $import$
declare
  -- contracts LEGACY_IMPORT_ACTOR_ID: the admin shows it as "Old admin".
  v_actor constant uuid := '00000000-0000-4000-8000-00000000a001';
  v_workspace uuid;
begin
  select id into v_workspace from app.workspaces where slug = 'canadawide';
  if v_workspace is null then
    raise exception 'the canadawide site does not exist';
  end if;
  if to_regclass('public.internet_leads') is null or to_regclass('public.mobility_leads') is null then
    raise exception 'the legacy lead tables do not exist';
  end if;

  -- Both legacy tables in one shape, with the submitted form as the CRM
  -- stores it. Optional fields that are empty are left out; the legacy NOT
  -- NULL fields are copied as they are, because the 0002 mirror trigger
  -- rebuilds a legacy row from this form on every insert and must not meet a
  -- null there (its `on conflict do nothing` comes after the NOT NULL check).
  -- The old admin keeps a mobility lead's plan label in `plan_id`, and an
  -- internet lead's label in `plan`.
  create temporary table cw_legacy_rows on commit drop as
  select
    i.id,
    'internet'::text as lead_type,
    i.full_name,
    btrim(i.email) as email,
    i.phone,
    i.status as stage,
    i.created_at,
    i.deleted_at,
    nullif(btrim(i.notes), '') as notes,
    i.notes_updated_at,
    i.reminder_at,
    nullif(btrim(i.reminder_note), '') as reminder_note,
    i.reminder_done_at,
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
    nullif(btrim(m.notes), ''),
    m.notes_updated_at,
    m.reminder_at,
    nullif(btrim(m.reminder_note), ''),
    m.reminder_done_at,
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
  from public.mobility_leads as m;

  -- Contacts, one per normalised email, named from that person's latest lead.
  insert into app.contacts as c (email, full_name, phone, country_code)
  select distinct on (lower(r.email)) lower(r.email), r.full_name, r.phone, 'CA'
  from cw_legacy_rows as r
  where position('@' in r.email) > 1
  order by lower(r.email), r.created_at desc
  on conflict (email) do update set
    full_name = coalesce(c.full_name, excluded.full_name),
    phone = coalesce(c.phone, excluded.phone),
    country_code = coalesce(c.country_code, excluded.country_code);

  insert into app.leads as l (
    id, workspace_id, lead_type, status, stage, full_name, email, phone, country_code,
    contact_id, payload, attribution, consent_version, deleted_at, created_at, updated_at
  )
  select
    r.id, v_workspace, r.lead_type, 'submitted', r.stage, r.full_name, r.email, r.phone, 'CA',
    c.id, r.form, '{}'::jsonb, 'cw-legacy-import', r.deleted_at, r.created_at,
    greatest(r.created_at, coalesce(r.notes_updated_at, r.created_at))
  from cw_legacy_rows as r
  left join app.contacts as c on c.email = lower(r.email)
  on conflict (id) do update set
    stage = excluded.stage,
    deleted_at = excluded.deleted_at,
    updated_at = greatest(l.updated_at, excluded.updated_at)
  where l.workspace_id = excluded.workspace_id
    and (l.stage, l.deleted_at) is distinct from (excluded.stage, excluded.deleted_at)
    and not exists (
      select 1 from app.lead_activities as a
      where a.workspace_id = l.workspace_id and a.lead_id = l.id and a.actor_id <> v_actor
        -- Opening a lead is not working it.
        and not (a.kind = 'system' and a.data ->> 'event' = 'opened')
    );

  insert into app.lead_activities (id, workspace_id, lead_id, actor_id, kind, body, data, created_at)
  select
    pg_temp.cw_legacy_uuid('cw-legacy-note:' || r.id || ':' || md5(r.notes)),
    v_workspace, r.id, v_actor, 'note', left(r.notes, 4000),
    jsonb_build_object('source', 'legacy_admin'),
    coalesce(r.notes_updated_at, r.created_at)
  from cw_legacy_rows as r
  join app.leads as l on l.workspace_id = v_workspace and l.id = r.id
  where r.notes is not null
  on conflict (id) do nothing;

  -- A task the CRM has changed has `updated_at` past `created_at`; this
  -- import never moves `updated_at`, so it can tell its own rows apart.
  insert into app.lead_tasks as k (
    id, workspace_id, lead_id, title, due_at, assigned_actor_id, status, completed_at,
    created_by, created_at, updated_at
  )
  select
    pg_temp.cw_legacy_uuid('cw-legacy-reminder:' || r.id),
    v_workspace, r.id, left(coalesce(r.reminder_note, 'Follow up'), 200),
    case when r.reminder_at is null then null
         else (to_char(r.reminder_at, 'YYYY-MM-DD') || 'T12:00:00Z')::timestamptz end,
    null,
    case when r.reminder_done_at is null then 'open' else 'done' end,
    r.reminder_done_at,
    v_actor, r.created_at, r.created_at
  from cw_legacy_rows as r
  join app.leads as l on l.workspace_id = v_workspace and l.id = r.id
  where r.reminder_at is not null or r.reminder_note is not null
  on conflict (id) do update set
    title = excluded.title,
    due_at = excluded.due_at,
    status = excluded.status,
    completed_at = excluded.completed_at
  where k.workspace_id = excluded.workspace_id and k.updated_at = k.created_at;

  -- Staff worked these leads in the old admin, which had no "New" badge: a
  -- lead this import brought over is opened, by the old admin. One that came
  -- through the CRM's own intake (and so reached the legacy tables through
  -- the 0002 mirror) stays New until someone opens it here.
  insert into app.lead_activities (id, workspace_id, lead_id, actor_id, kind, data, created_at)
  select
    pg_temp.cw_legacy_uuid('cw-legacy-opened:' || r.id),
    v_workspace, r.id, v_actor, 'system', jsonb_build_object('event', 'opened'), r.created_at
  from cw_legacy_rows as r
  join app.leads as l on l.workspace_id = v_workspace and l.id = r.id
  where l.consent_version = 'cw-legacy-import'
    and not exists (
      select 1 from app.lead_activities as opened
      where opened.workspace_id = v_workspace and opened.lead_id = r.id
        and opened.kind = 'system' and opened.data ->> 'event' = 'opened'
    )
  on conflict (id) do nothing;

  update app.lead_tasks as k
  set status = 'cancelled', completed_at = null
  from cw_legacy_rows as r
  where k.workspace_id = v_workspace
    and k.id = pg_temp.cw_legacy_uuid('cw-legacy-reminder:' || r.id)
    and r.reminder_at is null and r.reminder_note is null
    and k.status <> 'cancelled'
    and k.updated_at = k.created_at;
end
$import$;

-- Reconciliation: every legacy row should have its CRM lead.
select
  (select count(*) from public.internet_leads) as legacy_internet,
  (select count(*) from public.mobility_leads) as legacy_mobility,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'canadawide' and l.lead_type = 'internet') as crm_internet,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'canadawide' and l.lead_type = 'mobility') as crm_mobility,
  (select count(*) from public.internet_leads i
     where not exists (select 1 from app.leads l where l.id = i.id))
  + (select count(*) from public.mobility_leads m
     where not exists (select 1 from app.leads l where l.id = m.id)) as legacy_rows_missing,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'canadawide' and l.deleted_at is not null) as crm_trash,
  (select count(*) from app.lead_activities a join app.workspaces w on w.id = a.workspace_id
     where w.slug = 'canadawide' and a.actor_id = '00000000-0000-4000-8000-00000000a001'
       and a.kind = 'note') as imported_notes,
  (select count(*) from app.lead_tasks k join app.workspaces w on w.id = k.workspace_id
     where w.slug = 'canadawide' and k.created_by = '00000000-0000-4000-8000-00000000a001') as imported_tasks,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'canadawide' and l.deleted_at is null
       and not exists (
         select 1 from app.lead_activities a
         where a.workspace_id = l.workspace_id and a.lead_id = l.id
           and a.kind = 'system' and a.data ->> 'event' = 'opened'
       )) as crm_new;
