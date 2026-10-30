-- Get Canada Sim switch day (merge phase 5): the order counter's seed and the
-- reconciliation after the final import. Run in Supabase -> SQL Editor as
-- postgres, as the import itself is run, one block at a time (the editor
-- shows only the last result set of a run). Runbook:
-- docs/RUNBOOKS/legacy-import.md, "The final run (switch day)".
--
-- The day, in this order:
--   1. staff resolve the pending change requests in the old admin;
--   2. the SEED block below, then the website's CRM_ORDERS flag on (Vercel
--      production, redeploy): from then on every new order is a CRM lead
--      numbered MS-<n> from app.site_counters;
--   3. the final import, packages/db/sql/getcanadasim-legacy-import.sql,
--      exactly as before: it creates the leads of orders started on the old
--      checkout before the flip and refreshes the imported ones from
--      public.orders. It never touches a CRM order (its id is not in
--      public.orders), and it must not run again after this day;
--   4. the RECONCILE selects, one at a time.
--
-- Why the seed leaves a gap (planner ruling S1): an order started on the old
-- checkout between the seed and the flip takes the next order_no, and the
-- final import brings it in as MS-<order_no>. The seed sets the counter's
-- last issued number to the highest order_no plus 9, so the CRM's first
-- order is that plus 10 and the two never share a number (the unique index
-- on (workspace_id, lead_type, external_ref) would fail the import). It only
-- ever raises the counter (greatest), so running it twice is harmless.
--
-- Before the day (pre-flight PF2): before the first production test order
-- through the CRM, run the SEED block once with `+ 1000` in place of `+ 9`.
-- A test order then takes a number the old checkout will not reach before
-- the switch, and the switch-day seed's greatest() keeps the counter above it.
--
-- Part B adds the change request counter (change_request_no) to this block.

-- SEED BEGIN
insert into app.site_counters (workspace_id, counter, last_value)
select w.id, 'sim_order_ref', coalesce((select max(o.order_no) from public.orders o), 0) + 9
from app.workspaces w where w.slug = 'getcanadasim'
on conflict (workspace_id, counter) do update
  set last_value = greatest(app.site_counters.last_value, excluded.last_value), updated_at = now();
-- SEED END

-- After the seed, expect one row: last_value at least the highest order_no
-- plus 9. Write it down.
select c.last_value, (select max(o.order_no) from public.orders o) as highest_order_no
from app.site_counters c join app.workspaces w on w.id = c.workspace_id
where w.slug = 'getcanadasim' and c.counter = 'sim_order_ref';

-- RECONCILE BEGIN
-- 1. Every public.orders row has its lead. Expect rows_missing 0 and
--    imported_orders equal to gcs_orders.
select
  (select count(*) from public.orders) as gcs_orders,
  (select count(*) from app.leads l join app.workspaces w on w.id = l.workspace_id
     where w.slug = 'getcanadasim' and l.lead_type = 'sim_order'
       and exists (select 1 from public.orders o where o.id = l.id)) as imported_orders,
  (select count(*) from public.orders o
     where not exists (
       select 1 from app.leads l join app.workspaces w on w.id = l.workspace_id
       where w.slug = 'getcanadasim' and l.lead_type = 'sim_order' and l.id = o.id
     )) as rows_missing;

-- 2. MS- references held by more than one lead of the site. Expect no rows.
select l.external_ref, count(*) as leads
from app.leads l join app.workspaces w on w.id = l.workspace_id
where w.slug = 'getcanadasim' and l.external_ref like 'MS-%'
group by l.external_ref
having count(*) > 1
order by l.external_ref;

-- 3. CRM orders since the flip: MS- leads the old checkout never had. Expect
--    the switch-day test order and any real ones, each numbered above the
--    seed (archived test orders from before the day included).
select l.external_ref, l.status, l.stage, l.deleted_at is not null as archived, l.created_at
from app.leads l join app.workspaces w on w.id = l.workspace_id
where w.slug = 'getcanadasim' and l.lead_type = 'sim_order' and l.external_ref like 'MS-%'
  and not exists (select 1 from public.orders o where o.id = l.id)
order by l.created_at, l.external_ref;

-- 4. The counter: the last number the CRM issued (the seed, or the latest
--    CRM order's number).
select c.last_value, c.updated_at
from app.site_counters c join app.workspaces w on w.id = c.workspace_id
where w.slug = 'getcanadasim' and c.counter = 'sim_order_ref';
-- RECONCILE END
