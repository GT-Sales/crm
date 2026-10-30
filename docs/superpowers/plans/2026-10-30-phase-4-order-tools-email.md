# Phase 4: Order Tools and Customer Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SIM order goes from submitted to activated through allowed stage moves only, with dispatch and activation details as order properties, Delivered and Activated refused until the plan's documents are approved (the owner may override with a recorded reason), a website retry never creates a second lead, and the customer gets branded emails that each site edits, previews, tests and switches on in Settings → Email.

**Architecture:** Everything stays on the lead. Dispatch (`courier`, `trackingNumber`, `dispatchedAt`) and activation (`activatedAt`, `activationNumber`, `activationAccount`) are six more built-in order properties in `leads.order_details`, so the phase 3 property engine shows, filters, sorts and lays them out unchanged. Allowed moves and per-stage gates are data in `leadTypeCatalog`; the staff `PATCH …/leads/:id` checks the move, applies the order fields and the documents check (derived from the frozen plan's `requiredDocuments` and the latest review, never stored) in the locked transaction it already uses. Double-submit protection ports Canadian Plans' scoped key and request fingerprint into `app.idempotency_keys`, claimed in the lead's own transaction. Customer email moves from hard-coded adapter copy to per-site rows (`app.workspace_email_settings`, `app.email_templates`, append-only `app.email_template_versions`), a pure markup parser and one shared layout; the backend renders a message when it queues it (stage move, website submit, staff send, test), the outbox job only sends it, and `email_messages.template_version` records the version.

**Tech Stack:** TypeScript (strict), Zod 4, Express 5, Drizzle + PostgreSQL 17, Next.js 16 + React 19 + Tailwind 4 + shadcn, Vitest 5, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §5.3, §6, §7, §12 phase 4 (“A test SIM order goes from submitted to activated with branded emails; an unapproved document blocks activation.”), §13. Base: `docs/superpowers/plans/2026-10-30-phase-3-plans-stages-archive.md` (`order_details`, `ORDER_PROPERTY_KEYS`, `editOrder`, the frozen plan). Logic ported, not tables, from Canadian Plans (`/home/user/canadianplans-web-app`): `apps/backend/src/orders/{document-prerequisite,transitions,fingerprint}.ts` (with `fingerprint`'s tests), `routes/website.ts` l.225-274, `orders/store.ts` l.151-314, `apps/admin/src/components/orders/order-actions.tsx`, and `apps/site-1/src/emails/components.tsx` as a layout reference only. Out of scope: customer tracking (§8, which sends `tracking_code`), partner commission, changes to corrections, notes and tasks.

**Dependency waves** (2–3 implementers, one worktree each; whoever merges last in a wave re-runs `pnpm --filter @gt-sales/contracts build` for `docs/api/openapi.json`):

| Wave | Tasks                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 1a   | T1 contracts vocabulary ∥ T3 database                                                                                     |
| 1b   | T2 contracts API (T1) ∥ T4 email markup and layout (T1)                                                                   |
| 2a   | T5 idempotent intake (T1, T3) ∥ T6 email store and composer (T3, T4) ∥ T7 moves and documents (T1, T3) ∥ T9 jobs (T1, T3) |
| 2b   | T8 automatic emails (T5, T6, T7)                                                                                          |
| 3    | T10 lead routes (T2, T8) ∥ T11 email routes (T2, T6) ∥ T12 website header (T2, T5)                                        |
| 4    | T13 admin lead page (T10) ∥ T14 admin Settings → Email (T11)                                                              |
| 5    | T15 order-flow test and Playwright → T16 docs → T17 gate, PR, migrations                                                  |

## Global Constraints

- Strict TypeScript, no `any`, no `as`; typecheck, lint, format clean before every commit; every SQL value bound; integration suites on a `_test` database, re-runnable, fixed UUIDs in a range per suite.
- `ENV(n)` below means (database created once with `psql -h localhost -U postgres -c 'create database gt_sales_t<n>_test'`): `TEST_MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gt_sales_t<n>_test MIGRATION_DATABASE_SSL_MODE=disable DB_TEST_ALLOW_DESTRUCTIVE=1 DATABASE_URL=postgresql://app_runtime:local_ci_runtime_password@localhost:5432/gt_sales_t<n>_test DATABASE_SSL_MODE=disable EMAIL_CONTACT_HASH_SECRET=ci-email-contact-hash-secret-0123456789`. Backend filter: `backend`.
- Every new table: `workspace_id`, `tenantPolicy`, `backupReadPolicy`, FORCE RLS and grants in the custom migration; `0013_order_tools` generated, `0014_order_tools_runtime` custom and safe to run twice; paste file `docs/RUNBOOKS/manual/0013-0014-order-tools.sql`; no data migration; never edit an applied migration. Contracts hold every schema and the endpoint registry.
- `sim_order` moves: incomplete→pending|cancelled; pending→verified|on_hold|cancelled; verified→delivered|on_hold|cancelled; on_hold→pending|verified|cancelled; delivered→activated|on_hold|cancelled; activated→completed|cancelled; completed→none; cancelled→pending. Every other type `'any'`. From a stage the type does not list, any listed stage. Gates: `sim_order` delivered = dispatch + documents, activated = activation + documents; `mobility` activated = activation + documents.
- Order fields: `courier` 1–120, `trackingNumber` 1–120, `activationNumber` 1–40, `activationAccount` 1–80 (trimmed); `dispatchedAt`, `activatedAt` calendar dates defaulting to today in `America/Toronto`; override reason 1–2000. None sensitive; the timeline names keys, never values.
- Documents check: each type in the frozen plan's `requiredDocuments` needs a lead file (`record_type 'lead'`, `status 'available'`, not superseded, not an identity licence photo, the same set the lead page lists) whose latest review (`created_at desc, id desc`) is `approved`; no frozen plan means nothing is required. Override: action `order.override`, owner role only, no individual permission; review stays `order.manage`.
- Idempotency: optional `Idempotency-Key`, `z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/)`; scope `lead_submission`; stored as sha256 hex; fingerprint `sha256:<hex>` of canonical JSON; replay window 24 h from `created_at`; pruned after 7 days.
- Email: templates `tracking_code, order_received, information_needed, dispatched, activated, cancelled, sim_number_ready`; subject 1–150, body 1–5000; fill-ins exactly `{first name}`, `{last name}`, `{site name}`, `{plan}`, `{price}`, `{SIM number}`, `{courier}`, `{tracking number}`, `{tracking link}`, `{code}`; brand colour `#rrggbb`, default `#d72638`; from name 1–80; footer 0–500; every automatic email off until the owner switches it on (spec §15); `sim_number_ready` starts on.
- Privacy: no PII in logs, audit or timeline beyond today's (template keys, versions, job ids, field keys only); an address outside the job payload only as `hashContact`; preview uses sample values, never a lead; the admin shows preview HTML in `<iframe sandbox="" srcDoc>`; the raw idempotency key is never logged or stored.
- Admin copy in sentence case, every control labelled, keyboard-usable. Commit trailers as in phase 3 (the model that wrote the commit, plus the `Claude-Session:` line).

## Review Focus

1. **The website retries a submit after a network drop, sometimes twice at once, with the same `Idempotency-Key`.** Expected: one lead, one `order_received` job; each retry answers the first status with the same lead and `replayed: true`; the key with a changed body answers `409 idempotency_conflict`. Tests in Task 5 (two concurrent `createLead`) and Task 12.
2. **The deploy lands before the owner fills Settings → Email.** Expected: a site with only an `EMAIL_SENDERS_JSON` entry still sends `sim_number_ready` (starter, version 0, env sender); automatic emails stay off; a site with no sender at all reports `emailSkipped` `no_sender` only for a template its owner switched on. Tests in Task 6 and Task 8.
3. **A legacy SIM order (no frozen plan, or a plan with no required documents) is moved to Delivered.** Expected: the documents check passes, the courier is still required, nothing throws. Test in Task 7.
4. **A document is approved, then replaced by a new upload or rejected later.** Expected: the replaced file no longer counts and a later rejection blocks; Activated answers `documents_incomplete` naming it. Test in Task 7.
5. **An owner types `{First Name}`, `{tracking nmber}` or `{courier}` in a template that cannot use it; a customer is named `<b>Ann</b> & co`.** Expected: case and spacing are forgiven; the misspelt and the disallowed fill-ins are refused on save and in preview (`400 invalid_fill_in` naming it); the name is escaped in HTML and plain in text. Tests in Task 4 and Task 11.

---

### Task 1: Contracts: moves and gates, dispatch and activation fields, email vocabulary, timeline entries, error codes

Wave 1a. Model: hard.

**Files:**

- Modify: `packages/contracts/src/lead-types.ts`, `plans.ts`, `properties.ts`, `property-layouts.ts`, `lead-work.ts`, `files.ts`, `common.ts`, `index.ts`; `apps/backend/src/leads/order.ts` (`toLeadOrder` reads the seven new keys field by field, `null` fallback)
- Create: `packages/contracts/src/customer-email.ts`
- Test: `packages/contracts/src/stage-moves.test.ts`, `customer-email.test.ts`; update `plans.test.ts`, `properties.test.ts`, `schemas.test.ts`
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// lead-types.ts
export type StageGate = 'dispatch' | 'activation' | 'documents';
interface LeadTypeCatalogEntry { …; readonly moves: Readonly<Record<string, readonly string[]>> | 'any'; readonly gates?: Readonly<Record<string, readonly StageGate[]>> }
export function allowedStageMoves(leadType: string, from: string): readonly string[]; // catalogue order, never `from`
export function isStageMoveAllowed(leadType: string, from: string, to: string): boolean;
export function stageGates(leadType: string, to: string): readonly StageGate[];
// plans.ts
export const courierSchema, trackingNumberSchema /* trim 1–120 */, activationNumberSchema /* 1–40 */, activationAccountSchema /* 1–80 */;
export const orderDateSchema = z.string().refine(isCalendarDate);
export const documentsOverrideReasonSchema = z.string().trim().min(1).max(2000);
export const documentsOverrideSchema = z.object({ reason: documentsOverrideReasonSchema, missing: z.array(documentChecklistKeySchema).min(1).max(16), at: isoDateTimeSchema }).strict();
leadOrderSchema += { courier, trackingNumber, dispatchedAt, activatedAt, activationNumber, activationAccount, documentsOverride: <schema>.nullable() }; DEFAULT_LEAD_ORDER += the seven as null
leadOrderEditSchema += the six as <schema>.nullable().optional()   // documentsOverride is never a staff edit
// properties.ts — appended to ORDER_PROPERTY_KEYS, orderPropertyCatalog and ORDER_STORAGE_KEYS (identity mapping):
courier {label 'Courier', kind 'text', maxLength 120}, trackingNumber {'Tracking number','text',120}, dispatchedAt {'Dispatched on','date'}, activatedAt {'Activated on','date'}, activationNumber {'Activation number','text',40}, activationAccount {'Activation account','text',80}
// customer-email.ts
export const CUSTOMER_EMAIL_TEMPLATES = ['tracking_code','order_received','information_needed','dispatched','activated','cancelled','sim_number_ready'] as const;
export const customerEmailTemplateSchema = z.enum(CUSTOMER_EMAIL_TEMPLATES); // lead-work.ts re-exports it
export const CUSTOMER_EMAIL_TEMPLATE_LABELS: Readonly<Record<CustomerEmailTemplate, string>>; // 'Tracking code' … 'SIM number ready'
export const EMAIL_FILL_IN_KEYS = ['first name','last name','site name','plan','price','SIM number','courier','tracking number','tracking link','code'] as const;
export interface EmailFillIn { readonly key: EmailFillInKey; readonly hint: string; readonly templates: readonly CustomerEmailTemplate[] }
export const emailFillIns: readonly EmailFillIn[];
export function fillInsForTemplate(template: CustomerEmailTemplate): readonly EmailFillInKey[];
export function normalizeFillInName(raw: string): EmailFillInKey | undefined; // case-insensitive, whitespace collapsed
export function automaticEmailForMove(leadType: string, to: string): CustomerEmailTemplate | undefined;
export const DEFAULT_EMAIL_BRAND_COLOR = '#d72638';
export const emailSubjectSchema /* trim 1–150 */, emailBodySchema /* trim 1–5000 */;
export const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((v) => v.toLowerCase());
export const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(2048);
export const CUSTOMER_EMAIL_JOB_TYPE = 'lead_customer_email';
export const customerEmailJobPayloadSchema = z.object({ leadId: z.uuid().optional() /* absent for a test */, template: customerEmailTemplateSchema, templateVersion: z.int().min(0), toAddress: z.email(), contactHash: z.string().min(1), sender: z.object({ fromName: z.string().min(1).max(100), fromAddress: z.email(), replyToAddress: z.email().optional() }).strict(), rendered: z.object({ subject: z.string().min(1).max(300), html: z.string().min(1).max(200_000), text: z.string().min(1).max(50_000) }).strict(), test: z.literal(true).optional() }).strict();
```

Values: fill-in templates — `first name`, `last name`, `plan`, `price`, `tracking link`: all but `tracking_code`; `site name`: all; `SIM number`: `sim_number_ready`, `dispatched`, `activated`; `courier`, `tracking number`: `dispatched`; `code`: `tracking_code`. `automaticEmailForMove` (order types only): on_hold→`information_needed`, delivered→`dispatched`, activated→`activated`, cancelled→`cancelled`. Timeline (`leadActivitySchema`): new member `{ kind: 'document', fileId, documentType: documentChecklistKeySchema, decision: 'approved' | 'rejected' }` (the review note is not copied); `system.event` gains `documents_override` with `missing?` and `reason?`; `system` gains `automatic?: true` and `templateVersion?: int ≥ 0`. `queueCustomerEmailRequestSchema.template` becomes `z.literal('sim_number_ready')`. `leadDocumentSchema` gains `review: { decision, at } | null` (`.default(null)`). `domainErrorCodeSchema` gains `illegal_stage_move`, `activation_details_required`, `documents_override_not_allowed`, `idempotency_in_progress`, `invalid_fill_in`, `invalid_email_markup`, `email_template_disabled` (existing `dispatch_details_required`, `documents_incomplete`, `document_override_reason_required`, `idempotency_conflict` are reused). `defaultPropertyLayout`'s `order` section lists the ten keys (a stored phase 3 layout shows the six under “Other”, the existing rule).

- [ ] **Step 1: Write the failing tests.** `stage-moves.test.ts`: `test.each` over the eight `sim_order` stages, `allowedStageMoves` equals the Global Constraints list (`completed` → `[]`); `isStageMoveAllowed('sim_order','pending','delivered')` false; `allowedStageMoves('internet','new')` is the other eight stages; `allowedStageMoves('sim_order','paid')` all eight; `stageGates` for `('sim_order','delivered')` `['dispatch','documents']`, `('sim_order','activated')` and `('mobility','activated')` `['activation','documents']`, `('internet','installed')` `[]`. `customer-email.test.ts`: `fillInsForTemplate('tracking_code')` equals `['site name','code']`; `cancelled` has no `courier`; `normalizeFillInName(' First  Name ')` `'first name'`, `('sim number')` `'SIM number'`, `('tracking nmber')` undefined; `automaticEmailForMove('contact_message','closed')` undefined; `brandColorSchema.parse('#D72638')` `'#d72638'`; `httpsUrlSchema` refuses `http:` and `javascript:`; the job payload refuses an extra key and `templateVersion: -1`. `plans.test.ts`: `leadOrderSchema` accepts `DEFAULT_LEAD_ORDER`, refuses `courier: ''`, a 121-character courier, `dispatchedAt: '2026-02-30'`; `leadOrderEditSchema` accepts `{ courier: null }`, refuses `documentsOverride`. `properties.test.ts`: `forType('sim_order')` ends its order keys with the six; `filterable('sim_order')` gives `dispatchedAt` date operators. `schemas.test.ts`: a `document` and a `documents_override` activity parse; a document without `review` parses to `review: null`.
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- stage-moves customer-email plans properties schemas` → FAIL.
- [ ] **Step 3: Implement**, `pnpm --filter @gt-sales/contracts build`; fix compile errors elsewhere only where a `LeadOrder` literal lacks the new keys (spread `DEFAULT_LEAD_ORDER`).
- [ ] **Step 4: Run** the contracts suite and `pnpm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): stage moves and gates, dispatch and activation fields, customer email vocabulary`

---

### Task 2: Contracts: API shapes and endpoints

Wave 1b (after Task 1). Model: easy.

**Files:**

- Modify: `packages/contracts/src/lead-work.ts`, `workspace-leads.ts`, `leads.ts`, `customer-email.ts`, `endpoints.ts` (`HttpMethod` gains `'PUT'`), `openapi.ts`, `client.ts`, `index.ts`; `apps/backend/src/routes/staff.ts` (PATCH response gains `allowedMoves: allowedStageMoves(lead.leadType, lead.stage)`, one line)
- Test: `packages/contracts/src/openapi.test.ts`, `customer-email.test.ts`, `schemas.test.ts`, the client test
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// lead-work.ts
updateWorkspaceLeadRequestSchema += { documentsOverrideReason: z.string().max(2000).optional() } // refine: only with `stage`
export const emailSkippedSchema = z.object({ template: customerEmailTemplateSchema, reason: z.enum(['no_sender','no_customer_email','missing_fill_in']), missing: z.array(z.enum(EMAIL_FILL_IN_KEYS)).optional() });
updateWorkspaceLeadResponseSchema += { allowedMoves: z.array(leadStageSchema), emailSkipped: emailSkippedSchema.optional() }
getWorkspaceLeadResponseSchema += { allowedMoves: z.array(leadStageSchema).default([]) }
leadAccessSchema += { reviewDocuments?: boolean /* order.manage */, overrideDocuments?: boolean /* order.override */ }
// leads.ts
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'; export const idempotencyKeySchema;
createLeadResponseSchema, updateLeadResponseSchema += { replayed: z.literal(true).optional() }
// customer-email.ts
export const emailSettingsSchema = z.object({ fromName: z.string().trim().min(1).max(80), fromAddress: z.email().max(254), replyTo: z.email().max(254).nullable(), logoUrl: httpsUrlSchema.nullable(), brandColor: brandColorSchema, footerText: z.string().trim().max(500), siteUrl: httpsUrlSchema.nullable(), updatedAt: isoDateTimeSchema, updatedBy: z.uuid() });
export const updateEmailSettingsRequestSchema = emailSettingsSchema.omit({ updatedAt: true, updatedBy: true }).extend({ brandColor: brandColorSchema.default(DEFAULT_EMAIL_BRAND_COLOR), footerText: z.string().trim().max(500).default('') }).strict();
export const emailSettingsResponseSchema = z.object({ settings: emailSettingsSchema.nullable(), fallback: z.object({ fromName: z.string(), fromAddress: z.email(), siteUrl: z.url().nullable() }).nullable() /* EMAIL_SENDERS_JSON while unsaved */, requestId });
export const emailTemplateSchema = z.object({ key: customerEmailTemplateSchema, enabled: z.boolean(), subject: emailSubjectSchema, body: emailBodySchema, version: z.int().min(0) /* 0 = starter */, updatedAt: isoDateTimeSchema.nullable(), updatedBy: z.uuid().nullable() });
export const listEmailTemplatesResponseSchema = z.object({ templates: z.array(emailTemplateSchema).length(7), requestId });
export const updateEmailTemplateRequestSchema = z.object({ expectedVersion: z.int().min(0), enabled: z.boolean(), subject: emailSubjectSchema, body: emailBodySchema }).strict();
export const emailTemplateResponseSchema = z.object({ template: emailTemplateSchema, requestId });
export const previewEmailTemplateRequestSchema = z.object({ subject: emailSubjectSchema, body: emailBodySchema }).strict();
export const previewEmailTemplateResponseSchema = z.object({ subject: z.string(), html: z.string(), text: z.string(), requestId });
export const sendTestEmailResponseSchema = z.object({ queued: z.boolean(), requestId });
```

Endpoints under `/api/v1/staff/workspaces/{workspaceId}`: `getEmailSettings` GET `/email/settings`, `updateEmailSettings` PUT `/email/settings`, `listEmailTemplates` GET `/email/templates`, `updateEmailTemplate` PUT `/email/templates/{key}`, `previewEmailTemplate` POST `/email/templates/{key}/preview` (200), `sendTestEmail` POST `/email/templates/{key}/test` (202). Website `createLead` and `updateLead` add the header `{ name: 'Idempotency-Key', required: false, description: 'Optional; with submit, a retry with the same key and body within 24 hours returns the lead already created (replayed: true).' }`. Client methods with those names; `client.website.leads.create(body, { idempotencyKey? })` and `.update(…, { idempotencyKey? })` send the header only when given.

- [ ] **Step 1: Write the failing tests** (the six operation ids with methods and success codes, `updateEmailSettings` is `put`; `createLead` documents the optional header; settings request defaults colour and footer, refuses an `http:` logo and an 81-character name; template request refuses a 151-character subject; `documentsOverrideReason` without `stage` refused; `idempotencyKeySchema` refuses `short` and `a b c d e f`, accepts `cp_9f2c:retry.1`; the client sends the header only when given).
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- openapi customer-email schemas client` → FAIL.
- [ ] **Step 3: Implement**, `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the contracts suite, `pnpm run typecheck`, `pnpm --filter backend test -- lead-work-routes` → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): email settings and template endpoints, idempotency header, stage move responses`

---

### Task 3: Database: 0013 and 0014

Wave 1a. Model: hard.

**Files:**

- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0013_order_tools.sql` (`pnpm --filter @gt-sales/db db:generate -- --name order_tools`), `0014_order_tools_runtime.sql` (`--custom --name order_tools_runtime`), journal entries, `docs/RUNBOOKS/manual/0013-0014-order-tools.sql`
- Modify: `docs/RUNBOOKS/database.md` (two sections, “not yet applied”)
- Test: `packages/db/tests/order-tools.integration.test.ts`; update `apps/backend/tests/operational-retention.integration.test.ts`

**Interfaces (exact columns):**

- `idempotency_keys`: `id uuid pk`, `workspace_id → workspaces cascade`, `scope text` check `in ('lead_submission')`, `key_hash text` check `~ '^[0-9a-f]{64}$'`, `request_fingerprint text` check `~ '^sha256:[0-9a-f]{64}$'`, `lead_id uuid` (FK `(workspace_id, lead_id)` → leads, cascade), `status text default 'pending'` check `in ('pending','completed')`, `completed_at`, `created_at`; check `(status = 'completed') = (completed_at is not null and lead_id is not null)`; unique `idempotency_keys_scope_key_unique (workspace_id, scope, key_hash)`; index `(workspace_id, created_at)`.
- `workspace_email_settings`: `workspace_id uuid pk → workspaces cascade`, `from_name` (1–80 trimmed), `from_address` (≤ 254, `~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'`), `reply_to` (nullable, same), `logo_url` (nullable, `~ '^https://'`, ≤ 2048), `brand_color text not null default '#d72638'` check `~ '^#[0-9a-f]{6}$'`, `footer_text text not null default ''` (≤ 500), `site_url` (as `logo_url`), `updated_by uuid not null`, `updated_at`.
- `email_templates`: `id uuid pk`, `workspace_id`, `key` check in the seven, `enabled boolean not null default false`, `subject` (1–150), `body` (1–5000), `version integer` check `> 0`, `updated_by uuid not null`, `updated_at`; unique `(workspace_id, key)`.
- `email_template_versions`: `id uuid pk`, `workspace_id`, `key`, `version` (`> 0`), `subject`, `body` (same checks), `created_by uuid not null`, `created_at`; unique `(workspace_id, key, version)`.
- `email_messages.template_version integer` nullable, check `is null or >= 0`.
- The four: `tenantPolicy`, `backupReadPolicy`, `.enableRLS()` (backup read policies 29 → 33). 0014: FORCE RLS on the four; `GRANT SELECT, INSERT, UPDATE` on the first three, `SELECT, INSERT` on `email_template_versions`; `CREATE OR REPLACE FUNCTION app.prune_operational_rows` = the 0001 body plus a block deleting `idempotency_keys` with `created_at < p_now - interval '7 days'` (`LIMIT 1000`, `table_name 'idempotency_keys'`), then the same `REVOKE`/`GRANT EXECUTE`.
- Paste file as `0011-0012-plans.sql`: header with hashes and journal `when` values; **A** pre-check (four `to_regclass` null, no `template_version`, 0 tracker rows); `BEGIN` … both files verbatim and the four tracker rows … `COMMIT`; seven verification selects: (1) the four forced; (2) their eight policies; (3) 33 backup read policies; (4) `has_table_privilege` per table and verb (no DELETE anywhere, no UPDATE on versions; `backup_reader` select); (5) the nullable column; (6) the prune function's `prosrc` names `idempotency_keys`; (7) both Drizzle rows.

- [ ] **Step 1: Write the failing tests** (RLS and FORCE on the four; no rows across sites; `app_runtime` cannot DELETE any or UPDATE versions; one key per site and scope, the same hash on two sites allowed; `completed` without `lead_id` refused; an `http://` logo, `#D72638` and an 81-character name refused; key `order_status` refused; versions unique per key; `template_version` −1 refused; 0014's statements re-run in a rolled-back transaction succeed. Retention: a key created 8 days ago pruned, 6 days ago kept, `idempotency_keys` listed.)
- [ ] **Step 2: Run** `ENV(3) pnpm --filter @gt-sales/db test -- order-tools` → FAIL.
- [ ] **Step 3: Implement** (schema, generate, the custom file, paste file with `sha256sum` of each file, runbook sections).
- [ ] **Step 4: Run** `ENV(3) pnpm --filter @gt-sales/db test` and `ENV(3) pnpm --filter backend test -- operational-retention rls isolation backup-reader` → PASS.
- [ ] **Step 5: Commit** — `feat(db): idempotency keys, email settings and templates, template version on messages (0013, 0014)`

---

### Task 4: Backend: email markup, shared layout, starter texts, fill-in values (pure)

Wave 1b (after Task 1). Model: hard.

**Files:**

- Create: `apps/backend/src/email/markup.ts`, `layout.ts`, `starters.ts`, `fill-in-values.ts`
- Test: `apps/backend/tests/email-markup.test.ts`, `email-layout.test.ts`, `email-starters.test.ts`

**Interfaces (Produces):**

```ts
// markup.ts
export type EmailHref = { kind: 'url'; url: string } | { kind: 'fillIn'; key: 'tracking link' };
export type EmailInline =
  | { kind: 'text'; text: string }
  | { kind: 'fillIn'; key: EmailFillInKey }
  | { kind: 'bold'; children: readonly EmailInline[] }
  | { kind: 'link'; label: readonly EmailInline[]; href: EmailHref }
  | { kind: 'break' };
export type EmailBlock =
  | { kind: 'paragraph'; inlines: readonly EmailInline[] }
  | { kind: 'button'; label: string; href: EmailHref };
export type MarkupError =
  | { error: 'invalid_fill_in'; fillIn: string; where: 'subject' | 'body' }
  | { error: 'invalid_email_markup'; reason: 'two_buttons' | 'button_not_alone' | 'bad_link' };
export function parseEmailBody(
  body: string,
  template: CustomerEmailTemplate,
): { ok: true; blocks: EmailBlock[] } | ({ ok: false } & MarkupError);
export function parseEmailSubject(
  subject: string,
  template: CustomerEmailTemplate,
):
  | {
      ok: true;
      parts: Array<{ kind: 'text'; text: string } | { kind: 'fillIn'; key: EmailFillInKey }>;
    }
  | ({ ok: false } & MarkupError);
// layout.ts
export interface EmailBranding {
  siteName: string;
  logoUrl: string | null;
  brandColor: string;
  footerText: string;
}
export type FillInValues = Partial<Record<EmailFillInKey, string>>;
export type RenderedEmail =
  | { ok: true; subject: string; html: string; text: string }
  | { ok: false; missing: EmailFillInKey[] }
  | ({ ok: false } & MarkupError);
export function renderCustomerEmail(input: {
  template: CustomerEmailTemplate;
  subject: string;
  body: string;
  branding: EmailBranding;
  values: FillInValues;
}): RenderedEmail;
// starters.ts
export const STARTER_TEMPLATES: Readonly<
  Record<CustomerEmailTemplate, { enabled: boolean; subject: string; body: string }>
>;
// fill-in-values.ts
export interface FillInLead {
  fullName: string | null;
  form: Readonly<Record<string, unknown>>;
  order: LeadOrder | null;
}
export function fillInValuesForLead(
  lead: FillInLead,
  site: { siteName: string; siteUrl: string | null },
): FillInValues;
export function sampleFillInValues(site: {
  siteName: string;
  siteUrl: string | null;
}): FillInValues;
export function formatPlanPrice(plan: Pick<PlanSnapshot, 'priceMinor' | 'billingPeriod'>): string;
```

Markup: paragraphs split on blank lines; a single newline is a `break`; `**…**` bold (unclosed stays literal); `[label](url)` a link; `[button: Label](url)` the one button, alone in its paragraph (`button_not_alone`; a second is `two_buttons`); a URL is an `http(s)://` literal (else `bad_link`) or exactly `{tracking link}`; `{…}` resolves through `normalizeFillInName` and must be in `fillInsForTemplate(template)` (else `invalid_fill_in` naming the text inside the braces); a `{` with no `}` on its line is literal; the subject takes fill-ins only. Rendering: every text and value HTML-escaped; a blank or absent value is collected into `missing` (subject first, first-use order) and nothing renders; HTML is one table layout (`max-width:560px`, Arial): header `<img src alt=siteName height="40">` or the site name, the blocks, the button `background:<brandColor>;color:#ffffff;padding:10px 18px;border-radius:8px`, a footer of `footerText` (newlines `<br>`) in `#6b6359` 12 px; text part from the same blocks (link `label (url)`, button `Label: url`), then `--` and the footer or site name. Values: `first name` = `form.firstName` or the first word of `fullName`; `last name` = `form.lastName` or the rest of `fullName`; `plan` = the frozen plan's name, else `form.planLabel`; `price` = `formatPlanPrice` (`$40.00/month`; suffixes `''`, `/month`, `/30 days`, `/90 days`, `/year`; `en-CA` CAD); `SIM number` = `form.simNumber`; `courier`, `tracking number` from the order; `tracking link` = `${siteUrl}/track` when set; `code` never from a lead. Samples: Nadia, Khan, the site name, Rogers 60GB, $40.00/month, +1 647 555 0123, Canada Post, LX123456789CA, `${siteUrl ?? 'https://example.com'}/track`, 483920. Starters: plain and short; `sim_number_ready` keeps the message of today's `renderSimNumberReady` (`packages/adapters/src/messaging.ts`) using only `{first name}` and `{SIM number}`; `dispatched` names `{courier}`, `{tracking number}` and a `[button: Track your order]({tracking link})`.

- [ ] **Step 1: Write the failing tests.** Markup: paragraphs and a break; bold; unclosed `**` literal; link and button; two buttons → `two_buttons`; `See [button: A](https://a.test) now` → `button_not_alone`; `[x](javascript:alert(1))` → `bad_link`; `[x]({tracking link})` accepted; `{First  Name}` → `first name`; `{tracking nmber}` → `invalid_fill_in`, `fillIn: 'tracking nmber'`; `{courier}` in `cancelled` refused; `{code}` in `tracking_code` accepted; `{ oops` literal. Layout: `<b>Ann</b> & co` → `&lt;b&gt;Ann&lt;/b&gt; &amp; co` in HTML, raw in text; the button carries the brand colour; logo or site name; footer lines; no `tracking number` value → `{ ok: false, missing: ['tracking number'] }`; the subject is filled and never escaped; `formatPlanPrice({ priceMinor: 4000, billingPeriod: 'month' })` `$40.00/month`. Starters: `test.each` over the seven — parses for its template, renders with samples, fits the limits, `enabled` only for `sim_number_ready`; `sim_number_ready` renders with only `first name` and `SIM number`.
- [ ] **Step 2: Run** `pnpm --filter backend test -- email-markup email-layout email-starters` → FAIL.
- [ ] **Step 3: Implement** (no database, no environment reads).
- [ ] **Step 4: Run** → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): customer email markup, shared layout and starter texts`

---

### Task 5: Backend: double-submit protection in the lead store

Wave 2a. Model: hard.

**Files:**

- Create: `apps/backend/src/leads/idempotency.ts`
- Modify: `apps/backend/src/leads/store.ts`
- Test: `apps/backend/tests/idempotency.test.ts`, `lead-idempotency.integration.test.ts`

**Interfaces (Produces):**

```ts
export const IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export function requestFingerprint(value: unknown): string; // 'sha256:<hex>', CP's canonicalize
export function idempotencyKeyHash(key: string): string;
export interface IdempotencyInput { keyHash: string; fingerprint: string }
export type IdempotencyClaim = { kind: 'claimed'; id: string } | { kind: 'replay'; leadId: string } | { kind: 'conflict' } | { kind: 'in_progress' };
export async function claimIdempotencyKey(tx: TenantTransaction, input: IdempotencyInput & { workspaceId: string; now: Date }): Promise<IdempotencyClaim>;
export async function completeIdempotencyKey(tx: TenantTransaction, input: { workspaceId: string; id: string; leadId: string; now: Date }): Promise<void>;
export class IdempotencyError extends Error { constructor(readonly code: 'idempotency_conflict' | 'idempotency_in_progress') }
// store.ts
CreateLeadInput += { idempotency?: IdempotencyInput }; CreateLeadResult += { replayed: boolean }   // createLead throws IdempotencyError
UpdateLeadInput += { idempotency?: IdempotencyInput }   // honoured only with submit: true
UpdateLeadOutcome: 'updated' gains replayed?: true; += { status: 'idempotency_conflict' } | { status: 'idempotency_in_progress' }
```

Claim (scope `lead_submission`): `insert … on conflict do nothing returning id` → `claimed`; else read the row `for update`: older than the window → reset it (new fingerprint, `pending`, `lead_id`/`completed_at` null, `created_at` now) → `claimed`; other fingerprint → `conflict`; `completed` → `replay`; `pending` → `in_progress`. Claim and completion run inside the lead's transaction, so a concurrent duplicate waits on the unique index and reads the committed row. Replay of `createLead`: the existing lead's summary, `grant: null` when it was created submitted, a fresh draft grant when it is still an `incomplete` draft (the first token is never stored); nothing written. Replay of a submitting `updateLead`: the grant must match the lead (else `grant_invalid`), the row's `lead_id` must equal `leadId` (else conflict), then the summary with `replayed: true` instead of `draft_submitted`.

- [ ] **Step 1: Write the failing tests.** Unit: key order and `undefined` members do not change the fingerprint; `NaN` throws; the hash is 64 hex. Integration (`…-0000000005xx`): a submitted create, then the same key and body → one lead, `replayed: true`, `grant: null`, one `lead.created` audit; changed body → `idempotency_conflict`; **two concurrent `createLead` with one key → one lead row, one `replayed: false`, one `replayed: true`**; a draft create replayed → a new working grant for the same lead; a submitting `updateLead` replayed → `replayed: true`, plan frozen once; the key on another lead's PATCH → conflict; a row back-dated 25 h → a new lead; one key on two sites → two leads; no key → as before.
- [ ] **Step 2: Run** `ENV(5) pnpm --filter backend test -- idempotency lead-idempotency` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `leads-store lead-order` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): idempotent website submission with a scoped key and request fingerprint`

---

### Task 6: Backend: site email settings, versioned templates, sender, composer, queue

Wave 2a. Model: hard.

**Files:**

- Create: `apps/backend/src/email/settings-store.ts`, `compose.ts`, `queue.ts`
- Modify: `apps/backend/src/email/senders.ts`, `apps/backend/src/routes/staff.ts` (dependency type `customerEmail: CustomerEmail`; existing calls `await …available({ workspaceId, actorId })`), `apps/backend/src/app.ts`
- Test: `apps/backend/tests/email-settings-store.integration.test.ts`, `email-compose.integration.test.ts`; update `customer-email.test.ts`

**Interfaces (Produces):**

```ts
// settings-store.ts
export interface StoredEmailSettings {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  logoUrl: string | null;
  brandColor: string;
  footerText: string;
  siteUrl: string | null;
  updatedAt: Date;
  updatedBy: string;
}
export interface StoredEmailTemplate {
  key: CustomerEmailTemplate;
  enabled: boolean;
  subject: string;
  body: string;
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}
export async function readEmailSettings(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<StoredEmailSettings | undefined>;
export async function readEmailTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: CustomerEmailTemplate,
): Promise<StoredEmailTemplate>; // starter at version 0 when unsaved
export type PutTemplateOutcome =
  | { kind: 'saved'; template: StoredEmailTemplate }
  | { kind: 'version_conflict' }
  | ({ kind: 'invalid' } & MarkupError);
/** Scope = { workspaceId, actorId }; WriteScope adds requestId (as in work-store.ts; export them from a shared module). */
export interface EmailSettingsStore {
  getSettings(ctx: Scope): Promise<StoredEmailSettings | undefined>;
  putSettings(ctx: WriteScope, input: UpdateEmailSettingsRequest): Promise<StoredEmailSettings>; // audit email.settings_updated
  listTemplates(ctx: Scope): Promise<StoredEmailTemplate[]>; // the seven, CUSTOMER_EMAIL_TEMPLATES order
  putTemplate(
    ctx: WriteScope,
    key: CustomerEmailTemplate,
    input: UpdateEmailTemplateRequest,
  ): Promise<PutTemplateOutcome>; // audit email.template_saved {key, version, enabled}
}
export class DatabaseEmailSettingsStore implements EmailSettingsStore {}
// senders.ts
export interface ResolvedSender {
  sender: { fromName: string; fromAddress: string; replyToAddress?: string };
  branding: EmailBranding;
  siteUrl: string | null;
}
export interface CustomerEmailEnvironment {
  readonly providerReady: boolean;
  contactHash(email: string): string;
  readonly fallbackSenders: EmailSenders;
}
export function customerEmailEnvironmentFromEnv(env?: NodeJS.ProcessEnv): CustomerEmailEnvironment;
export async function resolveSiteSender(
  tx: TenantTransaction,
  environment: CustomerEmailEnvironment,
  workspaceId: string,
): Promise<ResolvedSender | undefined>; // row, else EMAIL_SENDERS_JSON (default colour, no logo, empty footer)
export interface CustomerEmail {
  readonly environment: CustomerEmailEnvironment;
  available(ctx: Scope): Promise<boolean>;
  fallback(workspaceId: string): SiteSender | undefined;
}
export function customerEmailFromEnv(env?: NodeJS.ProcessEnv): CustomerEmail;
// compose.ts
export type ComposeRecipient =
  | { kind: 'lead'; lead: FillInLead & { email: string | null } }
  | { kind: 'staff_test'; toAddress: string };
export type ComposeOutcome =
  | { kind: 'ready'; payload: CustomerEmailJobPayload }
  | { kind: 'disabled' }
  | {
      kind: 'skipped';
      reason: 'no_sender' | 'no_customer_email' | 'missing_fill_in';
      missing?: EmailFillInKey[];
    };
export async function composeCustomerEmail(
  tx: TenantTransaction,
  environment: CustomerEmailEnvironment,
  input: { workspaceId: string; template: CustomerEmailTemplate; recipient: ComposeRecipient },
): Promise<ComposeOutcome>;
// queue.ts
export async function queueComposedEmail(
  tx: TenantTransaction,
  input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    leadId: string | null;
    dedupeKey: string;
    payload: CustomerEmailJobPayload;
    automatic: boolean;
  },
): Promise<{ queued: boolean; jobId: string | null; activity: LeadActivity | null }>;
```

Rules: `putTemplate` takes `pg_advisory_xact_lock(hashtextextended('email_templates:' || workspaceId || ':' || key, 0))`, checks `expectedVersion` against the stored version (0 when none), validates subject and body with Task 4's parsers, upserts with `version + 1` and appends the version row (a switch is a save too). `composeCustomerEmail` for a lead: disabled → `disabled`; provider not ready or no sender → `skipped no_sender`; no valid address → `no_customer_email`; render with `fillInValuesForLead` (site name = the sender's from name) and missing values → `missing_fill_in`; else `ready` (`contactHash`, the version read, sender, rendered message). A staff test ignores `enabled` and uses `sampleFillInValues`. `queueComposedEmail` inserts `outbox_jobs` (`lead_customer_email`, `on conflict do nothing`); when inserted with a `leadId`: timeline `system {event:'customer_emailed', template, templateVersion, automatic?}`, audit `lead.customer_emailed {template, templateVersion, jobId, automatic}`, and for a manual send the lead's `updated_at` (as today); for a test, audit `email.test_sent {template, templateVersion, jobId}` only. `available` = provider ready, secret set, a sender resolves (one tenant transaction).

- [ ] **Step 1: Write the failing tests** (`…-0000000006xx`). Store: no row → `getSettings` undefined and seven starters at version 0, only `sim_number_ready` on; save → version 1 and one version row; again → version 2, two rows, the first unchanged; stale `expectedVersion` → `version_conflict`; `{courier}` in `cancelled` → `invalid` naming it, nothing written; sites independent; the colour lower-cased, one audit row. Compose: **no row but an `EMAIL_SENDERS_JSON` entry → that sender, `sim_number_ready` at version 0**; disabled `dispatched` → `disabled`; no sender → `no_sender`; no email → `no_customer_email`; `{tracking number}` with none → `missing_fill_in ['tracking number']`; saved version 3 → `templateVersion: 3`; the payload parses with `customerEmailJobPayloadSchema`; one dedupe key twice → one job, second `queued: false`; no timeline or audit row holds an address or body.
- [ ] **Step 2: Run** `ENV(6) pnpm --filter backend test -- email-settings-store email-compose customer-email` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): site email settings, versioned templates and the customer email composer`

---

### Task 7: Backend: allowed moves, dispatch and activation details, documents check and override; reviews on the timeline

Wave 2a. Model: hard.

**Files:**

- Create: `apps/backend/src/leads/stage-move.ts` (pure), `apps/backend/src/leads/documents-check.ts`
- Modify: `apps/backend/src/leads/work-store.ts` (`updateLead`, `editOrder`, input and outcome types), `apps/backend/src/documents/store.ts` (`recordReview`), `apps/backend/src/leads/staff-queries.ts` (each document's latest `review`)
- Test: `apps/backend/tests/stage-move.test.ts`, `lead-stage-gate.integration.test.ts`; update `documents-store.integration.test.ts` and any suite that seeds a stage by a now-illegal move (`lead-work-store`, `lead-order`, `lead-custom-values`: walk the allowed path or set it by SQL)

**Interfaces (Produces):**

```ts
// stage-move.ts
export type StageMoveRefusal = { status: 'illegal_stage_move'; from: string; to: string; allowed: readonly string[] } | { status: 'dispatch_details_required' } | { status: 'activation_details_required' };
export type StageMovePlan = { ok: true; gates: readonly StageGate[]; order: LeadOrderEdit | undefined } | { ok: false; refusal: StageMoveRefusal };
export function planStageMove(input: { leadType: string; from: string; to: string; current: LeadOrder; edit: LeadOrderEdit | undefined; today: string }): StageMovePlan;
export function todayInToronto(now: Date): string;
// documents-check.ts
export async function findMissingDocuments(tx: TenantTransaction, input: { workspaceId: string; leadId: string; required: readonly string[] }): Promise<string[]>; // `required` order, deduplicated
// work-store.ts
UpdateLeadWorkInput += { documentsOverrideReason?: string }   // the route admits it only from order.override
UpdateLeadWorkOutcome += StageMoveRefusal | { status: 'documents_incomplete'; missing: string[] } | { status: 'document_override_reason_required' }
```

On a stage change, inside the locked transaction: membership (`invalid_stage`) → `planStageMove` (illegal move; `dispatch` needs a courier in the edit or stored, a blank or null one refused, `dispatchedAt` defaults to today; `activation` refuses only an explicit `activatedAt: null`, else defaults to today) → a reason blank after trim → `document_override_reason_required` → `documents`: `findMissingDocuments` over the frozen plan's `requiredDocuments` → missing without a reason → `documents_incomplete`; with one → proceed and record; nothing missing → the reason is ignored. Then `editOrder` writes the edit with its defaults and, for an override, `order_details.documentsOverride = { reason, missing, at }`; timeline `status_change`, one `edit` naming the changed order keys, `system {event:'documents_override', missing, reason}`; audits `lead.updated` and `lead.documents_overridden` (`after: { from, to, missing, reason }`). Order fields without a stage change are plain order edits. `recordReview`, for a file of `record_type 'lead'` whose lead exists and is not restricted, inserts `document {fileId, documentType, decision}` with the reviewer as actor.

- [ ] **Step 1: Write the failing tests.** Pure: pending→delivered refused with `allowed: ['verified','on_hold','cancelled']`; verified→delivered without a courier → `dispatch_details_required`; with `courier: 'Canada Post'` the edit gains `dispatchedAt` today; a stored courier satisfies it; delivered→activated → `activatedAt` today, `activatedAt: null` → `activation_details_required`; internet any→any with no gates; `todayInToronto(new Date('2026-11-01T03:30:00Z'))` `2026-10-31`. Integration (`…-0000000007xx`, plan requiring `passport` and `visa`): no files → `documents_incomplete ['passport','visa']`; passport approved → `['visa']`; both → delivered, courier and `dispatchedAt` stored, one `status_change`, one `edit` naming `courier, dispatchedAt`; **the approved passport superseded by a new upload → activated refused `['passport']`; approved then rejected → refused**; an identity licence photo does not count; an override → activated, `documentsOverride` stored, a `documents_override` entry, a `lead.documents_overridden` audit; a blank reason refused; **a legacy SIM order with `order_details` `{}` → delivered needs only the courier**; completed→anything refused; cancelled→pending allowed; legacy stage `paid`→pending allowed. Documents store: approve and reject each write one `document` entry on the lead, none for another record type; the lead detail's document carries the latest `review`.
- [ ] **Step 2: Run** `ENV(7) pnpm --filter backend test -- stage-move lead-stage-gate documents-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole backend suite with `ENV(7)` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): allowed stage moves, dispatch and activation details, documents check with owner override`

---

### Task 8: Backend: automatic emails on moves and at submit; `sim_number_ready` through its template

Wave 2b (after Tasks 5, 6, 7). Model: hard.

**Files:**

- Modify: `apps/backend/src/leads/work-store.ts` (constructor `(database?, emailEnvironment?: CustomerEmailEnvironment)`; `updateLead`; `queueCustomerEmail`), `apps/backend/src/leads/store.ts` (same constructor; submit); delete `apps/backend/src/email/customer-emails.ts`
- Test: `apps/backend/tests/automatic-emails.integration.test.ts`; update `lead-work-store.integration.test.ts`

**Interfaces:**

- Consumes: Task 6 `composeCustomerEmail`, `queueComposedEmail`; Task 1 `automaticEmailForMove`; Task 5 replay.
- Produces: `updated` outcome gains `emailSkipped?: EmailSkipped`; `CustomerEmailOutcome` = `{ status: 'queued'; activity } | { status: 'not_found' | 'trashed' | 'no_sender' | 'disabled' } | { status: 'missing'; missing: Array<EmailFillInKey | 'customer email'> }`.

Rules: after a stage change is written, compose `automaticEmailForMove(leadType, to)` from the lead as now stored; `ready` → queue with dedupe `${leadId}:${template}:${statusChangeActivityId}`, `automatic: true` (moving back and forth is a new move and a new mail); `disabled` → nothing; `skipped` → `emailSkipped { template, reason, missing? }`, nothing queued. At website submit of an order type (`createLead` with `submit`, or the submitting `updateLead`), after the freeze: `order_received`, dedupe `${leadId}:order_received:submitted`, actor the website credential; a skip is silent; a replay queues nothing. `queueCustomerEmail` (manual `sim_number_ready`): `disabled` → `disabled`; `no_sender` → `no_sender`; `no_customer_email` → `missing ['customer email']`; `missing_fill_in` → `missing` with the keys; `ready` → dedupe `${leadId}:${requestId}`, `automatic: false`.

- [ ] **Step 1: Write the failing tests** (`…-0000000008xx`, a site with settings and `order_received`, `information_needed`, `dispatched`, `activated`, `cancelled` on): website submit → one `order_received` job at version 1 naming the frozen plan; replayed → still one; template off → none; verified→delivered with courier and tracking → one `dispatched` job containing the tracking number, a `customer_emailed` entry with `automatic` and `templateVersion`; →on_hold→verified→delivered → a second `dispatched` job; a template naming `{tracking number}` with none → move succeeds, no job, `emailSkipped { template: 'dispatched', reason: 'missing_fill_in', missing: ['tracking number'] }`; no email → `no_customer_email`; a site with no sender and `cancelled` on → `no_sender`; a `contact_message` move queues nothing; manual `sim_number_ready`: no SIM number → `missing ['SIM number']`, off → `disabled`, saved version 2 → job at version 2.
- [ ] **Step 2: Run** `ENV(8) pnpm --filter backend test -- automatic-emails lead-work-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole backend suite with `ENV(8)` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): automatic customer emails on stage moves and at submit; SIM number mail from its template`

---

### Task 9: Jobs and adapters: send the pre-rendered message, record its version

Wave 2a. Model: easy.

**Files:**

- Modify: `jobs/src/index.ts` (`outboxJobTypes` gains `'lead_customer_email'`; `customerEmailHandler`), `jobs/package.json` (`@gt-sales/contracts`), `packages/adapters/src/messaging.ts` (`emailTemplates` gains the six new keys; `EmailMessage.sender?: SenderIdentity`, `EmailMessage.rendered?: { subject; html; text }`; `ResendEmailAdapter.send` uses them when present and appends nothing to a rendered text), `apps/backend/src/jobs/providers.ts` (`resendAccountForWorkspace(env, registry, senders, workspaceId, siteSender = false)`), `apps/backend/src/email/store.ts` (`prepareDelivery` writes `template_version`)
- Test: `jobs/tests/customer-email-handler.test.ts`, `packages/adapters/src/messaging.test.ts`, `apps/backend/tests/jobs-providers.test.ts`, `email-store.integration.test.ts`

**Interfaces:** Consumes Task 1's payload schema and Task 3's column. Produces `EmailDeliveryRecorder.prepare` input `+= { templateVersion?: number; siteSender?: boolean }` and `QueueEmailMessageInput += { templateVersion?: number }`.

Handler: payload version 1; parse (else `invalid_job_payload`, permanent); `checkTransactional({ contactHash, leadId })` (suppressed → `skipped:<reason>` as today); `prepare({ template, templateVersion, messageClass: 'transactional', contactHash, leadId, siteSender: true })`; `send({ workspaceId, messageId, template, toAddress, leadId, sender, rendered })`; `recordResult`; no rendering in the job. With `siteSender` the Resend account is the registry's for the site, else `RESEND_ACCOUNT_ID`. `lead_sim_number_email` and its renderer stay for jobs queued before the deploy.

- [ ] **Step 1: Write the failing tests** (handler: sends exactly `rendered` from `sender`, prepares with `templateVersion: 4`; suppressed skips; an extra key or `payloadVersion: 2` fails permanently; Resend with a stubbed fetch: `from` `Name <address>` of the payload's sender, rendered `subject`/`text`/`html`, `Idempotency-Key` unchanged; providers: `lead_customer_email` registered, a site with no env sender and `siteSender` resolves `RESEND_ACCOUNT_ID`; email store: `templateVersion: 2` stored, absent → null).
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/jobs test -- customer-email-handler`, `pnpm --filter @gt-sales/adapters test -- messaging`, `ENV(9) pnpm --filter backend test -- jobs-providers email-store` → FAIL.
- [ ] **Step 3: Implement.** **Step 4:** the same → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(jobs): send pre-rendered customer emails and record the template version`

---

### Task 10: Backend routes: lead PATCH and GET, review, customer email, `order.override`

Wave 3. Model: easy.

**Files:**

- Modify: `apps/backend/src/staff/authorization.ts` (`'order.override'`, owner only, no `permissionActions` entry), `apps/backend/src/routes/staff.ts`, `apps/backend/src/http/domain-errors.ts`
- Test: `apps/backend/tests/lead-work-routes.test.ts`, `customer-email.test.ts`, `documents-route.test.ts`, `authorization.test.ts`

Rules: PATCH passes `documentsOverrideReason`; from an actor without `order.override` → `409 documents_override_not_allowed` before the store; `illegal_stage_move` → 409 `{ from, to, allowed }`; `dispatch_details_required` → 400 `{ field: 'courier' }`; `activation_details_required` → 400 `{ field: 'activatedAt' }`; `documents_incomplete` → 409 `{ missing }`; `document_override_reason_required` → 400; success `{ lead, activities, allowedMoves, emailSkipped?, requestId }`. GET adds `allowedMoves`, `access.reviewDocuments` (`order.manage`), `access.overrideDocuments` (`order.override`), `access.emailCustomer = lead.manage && await customerEmail.available(ctx)`. Customer email: `no_sender` → 409 `feature_not_ready`; `disabled` → 409 `email_template_disabled { template }`; `missing` → 409 `conflict { missing }`. Messages: `illegal_stage_move` “That stage move is not allowed; `details.allowed` lists the moves from this stage.”, `activation_details_required` “An activation date is required to activate this order.”, `documents_override_not_allowed` “Only the site owner can override the documents check.”, `email_template_disabled` “This email is switched off in Settings → Email.”.

- [ ] **Step 1: Write the failing tests** (mocked stores: each outcome's status, code and details; a `leads` member's reason → 409, store not called; an owner's reaches it; GET for `orders` `reviewDocuments: true, overrideDocuments: false`, owner both true; a pending SIM order's `allowedMoves` `['verified','on_hold','cancelled']`; `emailSkipped` passes through; customer email codes; `order.override` allowed for owner, denied for `orders`, no individual permission grants it).
- [ ] **Step 2: Run** `pnpm --filter backend test -- lead-work-routes customer-email documents-route authorization` → FAIL.
- [ ] **Step 3: Implement.** **Step 4:** backend suite (`ENV(10)`), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): stage moves, documents override and email skips on the lead routes`

---

### Task 11: Backend routes: Settings → Email

Wave 3. Model: easy.

**Files:**

- Create: `apps/backend/src/routes/email-settings.ts` (`createEmailSettingsRoutes(dependencies: EmailSettingsRouteDependencies)`, mounted beside `createPlanRoutes` in `app.ts`)
- Modify: `apps/backend/src/app.ts`, `apps/backend/src/http/domain-errors.ts`
- Test: `apps/backend/tests/email-settings-routes.test.ts`

```ts
export interface EmailSettingsRouteDependencies {
  store: EmailSettingsStore;
  customerEmail: CustomerEmail;
  withTenantTx: DatabaseClient['withTenantTx'];
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
}
```

All routes need `integration.manage`. Settings GET/PUT → `{ settings | null, fallback: customerEmail.fallback(ws) ?? null }`. Templates GET → the seven; PUT `:key` → 200, 409 `version_conflict`, 400 `invalid_fill_in { fillIn, where }` / `invalid_email_markup { reason }`; unknown `:key` → 404 `not_found`. Preview renders the posted subject and body with `sampleFillInValues` and the site's branding (row, else env fallback, else “Your site”), never a lead → 200, or 400 on a markup error. Test composes the saved version (`staff_test`, to `actor.verifiedEmail`); no sender or provider → 409 `feature_not_ready`; dedupe `test:${key}:${actorId}:${YYYYMMDDHHmm UTC}` → 202 `{ queued }`.

- [ ] **Step 1: Write the failing tests** (owner allowed, `orders` member 403 on each route; preview of `Hi {first name}` renders `Hi Nadia` and the brand colour; `{tracking nmber}` → 400 naming it; no lead is read; PUT maps each outcome and passes `expectedVersion`; a test send goes to the caller's verified email, `queued: true` then `false` within the minute, 409 with no sender; an `http:` logo → 400).
- [ ] **Step 2: Run** `pnpm --filter backend test -- email-settings-routes` → FAIL.
- [ ] **Step 3: Implement.** **Step 4:** backend suite (`ENV(11)`), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): email settings, template, preview and test routes`

---

### Task 12: Backend routes: `Idempotency-Key` on website submission

Wave 3. Model: easy.

**Files:** Modify `apps/backend/src/routes/website.ts` (`POST /leads`, `PATCH /leads/:leadId`), `apps/backend/src/http/domain-errors.ts`. Test: `apps/backend/tests/leads.test.ts`.

Rules: no header → as today; invalid → 400 `validation_error { field: 'Idempotency-Key' }`; valid → `{ keyHash: idempotencyKeyHash(key), fingerprint: requestFingerprint(body.data) }` (PATCH: `requestFingerprint({ leadId, body: body.data })`, only with `submit: true`); POST 201 and PATCH 200 with `replayed: true` on a replay; `idempotency_conflict` 409; `idempotency_in_progress` 409 with `Retry-After: 2` (“A request with this idempotency key is still being processed. Retry shortly.”).

- [ ] **Step 1: Write the failing tests** (mocked store: deterministic hash and fingerprint, the raw key never passed; replay 201 `replayed: true`; conflict and in-progress 409 with `Retry-After`; malformed key 400; PATCH without `submit` ignores it; the captured logger never holds the key).
- [ ] **Step 2: Run** `pnpm --filter backend test -- leads` → FAIL. **Step 3: Implement.** **Step 4:** backend suite (`ENV(12)`), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): Idempotency-Key on website lead submission`

---

### Task 13: Admin: stage moves and the dispatch/activation dialog, document review, timeline

Wave 4. Model: hard.

**Files:**

- Create: `apps/admin/src/components/leads/stage-move-dialog.tsx`
- Modify: `apps/admin/src/components/leads/lead-record.tsx`, `lead-documents.tsx`, `lead-timeline.tsx`, `leads-board.tsx`, `apps/admin/src/lib/api.ts`
- Test: `stage-move-dialog.test.tsx`, `lead-record.test.tsx`, `lead-documents.test.tsx`, `lead-timeline.test.tsx`, `leads-board.test.tsx`

```ts
export function StageMoveDialog(props: { lead: LeadDetail; to: string; gates: readonly StageGate[]; canOverride: boolean; onMove(body: UpdateWorkspaceLeadRequest): Promise<UpdateWorkspaceLeadResponse>; onDone(result: UpdateWorkspaceLeadResponse): void; onCancel(): void }): JSX.Element;
LeadDocuments props += { canReview: boolean; onReviewed(): Promise<void> }
```

Behaviour: the stage select lists the current stage plus `allowedMoves`. A target with a `dispatch` or `activation` gate (`stageGates`) opens the dialog: Courier (required), Tracking number, Dispatched on (today) — or Activated on (today), Activation number, Activation account — prefilled from `lead.order`; Move sends `{ stage, order }`. On `documents_incomplete` it lists the missing documents by `documentTypeLabel` (“Missing approved documents: Passport, Visa”); with `canOverride` a required “Reason for moving anyway” (≤ 2000) and “Move anyway” resend with `documentsOverrideReason`; without, “Approve the documents first, or ask the site owner.”. `illegal_stage_move` → “That move is not allowed from <stage>.”. Other stages move at once. `emailSkipped`: “The <label> email was not sent: this site has no sender yet (Settings → Email).” / “…: the customer has no email address.” / “…: it needs the <keys>.”. Documents: a badge (Approved, Rejected, Not reviewed) and, with `access.reviewDocuments`, Approve and Reject (`reviewFile`), then the record reloads. Timeline: `document` → “approved the passport”; `documents_override` → “moved on without approved documents: Passport. Reason: …”; automatic `customer_emailed` → “<label> email queued automatically (version n)”. Board: a drop on a gated stage sends nothing and says “Open the lead to move it to <stage>: it needs details.”; a refused move puts the card back with the reason. SIM number card: `missing` with `SIM number` → “Add the SIM number first.”; `email_template_disabled` → “The SIM number email is switched off in Settings → Email.”. The six order fields show through `PropertySections`.

- [ ] **Step 1: Write the failing tests** (`vi.mock('../../lib/api')`: from Pending the select has no Delivered; Delivered from Verified opens the dialog with today and sends `{ stage: 'delivered', order: { courier: 'Canada Post', trackingNumber: 'LX1', dispatchedAt: <today> } }`; a `documents_incomplete` rejection shows “Passport” and, for an owner, the reason field whose Move anyway sends `documentsOverrideReason`; a non-owner sees none; an `emailSkipped` notice; Approve calls `reviewFile` with `approved`, reloads, badge Approved; the timeline strings; the board refuses a Delivered drop without a request).
- [ ] **Step 2: Run** `pnpm --filter admin test -- stage-move-dialog lead-record lead-documents lead-timeline leads-board` → FAIL.
- [ ] **Step 3: Implement.** **Step 4:** admin suite, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(admin): allowed stage moves, dispatch and activation dialog, document review on the lead`

---

### Task 14: Admin: Settings → Email

Wave 4. Model: hard.

**Files:**

- Create: `apps/admin/src/app/w/[workspace]/settings/email/page.tsx`, `apps/admin/src/components/email/email-settings.tsx`, `template-list.tsx`, `template-editor.tsx`, `use-email-settings.ts`
- Modify: `apps/admin/src/app/w/[workspace]/settings/page.tsx` (link “Email”), `apps/admin/src/lib/api.ts` (the six calls)
- Test: `email-settings.test.tsx`, `template-list.test.tsx`, `template-editor.test.tsx`

```ts
export function useEmailSettings(workspaceId: string | undefined): {
  settings: EmailSettingsResponse | undefined;
  templates: EmailTemplate[];
  reload(): Promise<void>;
  error?: string;
};
export function EmailSettings(props: {
  initial: EmailSettingsResponse;
  onSave(input: UpdateEmailSettingsRequest): Promise<string | undefined>;
}): JSX.Element;
export function TemplateList(props: {
  templates: EmailTemplate[];
  onToggle(template: EmailTemplate, enabled: boolean): Promise<string | undefined>;
  onEdit(key: CustomerEmailTemplate): void;
}): JSX.Element;
export function TemplateEditor(props: {
  template: EmailTemplate;
  preview(input: PreviewEmailTemplateRequest): Promise<PreviewEmailTemplateResponse>;
  onSave(input: UpdateEmailTemplateRequest): Promise<string | undefined>;
  onSendTest(): Promise<string | undefined>;
}): JSX.Element;
```

Behaviour: site form (sender name; sender address, hint “Must be on a domain verified in Resend; send yourself a test to check.”; reply-to; logo URL; brand colour with a swatch; footer; site address) from `settings`, else from `fallback` with “Not saved yet: mail goes out as <name> <address> from the server's configuration.”; the list shows the seven by label with a switch (a toggle saves the current text with `expectedVersion`), the version (“Starter text” for 0) and Edit; the editor has Subject, Body (monospace), the fill-ins of `fillInsForTemplate(key)` with their hints, a markup cheat sheet, a preview 400 ms after typing stops (`<iframe title="Email preview" sandbox="" srcDoc={html}>`, the subject above, a Text tab; a 400 shows “Unknown fill-in {x}” or the markup reason), Save (`version_conflict` → “This email changed elsewhere. Reload and try again.”) and “Send me a test” (“Sent to your address: check your inbox.” / “A test was already sent this minute.”). A 403 shows “Only the site owner can change email settings.”.

- [ ] **Step 1: Write the failing tests** (the colour saved lower-case; the fallback note when `settings` is null; seven rows, SIM number ready on; a toggle sends `enabled: true` with `expectedVersion`; one preview call per burst of typing; the iframe has `sandbox=""`; the 400's fill-in name shown; save sends `expectedVersion` and shows the conflict copy; Send me a test calls `sendTestEmail`; `cancelled`'s help lists no `courier`).
- [ ] **Step 2: Run** `pnpm --filter admin test -- email-settings template-list template-editor` → FAIL.
- [ ] **Step 3: Implement.** **Step 4:** admin suite, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(admin): Settings → Email with templates, live preview and test sends`

---

### Task 15: “Done when”: order-flow integration test, e2e harness, Playwright journey

Wave 5. Model: hard.

**Files:**

- Create: `apps/backend/tests/order-flow.integration.test.ts`
- Modify: `apps/backend/tests/e2e/harness.ts` (Rogers 60GB requires `passport`; a passport file on Nadia Khan's order, inserted with the admin connection as an `available` lead file with every `files` column it needs and no review; Get Canada Sim settings through `DatabaseEmailSettingsStore.putSettings`; `dispatched` and `activated` switched on with their starter text; `process.env.EMAIL_PROVIDER ??= 'fake'` and `process.env.EMAIL_CONTACT_HASH_SECRET ??= 'e2e-email-contact-hash-secret-0123'` before `createApp`), `apps/admin/e2e/leads.spec.ts` (new journey; earlier journeys' stage steps follow the allowed moves)

- [ ] **Step 1: Write the integration test** (`…-0000000015xx`, real stores and the real handler with `FakeEmailAdapter`): settings saved; a plan requiring `passport`; `order_received` saved twice (version 2), `dispatched` and `activated` once and on; the website submits with a key → one `order_received` job at version 2; incomplete→pending→verified; →delivered with no approved passport → `documents_incomplete ['passport']`; approved → delivered with courier and tracking → `dispatched` at version 1; the passport then rejected → →activated `documents_incomplete`; a `leads`-role reason refused at the route (through `createApp` with a stub verifier); the owner's reason → activated, `documentsOverride` stored, `documents_override` on the timeline, `lead.documents_overridden` audited, `activated` at version 1; one outbox run sends three messages and `email_messages.template_version` is 2, 1, 1.
- [ ] **Step 2: Run** `ENV(15) pnpm --filter backend test -- order-flow` → PASS (a failure is a bug in an earlier task: fix it there, with a test).
- [ ] **Step 3: Add the journey** “a SIM order is approved, dispatched and activated with emails, and a template is edited and previewed”: open Nadia Khan's order → from Pending no Delivered option → Verified → Delivered → Courier “Canada Post”, Tracking “LX123456789CA” → Move → “Missing approved documents: Passport” and the owner's reason field → Cancel → Passport “Not reviewed” → Approve → “Approved” → Delivered → the same details → Move → the Order section shows Courier Canada Post, the timeline “Dispatched email queued automatically (version 1)” → Activated → today's date → Move → “Activated email queued automatically” → Settings → Email → Dispatched → Edit → subject “Your order is on its way, {first name}” → the preview shows “Your order is on its way, Nadia” → Save → “Version 2”.
- [ ] **Step 4: Run** `pnpm --filter admin test:e2e:leads` → PASS (all journeys).
- [ ] **Step 5: Commit** — `test: SIM order from submitted to activated with emails and the documents check`

---

### Task 16: Docs

Wave 5. Model: easy.

- Modify: `AGENTS.md` (vocabulary: allowed moves and gates, dispatch and activation details, documents check and override, idempotency key, email settings, templates, versions, fill-ins; where things live: `src/leads/{stage-move,documents-check,idempotency}.ts`, `src/email/`, `src/routes/email-settings.ts`, `components/email/`), `docs/HANDOFF.md` (§2.3 the six email routes, the PATCH's fields and codes, `order.override`; §2.6 `Idempotency-Key` and `replayed`; §3.7 phase 4; §5.1 owner steps: apply 0013/0014, fill Settings → Email per site, send a test, switch each email on only after checking the website sends no duplicate; §5.3: allowed moves done, follow-ups to remove `EMAIL_SENDERS_JSON` and `lead_sim_number_email` in phase 5), `docs/PLAN.md` (§7 status line; §10 owner row for 0013/0014), `docs/ENV.md` (`EMAIL_SENDERS_JSON` is a fallback until a site's Settings → Email is saved; the sender must be on a Resend-verified domain), `docs/RUNBOOKS/legacy-import.md` (the import writes stages directly, outside the allowed moves).
- [ ] **Step 1: Edit, format, commit** — `docs: phase 4 order tools and customer email`

---

### Task 17: Final gate, pull request, migrations, merge

Wave 5. Model: easy.

- [ ] **Step 1:** `pnpm run lint && pnpm run format && pnpm run typecheck`, `ENV(17) pnpm run test`, `pnpm --filter admin test:e2e:leads`, `pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json` → PASS, no diff.
- [ ] **Step 2:** Open the PR (`Order tools and customer email (merge phase 4)`), subscribe, drive CI green.
- [ ] **Step 3: Apply 0013 + 0014 to `xykrphbgpwisqacpyeiv` before merging** (the new backend reads the new tables and `email_messages.template_version`): pre-check A; `BEGIN` … `COMMIT` once from the paste file (or both files verbatim through the Supabase tool with the Drizzle rows in the same sitting); the seven verification selects one at a time; record versions, hashes and results in `docs/RUNBOOKS/database.md` and `docs/HANDOFF.md` §5.1.
- [ ] **Step 4: Deploy in order:** merge; Railway backend deploy and `GET /api/v1/health` green; then the Vercel admin (it reads `allowedMoves` and the email routes). Check live: a Get Canada Sim SIM order offers only its allowed moves; Settings → Email lists seven templates with SIM number ready on; the owner saves the site settings and sends a test to themselves; every automatic email stays off until the owner switches it on.
