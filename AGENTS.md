# GT Sales CRM — guide for AI agents and new sessions

Read this first, then [docs/HANDOFF.md](docs/HANDOFF.md) (what is live, what
was done, what comes next and how, with the architecture map),
[docs/PLAN.md](docs/PLAN.md) (decisions, phases) and [docs/ENV.md](docs/ENV.md)
(every variable). Keep all three current when you change what they describe.

## What this is

One backend and one admin for every GT Sales website (Get Canada Sim,
CanadaWide, more to come). Websites keep their own repositories and send leads
to the backend with a per-site key; staff work every site from this admin.
The code was copied from the Canadian Plans platform and pruned
(`docs/PLAN.md` §4); its business data, brand and catalogue were not.

| Path                                                       | Role                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/backend`                                             | Express 5 + strict TypeScript. **The only database client.** Docker image for Railway (`apps/backend/Dockerfile`).     |
| `apps/admin`                                               | Next.js staff app (Tailwind + shadcn). Talks to the backend only. Vercel, root `apps/admin`.                           |
| `packages/db`                                              | Drizzle schema (`src/schema.ts`), migrations (`drizzle/`), pooled runtime client, synthetic seed. Backend-only import. |
| `packages/contracts`                                       | Zod request/response schemas, the endpoint registry, the generated OpenAPI document and the one typed client.          |
| `packages/types`                                           | Value lists (roles, permissions, lead statuses, scopes) that schema, contracts and apps all derive from.               |
| `packages/adapters`                                        | Object store (S3 protocol), Resend email, alerts, error tracking, Umami sink.                                          |
| `jobs`                                                     | Outbox job types, handlers and runner.                                                                                 |
| `packages/ui`, `packages/config`, `packages/observability` | shadcn components; tsconfig/eslint/prettier/vitest/playwright bases; logging.                                          |

## Rules that are not negotiable

1. **Only the backend talks to Postgres**, as the `app_runtime` role
   (`NOBYPASSRLS`, owns nothing) over the Supabase transaction-mode pooler.
   The admin and the websites hold no database credential. An ESLint boundary
   rule fails the build if anything but `apps/backend` imports `@gt-sales/db`.
2. **Every tenant table carries `workspace_id`** and a row-level policy that
   reads `app.workspace_id` / `app.actor_id` set per transaction by
   `withTenantTx`. A query that forgets its tenant sees nothing. `contacts` is
   the one documented global table (merge by email); the backend exposes a
   contact only through a lead of the current site.
3. **Hand-written SQL lives in `drizzle/0001_runtime_functions.sql`** (grants,
   FORCE RLS, SECURITY DEFINER bootstrap functions, triggers). Adding a table
   means a generated migration **and** its grants + FORCE RLS in a new custom
   migration, and a seed/test touching it. `drizzle-kit generate --custom` makes
   the empty file. Never edit an applied migration.
4. **Staff authorization is per action** (`apps/backend/src/staff/authorization.ts`).
   Roles: `owner`, `leads`, `orders`, `partners`, `finance`, `content`,
   `viewer`. A privileged action needs only the role or per-member permission that
   grants it; there is no authenticator-code step (owner decision, 25 Oct 2026).
   Contact details, a lead's form, notes and tasks (and search, which would
   reveal them) are shown only to roles with `lead.manage`, `order.manage` or
   `financial.read`; every change to a lead needs `lead.manage`.
5. **Websites authenticate with a service credential** (`gtsk_…`, hashed at
   rest, scoped, revocable; its row id is the actor for its writes) and prove a
   visitor owns a draft with a draft grant (`gtdg_…`). They can create and
   resume their own leads and upload documents against them, nothing else.
6. **Side effects go through the outbox** (`app.outbox_jobs`), never straight
   from a request handler: emails, analytics, alerts. Dedupe on
   `(workspace, job_type, dedupe_key)`.
7. **No PII in logs, audit `before`/`after` may be redacted to null and never
   rewritten, email tables store a keyed `contact_hash`, never the address.**
8. **No secrets in the repo.** Keys, passwords and customer data live in
   Railway/Vercel/Supabase. Treat the repository as public.
9. **Demo-proof tests.** Integration suites run against a disposable database
   whose name ends in `_test`; the synthetic seed refuses hosted databases.
   Every integration test must be re-runnable on a persistent local database
   (clean what it asserts on).

## Commands

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format   # must pass before a commit
pnpm run test                                            # unit + integration (integration needs the env below)
pnpm run test:tooling                                    # scripts/*.test.mjs
pnpm run test:e2e                                        # admin shell browser checks (build the admin first)
pnpm --filter admin test:e2e:leads                       # lead journeys against the real backend (needs Postgres)
pnpm --filter @gt-sales/contracts build                  # regenerates docs/api/openapi.json (CI diffs it)
pnpm --filter @gt-sales/db db:generate                   # drizzle-kit generate after a schema change
```

Integration tests: `TEST_MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/crm_test
DB_TEST_ALLOW_DESTRUCTIVE=1 MIGRATION_DATABASE_SSL_MODE=disable`, plus for the
backend `DATABASE_URL=postgres://app_runtime:local_ci_runtime_password@localhost:5432/crm_test
DATABASE_SSL_MODE=disable EMAIL_CONTACT_HASH_SECRET=<≥16 chars>`. CI
(`.github/workflows/ci.yml`) runs exactly this on every PR and on `main`.

## Where things live

- Lead intake and store: `apps/backend/src/leads/` (`store.ts` does the contact
  merge and lead-type handling, `types.ts` the registry and its submit
  checks, `site-counter.ts` a site's running numbers such as the next order
  number), routes in `src/routes/website.ts`.
- Staff lead work (detail, stage, assignee, notes, tasks, board, archive):
  `src/leads/work-store.ts` for writes, `src/leads/staff-queries.ts` for reads
  (plain SQL with explicit aliases; see the comment at its top).
- Staff routes (sites, access, profile, leads, board, tasks, members, jobs,
  credentials, files): `src/routes/staff.ts`.
- Documents: `src/documents/` (signed upload intent → finalize with
  signature verification → attach; staff review and download links).
- Scheduler: `src/scheduler.ts` (`outbox`, `document_cleanup`,
  `data_retention`, `intake_check`), identities in `src/machines/registry.ts`.
- Site properties and record layouts: `apps/backend/src/properties/`
  (`store.ts` for definitions, tombstones and layouts, `catalog.ts` for the
  per-request catalogue) with routes in `src/routes/properties.ts`; staff
  private saved views in `src/views/store.ts` with routes in
  `src/routes/views.ts`.
- Plans and order details: `apps/backend/src/plans/` (`store.ts` for the
  site's plans and the freeze, `options.ts` for the catalogue's plan options)
  with staff routes in `src/routes/plans.ts`, the website's plan list in
  `src/routes/website.ts` and an order lead's details in `src/leads/order.ts`;
  contracts in `packages/contracts/src/plans.ts`.
- Stage moves, the documents check and website retries:
  `apps/backend/src/leads/stage-move.ts` (which moves a type allows and what a
  move into a stage asks first), `documents-check.ts` (the required-documents
  check) and `idempotency.ts` (a website submission's key and request
  fingerprint). The staff `PATCH` that uses the first two is in
  `src/routes/staff.ts` and the write in `src/leads/work-store.ts`; the website
  header is read in `src/routes/website.ts`.
- Customer email: `apps/backend/src/email/` (`senders.ts` resolves a site's
  sender, `settings-store.ts` holds its settings and templates, `markup.ts` and
  `layout.ts` are the template language and the one shared layout, `compose.ts`
  and `queue.ts` render a mail and queue it) with the staff routes in
  `src/routes/email-settings.ts`; contracts in
  `packages/contracts/src/customer-email.ts`.
- Customer order tracking: `apps/backend/src/tracking/` (`secrets.ts` the
  keyed hashes, the code and the signed grant, `store.ts` the challenges and
  the customer's order list, `service.ts` the code request, verify and grant
  check, `delivery.ts` the tracking code mail's outbox handler,
  `change-requests.ts` the customer's change requests, their held documents
  and staff's approve and reject) with the website routes in
  `src/routes/tracking.ts` and the two staff decision routes in
  `src/routes/staff.ts`; contracts in `packages/contracts/src/tracking.ts`;
  the lead page's card in `apps/admin/src/components/leads/change-request-card.tsx`.
- Automations: `apps/backend/src/automations/` (`store.ts` for each site's
  state and runs, `run.ts` fires the rules a stage move or a website submit
  triggers) with the staff routes in `src/routes/automations.ts`; the built-in
  rules in `packages/contracts/src/automations.ts`.
- Admin pages: `apps/admin/src/app/w/[workspace]/{leads,leads/[leadId],tasks,documents,reports/sources,automations,settings}`
  (Settings → Properties at `settings/properties`, Settings → Email at
  `settings/email`); lead screens in `src/components/leads/` (the stage-move
  dialog is `stage-move-dialog.tsx`); the CRM filter chip, menus, side panel and
  page header in `src/components/crm/` (tokens in `src/app/crm-theme.css`);
  property rendering, editing and the settings screens in
  `src/components/properties/`; Settings → Plans in `src/components/plans/`
  (`settings/plans`, with plan properties at `settings/plans/properties`);
  Settings → Email in `src/components/email/`; the Automations page in
  `src/components/automations/`; API client `apps/admin/src/lib/api.ts`.
- Source report: `apps/backend/src/reports/store.ts` (the one SQL statement,
  `sourceLabelSql` and `shapeSourceReport`) with the route in
  `src/routes/reports.ts`; contracts in `packages/contracts/src/reports.ts`;
  the admin page at `apps/admin/src/app/w/[workspace]/reports/sources` with
  its screen in `src/components/reports/` (the dashboard's periods in
  `src/lib/stats-windows.ts`).
- Intake check: `apps/backend/src/intake-check/` (`check.ts` the run and its
  steps, `store.ts` the test site's reads and deletes, `alert-rule.ts` when
  the owner hears about it), the manual run in `src/routes/intake-check.ts`;
  the scheduler's four tasks (`outbox`, `document_cleanup`, `data_retention`,
  `intake_check`) in `src/scheduler.ts`; the runbook
  `docs/RUNBOOKS/intake-check.md` and its paste file
  `docs/RUNBOOKS/manual/intake-check-site.sql`.
- Historical CanadaWide import: `packages/db/sql/canadawide-legacy-import.sql`
  (docs/RUNBOOKS/legacy-import.md).
- Hand-off pages for the remaining merge phases (5 to 8), with the rules,
  gate, shipping steps and working method they share:
  `docs/superpowers/phases/` (start with its `README.md`).

## Vocabulary

`workspace` in code = **Site** in the UI = one website. `lead_type` names the
form a lead came from (`sim_order`, `internet`, `mobility`,
`partner_application`, `contact_message`). A lead's `status` is the form's
lifecycle (`incomplete` → `submitted`); its `stage` is where staff are working
it (`new`, `contacted`, `won`…). Labels and stages per type live in one place,
`leadTypeCatalog` in `packages/contracts/src/lead-types.ts`; the backend
registry (`apps/backend/src/leads/types.ts`) adds payload schemas and intake
rules. Form property definitions live once in `leadPropertyCatalog` in
`packages/contracts/src/lead-properties.ts` (paired with each lead type's field
list in `leadTypeProperties`), and `leadFieldCatalog` in
`packages/contracts/src/lead-fields.ts` derives from it.

A **property** is one field of a lead, built-in or custom. Built-in properties
are the form fields defined in code (`leadPropertyCatalog`); a site may
relabel or hide one through a row in `app.properties`. A **custom property** is
a property staff of one site add under Settings → Properties (owner only): its
key is generated from the label as `custom_<snake>`, its kind is one of
`text`, `longText`, `number`, `money` (integer cents, CAD), `date`, `yesNo`,
`choice`, `email`, `phone` or `url`, and its values live in
`leads.custom_values`. A deleted custom property leaves a tombstone so its key
is never reused. The **catalogue** is the set of properties one site resolves
to (code built-ins plus its rows), built by `buildPropertyCatalog` in
`packages/contracts/src/properties.ts`; `codePropertyCatalog` is the same with
no rows. Every list, board, filter, sort, column and record screen reads the
catalogue, never the code list directly. A **layout** orders the sections and
property keys of the lead record for one site and lead type
(`app.property_layouts`). A **saved view** is one staff member's private copy
of the leads inbox state (layout, type, stage, assignee, archive, due today,
filters, sort, property columns and hidden columns), never the free-text search or the page; `app.saved_views` is
visible only to its owner, at most 30 per person per site.

A **plan** is something a site sells, for one order lead type (`sim_order`,
`internet` or `mobility`): a name, a price in cents (CAD), a billing period
(`one_time`, `month`, `30_days`, `90_days` or `year`), whether payment is
required, the documents it needs, custom values and a position, in
`app.plans`. A plan is never deleted; `active` off hides it. Its extra
details are **plan properties** (`?object=plan` on the property routes), each
with a _Show on website_ switch (`websiteVisible`). The **order details** of an
order lead (`leads.order_details`) are its plan link (`planId`), the **frozen
plan**, `quantity` (1–99), **payment status** (`not_needed`, `pending`,
`paid`) and **carrier commission** (`not_yet`, `invoiced`, `received`,
`clawback`). The frozen plan is a snapshot of the plan taken when the website
submits the lead and again whenever staff change the plan, so a later price or
name change never rewrites an order already taken; the website sends a plan id
and a quantity, never a price. The order details are properties too: a third
storage, `order`, beside `form` and `custom`. Payment and the carrier's
commission are order details, not stages: `sim_order` has no `paid` or
`invoiced` stage and its form has no `commissionStatus`. To **archive** a lead
is to soft-delete it (`deleted_at`); it can be restored. This replaces the word
"trash" in the admin, but `/trash` routes, `view=trash` and the `trash=1` URL
parameter are still accepted as aliases.

An **allowed move** is a stage a lead may be moved to from where it is
(`moves` in `leadTypeCatalog`, read through `allowedStageMoves`; `isStageMoveAllowed`
checks one). Every type allows any other listed stage except `sim_order`, whose
path is `incomplete` → `pending` → `verified` → `delivered` → `activated` →
`completed`, with `on_hold` and `cancelled` off to the side; a lead at a stage
its type no longer lists may move to any listed one. A **gate** is what a move
into a stage asks first (`gates`, read through `stageGates`): `dispatch` (a
courier), `activation` (an activation date) and `documents` (the required
documents approved). `sim_order` gates `delivered` with dispatch + documents
and `activated` with activation + documents; `mobility` gates `activated` with
activation + documents. `planStageMove` in `leads/stage-move.ts` decides a move.
The **dispatch details** (`courier`, `trackingNumber`, `dispatchedAt`) and the
**activation details** (`activatedAt`, `activationNumber`, `activationAccount`)
are six more built-in order properties in `leads.order_details`; a move that
needs a date and was given none uses today in `America/Toronto`. The timeline
and audit name these keys, never their values. The **documents check**
(`leads/documents-check.ts`) needs every document type in the order's frozen
plan's `requiredDocuments` to have a current file on the lead whose latest
review is `approved`; it is derived on every move, never stored, and a lead
with no frozen plan requires nothing. The **override** moves an order on
without them: action `order.override` (the roles `owner` and `orders`; no
individual permission grants it) and a required reason of 1–2000 characters
(`documentsOverrideReason`), recorded as a `documents_override` timeline entry
and a `lead.documents_overridden` audit. Moving a stage still needs
`lead.manage`, so in practice the override is for the owner or a member with the
Leads and Orders roles. An **idempotency key** is the optional
`Idempotency-Key` header a website sends when it creates or submits a lead so a
retry never makes a second one (`app.idempotency_keys`, scope
`lead_submission`): the key is stored as a SHA-256 hash with a fingerprint of the
request, a retry within 24 hours returns the first lead marked `replayed`, the
same key with another body is `idempotency_conflict`, and rows are pruned after
7 days.

An **order number** is a SIM order's `MS-<n>`, kept as the lead's
`externalRef` and returned on every website create and save
(`lead.externalRef`). An imported order keeps its old `order_no`; a new
`sim_order` created with no `externalRef` takes the next number from the
site's counter `sim_order_ref` in `app.site_counters`
(`nextSiteNumber`, advanced in the create's own transaction after the
idempotency claim and the order check, so a replay or a refused create takes
none). Unseeded, the counter starts after the site's highest imported
`MS-<n>`; on switch day it is seeded past the old checkout's last number
(`docs/RUNBOOKS/manual/gcs-switch-day.sql`) and it only ever goes up. It
never issues a number a lead already holds: a counter left behind the site's
highest `MS-<n>` jumps past it (the upsert takes the greater of the next
value and that highest plus 1); a number a concurrent import takes in the
same moment answers `409 external_ref_taken` and logs
`site_counter_collision` with ids only. A website that sends its own
`externalRef` keeps it as sent and takes no number (one already held is
`409 external_ref_taken` too). A `sim_order` draft may be partial and stays
at stage `incomplete`; its submission needs the contact's name and email, a
plan (`order.planId`) and `delivery` (`esim`, or `pickup` with a shipping
address), else `400 validation_error` with `details.field` `contact`,
`order` or `form` (the registry's `submitCheck`). Submitted (on the create
or the save that submits the draft), a SIM order still at `incomplete`
moves to `pending` in the same transaction (`submittedLeadStage`), with
`stage` in the audit and a `system` `submitted` timeline entry by the
website's credential; no stage-move automation runs (the submit rules
already fired). Other lead types stay at their first stage.

**Email settings** are a site's sender and look (`app.workspace_email_settings`,
Settings → Email): from name and address, reply-to, logo, brand colour, footer
and site address. A **template** is the current copy of one of nine emails
(`tracking_code`, `order_received`, `information_needed`, `dispatched`,
`activated`, `cancelled`, `sim_number_ready`, `change_approved`,
`change_rejected`; `app.email_templates`): a subject,
a body and a **version**, content only, so a template never says whether it is
sent. Every save is a new version in the append-only
`app.email_template_versions` (`expectedVersion` guards a concurrent save,
version 0 is the starter text that was never saved), and a sent mail records the
version it was rendered from in `email_messages.template_version`. A template is
written in a small markup (`email/markup.ts`: paragraphs, `**bold**`, links, one
`[button: Label](url)`) with **fill-ins** in braces, such as `{first name}`: the
list is `EMAIL_FILL_IN_KEYS` and each template may use only some
(`fillInsForTemplate`). A misspelt or disallowed fill-in is refused when the
template is saved. The backend renders a mail when it queues it, so the outbox
job (`lead_customer_email`) only sends it; the tracking code mail is the one
exception (below). A site that has not saved its email settings sends no
customer email at all (`no_sender`). An **always-sent email** is one of the
three that no automation rule controls (`ALWAYS_SENT_TEMPLATES`):
`tracking_code`, sent whenever the site has saved email settings, and
`change_approved` and `change_rejected`, queued in the staff decision's own
transaction; Settings → Email says so beside each.

**Customer order tracking** is how a customer of a site follows and changes
their own orders (Get Canada Sim's `/track`), through the website's key with
the `tracking` scope. A **tracking code** is the six digits a customer gets by
email for one address on one site; its **challenge** is the row that holds
the code's keyed hash (`app.tracking_challenges`: 10 minutes, 5 tries, a new
request replaces the pending one, pruned a day after it expires). The code
mail is the outbox job `tracking_code_email`, which carries the code sealed
and renders it only at send time; when the job ends its payload is scrubbed
to `{ challengeId }`. A verified code gives a **grant**: a signed token sent
back as `X-Customer-Grant`, valid 30 minutes, bound to the site and the
normalized email (`trim().toLowerCase()`), with which the website lists that
email's submitted orders on that site. `TRACKING_HASH_SECRET` keys every hash
and signs the grant; no raw email or code is stored or logged. A **change
request** is a customer's ask to change a `sim_order` at `pending`,
`verified` or `on_hold` (`app.change_requests`): name, phone, plan,
delivery, arrival date, permit type, addresses, flight booked and new
passport or visa files, never the email. A lead has at most one pending
request; a new one from the customer replaces it in place (same number,
`version + 1`), and staff approve or reject a version they saw
(`expectedVersion`, else `version_conflict`). Approval applies the fields
through `applyLeadUpdate`, the staff edit's own path. Requests are numbered
per site from the counter `change_request_no`, after the imported ones. A
**held document** is a customer's file sent with a pending request
(`files.held_for_change_request`): not on the Documents card and not current
until the request is approved, deleted if it is rejected. The timeline and
audit carry request numbers, field keys and document types, never values.

An **automation rule** is a trigger and an action, for example "when a SIM
order moves to Delivered, send the Dispatched email". Phase 4 has six built-in
rules (`BUILT_IN_AUTOMATIONS` in `packages/contracts/src/automations.ts`: a
trigger `lead_submitted` or `stage_entered`, an action `send_email`), switched
on or off per site in `app.automations` (every rule is off until someone with
`integration.manage` switches it on; a site without a row has it off). A **run** is one firing of a
rule for one lead, `queued` (with the outbox job) or `skipped` (with a reason:
`no_sender`, `no_customer_email` or `missing_fill_in`), in the append-only
`app.automation_runs` (pruned after 90 days). A rule that is off queues nothing
and records no run. The tables are built so the phase 8 automation builder adds
custom rules to them.

The **source report** (Reports → Sources) counts one lead type's leads per
**source** over 7, 30 or 90 days or all time: the source is the label
`deriveSource` gives a lead's attribution (`partner:<code>`, with
` (unmatched)` when no partner application matched the code; else
`utm:<source>` with `/<medium>` when there is one; else `referrer:<host>`;
else `direct`), computed in SQL. Per source it shows **received** (every
counted lead), **submitted** (`status = 'submitted'`) and **made it** (the
stage is one of `SOURCE_REPORT_SUCCESS_STAGES`: `activated`, `installed`,
`completed`, `won`), and a `utm` source's campaigns. It counts exactly the
leads `GET /leads/stats` counts (the site and type, not archived, not
restricted, the window); at most `SOURCE_REPORT_MAX_SOURCES` (50) sources and
`SOURCE_REPORT_MAX_CAMPAIGNS` (20) campaigns per source, the rest summed into
one "Other" row. Attribution is customer-influenced text, shown as text only.

The **intake check** proves every 15 minutes that a website could still save a
lead: the scheduler's task `intake_check` first refuses a site with any
member, role or site key (`intake_check_site_not_test`, nothing written),
deletes its own synthetic `internet` leads older than 10 minutes, pushes one fictional submitted `internet` lead ("Intake Check",
`intake-check@example.invalid`) through the website route's own checks and
`createLead`, reads it back and deletes it, as the scheduler's machine identity
(scope `synthetic:check`). It runs on the **test site**: the site with slug
`intake-check`, no members, no site keys, no email settings and no automation
rows, whose id is `INTAKE_CHECK_WORKSPACE_ID` (unset, the check is off). A
failure is a step (`leftovers`, `create`, `verify`, `delete`) and a bounded
code; the owner is alerted (`synthetic_check_failed`, detail `<step>:<code>`)
on the first failure and at most hourly while it lasts, and gets one
all-clear (`synthetic_check_recovered`, `failed_runs:<n>`) when it passes
again. A whole run gives up after 60 s (`INTAKE_CHECK_TIMEOUT_MS`, code
`timeout`). `POST /api/internal/jobs/intake-check` runs one by hand and never
alerts.

## Git

Feature branches (`claude/<topic>`), PR into `main`. CI must be green. Pushing
`main` is a release: Railway builds the backend image, Vercel builds the
admin. Migrations are applied deliberately (docs/RUNBOOKS/database.md), not by
the deploy.
