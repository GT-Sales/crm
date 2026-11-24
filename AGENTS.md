# GT Sales CRM — guide for AI agents and new sessions

Read this first, then [docs/HANDOFF.md](docs/HANDOFF.md) (where it runs, what
is live, what waits for the owner, what comes next),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it works: surfaces, data
model, roles, website integration, domain rules),
[docs/PLAN.md](docs/PLAN.md) (decisions in force) and
[docs/ENV.md](docs/ENV.md) (every variable). Keep them current when you
change what they describe; say a thing once and link to it.

## What this is

One backend and one admin for every GT Sales website (Get Canada Sim,
CanadaWide, more to come). Websites keep their own repositories and send
leads to the backend with a per-site key; staff work every site from this
admin.

| Path                                                       | Role                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/backend`                                             | Express 5 + strict TypeScript. **The only database client.** Docker image for Railway (`apps/backend/Dockerfile`).     |
| `apps/admin`                                               | Next.js staff app (Tailwind + shadcn). Talks to the backend only. Vercel, root `apps/admin`.                           |
| `packages/db`                                              | Drizzle schema (`src/schema.ts`), migrations (`drizzle/`), pooled runtime client, synthetic seed. Backend-only import. |
| `packages/contracts`                                       | Zod request/response schemas, the endpoint registry, the generated OpenAPI document and the one typed client.          |
| `packages/types`                                           | Value lists (roles, permissions, lead statuses, scopes) that schema, contracts and apps all derive from.               |
| `packages/adapters`                                        | Object store (S3 protocol), Resend email, alerts, error tracking, Umami sink.                                          |
| `jobs`                                                     | Outbox job types, handlers and runner; the backup, monitor, retention and restore CLIs.                                |
| `packages/ui`, `packages/config`, `packages/observability` | shadcn components; tsconfig/eslint/prettier/vitest/playwright bases; logging.                                          |

## Rules that are not negotiable

The numbers are cited from code comments ("AGENTS.md rule 7"); keep them.

1. **Only the backend talks to Postgres**, as the `app_runtime` role
   (`NOBYPASSRLS`, owns nothing) over the Supabase transaction-mode pooler.
   The admin and the websites hold no database credential. An ESLint boundary
   rule fails the build if anything but `apps/backend` imports `@gt-sales/db`.
2. **Every tenant table carries `workspace_id`** and a row-level policy that
   reads `app.workspace_id` / `app.actor_id` set per transaction by
   `withTenantTx`. A query that forgets its tenant sees nothing. `contacts` is
   the one documented global table (merge by email); the backend exposes a
   contact only through a lead of the current site.
3. **Hand-written SQL lives in migrations** (`drizzle/0001_runtime_functions.sql`
   and the later custom ones: grants, FORCE RLS, SECURITY DEFINER functions,
   triggers). Adding a table means a generated migration **and** its grants +
   FORCE RLS in a custom migration (`drizzle-kit generate --custom` makes the
   empty file), and a seed/test touching it. Never edit an applied migration.
4. **Staff authorization is per action** (`apps/backend/src/staff/authorization.ts`).
   Roles: `owner`, `leads`, `orders`, `partners`, `finance`, `content`,
   `viewer`. A privileged action needs only the role or per-member permission
   that grants it; there is no authenticator-code step. Contact details, a
   lead's form, notes and tasks (and search, which would reveal them) are
   shown only to roles with `lead.manage`, `order.manage` or `financial.read`;
   every change to a lead needs `lead.manage`.
5. **Websites authenticate with a service credential** (`gtsk_…`, hashed at
   rest, scoped, revocable; its row id is the actor for its writes) and prove
   a visitor owns a draft with a draft grant (`gtdg_…`). They can create and
   resume their own leads and upload documents against them, nothing else. A
   key also names the lead types it may send
   (`service_credentials.lead_types`): a create or a draft save of any other
   type is `403 lead_type_not_permitted` and writes nothing.
6. **Side effects go through the outbox** (`app.outbox_jobs`), never straight
   from a request handler: emails, analytics, alerts. Dedupe on
   `(workspace, job_type, dedupe_key)`. A mail the provider refuses outright
   (HTTP 429) is retried with backoff under the same idempotency key; a
   timeout or a 5xx may have been sent, so it ends `uncertain` and waits for
   staff.
7. **No PII in logs or URLs; audit `before`/`after` may be redacted to null
   and never rewritten; email tables store a keyed `contact_hash`, never the
   address.** Customer text is kept in exactly one kind of place, a timeline
   entry's `body`, which a customer's erasure nulls: a note, a sent mail's
   subject and plain text (`email/kept-text.ts`), and the values a customer
   changed in a draft save (`leads/draft-changes.ts`; never a sensitive
   field's or an unmodelled key's value). Never in the entry's `data`, a log
   or an audit event. The leads search (a name, email or phone) travels in a
   request body, never in a URL.
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
pnpm run build                                           # every package and app
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
The lead journeys need a local `gt_sales_crm_e2e_test` database.

Local notes: the dev container's Postgres 16 stops on worker restarts
(`pg_ctlcluster 16 main start`; the `postgres` password there is `postgres`).
After deleting an admin route, delete `apps/admin/.next` before the
typecheck (it reads stale generated types).

## How to change things

- **Contracts**: regenerate `docs/api/openapi.json` (command above).
- **Schema**: edit `packages/db/src/schema.ts`, generate the migration, add
  the custom companion (rule 3). Migrations are applied to the hosted
  project by hand, never by a deploy, and recorded in
  [docs/RUNBOOKS/database.md](docs/RUNBOOKS/database.md); until one is
  applied, list it in HANDOFF §3. Where the deploy and the migration may land
  in either order, add a catalogue probe (`*-schema.ts`) rather than assume
  the column.
- **A variable**: document it in docs/ENV.md.
- **A confirmation after an action** in the admin ("Archived 3 leads.",
  "Saved."): `toast()` from `apps/admin/src/lib/toast.tsx`, shown in the
  bottom-right corner, never a line that pushes the page down. A field error
  or something that must stay on screen (a secret shown once) stays inline.
- **A database or operations procedure**: its runbook in `docs/RUNBOOKS/`.

## Where things live

Backend paths are under `apps/backend/src/`, admin paths under
`apps/admin/src/`, contracts under `packages/contracts/src/`.

- **App wiring**: `app.ts` (middleware, mounts), `server.ts`, `scheduler.ts`,
  `machines/registry.ts` (machine identities), `auth/session.ts`, `staff/`
  (authorization, `lead-visibility.ts`). Contracts and admin: `endpoints.ts`;
  admin `lib/api.ts`, `lib/use-resource.ts`.
- **Lead intake**: `leads/store.ts` (contact merge, lead types),
  `leads/types.ts` (registry, submit checks, closing stages),
  `leads/site-counter.ts`, `leads/idempotency.ts`, `leads/draft-changes.ts`,
  `website/` (credential auth, limits, bot check), `routes/website.ts`.
  Contracts and admin: `leads.ts`, `lead-types.ts`, `website-auth.ts`.
- **Staff lead work**: writes in `leads/work-store.ts` (the store),
  `leads/work-writes.ts` (its steps) and `leads/work-types.ts` (its
  contract); reads, plain SQL with explicit aliases, in
  `leads/staff-queries.ts` (list and board), `leads/lead-filters.ts` (filter
  conditions) and `leads/lead-work-queries.ts` (lead page, tasks, timeline);
  `leads/stage-move.ts`, `leads/documents-check.ts`, `leads/order.ts`,
  `leads/task-schema.ts`. Staff routes: `routes/staff.ts` mounts
  `staff-leads.ts`, `staff-site.ts` (team, keys, jobs) and `staff-files.ts`
  over the shared `staff-context.ts`. Contracts and admin:
  `workspace-leads.ts`, `lead-work.ts`; admin `components/leads/`
  (`stage-move-dialog.tsx`, `change-request-card.tsx`),
  `components/tasks/task-composer.tsx`.
- **Export to Excel**: `leads/export/` (`store.ts`, `cells.ts` with the
  formula-injection guard, `workbook.ts`), `routes/lead-export.ts`. Contracts
  and admin: `lead-export.ts`; admin
  `components/leads/lead-export-dialog.tsx`.
- **Properties, layouts, views**: `properties/` (`store.ts`, `catalog.ts`),
  `routes/properties.ts`, `views/store.ts`, `routes/views.ts`. Contracts and
  admin: `lead-properties.ts`, `properties.ts`, `property-layouts.ts`,
  `saved-views.ts`, `custom-values.ts`, `lead-fields.ts`; admin
  `components/properties/`, `settings/properties`.
- **Plans and order details**: `plans/` (`store.ts`, `options.ts`),
  `routes/plans.ts`. Contracts and admin: `plans.ts`; admin
  `components/plans/`, `settings/plans`.
- **Documents**: `documents/` (signed upload intent → finalize with signature
  verification → attach; review and download links; `object-deletions.ts` and
  the `document_cleanup` sweep).
- **Customer email**: `email/` (`senders.ts`, `settings-store.ts`,
  `markup.ts`, `layout.ts`, `compose.ts`, `queue.ts`, `kept-text.ts`,
  `inbound.ts`, `reply-address.ts`), `routes/email-settings.ts`,
  `routes/email.ts`. Contracts and admin: `customer-email.ts`; admin
  `components/email/`, `components/mail/`, `settings/email`.
- **Customer tracking**: `tracking/` (`secrets.ts`, `store.ts`, `service.ts`,
  `delivery.ts`, `change-requests.ts`), `routes/tracking.ts`. Contracts and
  admin: `tracking.ts`.
- **Automation flows**: `automations/` (`engine.ts`, `conditions.ts`,
  `actions.ts`, `timers.ts`, `tick.ts`, `staff-notification.ts`,
  `flow-store.ts`, `site.ts`, `records.ts`, `run.ts`),
  `routes/automations.ts`. Contracts and admin: `automation-keys.ts`,
  `automation-flows.ts`, `automation-api.ts`, `automations.ts`; admin
  `components/automations/` (`canvas/`, `flow-list-view.tsx`,
  `flow-words.ts`).
- **Dashboard and reports**: `analytics/store.ts`,
  `analytics/web-analytics.ts`, `routes/analytics.ts`, `reports/store.ts`,
  `routes/reports.ts`. Contracts and admin: `analytics.ts`, `reports.ts`;
  admin `components/dashboard.tsx`, `components/analytics/`,
  `components/reports/source-report.tsx`, `lib/stats-windows.ts`.
- **Ask AI: reads and cards**: `ai/` (`tools.ts`, `read-tools.ts`,
  `lead-record.ts`, `record-text.ts`, `actions.ts`, `card-safeguards.ts`,
  `card-store.ts`, `engine.ts`, `prompt.ts`), `routes/ai-assistant.ts`,
  `routes/ai-automations.ts`. Contracts and admin: `ai-assistant.ts`; admin
  `components/ai/` (`assistant-provider.tsx`).
- **Ask AI: saved chat, usage, models**: `ai/` (`conversation-store.ts`,
  `attachment-store.ts`, `attachments.ts`, `attachment-budget.ts`,
  `usage-store.ts`, `usage-cost.ts`, `chat-schema.ts`, `chat-factory.ts`,
  `model-catalogue.ts`, `model-settings-store.ts`, `model-schema.ts`),
  `routes/ai-conversations.ts`, `routes/ai-models.ts`. Contracts and admin:
  `ai-conversations.ts`, `ai-models.ts`; admin `app/w/[workspace]/chat/`,
  `components/ai/` (`chat-screen.tsx`, `model-control.tsx`),
  `components/ai-usage/`, `components/ai-models/`.
- **Ask AI evaluations**: `docs/evals/` (automation authoring;
  `model-test/README.md`, the model comparison: seed, prompts, runner,
  scorer and report under `apps/backend/scripts/model-test/`).
- **Intake check**: `intake-check/` (`check.ts`, `store.ts`, `alert-rule.ts`),
  `routes/intake-check.ts`. Runbook `docs/RUNBOOKS/intake-check.md`, paste
  file `docs/RUNBOOKS/manual/intake-check-site.sql`.
- **Retention and erasure**: `retention/` (`abandoned-leads.ts`, `operational.ts`).

Also:

- **Admin pages**:
  `apps/admin/src/app/w/[workspace]/{dashboard,leads,leads/[leadId],tasks,mail,chat,analytics,automations,automations/[key],settings/*}`.
  The menus are data: `components/nav-items.ts` (sidebar, top bar and
  Ctrl/Cmd K) and `settings-nav-items.ts`. The CRM filter chips, menus and
  side panel are in `components/crm/` (tokens in `app/crm-theme.css`).
  Documents are reviewed on each lead's page; there is no Documents page.
- **Error messages in the admin**: `lib/error-text.ts`.
  `describeError(error, 'save the change')` turns any failure into a plain
  sentence that says what to do next; `describeInvalid` names the field and
  the limit. A screen never shows a raw error code.
- **The leads search** is kept in page state (`lib/lead-search-handoff.ts`
  carries it from Ctrl/Cmd K) and sent in the body of `POST …/leads/search`.
- **The admin's CSP**: a per-request nonce in `src/proxy.ts` and `lib/csp.ts`.
- **Legacy imports**: `packages/db/sql/` (docs/RUNBOOKS/legacy-import.md).
- **Tests**: `apps/backend/tests/` (unit, `*.integration.test.ts`,
  `isolation.spec.ts` the tenant-isolation gate, `e2e/harness.ts`),
  `apps/admin/e2e/` (README explains the compiled-out test session seam).
- **Decisions and rulings the code cites by name** (D1, R4, O9, P7, L-3,
  ENG-5, …): docs/PLAN.md §11.

## Vocabulary

The full domain rules are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §6.

- `workspace` in code = **Site** in the UI = one website.
- A lead's `status` is the form's lifecycle (`incomplete` → `submitted`); its
  `stage` is where staff are working it. `lead_type` names the form
  (`sim_order`, `internet`, `mobility`, `partner_application`,
  `contact_message`); labels, stages, **allowed moves** and **gates** per type
  are in `leadTypeCatalog` (`packages/contracts/src/lead-types.ts`).
- A **property** is one field of a lead, built-in (`leadPropertyCatalog`) or
  **custom** (`custom_<snake>`, values in `leads.custom_values`). The
  **catalogue** is what one site resolves to; every screen reads the
  catalogue, never the code list.
- A **plan** is something a site sells for one order lead type. An order
  lead's **order details** hold its plan link, the **frozen plan** (a
  snapshot taken at submission), quantity, payment status, carrier
  commission and the dispatch and activation details. Payment and commission
  are order details, never stages.
- The **documents check** needs the frozen plan's required documents
  approved before a gated move; the **override** (`order.override`, with a
  reason) moves on without them.
- To **archive** a lead is to soft-delete it. `/trash` routes and
  `view=trash` are still accepted as aliases.
- A **rescued checkout**: the first staff stage move of an incomplete lead
  marks it submitted, unless the move is into a closing stage.
- An **order number** is a SIM order's `MS-<n>`, the lead's `externalRef`,
  from the site's counter.
- A **change request** is a customer's ask, through order tracking, to change
  a SIM order; staff approve or reject it on the lead page. A **held
  document** is a file sent with a pending request.
- A **flow** is an automation: a trigger and steps, with versions and runs.
  Every flow is off until switched on.
- A **task** is a lead's follow-up or a **plain task** with no lead.
- A **card** is Ask AI's signed proposal of one change; nothing is written
  until a person confirms it.
- The **test site** is `intake-check`, used only by the intake check.

## Git

Feature branches (`claude/<topic>`), PR into `main`. CI must be green. Pushing
`main` is a release (Railway builds the backend image, Vercel builds the
admin), so push there only with the owner's say-so; both skip builds when
only docs change. Migrations are applied deliberately
(docs/RUNBOOKS/database.md), not by the deploy. Commit messages explain the
why; one change per commit.
