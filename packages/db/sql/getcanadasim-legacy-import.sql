-- Get Canada Sim's admin -> the CRM: every row of public.orders becomes a
-- `sim_order` lead of the `getcanadasim` site, and every row of
-- public.partners a `partner_application` lead, each under its own id, with
-- its contact, the order form, staff notes and the reminder.
--
-- Run as the project's `postgres` role (Supabase SQL editor, the Supabase MCP
-- `execute_sql`, or psql with MIGRATION_DATABASE_URL). It writes only to the
-- `app` schema and reads `public`, never the other way round. Runbook:
-- docs/RUNBOOKS/legacy-import.md.
--
-- Re-runnable, and meant to be re-run until staff move to the CRM (Get Canada
-- Sim's own admin stays in use until then):
--   * leads: inserted once; later runs carry the old admin's status, archive
--     and approved customer edits (name, phone, the order form) over, but
--     never onto a lead anyone has already worked in the CRM (any timeline
--     entry not written by this import);
--   * contacts: found or created by normalised email; an existing contact's
--     name, phone and country are only filled where empty, never overwritten;
--   * notes: one timeline entry per distinct text (the staff note, the
--     partner's note), so an edited note adds an entry instead of rewriting
--     history;
--   * the reminder: one task per order, refreshed while the CRM has not
--     touched it, cancelled when the old admin clears it.
-- Ids are derived from the legacy ids (version-4 shaped), so a re-run finds
-- what an earlier one wrote.
--
-- Mapping: an order's status is its stage (the same keys, sim_order's stages
-- in the contracts catalogue), and `incomplete` is also the lead's status (a
-- checkout that never finished; the CRM's 90-day rule for abandoned forms
-- applies to it). An archived order goes to the CRM's trash, from which it
-- can be restored. `MS-<order_no>` and `PT-<partner_no>` become the leads'
-- external references, so staff find them by the numbers they know.
--
-- The SIM number staff gave the order travels in the form too, as the
-- staff-only `simNumber` field (contracts `leadFields`).
--
-- Not imported yet: documents (passport, visa, SIM photo, billing contract,
-- partner licence), commission and invoice data, customer edit requests and
-- the IP address. They stay in Get Canada Sim's admin.

create or replace function pg_temp.gcs_legacy_uuid(seed text) returns uuid
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
  select id into v_workspace from app.workspaces where slug = 'getcanadasim';
  if v_workspace is null then
    raise exception 'the getcanadasim site does not exist';
  end if;
  if to_regclass('public.orders') is null or to_regclass('public.partners') is null then
    raise exception 'the Get Canada Sim tables do not exist';
  end if;

  -- Plan labels as Get Canada Sim's data.ts names them today (`planLabel`);
  -- a retired plan keeps only its slug.
  create temporary table gcs_plan_labels (slug text primary key, label text not null) on commit drop;
  insert into gcs_plan_labels values
    ('unlimited-data-120gb-rogers', 'Unlimited Data · $50, Rogers'),
    ('unlimited-data-rogers', 'Unlimited Data · $40, Rogers'),
    ('75gb-fido', '75GB · $35, Fido'),
    ('95gb-chatr', '90GB · $40, Chatr'),
    ('25gb-chatr', '50GB · $35, Chatr'),
    ('75gb-chatr', '75GB · $75, Chatr');

  -- Both tables in one shape, with the submitted form as the CRM stores it.
  -- Empty optional fields are left out. Before `shipping_address` existed the
  -- order form wrote the address into `notes` behind "Shipping address:",
  -- which Get Canada Sim's `orderShippingAddress` still reads; so does this.
  create temporary table gcs_legacy_rows on commit drop as
  select
    o.id,
    'sim_order'::text as lead_type,
    case when o.status = 'incomplete' then 'incomplete' else 'submitted' end as status,
    o.status as stage,
    nullif(btrim(o.full_name), '') as full_name,
    nullif(btrim(o.email), '') as email,
    nullif(btrim(o.phone), '') as phone,
    case when upper(btrim(o.country_code)) ~ '^[A-Z]{2}$' then upper(btrim(o.country_code)) end as country_code,
    'MS-' || o.order_no as external_ref,
    o.created_at,
    o.archived_at as deleted_at,
    nullif(btrim(o.admin_note), '') as staff_note,
    o.admin_note_at as staff_note_at,
    nullif(btrim(o.partner_note), '') as partner_note,
    o.partner_note_at,
    o.reminder_at,
    nullif(btrim(o.reminder_note), '') as reminder_note,
    o.reminder_done_at,
    case when p.id is null then '{}'::jsonb
         else jsonb_build_object('partnerCode', 'PT-' || p.partner_no, 'partnerCodeMatched', true)
    end as attribution,
    jsonb_build_object('schemaVersion', 1, 'payload', jsonb_strip_nulls(jsonb_build_object(
      'planId', nullif(btrim(o.plan), ''),
      'planLabel', pl.label,
      'delivery', o.delivery,
      'arrivalDate', to_char(o.arrival, 'YYYY-MM-DD'),
      'permitType', nullif(btrim(o.permit_type), ''),
      'gotVisa', o.got_visa,
      'flightBooked', o.flight_booked,
      'canadaAddress', nullif(btrim(o.canada_address), ''),
      'shippingAddress', coalesce(
        nullif(btrim(o.shipping_address), ''),
        case when o.notes ~* '^Shipping address:'
             then nullif(btrim(regexp_replace(o.notes, '^Shipping address:\s*', '', 'i')), '') end
      ),
      'reference', nullif(btrim(o.reference), ''),
      'customerNotes', case when o.notes ~* '^Shipping address:' then null
                            else nullif(btrim(o.notes), '') end,
      'simNumber', nullif(btrim(o.sim_number), '')
    ))) as form
  from public.orders as o
  left join public.partners as p on p.id = o.partner_id
  left join gcs_plan_labels as pl on pl.slug = o.plan
  union all
  select
    p.id,
    'partner_application'::text,
    'submitted'::text,
    p.status,
    nullif(btrim(p.contact_name), ''),
    nullif(btrim(p.email), ''),
    nullif(btrim(p.phone), ''),
    null::text,
    'PT-' || p.partner_no,
    p.created_at,
    null::timestamptz,
    null::text,
    null::timestamptz,
    null::text,
    null::timestamptz,
    null::date,
    null::text,
    null::timestamptz,
    '{}'::jsonb,
    jsonb_build_object('schemaVersion', 1, 'payload', jsonb_strip_nulls(jsonb_build_object(
      'company', nullif(btrim(p.company), ''),
      'website', nullif(btrim(p.website), ''),
      'country', nullif(btrim(p.country), ''),
      'businessType', nullif(btrim(p.business_type), ''),
      'volume', nullif(btrim(p.volume), ''),
      'message', nullif(btrim(p.message), '')
    )))
  from public.partners as p;

  -- Contacts, one per normalised email, named from that person's latest row.
  -- Contacts are shared by every site, so a CanadaWide customer who also
  -- ordered a SIM is one person here.
  insert into app.contacts as c (email, full_name, phone, country_code)
  select distinct on (lower(r.email)) lower(r.email), r.full_name, r.phone, r.country_code
  from gcs_legacy_rows as r
  where position('@' in coalesce(r.email, '')) > 1
  order by lower(r.email), r.created_at desc
  on conflict (email) do update set
    full_name = coalesce(c.full_name, excluded.full_name),
    phone = coalesce(c.phone, excluded.phone),
    country_code = coalesce(c.country_code, excluded.country_code);

  insert into app.leads as l (
    id, workspace_id, lead_type, status, stage, full_name, email, phone, country_code,
    contact_id, external_ref, payload, attribution, consent_version, deleted_at, created_at,
    updated_at
  )
  select
    r.id, v_workspace, r.lead_type, r.status, r.stage, r.full_name, r.email, r.phone,
    r.country_code, c.id, r.external_ref, r.form, r.attribution, 'gcs-legacy-import',
    r.deleted_at, r.created_at,
    greatest(
      r.created_at,
      coalesce(r.staff_note_at, r.created_at),
      coalesce(r.partner_note_at, r.created_at)
    )
  from gcs_legacy_rows as r
  left join app.contacts as c on c.email = lower(r.email)
  on conflict (id) do update set
    stage = excluded.stage,
    status = case when l.status = 'incomplete' then excluded.status else l.status end,
    full_name = excluded.full_name,
    phone = excluded.phone,
    payload = excluded.payload,
    attribution = excluded.attribution,
    deleted_at = excluded.deleted_at,
    updated_at = greatest(l.updated_at, excluded.updated_at)
  where l.workspace_id = excluded.workspace_id
    and l.customer_data_restricted_at is null
    and (l.stage, l.status, l.full_name, l.phone, l.payload, l.attribution, l.deleted_at)
        is distinct from
        (excluded.stage, excluded.status, excluded.full_name, excluded.phone, excluded.payload,
         excluded.attribution, excluded.deleted_at)
    and not exists (
      select 1 from app.lead_activities as a
      where a.workspace_id = l.workspace_id and a.lead_id = l.id and a.actor_id <> v_actor
    );

  insert into app.lead_activities (id, workspace_id, lead_id, actor_id, kind, body, data, created_at)
  select
    pg_temp.gcs_legacy_uuid('gcs-legacy-note:' || r.id || ':' || md5(r.staff_note)),
    v_workspace, r.id, v_actor, 'note', left(r.staff_note, 4000),
    jsonb_build_object('source', 'legacy_admin'),
    coalesce(r.staff_note_at, r.created_at)
  from gcs_legacy_rows as r
  join app.leads as l on l.workspace_id = v_workspace and l.id = r.id
  where r.staff_note is not null
  union all
  select
    pg_temp.gcs_legacy_uuid('gcs-legacy-partner-note:' || r.id || ':' || md5(r.partner_note)),
    v_workspace, r.id, v_actor, 'note', left('Partner note: ' || r.partner_note, 4000),
    jsonb_build_object('source', 'legacy_partner'),
    coalesce(r.partner_note_at, r.created_at)
  from gcs_legacy_rows as r
  join app.leads as l on l.workspace_id = v_workspace and l.id = r.id
  where r.partner_note is not null
  on conflict (id) do nothing;

  -- A task the CRM has changed has `updated_at` past `created_at`; this
  -- import never moves `updated_at`, so it can tell its own rows apart.
  insert into app.lead_tasks as k (
    id, workspace_id, lead_id, title, due_at, assigned_actor_id, status, completed_at,
    created_by, created_at, updated_at
  )
  select
    pg_temp.gcs_legacy_uuid('gcs-legacy-reminder:' || r.id),
    v_workspace, r.id, left(coalesce(r.reminder_note, 'Follow up'), 200),
    case when r.reminder_at is null then null
         else (to_char(r.reminder_at, 'YYYY-MM-DD') || 'T12:00:00Z')::timestamptz end,
    null,
    case when r.reminder_done_at is null then 'open' else 'done' end,
    r.reminder_done_at,
    v_actor, r.created_at, r.created_at
  from gcs_legacy_rows as r
  join app.leads as l on l.workspace_id = v_workspace and l.id = r.id
  where r.reminder_at is not null or r.reminder_note is not null
  on conflict (id) do update set
    title = excluded.title,
    due_at = excluded.due_at,
    status = excluded.status,
    completed_at = excluded.completed_at
  where k.workspace_id = excluded.workspace_id and k.updated_at = k.created_at;

  update app.lead_tasks as k
  set status = 'cancelled', completed_at = null
  from gcs_legacy_rows as r
  where k.workspace_id = v_workspace
    and k.id = pg_temp.gcs_legacy_uuid('gcs-legacy-reminder:' || r.id)
    and r.reminder_at is null and r.reminder_note is null
    and k.status <> 'cancelled'
    and k.updated_at = k.created_at;
end
$import$;

-- Reconciliation: every order and partner application should have its lead.
select
  (select count(*) from public.orders) as gcs_orders,
  (select count(*) from public.partners) as gcs_partners,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'getcanadasim' and l.lead_type = 'sim_order') as crm_orders,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'getcanadasim' and l.lead_type = 'partner_application') as crm_partners,
  (select count(*) from public.orders o
     where not exists (select 1 from app.leads l where l.id = o.id))
  + (select count(*) from public.partners p
     where not exists (select 1 from app.leads l where l.id = p.id)) as rows_missing,
  (select count(*) from public.orders o join app.leads l on l.id = o.id
     where l.stage <> o.status) as stage_mismatches,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'getcanadasim' and l.deleted_at is not null) as crm_trash,
  (select count(*) from app.lead_activities a join app.workspaces w on w.id = a.workspace_id
     where w.slug = 'getcanadasim' and a.actor_id = '00000000-0000-4000-8000-00000000a001'
       and a.kind = 'note') as imported_notes,
  (select count(*) from app.lead_tasks k join app.workspaces w on w.id = k.workspace_id
     where w.slug = 'getcanadasim' and k.created_by = '00000000-0000-4000-8000-00000000a001') as imported_tasks;
