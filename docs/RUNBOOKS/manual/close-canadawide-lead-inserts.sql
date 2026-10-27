-- Closes CanadaWide's anonymous lead inserts (HANDOFF.md §5.4): drops the two
-- anon INSERT policies on public.internet_leads and public.mobility_leads,
-- now that CanadaWide sends its leads to the CRM (no fallback to Supabase).
--
-- Paste into Supabase → SQL Editor and run, as one script. It checks first
-- and drops nothing unless every lead that reached the legacy tables since
-- the switch came through the CRM's intake (audited `lead.created` by a
-- website credential); otherwise it stops with the reason. The ID step's
-- policies (mobility_id_uploads, storage "mobility-ids") are left alone:
-- they close after CRM_ID_STEP=on.

begin;

do $check$
declare
  v_switch timestamptz;
  v_direct bigint;
begin
  -- The switch: CanadaWide's first lead through intake, smoke tests aside.
  select min(e.created_at) into v_switch
  from app.audit_events e
  join app.leads l on l.id = e.entity_id
  join app.workspaces w on w.id = l.workspace_id
  where w.slug = 'canadawide'
    and e.action = 'lead.created'
    and e.actor_label = 'website credential'
    and l.consent_version not in ('crm-smoke-test', 'cw-mobility-smoke');
  if v_switch is null then
    raise exception 'CanadaWide has sent no lead through the CRM yet; the policies stay.';
  end if;

  select count(*) into v_direct
  from (
    select i.id from public.internet_leads i
    where i.created_at > v_switch
      and not exists (
        select 1 from app.audit_events e
        where e.entity_id = i.id and e.action = 'lead.created'
          and e.actor_label = 'website credential'
      )
    union all
    select m.id from public.mobility_leads m
    where m.created_at > v_switch
      and not exists (
        select 1 from app.audit_events e
        where e.entity_id = m.id and e.action = 'lead.created'
          and e.actor_label = 'website credential'
      )
  ) as direct;
  if v_direct > 0 then
    raise exception '% lead(s) reached the legacy tables without the CRM since %; the policies stay.',
      v_direct, v_switch;
  end if;
end
$check$;

drop policy if exists "anon can submit leads" on public.internet_leads;
drop policy if exists "anon can insert mobility leads" on public.mobility_leads;

commit;

-- What is left: only the ID step's two policies.
select schemaname, tablename, policyname
from pg_policies
where (schemaname = 'public' and tablename in ('internet_leads', 'mobility_leads', 'mobility_id_uploads'))
   or (schemaname = 'storage' and policyname ilike '%mobility%')
order by 1, 2, 3;
