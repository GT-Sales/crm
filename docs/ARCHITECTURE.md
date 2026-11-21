# GT Sales CRM — how it works

The system as it runs today: the parts, the request path, the data model,
who may do what, how a website integrates, and the domain rules. The rules
that must never be broken, the commands and the file map are in
[AGENTS.md](../AGENTS.md); where it runs and what is pending is in
[HANDOFF.md](HANDOFF.md). Exact request and response shapes are the Zod
contracts in `packages/contracts/src/`, rendered in `docs/api/openapi.json`.

## 1. System

```
   Get Canada Sim (Next.js, Vercel)     CanadaWide (site)       …more sites
          │  POST /api/v1/website/*  (Authorization: Bearer gtsk_…, per-site key, scopes)
          ▼
 ┌──────────────────────────── backend: apps/backend (Express 5, Railway, Singapore) ────────────────────────────┐
 │ requestId → requestLog → CORS(ADMIN_ORIGIN) → JSON 64 kB                                                     │
 │  /api/v1/health            liveness, no auth                                                                 │
 │  /api/v1/ready             readiness (select 1 as app_runtime), no auth; Railway's deploy health check       │
 │  /api/internal/jobs/*      machine identity (MACHINE_REGISTRY_JSON + CRON_SECRET), manual job runs           │
 │  /api/v1/staff/*           Supabase bearer → verified by Auth API → per-IP rate limit → per-action authorize │
 │  /api/v1/website/*         service credential (hash lookup) → scope → per-endpoint rate limit → bot check    │
 │  /api/v1/email/*           unsubscribe links, delivery view;  /api/v1/webhooks/{resend,inbound-mail} signed  │
 │  scheduler (in-process):   outbox 60 s · document_cleanup 1 h · data_retention 1 d · automations 5 min ·     │
 │                            intake_check 15 min                                                               │
 │  every data access: withTenantTx → set_config(app.workspace_id, app.actor_id) → RLS decides                  │
 └───────────────┬───────────────────────────────────────────────┬───────────────────────────────┬──────────────┘
                 │ postgres (pooler, app_runtime)                │ Auth API (getUser)            │ S3 API
                 ▼                                               ▼                               ▼
      Supabase Postgres, schema `app`                     Supabase Auth                  Supabase Storage
      50 tables, FORCE RLS, SECURITY DEFINER functions   email+password sessions         bucket `documents`
                 ▲
                 │ NEXT_PUBLIC_SUPABASE_* (browser signs in directly with Supabase Auth, nothing else)
 ┌───────────────┴────────── admin: apps/admin (Next.js 16, Vercel iad1) ───────────────┐
 │ /login (+ invitation sign-up) · /recovery · /denied · /w/[site]/{dashboard, leads,     │
 │ leads/[id], tasks, mail, chat, analytics, automations, settings/*};                    │
 │ every call = fetch(API, bearer)                                                        │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

Two facts shape everything. The admin never touches the database (an ESLint
boundary rule fails the build if `apps/admin` imports `@gt-sales/db`). The
backend never trusts a caller's claim about who they are or which site they
belong to: identity comes from Supabase Auth or a credential hash, tenancy
from the database row that identity resolves to, enforced again by RLS.

## 2. Backend surfaces

### Staff routes (`/api/v1/staff`, Supabase bearer token)

Every route names the action `decideAccess` checks against the caller's roles
and permission overrides (§4). The full list is the endpoint registry
(`packages/contracts/src/endpoints.ts`). Routes below are under
`/workspaces/:id` unless they start with `/workspaces` or `/profile`; each
line gives the routes and the action needed.

- **Sites, profile** (`GET /workspaces`, `/access`, `PATCH /profile`,
  `/members`; `workspace.read`). `GET /workspaces` first accepts pending
  invitations for the verified email. Members are listed by name, never email.
- **Leads inbox and board** (`GET /leads`, `/leads/board`, `/leads/summary`,
  `/leads/stats`; `POST /leads/search`, `/leads/board/search`;
  `workspace.read`). Filters, `where` (up to 10 property filters), `sort` and
  `columns` are checked against the site's catalogue. Contact fields,
  properties, property filters and name sorts need contact access (§4). The
  free-text search is never a query parameter (`?q=` is `400`): it travels in
  the body of the two `search` routes, so a customer's name, email or phone is
  in no URL.
- **One lead** (`GET`/`PATCH /leads/:leadId`;
  `POST …/{opened,notes,tasks,archive,restore,customer-emails}`;
  `workspace.read` to read, `lead.manage` to change). Without contact access a
  reader gets stage and source only. The `PATCH` takes stage, assignee,
  contact, form, custom values and order details, and checks allowed moves and
  gates (§6.3). A contact save sends each touched field's value as the editor
  opened it (`expectedContact`); a field changed since is
  `409 version_conflict` and nothing is written. An archived lead refuses
  changes (`lead_trashed`). `/trash` routes and `view=trash` are still
  accepted as aliases of archive.
- **Change requests**
  (`POST /leads/:leadId/change-requests/:id/{approve,reject}`; `lead.manage`).
  Decided at `expectedVersion`; approval goes through the staff edit's own
  path and queues the decision email in the same transaction (§6.6).
- **Tasks** (`GET /tasks`, `POST /tasks`, `PATCH /tasks/:taskId`;
  `workspace.read` + contact access to read, `lead.manage` to change).
  `POST /tasks` makes a plain task (no lead). `plain=include` lists plain
  tasks too. The Tasks page reads 200 at a time and says so when there are
  more.
- **Properties, layouts, views** (`/properties[/:key]`,
  `/properties/layouts/:leadType`, `/views[/:viewId]`; `property.manage`
  (owner) to change properties; views are the caller's own). `?object=plan`
  works on plan properties instead of lead properties. Saves carry
  `expectedVersion`. A custom property in use cannot be deleted
  (`property_in_use`).
- **Plans** (`/plans[/:planId]`; `order.manage` to change). Never deleted;
  `active` off hides one. Names are unique per lead type, 200 plans per site.
- **Email settings, templates** (`/email/settings`, `/email/templates[/:key]`,
  `…/{preview,test,archive,restore}`; `integration.manage`, reading included).
  Every template save is a new version (`expectedVersion`). A test goes only
  to the caller's own verified address.
- **Automations** (`/automations[/:key]`,
  `…/{draft,activate,reset,archive,restore,test,runs,versions}`,
  `/automations/catalog`; `workspace.read` to read, `integration.manage` to
  change; activating a flow that changes leads also needs `lead.manage`).
  §6.8.
- **Documents** (`POST /files/:fileId/review`, `/files/:fileId/download-link`,
  `/leads/:leadId/identities/:id/reveal`; `order.manage`, `document.download`,
  `sensitive.reveal` (owner)). Downloads are short-lived signed URLs, audited.
  A SIN reveal is audited before the number is returned.
- **Export** (`POST /leads/export`; `lead.export`). An `.xlsx` of the ticked
  leads or of everything the list's filters match, at most 5,000 leads, 10
  exports per member and site per 10 minutes. What is written follows the
  caller's role on the server; sensitive and hidden properties, sealed
  identities, documents and restricted leads never. Audited.
- **Dashboard, reports** (`GET /analytics`, `/reports/sources`,
  `/web-analytics`, `/mail`; `workspace.read` (the sent box also needs contact
  access)). Counts only. Money keys are left out without `revenue.view`. Web
  analytics is read from Umami, cached 60 s.
- **Team, keys, jobs** (`/invitations`, `/memberships/:id`,
  `/service-credentials[/:id]`, `/jobs`, `/jobs/:id/{retry,resolve}`;
  `staff.invite`, `staff.remove`, `integration.manage`). A site key is shown
  once and stored hashed, with its scopes and lead types; `PATCH
/service-credentials/:id` changes an active key's lead types (audit event
  `service_credential.lead_types_updated`). Removing
  a member is serialised so a site always keeps an owner.
- **Ask AI** (`/ai/capabilities`, `/ai/chat`, `/ai/actions/{confirm,revise}`,
  `/ai/automations/*`, `/ai/conversations`, `/ai/attachments/*`;
  `workspace.read` plus `lead.manage`, `order.manage` or `financial.read`;
  each card its own staff actions). design/ai-assistant.md, ai-actions.md,
  ai-chat.md.
- **Ask AI, owner** (`/ai/usage`, `/ai/model-settings`; `staff.remove`). Usage
  counts and approximate cost; the site's allowed models and default
  (RUNBOOKS/ai-assistant.md §12, §14).

### Website routes (`/api/v1/website`, `Authorization: Bearer gtsk_…`)

| Method | Path                                                                     | Scope              | Notes                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/plans`                                                                 | `leads:write`      | The site's active plans for its storefront, optionally one `?leadType=`. Never cached.                                                                                                                       |
| POST   | `/leads`                                                                 | `leads:write`      | Creates a lead of one of the key's permitted lead types (else `403 lead_type_not_permitted`, nothing written). Returns a draft grant `gtdg_…`. Optional `externalRef`, `leadId`, `order`, `Idempotency-Key`. |
| GET    | `/leads/:leadId`                                                         | `leads:write`      | Resume a draft with its grant.                                                                                                                                                                               |
| PATCH  | `/leads/:leadId`                                                         | `leads:write`      | Save or submit (`submit: true`) the draft. A save that changes something writes one `draft_saved` timeline entry.                                                                                            |
| POST   | `/uploads/intents`, `/uploads/:uploadId/finalize`                        | `uploads:customer` | Signed upload target, then verification of the real bytes and the link to the lead.                                                                                                                          |
| POST   | `/files/:fileId/download-link`                                           | `uploads:customer` | The customer's own document.                                                                                                                                                                                 |
| POST   | `/leads/:leadId/identity/uploads`, `/leads/:leadId/identity`             | `leads:write`      | The ID step of a mobility lead under 24 hours old: a licence photo, or a SIN sealed under `SENSITIVE_FIELDS_KEY`. For CanadaWide it is also written to the old admin's table and bucket.                     |
| POST   | `/tracking/code`, `/tracking/verify`                                     | `tracking`         | A customer's email gets a six-digit code; the right code gives a 30-minute grant (§6.6).                                                                                                                     |
| GET    | `/tracking/orders`                                                       | `tracking`         | With `X-Customer-Grant`: the email's submitted orders on this site.                                                                                                                                          |
| POST   | `/tracking/orders/:reference/changes`, `…/uploads/intents`, `…/finalize` | `tracking`         | A change request and its held passport or visa upload.                                                                                                                                                       |

### Other

- `GET /api/v1/health` is liveness. `GET /api/v1/ready` answers 200 once the
  database answers `select 1` within 3 s, else `503 database_unreachable`; it
  is Railway's deploy health check, so a release with a broken `DATABASE_URL`
  never replaces a working one.
- `POST /api/internal/jobs/run` (machine secret) runs a scheduler task by
  hand; `POST /api/internal/jobs/intake-check` (scope `synthetic:check`) runs
  one intake check and never alerts. Both count attempts per client IP before
  the secret is checked (10 a minute, fail closed).
- `/api/v1/email/unsubscribe`: `GET` shows a confirmation page and changes
  nothing; `POST` records the unsubscribe (also what a provider's RFC 8058
  one-click request sends).
- `POST /api/v1/webhooks/resend/:selector`: Resend delivery events, signature
  verified. `POST /api/v1/webhooks/inbound-mail`: Resend's `email.received`,
  signature checked with `RESEND_INBOUND_WEBHOOK_SECRET`; a mail to a valid
  reply address is fetched, its quoted history cut, and kept on the lead as a
  `customer_replied` entry (`email/inbound.ts`).
- Every `/api` response carries `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The
  last-resort error handler answers an unreadable body with 400 (413 when too
  large), an unreachable database with a retryable 503 and anything else with
  a generic 500.

### Scheduler

In-process, `ENABLE_SCHEDULER=1`, one replica, overlap-guarded
(`apps/backend/src/scheduler.ts`). A task's failure is logged as
`scheduler_task_failed`; a task left out at start by its own configuration
logs its code once (`scheduler_scope_missing`, …) and the others run.

| Task               | Every  | Does                                                                                                                                                                                                                                                 |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbox`           | 60 s   | Sends queued email, analytics and alerts.                                                                                                                                                                                                            |
| `document_cleanup` | 1 h    | Deletes the document objects recorded in `app.file_object_deletions` until storage confirms; sweeps Ask AI files left unsent for a day, the files of erased chat turns and the chats of members gone 30 days.                                        |
| `data_retention`   | 24 h   | Restricts abandoned drafts and erases their data; with `OPERATIONAL_RETENTION_ENABLED` also prunes old operational rows (`app.prune_operational_rows`).                                                                                              |
| `automations`      | 5 min  | Resumes due waits and fires due timers, at most 200 items per site per pass, in passes until no site is full or four minutes are spent. Alerts once for a site that stays behind and for a site with overdue work the scheduler entry does not list. |
| `intake_check`     | 15 min | Only when `INTAKE_CHECK_WORKSPACE_ID` is set and the scheduler entry holds `synthetic:check` (§6.10).                                                                                                                                                |

## 3. Data model and tenancy

Schema `app`. Every table carries `workspace_id` except `contacts` and
`rate_limit_buckets`. A workspace **is a site**.

| Group        | Tables                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sites, staff | `workspaces`, `memberships` (pending, active or revoked; `display_name`, `notification_email`), `roles`, `membership_roles`, `permissions`, `membership_permissions`, `service_credentials` (`scopes`, `lead_types`)                                      |
| CRM          | `contacts` (global, unique by `lower(btrim(email))`), `leads`, `lead_activities` (the append-only timeline), `lead_tasks`, `draft_grants`, `lead_identities` (append-only), `site_counters`, `idempotency_keys`, `change_requests`, `tracking_challenges` |
| Properties   | `properties` (built-in overrides and custom properties; tombstones keep keys reserved), `property_layouts`, `saved_views`, `plans`                                                                                                                        |
| Documents    | `files`, `file_revisions`, `file_review_events`, `file_object_deletions`                                                                                                                                                                                  |
| Email        | `workspace_email_settings`, `email_templates`, `email_template_versions` (append-only), `email_messages`, `email_provider_events`, `email_suppressions`, `marketing_consents`, `follow_up_schedules`, `deleted_email_messages`                            |
| Automations  | `automations`, `automation_versions`, `automation_runs`, `automation_step_runs` (append-only), `automation_waits`, `automation_timers`                                                                                                                    |
| Ask AI       | `ai_turns` (counts per turn, no text, 90 days), `ai_automation_proposals`, `ai_conversations`, `ai_messages` (written once), `ai_attachments` (rows only; bytes in the `documents` bucket), `ai_model_settings`                                           |
| Operations   | `outbox_jobs`, `outbox_job_alerts`, `audit_events` (redaction-only updates), `rate_limit_buckets`                                                                                                                                                         |

**Tenancy.** `withTenantTx` opens a transaction and sets `app.workspace_id`
and `app.actor_id` with `set_config(…, true)`; every `tenantPolicy` requires
both and matches the row's `workspace_id`. `contacts` use `actorPolicy` (an
actor present); `saved_views`, `ai_automation_proposals` and the three saved
chat tables use `ownerPolicy` (site and actor). FORCE RLS is on every table,
each has a `<table>_backup_reader_read` policy for the backup login, and
`app_runtime` is NOBYPASSRLS with no grant on `app.workspaces`. Work that must
cross the tenant boundary goes through SECURITY DEFINER functions
(`list_staff_workspaces`, `accept_staff_invitations`,
`resolve_website_credential`, `rate_limit_hit`, `prune_operational_rows`,
`staff_access_snapshot`, `current_workspace_identity`,
`record_staff_notification_email`, `automation_overdue_sites`, the erasure
and sweep functions). Triggers keep `audit_events` redaction-only and stop
ordinary writes to a restricted lead's data.

**Legacy mirrors (temporary).** Two triggers on `app.leads` copy new rows
into the old admins' `public` tables so those admins keep working: CanadaWide's
`internet` and `mobility` leads on insert (migration 0002), Get Canada Sim's
`sim_order` leads when submitted (0041). Both are insert-only and never fail
the CRM's write; nothing is synced afterwards in either direction. How to
operate and retire them: [RUNBOOKS/database.md](RUNBOOKS/database.md#the-legacy-mirrors-0002-0005-0006-0041-temporary).
Every legacy row is also in `app.leads` under its own id
([RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md)).

**Seeded sites.** `getcanadasim` (`10000000-0000-4000-8000-000000000101`)
and `canadawide` (`…102`, domain `canadawideinternet.com`), each with the
seven roles and six permissions. The test site `intake-check`
(`abf5dabe-5fcc-4976-a3d1-d4b1838dd39f`) has no members, roles, site keys,
email settings or automations, by design.

## 4. Identity, roles, permissions

Roles: `owner` (everything), `leads` (`workspace.read`, `lead.manage`),
`orders` (`order.manage`, `order.override`), `finance` (`financial.read`,
`invoice.approve`), `partners`, `content`, `viewer` (read only).

Actions: `workspace.read`, `lead.manage`, `order.manage`, `order.override`,
`staff.invite`, `staff.remove`, `staff.roles.manage`, `document.download`,
`financial.read`, `export.bulk`, `lead.export`, `record.delete`,
`invoice.approve`, `integration.manage`, `sensitive.reveal`,
`property.manage`, `revenue.view`.

- `sensitive.reveal`, `property.manage` and `revenue.view` (every money
  figure) are owner only.
- `order.override` belongs to `owner` and `orders`; no individual permission
  grants it.
- `lead.export` belongs to `owner`, `leads`, `orders` and `finance`, or the
  individual `bulk_export` permission (as a deny it also takes it away).
- Per-member overrides (`membership_permissions`, allow or deny) map to
  `document.download` through `integration.manage`; a deny always wins.
- **Contact access** means `lead.manage`, `order.manage` or `financial.read`:
  contact details, a lead's form, notes, tasks and search are shown only with
  it (`staff/lead-visibility.ts`).

`decideAccess` is pure; `createAuthorize` loads then decides
(`apps/backend/src/staff/authorization.ts`). Authorization is re-read from
the database on every request, so a revoked member is out on their next call.
There is no multi-factor step (owner decision, 2026-10-25).

**Staff sign-in.** The admin signs the user in with Supabase Auth in the
browser (email and password; an invited person signs up with the invited
email and confirms it). The first `GET /staff/workspaces` calls
`accept_staff_invitations(verified_email)`, which turns pending memberships
for that email into active ones; an invitation is claimable for 14 days. The
backend verifies a token with `auth.getUser(token)` (`auth/session.ts`),
never the token's own claims, and caches a successful verification for 60
seconds per token (owner decision, 2026-10-27): a session signed out in Auth
can keep working that long, while a removed membership stops at the next
request.

## 5. How a website integrates

1. An owner creates a site key in the admin (Settings → Integrations) with
   the scopes `leads:write`, `uploads:customer` and, for customer tracking,
   `tracking`, and the **lead types** the site sends. The secret is shown
   once; the website keeps it server-side only.
2. The website calls `POST /api/v1/website/leads` with
   `Authorization: Bearer <key>`, `leadType`, `contact`, `form`
   (`{ schemaVersion, payload }`), `consentVersion`, and optionally
   `attribution`, `externalRef` (unique per site and type), `leadId`,
   `order` and `submit`.
3. **The lead-type registry decides what a lead must carry**
   (`apps/backend/src/leads/types.ts`; payload schemas in
   `packages/contracts/src/lead-types.ts`). An unlisted type is a 400.
   - `internet` and `mobility` (CanadaWide): strict payloads, name, email and
     phone required, **one-shot** (sent with `submit: true`, no draft grant).
   - `sim_order` (Get Canada Sim): a strict payload of optional keys. A draft
     may hold any part of it. A submission needs the contact's name and
     email, a plan (`order.planId`) and `delivery` (`esim`, or `pickup` with
     a shipping address).
   - `partner_application` and `contact_message` are not modelled yet and
     take any payload as resumable drafts.

   A refusal is `validation_error` with `details.field` naming the refused
   part (`leadType`, `submit`, `form`, `contact` or `order`), never a value.

4. Multi-step forms keep the returned draft grant and `PATCH` the lead. Once
   staff rescue a checkout (§6.4) the website's next `PATCH` answers
   `draft_already_submitted`.
5. Documents: `uploads/intents` → the browser uploads to the signed target →
   `uploads/:id/finalize` re-reads the bytes and checks the file signature.
6. Rate limits are per credential, per visitor and per endpoint. A website
   server can send `x-website-visitor-id` (64 hex; CanadaWide sends an HMAC
   of the customer's IP) so the visitor limit applies per customer.
7. **Human proof** is `WEBSITE_BOT_CHECK` (ENV.md). Production runs
   `delegated`, which trusts the calling website's own screening; the site
   key and the limits still apply. That is why the OpenAPI document marks
   `X-Turnstile-Token` as needed only in `turnstile` mode: a website that
   sends none is correct.
8. **Plans and orders.** `GET /plans?leadType=…` lists the site's active
   plans. An order lead is created or updated with
   `order: { planId, quantity }`; the browser sends no price. On submission
   the backend freezes a copy of the plan on the lead (§6.2). A plan that is
   inactive, another site's or of another lead type is
   `400 plan_not_available`.
9. **Safe retries.** An `Idempotency-Key` header (8–200 characters of
   letters, digits and `_ . : -`) on `POST /leads` and on a submitting
   `PATCH`: the same key with the same request within 24 hours answers the
   first status again with the same lead and `replayed: true`; the same key
   with another request is `409 idempotency_conflict`; while the first is in
   flight, `409 idempotency_in_progress` with `Retry-After: 2`. Only a hash
   is stored, for 7 days.
10. **Order numbers.** Every create and save answers `lead.externalRef`. A
    `sim_order` created with none gets the next `MS-<n>` from the site's
    counter (§6.5). A website's own `externalRef` is kept as sent.
11. **Order emails.** Submitting an order fires the site's `order_received`
    flow if the owner switched it on. A website that sends its own order
    email and has the flow on would send two, which is why every flow starts
    off.
12. **Customer tracking**: §6.6.

Reference client: `lib/crm.ts` in the CanadaWide repository.

## 6. Domain rules

`workspace` in code = **Site** in the UI = one website.

### 6.1 Leads, types, stages

`lead_type` names the form a lead came from (`sim_order`, `internet`,
`mobility`, `partner_application`, `contact_message`). A lead's `status` is
the form's lifecycle (`incomplete` → `submitted`); its `stage` is where staff
are working it. Labels, stages, allowed moves and gates per type live in
`leadTypeCatalog` (`packages/contracts/src/lead-types.ts`); the backend
registry adds payload schemas and intake rules.

| Type                  | Site           | Stages                                                                                                             |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `internet`            | CanadaWide     | `new`, `contacted`, `qualified`, `existing_shaw`, `non_serviceable_address`, `old_due`, `installed`, `won`, `lost` |
| `mobility`            | CanadaWide     | `new`, `contacted`, `qualified`, `activated`, `won`, `lost`                                                        |
| `sim_order`           | Get Canada Sim | `incomplete`, `pending`, `verified`, `on_hold`, `delivered`, `activated`, `completed`, `cancelled`                 |
| `partner_application` | Get Canada Sim | `new`, `contacted`, `approved`, `declined`                                                                         |
| `contact_message`     | Get Canada Sim | `new`, `replied`, `closed`                                                                                         |

To **archive** a lead is to soft-delete it (`deleted_at`); it can be
restored. Contacts are merged by normalized email across sites; the backend
exposes a contact only through a lead of the current site.

### 6.2 Properties, plans, order details

A **property** is one field of a lead, built-in or custom. Built-ins are
defined once in `leadPropertyCatalog` (`packages/contracts/src/lead-properties.ts`);
a site may relabel or hide one through a row in `app.properties`. A **custom
property** is added by a site's owner under Settings → Fields and layouts:
key `custom_<snake>` from the label, kind one of `text`, `longText`,
`number`, `money` (integer cents, CAD), `date`, `yesNo`, `choice`, `email`,
`phone` or `url`, values in `leads.custom_values`, at most 100 per site. A
deleted one leaves a tombstone so its key is never reused. The **catalogue**
is the set one site resolves to (`buildPropertyCatalog` in
`packages/contracts/src/properties.ts`); every list, board, filter, sort,
column and record screen reads the catalogue, never the code list. A
**layout** orders the sections and keys of the lead record for one site and
lead type. A **saved view** is one member's private copy of the inbox state
(never the free-text search or the page), at most 30 per person per site.

A **plan** is something a site sells, for one order lead type (`sim_order`,
`internet` or `mobility`): name, price in cents (CAD), billing period
(`one_time`, `month`, `30_days`, `90_days`, `year`), whether payment is
required, required documents, a staff-only commission, custom values
(**plan properties**, each with a _Show on website_ switch) and a position.

The **order details** of an order lead (`leads.order_details`) are its plan
link, the **frozen plan**, `quantity` (1–99), **payment status**
(`not_needed`, `pending`, `paid`), **carrier commission** (`not_yet`,
`invoiced`, `received`, `clawback`), the **dispatch details** (`courier`,
`trackingNumber`, `dispatchedAt`) and the **activation details**
(`activatedAt`, `activationNumber`, `activationAccount`). The frozen plan is
a snapshot taken when the lead is submitted and again whenever staff change
the plan, so a later price or name change never rewrites an order already
taken. Payment and commission are order details, not stages.

### 6.3 Stage moves, gates, the documents check

An **allowed move** is a stage a lead may move to from where it is. Every
type allows any other listed stage except `sim_order`, whose path is
`incomplete` → `pending` → `verified` → `delivered` → `activated` →
`completed`, with `on_hold` and `cancelled` off to the side. A **gate** is
what a move into a stage asks first: `dispatch` (a courier), `activation` (an
activation date; none given means today in `America/Toronto`) and `documents`.
`sim_order` gates `delivered` with dispatch + documents and `activated` with
activation + documents; `mobility` gates `activated` with activation +
documents. `planStageMove` (`leads/stage-move.ts`) decides a move.

The **documents check** (`leads/documents-check.ts`) needs every document
type in the order's frozen plan's `requiredDocuments` to have a current file
whose latest review is `approved`. It is derived on every move, never stored;
a lead with no frozen plan requires nothing. The **override** moves an order
on without them: action `order.override` and a reason of 1–2000 characters,
recorded as a `documents_override` timeline entry and a
`lead.documents_overridden` audit. Moving a stage still needs `lead.manage`,
so in practice the override is for the owner or a member with both the Leads
and Orders roles. The timeline and audit name field keys, never values.

### 6.4 Submission and rescued checkouts

A submitted SIM order still at `incomplete` moves to `pending` in the same
transaction, with a `submitted` timeline entry; other types stay at their
first stage. A submission fires the `lead_submitted` flows and then counts as
entering the stage the lead stands in, so that stage's flows fire after them.

A **rescued checkout** counts as submitted for every lead type: the first
staff stage move of an incomplete lead marks it submitted, freezes its plan
and fires the submitted and stage flows; the customer can then no longer
finish that checkout. A move of such a lead into a **closing stage**
(`isClosingStage`: a SIM order's Cancelled, internet Lost and Non-serviceable
address, mobility Lost, a partner application's Declined, a contact message's
Closed) is no rescue: the lead stays unsubmitted, nothing is frozen and no
flow fires. If the customer then submits that draft it is a fresh submission.

A customer's draft save writes one `draft_saved` timeline entry with the
fields changed and the values filled in, in the entry's `body` only (erased
with the notes; never a sensitive field's or an unmodelled key's value).

### 6.5 Order numbers

A SIM order's `MS-<n>` is the lead's `externalRef`. A new `sim_order` created
with no `externalRef` takes the next number from the site's counter
`sim_order_ref` in `app.site_counters` (`nextSiteNumber`), advanced in the
create's own transaction after the idempotency claim and the order check, so
a replay or a refused create takes none. The counter only goes up and never
issues a number a lead already holds (it jumps past the site's highest
`MS-<n>`). A number taken at the same moment, or a website's own
`externalRef` another lead holds, is `409 external_ref_taken`. A website may
also send the lead's id (`leadId`); an id any lead already has is
`409 lead_id_taken` (CanadaWide does, so its intake fallback copy and a late CRM
save are one lead).

### 6.6 Customer order tracking and change requests

Through the website's key with the `tracking` scope; needs
`TRACKING_HASH_SECRET` on the backend (unset or under 32 characters, the code
route answers neutrally and sends nothing and the others answer
`409 feature_not_ready`).

- `POST /tracking/code` always answers `200 { status: 'code_sent' }` after at
  least 500 ms, so an email with no orders looks the same as one with orders;
  only the latter gets a code. The **code** is six digits, lives 10 minutes
  and allows 5 tries; a new request replaces the pending one
  (`app.tracking_challenges` holds only keyed hashes). The code mail is the
  outbox job `tracking_code_email`, which carries the code sealed and is
  scrubbed to `{ challengeId }` when it ends.
- Limits per email per 10 minutes: 5 code requests, 10 verifications, 30
  customer writes; 30 verifications per email per 24 hours; per visitor per
  10 minutes: 20 code requests and 40 verifications; the endpoint budget is
  `RATE_LIMIT_TRACKING_*`.
- `POST /tracking/verify` turns the right code into a **grant**: a signed
  token the website keeps server-side and sends as `X-Customer-Grant`, valid
  30 minutes, for this site and the normalized email only.
- **What is listed**: the email's submitted `sim_order`, `internet` and
  `mobility` leads on this site, not archived or restricted, newest
  submission first, at most 50: reference, the stage in the customer's words,
  the frozen plan, quantity, delivery, dispatch details, SIM number, the
  customer's own answers, each document's state (never a link) and the
  pending change request. Never payment status, commission, notes, tasks,
  assignee or custom values.
- **A change request** (`app.change_requests`) is a customer's ask to change
  a `sim_order` at `pending`, `verified` or `on_hold`: name, phone, plan,
  delivery, arrival date, permit type, addresses, flight booked and a new
  passport or visa (a **held document**, not current until approved, deleted
  if rejected); never the email. One pending request per lead, replaced in
  place by the customer's next one (`version + 1`). Staff approve or reject
  the version they saw (`expectedVersion`, else `version_conflict`); approval
  applies the fields through `applyLeadUpdate`. Requests are numbered per
  site from the counter `change_request_no`. `internet` and `mobility` orders
  are listed read-only.

### 6.7 Customer email

**Email settings** are a site's sender and look
(`app.workspace_email_settings`): from name and address, reply-to, logo,
brand colour, footer, site address, **style** (`classic`, or `hero` with an
accent colour) drawn by one layout (`email/layout.ts`). A site that has not
saved them sends no customer email at all (`no_sender`).

A **template** is the current copy of one of nine built-in emails
(`tracking_code`, `order_received`, `information_needed`, `dispatched`,
`activated`, `cancelled`, `sim_number_ready`, `change_approved`,
`change_rejected`) or a **site-made template** (`tpl_…`, at most 50 not
archived): a subject, a body and a version, content only. Every save is a
new version; a sent mail records the version it was rendered from. Templates
are written in a small markup (`email/markup.ts`) with **fill-ins** in braces
such as `{first name}` (`EMAIL_FILL_IN_KEYS`; site-made templates also take
`{prop:<key>}` for properties a customer may see); a misspelt or disallowed
fill-in is refused on save. The backend renders a mail when it queues it, so
the outbox job only sends it. Three emails are **always sent** when the site
has a sender, with no flow controlling them: `tracking_code`,
`change_approved` and `change_rejected`.

A mail to a lead's customer keeps its subject and plain text on its timeline
entry (owner decision, 13 Nov 2026); the address is never stored. A
customer's reply to a CRM mail lands on the lead as a `customer_replied`
entry.

### 6.8 Automation flows

A **flow** is a trigger and ordered steps. Triggers: `lead_submitted`,
`stage_entered`, and the time triggers `time_in_stage` (once per stay),
`task_overdue` and `after_submitted`. Steps: `send_email`, `create_task`,
`assign_lead`, `update_lead` (a property, or the stage through the same
gates a person passes), `notify_staff`, `if_else` (two branches, last in its
sequence) and `wait`.

- A flow lives in `app.automations` (at most 50 not archived per site,
  built-ins included) with **versions**: one `draft` and one `active` at
  most; an activated version never changes, so a waiting run finds its steps.
- The six **built-in flows** (`order_received`,
  `sim_order_information_needed`, `sim_order_dispatched`,
  `sim_order_activated`, `sim_order_cancelled`, `mobility_activated`) are
  seeded per site the first time the Automations page is read, off.
- Every flow is off until someone with `integration.manage` switches it on.
  Off queues nothing, records no run and cancels waiting runs. Activating a
  flow that changes leads also needs `lead.manage`, and its changes are made
  as the member who activated it.
- A **run** is one firing for one lead and occurrence (`waiting`,
  `completed`, `skipped`, `failed`, `cancelled`); runs are pruned 90 days
  after they finish. A waiting run continues on the version it started with.
- Time triggers never back-fill. A flow's stage move may set off other
  flows, at most 3 deep (`chain_too_deep`) and never the same flow twice in
  one chain (`loop_prevented`).
- A flow naming a stage, template, property, plan or member that is no
  longer usable is skipped whole and marked "Needs attention".
- A `notify_staff` step mails the member's verified sign-in address
  (`memberships.notification_email`), which is never shown.
- A Test run mails only the caller's own address.

### 6.9 Reports

The **source report** counts one lead type's leads per **source** over 7, 30
or 90 days or all time. The source is the label `deriveSource` gives a
lead's attribution (`partner:<code>`, with ` (unmatched)` when no partner
application matched; else `utm:<source>[/<medium>]`; else `referrer:<host>`;
else `direct`). Per source: **received**, **submitted** and **made it** (the
stage is one of `SOURCE_REPORT_SUCCESS_STAGES`). At most 50 sources and 20
campaigns per source; the rest are summed into "Other". It counts exactly the
leads `GET /leads/stats` counts. The **Dashboard** (`GET /analytics`) is one
read-only aggregate: New = created in range, not archived or restricted, lost
stages aside; Won = at a won stage now (`ANALYTICS_WON_STAGES`).

### 6.10 The intake check

Every 15 minutes the scheduler proves a website could still save a lead: it
refuses a site with any member, role or site key
(`intake_check_site_not_test`), deletes its own leftovers, pushes one
fictional submitted `internet` lead through the website route's own checks
and `createLead`, reads it back and deletes it. It runs on the **test site**
(slug `intake-check`, id in `INTAKE_CHECK_WORKSPACE_ID`; unset, the check is
off). A failure is a step (`leftovers`, `create`, `verify`, `delete`) and a
bounded code; the owner is alerted on the first failure and at most hourly
while it lasts, and gets one all-clear. Runbook:
[RUNBOOKS/intake-check.md](RUNBOOKS/intake-check.md).

### 6.11 Tasks

A **task** is a row of `app.lead_tasks` (`open`, `in_progress`, `done`,
`cancelled`): a lead's follow-up, or a **plain task** with no lead, made on
the Tasks page or by an Ask AI card. A plain task is on the Tasks board and
in My tasks, starts no flow and is in no lead count.

### 6.12 Ask AI

Staff ask questions about one site; the model reads through bounded tools
and can only **prepare** signed cards that a person confirms. Design and
limits: [design/ai-assistant.md](design/ai-assistant.md) (trust boundaries,
reads, limits, models), [design/ai-actions.md](design/ai-actions.md) (cards
and confirmation), [design/ai-chat.md](design/ai-chat.md) (saved
conversations, attachments, usage). Operation:
[RUNBOOKS/ai-assistant.md](RUNBOOKS/ai-assistant.md).

- A **conversation** is one member's saved chat on one site, private to that
  member (the owner included gets `404`). It is kept until the member deletes
  it, except that a customer's erasure empties the turns about that lead and
  a member gone from the site for 30 days loses their chats there.
- An **attachment** is a file a member adds to a message (`image`, `pdf` or
  `text`, of the kinds `AI_ATTACHMENT_KINDS` enables); never a lead's
  document, never in `app.files`.
- **AI usage** (Settings → AI usage, owner only) is counts per member, model
  and Toronto day from `app.ai_turns`, with an approximate cost at the
  Gateway's current list prices; never content.
- An **effort level** is `normal` or `high` (`AI_HIGH_EFFORT_ENABLED`): larger
  turn limits and its own model, never wider reads or fewer checks.
- The **allowed models** are the Gateway models a site's owner lets members
  choose (up to 8, one default; Settings → AI models); with nothing saved,
  `AI_GATEWAY_MODEL` answers.
