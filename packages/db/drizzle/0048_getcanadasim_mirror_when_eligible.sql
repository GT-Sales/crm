-- Issue #85: a rescued Get Canada Sim order reaches the old admin once it can.
--
-- 0041 (applied) copies a submitted `sim_order` of the `getcanadasim` site
-- into public.orders the moment the lead becomes submitted, and skips one
-- with no name or email (the old table requires both). Staff may rescue a
-- checkout that has neither (a stage move submits it, O9/O12) and complete the
-- contact afterwards; that correction changes no status, so 0041's trigger
-- never looked at the lead again and the order never reached the old admin.
--
-- Where the contact lives: the copy reads the lead's own `full_name` and
-- `email` columns (`app.leads`). A staff correction writes those columns (and
-- refreshes the shared `app.contacts` row, which the copy never reads), so the
-- trigger watches `app.leads` alone.
--
-- What changes (owner decision, 21 Nov 2026):
--  1. The trigger also fires on an UPDATE of `full_name` or `email`, and the
--     trigger function copies a submitted lead whose name or email was missing
--     before the update and both are present after it: the moment it becomes
--     eligible. A lead whose contact was already complete is never copied by a
--     later contact edit (it was copied when submitted, or skipped for a reason
--     a contact edit does not cure, such as a number the old table holds).
--  2. The BACKFILL below copies, once, every submitted order 0041 skipped that
--     has a name and email now and no public.orders row.
-- Both go through 0041's own `app.copy_getcanadasim_legacy_order`, unchanged:
-- insert only (`on conflict do nothing` on the id and on `order_no`), so an
-- existing legacy row and staff's edits to it are never touched, there is at
-- most one legacy order under the CRM's order number, and running the backfill
-- twice changes nothing. It never fails the CRM's write.
--
-- Live-database impact: CREATE OR REPLACE FUNCTION, then DROP and CREATE
-- TRIGGER on app.leads, which hold a SHARE ROW EXCLUSIVE lock on app.leads
-- for the moment the statements take (writes wait; reads go on). The
-- backfill reads the Get Canada Sim site's submitted orders without a legacy
-- row (a handful) and inserts into public.orders only.
create or replace function app.mirror_getcanadasim_legacy_order() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    -- #85: a submitted lead whose name and email are completed only now.
    if new.lead_type = 'sim_order' and new.status = 'submitted'
       and (nullif(btrim(old.full_name), '') is null or nullif(btrim(old.email), '') is null)
       and nullif(btrim(new.full_name), '') is not null
       and nullif(btrim(new.email), '') is not null then
      perform app.copy_getcanadasim_legacy_order(new);
    end if;
    return new;
  end if;
  -- As 0041: the moment a lead becomes submitted, its create or the save that submits it.
  if new.lead_type = 'sim_order' and new.status = 'submitted' then
    perform app.copy_getcanadasim_legacy_order(new);
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists leads_mirror_getcanadasim_legacy on app.leads;
--> statement-breakpoint
create trigger leads_mirror_getcanadasim_legacy
  after insert or update of status, full_name, email on app.leads
  for each row
  execute function app.mirror_getcanadasim_legacy_order();
--> statement-breakpoint
-- BACKFILL BEGIN
-- Every submitted order 0041 skipped that now has a name and an email, oldest
-- first. Re-runnable: a lead whose id is already in public.orders is skipped,
-- and the copy itself inserts nothing that is already there.
do $backfill$
begin
  if to_regclass('public.orders') is null then
    return;
  end if;
  perform app.copy_getcanadasim_legacy_order(l)
  from app.leads l
  join app.workspaces w on w.id = l.workspace_id
  where w.slug = 'getcanadasim'
    and l.lead_type = 'sim_order'
    and l.status = 'submitted'
    and nullif(btrim(l.full_name), '') is not null
    and nullif(btrim(l.email), '') is not null
    and not exists (select 1 from public.orders o where o.id = l.id)
  order by l.created_at, l.id;
end
$backfill$;
-- BACKFILL END
