# CanadaWide historical import

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
| `mobility_id_uploads` (licence photos, SINs)       | **not imported**: they wait for Storage S3 keys and the SIN-sealing key (PLAN.md §5.9)                                   |

## Running it

As the project's `postgres` role, in one go (the script is one transaction
plus a reconciliation query):

- Supabase dashboard → SQL editor: paste the file, run; or
- the Supabase MCP `execute_sql` with the file's contents; or
- `psql "$MIGRATION_DATABASE_URL" -f packages/db/sql/canadawide-legacy-import.sql`.

The last result row reconciles: `legacy_rows_missing` must be `0`, and
`crm_internet` / `crm_mobility` must equal `legacy_internet` /
`legacy_mobility`. `crm_new` counts the site's active leads nobody has
opened in the CRM: only leads that came through the CRM's intake.

## Re-running it

Run it again **right before staff move to the CRM**, and whenever new leads
reach the legacy tables before the CanadaWide switch (HANDOFF.md §5.1 step 1):
until then CanadaWide still writes there directly, and the old admin is still
where staff change statuses and notes. Every run is safe to repeat:

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

## History

| Date       | Run                                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-27 | First production run: 669 internet + 39 mobility leads (0 missing), 623 contacts, 279 notes, 28 tasks (12 done, 16 open), 129 in the trash; stages and trash matched the legacy rows one for one. A second run left every count and a fingerprint of all leads and tasks unchanged.                                    |
| 2026-10-27 | Run with the "New" badge (`f5d6639`): 676 internet + 40 mobility rows, 0 missing (6 leads CanadaWide wrote to the legacy tables before its 07:22 UTC switch came over); 712 imported leads each opened by the old admin; 280 notes, 28 tasks, 131 in the trash; `crm_new` 1, the first lead from the CRM's own intake. |

The rehearsal is `apps/backend/tests/canadawide-legacy-import.integration.test.ts`
(replica legacy tables in `tests/support/legacy-canadawide.ts`, shared with the
mirror suite under an advisory lock).

# Get Canada Sim historical import

`packages/db/sql/getcanadasim-legacy-import.sql` copies Get Canada Sim's
`public.orders` and `public.partners` into the CRM's `getcanadasim` site, each
row **under its own id**, the same way and with the same re-run rules as the
CanadaWide import above (it reads `public`, writes only `app`).

| Get Canada Sim                                                                            | CRM                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| an order                                                                                  | a `sim_order` lead; `MS-<order_no>` is its external reference                                                                                                                  |
| `status`                                                                                  | `stage` (sim_order's stages are Get Canada Sim's statuses, but `paid` → `pending`, `invoiced` → `completed`); `incomplete` is also the lead's status, the rest are `submitted` |
| `status`, `commission_status`                                                             | `order_details` (migration 0012's mapping): no plan link, quantity 1, the payment status and carrier commission below                                                          |
| `archived_at`                                                                             | `deleted_at` (the CRM trash, restorable): the archive holds dismissed pending, incomplete and cancelled orders                                                                 |
| name, email, phone, `country_code`                                                        | the lead's contact fields, and a contact found or created by `lower(btrim(email))`; contacts are shared by every site                                                          |
| plan, SIM type, arrival, permit, visa, flight, addresses, reference, the customer's note  | `payload` as `{ schemaVersion: 1, payload }`; the plan label as `data.ts` names it today; an address kept in `notes`                                                           |
| `partner_id`                                                                              | `attribution.partnerCode` = `PT-<partner_no>`                                                                                                                                  |
| `admin_note`, `partner_note`                                                              | `note` timeline entries by the "Old admin", dated `admin_note_at` / `partner_note_at`                                                                                          |
| `reminder_at`, `reminder_note`, `reminder_done_at`                                        | a task, as for CanadaWide                                                                                                                                                      |
| a partner application                                                                     | a `partner_application` lead (stage = its status); `PT-<partner_no>` is its external reference                                                                                 |
| `sim_number`                                                                              | the staff-only `simNumber` in `payload` (shown in the lead page's Staff details)                                                                                               |
| `viewed_at` (the old admin's "New" badge)                                                 | an `opened` system entry by the "Old admin" at that time; every partner application is opened too                                                                              |
| `passport_path`, `permit_path`, `sim_photo_path`, `billing_contract_path`, `license_path` | files on the lead's Documents card (`passport`, `visa`, `sim_photo`, `billing_contract`, `business_licence`), copied verified                                                  |
| `order_edit_requests` (`/track` change requests)                                          | timeline entries: the request by the customer (its fields and documents, never values) and the old admin's decision                                                            |
| partner commission, invoices, IP address                                                  | **not imported yet**: they stay in Get Canada Sim's admin until the CRM models them                                                                                            |

Since phase 3 an order's payment and the carrier's commission are the
order's, not stages: an order's `order_details.paymentStatus` is `paid` for
the statuses paid, verified, delivered, activated, completed and invoiced,
`not_needed` for cancelled and on_hold, otherwise `pending`; its
`carrierCommission` is `invoiced` for an invoiced order, else from
`commission_status` (`invoiced`, `commission_received` → `received`,
`claw_back` → `clawback`), else `not_yet`. The form no longer carries
`commissionStatus`. Migration 0012 gave the orders already imported the same
order details and stages, but it leaves the old `commissionStatus` key in
their form. So the first import run after 0012 removes that key from every
order that had one (and only from orders nobody has worked in the CRM, as
below). Order details and stages already match, unless the old admin changed
the order since. **Apply 0011 and 0012 first** (the script writes
`order_details`).

**The import writes stages directly.** Since phase 4 staff move a stage only
along the type's allowed moves, with the dispatch and activation details and the
documents check (`apps/backend/src/leads/stage-move.ts`), and a move fires the
site's automation rules. Both imports (this one and CanadaWide's above)
bypass all of that: they copy the old admin's status into `stage` as it is,
however far it is from the lead's previous stage, never check or write the
dispatch and activation details, and never fire an automation rule, so a re-run
queues no customer email even when a rule is on. An order the import carries to
Delivered or Activated therefore has no courier, tracking or activation details
unless staff add them on the lead page. A re-run still skips a lead someone has
worked in the CRM, as above.

**No import from `main`'s old script between 0012 and the phase 3 deploy.**
The script on `main` before phase 3 writes the old admin's `orders.status`
straight into `stage`: run after 0012, it would put the 20 orders 0012 moved
back on `paid`, and 0012 cannot repair them (its data step only touches leads
whose `order_details` is still `'{}'`, and it never runs twice). In the same
window staff should not move SIM orders in the old admin. After the deploy,
re-run verification select 7 of
[`manual/0011-0012-plans.sql`](manual/0011-0012-plans.sql): `old_stages_left`
must be `0`. If not, run this branch's import (it maps the statuses), or remap
the stragglers by hand; for a `paid` row:

```sql
UPDATE app.leads SET stage = 'pending', order_details = order_details || '{"paymentStatus":"paid"}'::jsonb, updated_at = now() WHERE lead_type = 'sim_order' AND stage = 'paid';
```

(an `invoiced` row becomes `completed`, with `paymentStatus` `paid` and
`carrierCommission` `invoiced`).

A later run also carries approved customer edits (name, phone, the order
form) and the old admin's status (stage and order details) over, unless
someone worked the lead in the CRM. An unfinished
checkout falls under the CRM's 90-day rule for abandoned forms (SEC-12): its
contact details are erased from the CRM's copy 90 days after its last change.
The reconciliation row must show `rows_missing` and `stage_mismatches` at `0`
(`stage_mismatches` compares with the mapping applied: a `paid` order on a
`pending` lead matches). The rehearsal is `apps/backend/tests/getcanadasim-legacy-import.integration.test.ts`.
The import runs one last time on switch day, when the checkout moves to the
CRM; see [The final run (switch day)](#the-final-run-switch-day) below.

**Documents** are not copied by the script itself: it queues one
`legacy_document_import` outbox job per file Get Canada Sim keeps in the
`documents` bucket (only where Supabase's `storage.objects` lists it, and only
for a lead that is not restricted), and the backend's outbox copies each one
within minutes:

- The copy lands in the CRM's own part of the bucket
  (`workspaces/<site>/candidate/<site>/legacy-<file id>`) and is verified like
  any upload: at most 10 MB, a PDF, JPEG or PNG by its bytes, its SHA-256
  recorded. Get Canada Sim's original is only read, never moved or deleted.
- The file shows as from the "Old admin", dated when the customer gave it.
  It takes the job's message id, so a rerun of a job imports nothing twice.
- The job's key carries the object's storage version: a file replaced in the
  old admin (Get Canada Sim overwrites under the same name) arrives as a
  newer revision, which becomes the current one; an unchanged file is never
  queued twice.
- A lead that is gone or restricted, or a file no longer in storage, completes
  as `skipped:…`; bytes that are not a document fail the job
  (`document_unsupported_signature`, `document_too_large`) so the owner alert
  shows it.
- **Deploy the backend first.** A backend without the handler fails such jobs
  as `handler_not_registered`.

The reconciliation row adds `documents_queued` (still to run),
`documents_failed` and `crm_documents` (current files from the old admin);
after the outbox has run, `documents_queued` and `documents_failed` should be
`0` and `crm_documents` the number of files Get Canada Sim names that exist.

**Change requests** (`order_edit_requests`) become two timeline entries each,
written once and never rewritten: the request, dated when the customer sent
it, and the old admin's decision, dated when it was made. A request still
pending gets its decision entry on the first run after it is decided; until
then the lead page shows it as waiting in the old admin. `change_requests` in
the reconciliation row counts the requests on the CRM's timelines. **Deploy
the backend and the admin first**, and once the entries are in, never roll
the admin back to a build older than `9630b76`: the admin reads every
response against its own contract, so an older build fails to open a lead
page that has them.

| Date       | Run                                                                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-27 | First production run: 138 orders + 5 partner applications (0 missing, 0 stage mismatches), 44 archived orders in the trash, 14 staff notes, 21 reminders as tasks.                                                                                                                                                    |
| 2026-10-27 | Run with the "New" badge (`f5d6639`): the same counts; all 138 orders had been opened in the old admin, so 143 `opened` entries and `crm_new` 0.                                                                                                                                                                      |
| 2026-10-27 | Run with documents (`081d478`): the same counts; 121 copies queued (50 passports, 51 approval letters, 9 billing contracts, 7 SIM photos, 4 licences), all completed in 9 minutes, about 2.5 s each; 121 current files on 60 leads, each matching its original's size and type, 121 `file.imported` audits, 0 failed. |
| 2026-10-27 | Run with change requests (`9630b76`): the same counts, documents unchanged (121, none queued or failed); all 69 requests on 57 orders came over as 137 entries: 69 requests, 64 approvals, 4 rejections, and 1 request still waiting in the old admin.                                                                |

## The final run (switch day)

On switch day (merge phase 5, Task A11) Get Canada Sim's checkout moves to
the CRM and the import runs one last time. The seed and the checks are in
[`manual/gcs-switch-day.sql`](manual/gcs-switch-day.sql). Run it as the
import is run: Supabase SQL editor, as `postgres`, one block at a time.

1. Staff resolve the pending change requests in the old admin.
2. Run the `SEED` block, then turn the website's `CRM_ORDERS` flag on
   (Vercel production, redeploy). The seed sets `app.site_counters`
   (`sim_order_ref`) to the highest `public.orders.order_no` plus 9. From the
   flip on, every new order is a CRM lead numbered `MS-<n>` from that counter,
   so the CRM's first order is at least the highest `order_no` plus 10. An
   order started on the old checkout between the seed and the flip takes one
   of the nine numbers in between, and the final import brings it in under
   its own `MS-<order_no>`. The same block seeds the change request counter
   (`change_request_no`) to the highest `public.order_edit_requests.request_no`
   plus 9 (pre-flight PF3), so a request made in the old admin before the
   flip and imported afterwards keeps its own number and never shares one
   with a request made through the CRM's tracking. The seed only ever raises
   either counter (`greatest`), so running it twice is harmless. Its two
   check selects show each `last_value` beside the old system's highest
   number.
3. Run the import (`packages/db/sql/getcanadasim-legacy-import.sql`) exactly
   as before. It creates the leads of orders the old checkout took before the
   flip and refreshes the imported ones from `public.orders`
   (`on conflict (id) do update`, with the rules above). That is safe on this
   day because staff worked those orders in the old admin until now. It never
   touches a CRM order, since a CRM order's id is not in `public.orders`.
   **Do not run it again after switch day**: after the flip nothing flows
   from `public.orders` to the CRM, and staff work orders only in the CRM.
4. Run the `RECONCILE` selects one at a time:
   1. `rows_missing` must be `0`, and `imported_orders` must equal
      `gcs_orders`.
   2. No `MS-` reference may be held by more than one lead of the site.
   3. The CRM's own orders (`MS-` leads whose id is not in
      `public.orders`) must each be numbered above the seed.
   4. Write down the counter's `last_value` (and the change request
      counter's, from the seed's second check select).

So the order is: the seed, the flip, the import, then reconcile.

**A production test order before the day** (pre-flight PF2): before the
first one, run the `SEED` block once with `+ 1000` in place of both `+ 9`
(the second is the change request counter's: a test change request made
through the CRM before the day then takes a number the old admin will not
reach). A test
order placed before switch day takes `MS-<highest order_no + 1001>` and keeps
that number even after staff archive it (the unique index ignores
`deleted_at`). The old checkout keeps numbering from the highest `order_no`
until the flip, so with no gap it would reach the test order's number and
the final import would fail on `leads_workspace_type_external_ref_unique`.
The switch-day seed's `greatest` never lowers the counter below the test
order.

### Rollback

Undo the switch day one flag at a time, the newer first.

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

The rehearsal is the "switch day" suite in
`apps/backend/tests/getcanadasim-legacy-import.integration.test.ts`. It runs
the `SEED` and `RECONCILE` blocks verbatim. Orders 141 to 143 are imported,
the seed gives `last_value` 152, and the CRM's first order is `MS-153`. Order
144, taken by the old checkout in the window, then imports as `MS-144` with
no unique violation, and the import leaves `MS-153` untouched (its stage,
form and timeline). A second seed after the counter reached 160 leaves 160.
Reconciliation shows 0 missing, no duplicated reference and one CRM order. A
second case runs the `+ 1000` seed: the test order is `MS-1144` (then
archived), the old checkout's 144 and 1143 import cleanly, the switch-day
seed gives 1152 and the next order is `MS-1153`. The change request
counter is rehearsed the same way: the seed gives the highest `request_no`
plus 9 (plus 1000 before a test request), a second seed never lowers it, and
the CRM's next request number is the highest plus 10.
