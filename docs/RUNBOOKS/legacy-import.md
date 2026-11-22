# Legacy imports and mirrors

Both sites' histories from before the CRM were imported on 2026-10-27 by
re-runnable scripts in `packages/db/sql/`. CanadaWide's import runs once
more at its staff cutover. **Get Canada Sim's import must never run again.**

## CanadaWide historical import

`packages/db/sql/canadawide-legacy-import.sql` copies CanadaWide's old admin
data, `public.internet_leads` and `public.mobility_leads`, into the CRM's
`canadawide` site. Each legacy row becomes an `app.leads` row **under its own
id** (the id the old admin, the 0002 mirror and `mobility_id_uploads` already
use), with:

| Legacy                                             | CRM                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `status`                                           | `stage` (the same keys; `status` is `submitted`)                                                                         |
| name, email, phone                                 | the lead's contact fields, and a contact found or created by `lower(btrim(email))`                                       |
| plan, address, date of birth, provider, consent…   | `payload` as `{ schemaVersion: 1, payload }`, the shape CanadaWide's intake sends                                        |
| `deleted_at`                                       | `deleted_at` (the CRM trash)                                                                                             |
| `notes` (+ `notes_updated_at`)                     | a `note` timeline entry, actor `LEGACY_IMPORT_ACTOR_ID` (shown as "Old admin"), dated `notes_updated_at`                 |
| `reminder_at`, `reminder_note`, `reminder_done_at` | a task: title from the note (or "Follow up"), due at noon UTC that day, `done` with `reminder_done_at` as its completion |
| `consent_version`                                  | `cw-legacy-import` (the old tables never recorded one)                                                                   |
| (no "New" badge in the old admin)                  | an `opened` system entry by the "Old admin", dated the lead's creation, so imported leads carry no "New" badge           |
| `mobility_id_uploads` (licence photos, SINs)       | **not imported** (PLAN.md §5.9)                                                                                          |

### Running it

As the project's `postgres` role, in one go (the script is one transaction
plus a reconciliation query):

- Supabase dashboard → SQL editor: paste the file, run; or
- the Supabase MCP `execute_sql` with the file's contents; or
- `psql "$MIGRATION_DATABASE_URL" -f packages/db/sql/canadawide-legacy-import.sql`.

The last result row reconciles: `legacy_rows_missing` must be `0`, and
`crm_internet` / `crm_mobility` must equal `legacy_internet` /
`legacy_mobility`. `crm_new` counts the site's active leads nobody has
opened in the CRM: only leads that came through the CRM's intake.

### Re-running it

Run it again **right before staff move to the CRM**, and whenever new leads
reach the legacy tables before the staff cutover (HANDOFF.md §3): until
then the old admin is still where staff change statuses and notes. Every run is safe to repeat:

- a lead is inserted once; later runs carry the old admin's stage and trash
  over, **except onto a lead someone already worked in the CRM** (any timeline
  entry by a real person other than opening it), where the CRM wins;
- an existing contact's name and phone are only filled where empty;
- an edited note becomes a second timeline entry; the first is never
  rewritten;
- a reminder's task is refreshed while the CRM has not touched it (its
  `updated_at` still equals `created_at`), and cancelled when the old admin
  clears the reminder;
- every lead the import brought over gets one `opened` entry; a lead from
  the CRM's intake (mirrored into the legacy tables by 0002) gets none and
  stays New until someone who works leads opens it.

The ids of notes and tasks are derived from the legacy ids (`md5`, shaped as a
version-4 UUID so the contracts accept them), which is how a re-run finds what
an earlier one wrote.

The rehearsal is `apps/backend/tests/canadawide-legacy-import.integration.test.ts`
(replica legacy tables in `tests/support/legacy-canadawide.ts`, shared with the
mirror suite under an advisory lock).

## Get Canada Sim historical import (finished)

`packages/db/sql/getcanadasim-legacy-import.sql` copied `public.orders` and
`public.partners` into the `getcanadasim` site, each row under its own id: an
order became a `sim_order` lead with `MS-<order_no>` as its reference (the
old statuses `paid` and `invoiced` became the order details' payment status
and carrier commission), a partner application a `partner_application` lead
(`PT-<partner_no>`), notes became timeline entries by the "Old admin",
reminders tasks, the files named on an order verified copies on its Documents
card, and `/track` change requests timeline entries. Partner commission,
invoices and IP addresses were not imported.

**Do not run it again.** It ran for the last time on the switch day, around
2026-11-12, when the checkout moved to the CRM. Since the mirror (below) the
CRM's own orders are in `public.orders` too, and a run would copy the old
admin's notes, reminders and "opened" marks onto them. The nightly sync job
`gcs-legacy-sync` that kept the CRM's copy fresh before the switch no longer
exists.

Both imports write stages directly: they bypass the allowed moves, the gates
and the flows, so an imported order at Delivered or Activated has no courier,
tracking or activation details unless staff add them.

### The final run (switch day)

Done around 2026-11-12: staff resolved the old admin's pending change
requests, the `SEED` block of
[`manual/gcs-switch-day.sql`](manual/gcs-switch-day.sql) raised the site's
counters (`sim_order_ref` and `change_request_no`) past the old system's
highest numbers, `CRM_ORDERS` went on, the import ran once more and the
`RECONCILE` selects were checked. The paste file is kept because the "switch
day" suite in `apps/backend/tests/getcanadasim-legacy-import.integration.test.ts`
runs its blocks verbatim. The day's two seed values and whether
`CRM_TRACKING` is on were not written down (HANDOFF.md §3).

### Rollback

Undo the switch one flag at a time, the newer first.

1. **Prefer turning only `CRM_TRACKING` off** (Vercel production,
   redeploy). That is safe: `/track` falls back to the read-only view of
   `public.orders`, so orders made in the CRM vanish from `/track` until the
   flag is back on, and staff can still decide the pending CRM change
   requests on the lead page.
2. **Turning `CRM_ORDERS` off once CRM orders exist double-issues order
   numbers** unless the old checkout's numbering is moved first: it numbers
   from `public.orders`' own sequence (its highest `order_no` plus 1), which
   reaches the CRM's `MS-<n>` within days, and two customers would hold one
   number. So, before the flag goes off, in the SQL editor as `postgres`
   (the counter is in the same database):

   ```sql
   select setval(pg_get_serial_sequence('public.orders','order_no'),
     (select last_value from app.site_counters c join app.workspaces w on w.id = c.workspace_id
      where w.slug = 'getcanadasim' and c.counter = 'sim_order_ref') + 1000);
   ```

   Then turn `CRM_ORDERS` off. The orders made in the CRM stay in the CRM and
   are worked there; the import must not run again (it would not bring them
   back, and would fail on the unique index), and the old admin's Orders
   board takes the new old-checkout orders, so staff work two systems until
   the flag is back on.

## After the switch: the mirror

Migration 0041 copies each Get Canada Sim order into `public.orders` the
moment it is submitted, so the old Get Canada Sim admin keeps receiving
orders until the owner retires it. The CRM stays the system the website
writes to. Operating notes, verify selects and how to retire it:
[database.md](database.md#the-legacy-mirrors-0002-0005-0006-0041-temporary).

**When.** The copy runs on the statement that makes the lead `submitted`
(the insert of a submitted lead, the website's submitting `PATCH`, or a staff
move that rescues a checkout), in the same transaction, with the order as it
then stands. Drafts are never copied: the old table requires a name, email
and phone. Once copied, the row is never written by the CRM again.

**A rescued order completed later.** Staff can rescue a checkout that has no
name or email yet; 0041 skips it. Migration 0048 (**not applied yet**,
[database.md](database.md#0048-not-applied-yet)) makes the trigger also watch
the lead's `full_name` and `email`, so such an order is copied the moment
both are present for the first time.

**The mapping**, the import's turned around (`form` is the lead's
`payload.payload`, `order` its `order_details`):

| `public.orders`                                                                                | From the lead                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                                                           | the lead's id                                                                                                                                                            |
| `order_no`                                                                                     | the number of `external_ref` `MS-<n>` (a lead without one is not copied)                                                                                                 |
| `full_name`, `email`                                                                           | the lead's, trimmed (a lead without either is not copied)                                                                                                                |
| `phone`                                                                                        | the lead's, trimmed, else `''` (the CRM's checkout does not require one; the column is NOT NULL)                                                                         |
| `country_code`                                                                                 | the lead's                                                                                                                                                               |
| `plan`                                                                                         | `form.planId` (the website's slug), else the frozen plan's "Website slug" (`order.plan.properties.custom_website_slug`)                                                  |
| `delivery`                                                                                     | `form.delivery`, else `esim` (the column's default; only a rescued checkout can lack it)                                                                                 |
| `arrival`, `permit_type`, `got_visa`, `flight_booked`, `canada_address`, `shipping_address`    | `form.arrivalDate`, `permitType`, `gotVisa`, `flightBooked`, `canadaAddress`, `shippingAddress` (the address in its own column, never in `notes`)                        |
| `reference`, `notes`, `sim_number`                                                             | `form.reference`, `customerNotes`, `simNumber` (the last two only staff or the import set)                                                                               |
| `status`                                                                                       | the stage: the same keys (`pending` for a new order); `paid` and `invoiced` are never written, since the payment status and carrier commission are order details         |
| `commission_status`                                                                            | `order.carrierCommission`: `invoiced` → `invoiced`, `received` → `commission_received`, `clawback` → `claw_back`, else null                                              |
| `created_at`, `archived_at`                                                                    | the lead's `created_at` and `deleted_at`                                                                                                                                 |
| `partner_id`                                                                                   | the `public.partners` row whose `partner_no` is `<n>` when the lead's `attribution.partnerCode` is `PT-<n>` (the import's form), else null                               |
| `passport_path`, `permit_path`, `sim_photo_path`, `billing_contract_path`                      | null: documents stay in the CRM (below)                                                                                                                                  |
| `admin_note`, `partner_note`, reminders, `viewed_at`, `ip_address`, `order_edit_requests` rows | null or nothing: notes and tasks are the CRM's timeline, the CRM keeps no IP address, a CRM order's change requests are the CRM's; the old admin's "New" badge starts on |

**Documents** are not copied and the path columns stay empty: the old admin
replaces a file in place under the same name, so pointing it at the CRM's
verified objects would let it overwrite them. Staff open an order's
documents on the CRM's lead page.

**Not synced after the order is created**, in either direction, as for
CanadaWide's mirror. Staff should work each order in one place (the CRM). An
erasure done in the CRM must be repeated by hand in the old admin.

**Skips.** A row with the same id or the same `order_no` is left as it is
and the CRM's write goes on; a legacy-side error is caught the same way.
Each skip logs `getcanadasim legacy mirror: lead <id> not copied (<reason or
SQLSTATE>)` at LOG level (Supabase → Logs → Postgres), with no customer data.

The rehearsal is `apps/backend/tests/getcanadasim-legacy-mirror.integration.test.ts`.
