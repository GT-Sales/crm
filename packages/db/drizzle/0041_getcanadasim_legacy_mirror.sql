-- Transitional bridge after the Get Canada Sim switch (docs/HANDOFF.md §2.4,
-- docs/RUNBOOKS/legacy-import.md "After the switch: the mirror").
--
-- Since about 2026-11-12 Get Canada Sim's checkout writes every order to the
-- CRM (`CRM_ORDERS`), so the old Get Canada Sim admin, which reads
-- public.orders in the same database, stopped seeing new orders. Until the
-- owner retires it, both receive every order: each submitted `sim_order` lead
-- of the `getcanadasim` site is copied into public.orders under the same id,
-- with `order_no` the number of its `MS-<n>` reference, in the same
-- transaction. The mapping is the mirror image of
-- packages/db/sql/getcanadasim-legacy-import.sql.
--
-- When: the moment the lead is submitted. The website's checkout creates a
-- draft (`incomplete`, possibly with no name or email yet), saves it, uploads
-- the documents against it and submits it with a later `PATCH`; a one-shot
-- create submits at once; staff rescue a draft by moving its stage. So the
-- copy runs after an INSERT of a submitted lead and after an UPDATE that
-- changes a lead's status into `submitted`, and never for a draft. A draft is
-- the CRM's alone: it may lack the name, email and phone the old table
-- requires, and the CRM erases an abandoned one after 90 days.
--
-- Insert only: once the row exists the mirror never writes it again, so
-- whatever the old admin changes on it stays, and nothing the CRM changes
-- later reaches it. It is idempotent: a row with the same id, or with the
-- same order_no, is left as it is (`on conflict do nothing`). It never fails
-- the CRM's write: any error on the legacy side skips the copy and logs the
-- lead id and the SQLSTATE at LOG level (server log only), nothing personal.
-- A database without public.orders (CI, the Canadian Plans database) makes
-- it a no-op, as does any other site or lead type.
--
-- Not copied: documents (the old admin's paths would point at the CRM's
-- verified objects, which it could then overwrite), notes, reminders, the IP
-- address and the old admin's `viewed_at`. `partner_id` only when the lead's
-- `partnerCode` is `PT-<partner_no>` of a public.partners row.
--
-- The same migration copies the submitted orders the CRM took since the
-- switch (BACKFILL below), through the same function.
--
-- Remove the trigger and both functions, in a new migration, when the owner
-- retires the old Get Canada Sim admin.

create function app.copy_getcanadasim_legacy_order(p_lead app.leads) returns boolean
  language plpgsql
  set search_path = ''
as $$
declare
  v_form jsonb := coalesce(p_lead.payload -> 'payload', '{}'::jsonb);
  v_order jsonb := coalesce(p_lead.order_details, '{}'::jsonb);
  v_order_no bigint;
  v_partner uuid;
  v_copied integer := 0;
begin
  if p_lead.lead_type is distinct from 'sim_order'
     or p_lead.status is distinct from 'submitted'
     or p_lead.customer_data_restricted_at is not null then
    return false;
  end if;
  if to_regclass('public.orders') is null then
    return false;
  end if;
  if not exists (
    select 1 from app.workspaces w where w.id = p_lead.workspace_id and w.slug = 'getcanadasim'
  ) then
    return false;
  end if;

  begin
    v_order_no := substring(p_lead.external_ref from '^MS-([1-9][0-9]{0,17})$')::bigint;
    if v_order_no is null then
      -- A reference the website chose itself: the old table has no number for it.
      raise log 'getcanadasim legacy mirror: lead % not copied (no MS- number)', p_lead.id;
      return false;
    end if;
    if nullif(btrim(p_lead.full_name), '') is null or nullif(btrim(p_lead.email), '') is null then
      -- A rescued checkout with no name or email: the old table requires both.
      raise log 'getcanadasim legacy mirror: lead % not copied (no name or email)', p_lead.id;
      return false;
    end if;

    -- The import's partnerCode is `PT-<partner_no>`; anything else names no partner.
    if to_regclass('public.partners') is not null then
      select p.id into v_partner
      from public.partners p
      where p.partner_no = substring(p_lead.attribution ->> 'partnerCode' from '^PT-([1-9][0-9]{0,17})$')::bigint;
    end if;

    insert into public.orders (
      id, order_no, full_name, email, phone, plan, delivery, arrival, permit_type, reference,
      notes, status, created_at, partner_id, canada_address, flight_booked, shipping_address,
      got_visa, archived_at, country_code, sim_number, commission_status
    ) values (
      p_lead.id,
      v_order_no,
      btrim(p_lead.full_name),
      btrim(p_lead.email),
      -- The CRM's checkout does not require a phone; the old table does.
      coalesce(btrim(p_lead.phone), ''),
      -- The website's plan slug as submitted, else the frozen plan's "Website slug".
      coalesce(
        nullif(btrim(v_form ->> 'planId'), ''),
        nullif(btrim(v_order -> 'plan' -> 'properties' ->> 'custom_website_slug'), '')
      ),
      -- A submission always has one; a rescued checkout may not (the column's default).
      coalesce(v_form ->> 'delivery', 'esim'),
      (v_form ->> 'arrivalDate')::date,
      v_form ->> 'permitType',
      v_form ->> 'reference',
      v_form ->> 'customerNotes',
      -- The stage is the old status (the same keys). `paid` and `invoiced` are
      -- no stages: the payment status and the carrier commission are order
      -- details, the latter carried in commission_status below.
      case
        when p_lead.stage in (
          'incomplete', 'pending', 'verified', 'on_hold', 'delivered', 'activated', 'completed',
          'cancelled'
        ) then p_lead.stage
        else 'pending'
      end,
      p_lead.created_at,
      v_partner,
      v_form ->> 'canadaAddress',
      (v_form ->> 'flightBooked')::boolean,
      v_form ->> 'shippingAddress',
      (v_form ->> 'gotVisa')::boolean,
      p_lead.deleted_at,
      p_lead.country_code,
      v_form ->> 'simNumber',
      case v_order ->> 'carrierCommission'
        when 'invoiced' then 'invoiced'
        when 'received' then 'commission_received'
        when 'clawback' then 'claw_back'
      end
    )
    on conflict do nothing;
    get diagnostics v_copied = row_count;

    if v_copied = 0 and not exists (select 1 from public.orders o where o.id = p_lead.id) then
      raise log 'getcanadasim legacy mirror: lead % not copied (order number held by another order)', p_lead.id;
    end if;
  exception when others then
    -- Never fail the CRM's write. SQLSTATE only: a message's detail can carry values.
    raise log 'getcanadasim legacy mirror: lead % not copied (SQLSTATE %)', p_lead.id, sqlstate;
    return false;
  end;
  return v_copied > 0;
end;
$$;
--> statement-breakpoint
-- Only its owner (the trigger below, and this migration's backfill) runs it.
revoke all on function app.copy_getcanadasim_legacy_order(app.leads) from public;
--> statement-breakpoint
create function app.mirror_getcanadasim_legacy_order() returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  -- Only the moment a lead becomes submitted: its create, or the save that submits it.
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  if new.lead_type = 'sim_order' and new.status = 'submitted' then
    perform app.copy_getcanadasim_legacy_order(new);
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger leads_mirror_getcanadasim_legacy
  after insert or update of status on app.leads
  for each row
  execute function app.mirror_getcanadasim_legacy_order();
--> statement-breakpoint
-- BACKFILL BEGIN
-- The submitted orders the CRM took since the switch, oldest first. Re-runnable:
-- a lead whose id is already in public.orders is skipped.
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
    and not exists (select 1 from public.orders o where o.id = l.id)
  order by l.created_at, l.id;
end
$backfill$;
-- BACKFILL END
