# Phase 3: Plans, Stage Clean-up and Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff manage each site's plans in the admin, a website reads them and submits an order against one, the lead keeps a frozen copy of the plan with a quantity, a payment status and a carrier commission status that live outside the stages, no `sim_order` lead is left in an `invoiced` or `paid` stage, and Trash is called Archive.

**Architecture:** A new `app.plans` table holds each site's plans (one order lead type each; built-in columns for name, price in cents, billing period, payment required, active, required documents; custom plan properties through the phase 2 property engine with `object = 'plan'` and a new per-property _show on website_ switch). Order leads gain an `order_details` JSONB column: the plan link, the frozen plan snapshot taken at submission, `quantity`, `paymentStatus` and `carrierCommission`. Those order fields are built-in properties with a third storage, `order`, so the existing catalogue, filters, sorts, columns, layouts and record sections work on them unchanged, and the plan filter's options are the site's plans. `sim_order` loses the `invoiced` and `paid` stages; one data migration moves the 20 live `paid` orders (and anything the Get Canada Sim import would re-create) to a progress stage plus a payment status, and the import script learns the same mapping. Archive is a rename: the API keeps `trash` identifiers as aliases, the admin and docs say Archive. Dispatch, activation, the documents gate, double-submit protection and customer emails stay in phase 4.

**Tech Stack:** TypeScript (strict), Zod 4, Express 5, Drizzle + PostgreSQL 17, Next.js 16 + React 19 + Tailwind 4 + shadcn, Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §2 (decisions 9–14, 18, 29), §5.1, §5.3, §5.4, §5.5, §12 phase 3 (“Staff manage plans; a test website reads them; no lead is left in an `invoiced` or `paid` stage.”), §13, §14. Phase 2 base: `docs/superpowers/plans/2026-10-29-phase-2-properties-layout-views.md` (property engine, `PropertyCatalog`, `storage`, layouts, saved views). Canadian Plans is a reference only for the snapshot idea (`orderSnapshotSchema` in its `workspace-orders.ts`) and `paymentRequired` → `paymentState`; it has no admin-managed plan object, no quantity and no carrier commission, so nothing is copied.

**Production facts (checked 2026-10-30 on `xykrphbgpwisqacpyeiv`):** 912 leads. `sim_order` (Get Canada Sim) by stage: incomplete 12 (+11 archived), pending 34 (+25), verified 1, delivered 1, activated 8, completed 13, cancelled 6 (+8), **paid 20**, invoiced 0. The form key `commissionStatus` was never stored on any lead. The website holds no plans table: its six SIM plans are the `SIM_PLANS` option list in `packages/contracts/src/lead-properties.ts`. `packages/db/sql/getcanadasim-legacy-import.sql` copies the website's `orders.status` straight into `stage` and re-runs before the staff cutover.

## Global Constraints

- Strict TypeScript, no `any`, no `as`; typecheck, lint, format clean before every commit; every SQL value bound; integration suites on a `_test` database, re-runnable.
- Every tenant table: `workspace_id`, `tenantPolicy`, `backupReadPolicy`, FORCE RLS and grants in a custom migration; migrations additive, `0011_plans` generated, `0012_plans_runtime` custom (grants, seed, data migration); applied to the hosted project deliberately with a paste file `docs/RUNBOOKS/manual/0011-0012-plans.sql` and recorded in both trackers; never edit an applied migration.
- Website intake stays backward compatible: every existing request keeps working; `order` is optional; the browser never sends a price (the backend reads the plan's current price at submission and freezes it).
- Stage keys are code-defined per type (`leadTypeCatalog`); `sim_order` becomes exactly `incomplete, pending, verified, on_hold, delivered, activated, completed, cancelled` (spec §5.3). The backend refuses a stage the type does not list.
- Order values: `priceMinor` and every money value are integer cents, `currency` is `CAD`; `quantity` is an integer 1–99 (spec decision 29: one lead = one sale, with a quantity); `paymentStatus` ∈ `not_needed | pending | paid`; `carrierCommission` ∈ `not_yet | invoiced | received | clawback`; `billingPeriod` ∈ `one_time | month | 30_days | 90_days | year`.
- Editing a plan never changes a past lead (the snapshot is the record); a plan is never deleted from the admin (`active` off hides it from the website and from new orders).
- Sensitive and access rules of phase 2 hold: order properties are filterable only with contact access; `property.manage` (owner role) manages plan properties; plans themselves are managed with `order.manage`.
- API compatibility for the rename: `view=trash`, `POST …/trash`, `trash` in the summary and in a saved view's state keep working as aliases; new names are `archived` / `…/archive`; the error code `lead_trashed` keeps its code with Archive wording.
- Admin copy in sentence case, every control labelled, keyboard-usable. Commit trailers as in phase 2 (the model that wrote the commit, plus the Claude-Session line).

## Review Focus

1. **The website sends a plan id that is inactive, belongs to another site or another lead type.** Expected: `400 plan_not_available`, no lead created or submitted. Test in Task 6.
2. **Staff change a lead's plan after submission, then someone edits that plan.** Expected: the lead's snapshot is re-frozen at the staff change (timeline `edit` names `planId`), and the later plan edit changes no lead. Test in Task 6 (snapshot frozen at change) and Task 5 (plan update touches no lead).
3. **The Get Canada Sim import re-runs after the migration.** Expected: a website order in status `paid` becomes stage `pending` with `paymentStatus: 'paid'`, `invoiced` becomes `completed` with `carrierCommission: 'invoiced'`, and the verification query reports no stage mismatch for them. Test in Task 4 (import integration test).
4. **A bookmarked URL or a saved view made before the rename uses `trash`.** Expected: `?trash=1`, `view=trash`, a view state with `trash: true` and `POST …/trash` all still work and read as Archive in the admin. Tests in Tasks 3, 6 and 8.
5. **A plan with payment required off.** Expected: a new order against it starts at `paymentStatus: 'not_needed'`, and with payment required on at `'pending'`; `carrierCommission` always starts `not_yet`; `quantity` defaults to 1. Test in Task 6.

---

### Task 1: Contracts: order vocabulary, plans, order details, stage clean-up

**Files:**

- Modify: `packages/types/src/index.ts` (new tuples)
- Create: `packages/contracts/src/plans.ts`
- Modify: `packages/contracts/src/lead-types.ts` (`sim_order` stages; `order: true` on order types), `packages/contracts/src/lead-properties.ts` (remove `commissionStatus`; relabel the legacy plan field), `packages/contracts/src/leads.ts` (`order` on create/update requests), `packages/contracts/src/lead-work.ts` (`order` on the detail and the staff PATCH), `packages/contracts/src/endpoints.ts` + `client.ts` (plan routes, website plans route), `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/plans.test.ts`; update `packages/contracts/src/schemas.test.ts` (the `sim_order` stage list), `lead-fields.test.ts` (the PR #1 "byte-identical" test is retired for `sim_order` and replaced by an explicit expected list)
- Regenerate: `docs/api/openapi.json`

**Interfaces:**

```ts
// packages/types
export const orderLeadTypes = tuple('sim_order', 'internet', 'mobility');
export const billingPeriods = tuple('one_time', 'month', '30_days', '90_days', 'year');
export const paymentStatuses = tuple('not_needed', 'pending', 'paid');
export const carrierCommissionStatuses = tuple('not_yet', 'invoiced', 'received', 'clawback');
// contracts plans.ts
export const PLAN_LIMIT = 200;             // plans per site
export const planRequiredDocumentSchema = documentChecklistKeySchema;   // existing, ^[a-z0-9_]{1,64}$
export const planSchema = z.object({ id: z.uuid(), leadType: z.enum(orderLeadTypes), name: z.string().trim().min(1).max(120), priceMinor: z.number().int().min(0).max(1e12), currency: z.literal('CAD'), billingPeriod: z.enum(billingPeriods), paymentRequired: z.boolean(), active: z.boolean(), requiredDocuments: z.array(planRequiredDocumentSchema).max(16), customValues: z.record(propertyKeySchema, leadPropertyValueSchema), position: z.number().int().min(0), version: z.number().int().positive(), createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema });
export const createPlanRequestSchema = planSchema.pick({ leadType, name, priceMinor, billingPeriod, paymentRequired, requiredDocuments }).extend({ active: z.boolean().default(true), customValues: ….default({}) }).strict();
export const updatePlanRequestSchema = z.object({ expectedVersion: z.number().int().positive(), name?, priceMinor?, billingPeriod?, paymentRequired?, active?, requiredDocuments?, customValues?: z.record(propertyKeySchema, leadPropertyValueSchema.nullable()), position? }).strict().refine(/* something besides expectedVersion */);
export const listPlansQuerySchema = z.object({ leadType: z.enum(orderLeadTypes).optional(), includeInactive: z.enum(['true','false']).default('false') });
export const listPlansResponseSchema = z.object({ plans: z.array(planSchema).max(PLAN_LIMIT), requestId });
export const planResponseSchema = z.object({ plan: planSchema, requestId });
/** The copy frozen on the lead at submission or at a staff plan change (spec §5.3). */
export const planSnapshotSchema = z.object({ planId: z.uuid(), name, priceMinor, currency: z.literal('CAD'), billingPeriod, paymentRequired, requiredDocuments, properties: z.record(propertyKeySchema, leadPropertyValueSchema) /* website-visible custom values */, frozenAt: isoDateTimeSchema }).strict();
export const leadOrderSchema = z.object({ planId: z.uuid().nullable(), plan: planSnapshotSchema.nullable(), quantity: z.number().int().min(1).max(99), paymentStatus: z.enum(paymentStatuses), carrierCommission: z.enum(carrierCommissionStatuses) }).strict();
export const DEFAULT_LEAD_ORDER: LeadOrder = { planId: null, plan: null, quantity: 1, paymentStatus: 'not_needed', carrierCommission: 'not_yet' };
/** Website: only what a storefront needs; custom values limited to website-visible properties. */
export const websitePlanSchema = planSchema.pick({ id, leadType, name, priceMinor, currency, billingPeriod, paymentRequired, requiredDocuments }).extend({ properties: z.record(propertyKeySchema, leadPropertyValueSchema) });
export const listWebsitePlansQuerySchema = z.object({ leadType: z.enum(orderLeadTypes).optional() });
export const listWebsitePlansResponseSchema = z.object({ plans: z.array(websitePlanSchema), requestId });
/** Website intake: the chosen plan and quantity; the price is never sent. */
export const leadOrderIntakeSchema = z.object({ planId: z.uuid(), quantity: z.number().int().min(1).max(99).default(1) }).strict();
/** Staff edit of the order fields; `planId` re-freezes the snapshot. */
export const leadOrderEditSchema = z.object({ planId: z.uuid().nullable().optional(), quantity?, paymentStatus?, carrierCommission? }).strict().refine(/* at least one key */);
export function isOrderLeadType(leadType: string): boolean;
export function initialPaymentStatus(plan: Pick<Plan,'paymentRequired'> | null): PaymentStatus; // paid? no: pending when required, not_needed otherwise
export function freezePlan(plan: Plan, websiteVisibleKeys: readonly string[], now: Date): PlanSnapshot;
```

Changes to existing schemas: `createLeadRequestSchema` and `updateLeadRequestSchema` (`leads.ts`) gain `order: leadOrderIntakeSchema.optional()`; `leadDetailSchema` gains `order: leadOrderSchema.optional()` (present for order lead types with contact access); `updateWorkspaceLeadRequestSchema` gains `order: leadOrderEditSchema.optional()` counted as a change; `LeadTypeCatalogEntry` gains `readonly order?: true` set on `sim_order`, `internet`, `mobility`; `sim_order.stages` becomes the eight stages (labels `Incomplete, Pending, Verified, On hold, Delivered, Activated, Completed, Cancelled`); `leadTypeProperties.sim_order` loses `commissionStatus` and `leadPropertyCatalog` loses `commissionStatus` and `COMMISSION_STATUS_OPTIONS`; the `sim_order` `planId` use is relabelled `Plan (as submitted)`. Endpoints (staff): `GET /workspaces/{workspaceId}/plans` (`listPlans`), `POST /plans` (`createPlan`, 201), `PATCH /plans/{planId}` (`updatePlan`); website: `GET /plans` (`listWebsitePlans`, auth website). Client methods with those names (website: `client.plans.list`).

- [ ] **Step 1: Write the failing tests** (`plans.test.ts`: snapshot and order schemas accept the defaults and reject a browser price field, `quantity` 0 and 100, a non-CAD currency, an unknown billing period; `initialPaymentStatus` table; `freezePlan` copies only website-visible keys and stamps `frozenAt`; `isOrderLeadType` for the five types. `schemas.test.ts`: `sim_order` stages equal the eight keys in order, `isLeadStage('sim_order','paid')` is false, `initialLeadStage('sim_order')` is `incomplete`. `lead-fields.test.ts`: `leadFields('sim_order')` has no `commissionStatus` and its `planId` label is `Plan (as submitted)`; the other three types are unchanged byte for byte.)
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- plans schemas lead-fields` → FAIL.
- [ ] **Step 3: Implement**, register endpoints and client methods, `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the contracts suite and `pnpm run typecheck` → PASS (fix the admin/backend compile errors the stage list change causes only where they are literal lists, for example `STAGE_TONES`; behaviour changes belong to later tasks).
- [ ] **Step 5: Commit** — `feat(contracts): plans, order details, sim_order stage clean-up`

---

### Task 2: Contracts: order storage and plan properties in the catalogue

**Files:**

- Modify: `packages/contracts/src/properties.ts` (`storage: 'form' | 'custom' | 'order'`, `websiteVisible`, `orderPropertyCatalog`, `buildPropertyCatalog` options), `packages/contracts/src/custom-values.ts` (unchanged semantics; refuses `order` storage), `packages/contracts/src/property-layouts.ts` (`defaultPropertyLayout` gets an `Order` section for order types)
- Test: `packages/contracts/src/properties.test.ts`, `property-layouts.test.ts`

**Interfaces:**

```ts
export type PropertyStorage = 'form' | 'custom' | 'order';
export interface SiteProperty { …; readonly storage: PropertyStorage; readonly websiteVisible: boolean /* plan custom properties only; false otherwise */ }
export interface PlanOption { readonly id: string; readonly name: string; readonly active: boolean }
export interface BuildCatalogOptions { readonly plans?: readonly PlanOption[] }
export function buildPropertyCatalog(rows: readonly PropertyRow[], object?: PropertyObject, options?: BuildCatalogOptions): PropertyCatalog;
/** Built-ins of order lead types, storage 'order', keyed as stored in leads.order_details. */
export const orderPropertyCatalog: Readonly<Record<string, LeadPropertyDefinition>> = {
  planId: { key: 'planId', label: 'Plan', kind: 'choice', options: [] /* filled from options.plans: value id, label name, hidden !active */ },
  quantity: { key: 'quantity', label: 'Quantity', kind: 'count' },
  paymentStatus: { key: 'paymentStatus', label: 'Payment status', kind: 'choice', options: [{not_needed:'Not needed'},{pending:'Pending'},{paid:'Paid'}] },
  carrierCommission: { key: 'carrierCommission', label: 'Carrier commission', kind: 'choice', options: [{not_yet:'Not yet'},{invoiced:'Invoiced'},{received:'Received'},{clawback:'Clawback'}] },
};
export const ORDER_PROPERTY_KEYS = ['planId','quantity','paymentStatus','carrierCommission'] as const;
```

Rules: for `object = 'lead'`, `forType(t)` of an order type appends the four order properties (editable, `staffOnly: false`, `storage: 'order'`) after the form properties and before custom ones; `filterable(t)` includes them (none sensitive); `planId`'s options come from `options.plans` (an inactive plan is a hidden option, so an old value still reads); a built-in override row may relabel or hide them like any built-in. `propertyRowSchema`, `createCustomPropertySchema` and `updatePropertySchema` gain `websiteVisible: z.boolean()` (default `false`); the catalogue carries it through. `defaultPropertyLayout(leadType, catalog)` for an order type yields sections `order` ("Order", the four keys), `request`, `staff`, `custom` (empty ones dropped). `applyCustomValueEdits` still refuses anything not `storage: 'custom'`.

- [ ] **Step 1: Write the failing tests** (order properties present for `sim_order`/`internet`/`mobility` and absent for `partner_application`; plan options from `options.plans` with inactive hidden; `filterable('sim_order')` includes `paymentStatus` with choice operators; a hidden override on `quantity` removes it from `forType`; `websiteVisible` round-trips through `propertyRowSchema` and defaults false; `defaultPropertyLayout('sim_order', codePropertyCatalog).sections.map(s=>s.id)` equals `['order','request','staff']`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** contracts suite, `pnpm run typecheck` → PASS (the backend's exhaustive `storage` switches will not compile until Task 6; add the `order` case there as a `throw new Error('order storage is wired in task 6')` placeholder only if typecheck demands it, otherwise leave it to Task 6).
- [ ] **Step 5: Commit** — `feat(contracts): order properties as a third storage; plan options and website visibility in the catalogue`

---

### Task 3: Contracts: Archive aliases

**Files:**

- Modify: `packages/contracts/src/workspace-leads.ts` (`leadViewSchema`), `saved-views.ts` (`archived` with `trash` accepted), `lead-work.ts` (`archived`/`restored` system events keep `trashed` accepted on read), `common.ts` (`lead_trashed` message is set in the backend; nothing here), `endpoints.ts` + `client.ts` (`archiveWorkspaceLead` POST `/leads/{leadId}/archive`; keep `trashWorkspaceLead` registered as deprecated alias), `index.ts`
- Test: `saved-views.test.ts`, `schemas.test.ts`

**Interfaces:**

```ts
export const leadViewSchema = z.enum(['active', 'archived', 'trash']);        // 'trash' = legacy alias of 'archived'
export function normalizeLeadView(view: LeadView | undefined): 'active' | 'archived';
// saved views: state field renamed
savedViewStateSchema: { …, archived: z.boolean(), … }  // z.preprocess maps a legacy `trash` key to `archived`
DEFAULT_LEAD_VIEW_STATE.archived = false
leadsSummaryResponseSchema: { …, archived: z.int(), trash: z.int() /* same number, deprecated */ }
```

- [ ] **Step 1: Write the failing tests** (a stored state `{...,"trash":true}` parses to `archived: true`; `leadViewSchema` accepts all three and `normalizeLeadView('trash')` is `archived`; the endpoint registry has both `archiveWorkspaceLead` and `trashWorkspaceLead` with the same response schema).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, regenerate openapi. **Step 4:** contracts suite, typecheck → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): archive replaces trash, with aliases`

---

### Task 4: Database: `plans`, `leads.order_details`, `properties.website_visible`, the stage data migration, the import script

**Files:**

- Modify: `packages/db/src/schema.ts` (`plans` table; `leads.orderDetails`; `properties.websiteVisible`; `schema` export)
- Create: `packages/db/drizzle/0011_plans.sql` (generated), `packages/db/drizzle/0012_plans_runtime.sql` (custom), journal entries, `docs/RUNBOOKS/manual/0011-0012-plans.sql` (paste file with pre-check, both files, tracker rows, verification selects, **a before/after reconciliation query** of `sim_order` counts per stage and `order_details->>'paymentStatus'`)
- Modify: `packages/db/sql/getcanadasim-legacy-import.sql` (status → stage and `order_details` mapping; the verification query), `docs/RUNBOOKS/database.md`, `docs/RUNBOOKS/legacy-import.md`
- Test: `packages/db/tests/plans.integration.test.ts`; `apps/backend/tests/getcanadasim-legacy-import.integration.test.ts` (the `paid` fixtures now expect the mapping)

**Interfaces (exact columns):**

- `plans` (`app.plans`): `id uuid pk`, `workspace_id → workspaces cascade`, `lead_type text` check `~ '^[a-z0-9_]{1,64}$'`, `name text` check `length(btrim(name)) between 1 and 120`, `price_minor bigint not null default 0` check `>= 0`, `currency text not null default 'CAD'` check `= 'CAD'`, `billing_period text not null default 'month'` check in the five values, `payment_required boolean not null default false`, `active boolean not null default true`, `required_documents text[] not null default '{}'`, `custom_values jsonb not null default '{}'` check object, `position integer not null default 0`, `version integer not null default 1`, `created_by uuid`, `updated_by uuid`, `created_at`, `updated_at`. Unique `(workspace_id, id)`; unique index `plans_workspace_type_name_unique (workspace_id, lead_type, lower(name))`. `tenantPolicy`, `backupReadPolicy`, RLS.
- `leads.orderDetails: jsonb('order_details').notNull().default({})` + check `leads_order_details_check` object. `properties.websiteVisible: boolean('website_visible').notNull().default(false)`.
- 0012: `FORCE ROW LEVEL SECURITY` on `plans`; `GRANT SELECT, INSERT, UPDATE ON app.plans TO app_runtime` (no DELETE); **seed** for the workspace with slug `getcanadasim` when it exists: six plans from `SIM_PLANS` (names = the labels, `price_minor` parsed from the `$N` in the label ×100: 5000, 4000, 3500, 4000, 3500, 7500; `billing_period 'month'`; `payment_required true`; `active true`; `position` 0–5), `ON CONFLICT DO NOTHING` on the name index; **data migration** for every `sim_order` lead: `order_details = jsonb_build_object('planId', null, 'plan', null, 'quantity', 1, 'paymentStatus', <map>, 'carrierCommission', <map>)` where paymentStatus = `paid` for stage in (paid, verified, delivered, activated, completed), `pending` for (pending, incomplete), `not_needed` for (cancelled, on_hold), and carrierCommission from `payload->'payload'->>'commissionStatus'` (`invoiced`→`invoiced`, `commission_received`→`received`, `claw_back`→`clawback`, else `not_yet`; `invoiced` stage forces `invoiced`); then `stage = 'pending'` where stage `paid`, `stage = 'completed'` where `invoiced`; and one `lead_activities` row per remapped lead (`kind 'system'`, `body 'Stage Paid became Pending; payment status set to Paid (phase 3 migration)'` or the Invoiced wording, `actor_id null`, `data {"migration":"0012"}`); every other lead type gets `order_details = '{}'` untouched (the default). Non-`sim_order` order types (`internet`, `mobility`) get `order_details` only when they are created or edited from now on (`DEFAULT_LEAD_ORDER` is applied on read when the column is `{}`).
- Import script: `stage = case o.status when 'paid' then 'pending' when 'invoiced' then 'completed' else o.status end`; `order_details` built with the same mapping (and `commission_status`); the `commissionStatus` form key is no longer written; the verification counts `stage_mismatches` with the mapping applied; `docs/RUNBOOKS/legacy-import.md` records the mapping.

- [ ] **Step 1: Write the failing tests** (`plans.integration.test.ts`: RLS and FORCE on `plans`; `app_runtime` cannot DELETE; name unique per type ignoring case; `price_minor < 0` and a non-CAD currency refused; `leads.order_details` defaults `{}` and refuses a non-object; the seed inserts six plans for a `getcanadasim` workspace and none for another slug; the data migration on fixture leads (one per sim_order stage incl. `paid` and `invoiced`, one with `commissionStatus: 'claw_back'`) yields the mapped stage, `paymentStatus`, `carrierCommission` and one system activity per remapped lead, and leaves an `internet` lead's `order_details` at `{}`. Import test: website orders in `paid`/`invoiced` land mapped and the verification query counts 0 mismatches.)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (generate 0011 with `drizzle-kit generate --name plans`, hand-write 0012, paste file with the reconciliation query, runbook sections, import script). **Step 4:** `pnpm --filter @gt-sales/db test`, `pnpm --filter backend test -- legacy-import rls isolation backup-reader` → PASS (28 → 29 backup policies).
- [ ] **Step 5: Commit** — `feat(db): plans, order details, website-visible properties; sim_order stage migration (0011, 0012)`

---

### Task 5: Backend: plan store, staff plan routes, website plans route, plan properties

**Files:**

- Create: `apps/backend/src/plans/store.ts`, `apps/backend/src/routes/plans.ts` (staff), website route in `apps/backend/src/routes/website.ts`
- Modify: `apps/backend/src/properties/store.ts` (object-aware usage counts over `app.plans.custom_values` for `object = 'plan'`; `websiteVisible` on create/update; `builtinKeys` empty for plans), `apps/backend/src/properties/catalog.ts` (`loadPropertyCatalog(tx, object, options)`), `apps/backend/src/routes/properties.ts` (`?object=lead|plan` on the five routes; layouts for plans use `leadType ''`), `apps/backend/src/app.ts`
- Test: `apps/backend/tests/plan-store.integration.test.ts`, `plan-routes.test.ts`, `website-plans-route.test.ts`, `property-store.integration.test.ts` (plan usage), `property-routes.test.ts` (`object=plan`)

**Interfaces:**

```ts
export type CreatePlanOutcome =
  | { kind: 'created'; plan: Plan }
  | { kind: 'name_taken' }
  | { kind: 'limit_reached' }
  | { kind: 'invalid_custom_value'; field: string };
export type UpdatePlanOutcome =
  | { kind: 'updated'; plan: Plan }
  | { kind: 'not_found' }
  | { kind: 'name_taken' }
  | { kind: 'version_conflict' }
  | { kind: 'invalid_custom_value'; field: string };
export interface PlanStore {
  list(
    ctx: TenantContext,
    filter: { leadType?: string; includeInactive: boolean },
  ): Promise<Plan[]>; // ordered by lead_type, position, lower(name)
  get(ctx: TenantContext, planId: string): Promise<Plan | undefined>;
  create(ctx: PropertyContext, input: CreatePlanRequest): Promise<CreatePlanOutcome>;
  update(
    ctx: PropertyContext,
    planId: string,
    input: UpdatePlanRequest,
  ): Promise<UpdatePlanOutcome>;
  /** For the website and for freezing: active plans of one type, with only website-visible custom values. */
  listForWebsite(ctx: TenantContext, leadType?: string): Promise<WebsitePlan[]>;
  options(ctx: TenantContext): Promise<PlanOption[]>; // every plan, for the catalogue
}
export class DatabasePlanStore implements PlanStore {}
```

Rules: `create`/`update` take `pg_advisory_xact_lock(hashtextextended('plans:' || workspaceId, 0))`; `23505` on the name index → `name_taken`; `PLAN_LIMIT` → `limit_reached`; custom values validated with `applyCustomValueEdits` against the site's plan catalogue (`object 'plan'`); `update` is version-guarded; audit `plan.created` / `plan.updated` (`entity 'plan'`, before/after the plan row; plan data is not PII). Staff routes under `/workspaces/:workspaceId`: `GET /plans` (`workspace.read`), `POST /plans` (`order.manage`, 201; 409 `plan_name_taken`, 409 `plan_limit`, 400 `invalid_request`), `PATCH /plans/:planId` (`order.manage`; 404 `plan_not_found`, 409 `version_conflict`, 409 `plan_name_taken`). Website: `GET /api/v1/website/plans?leadType=` with `authenticate` + `requireScope('leads:write')` (no bot check), `Cache-Control: no-store`, answers `listWebsitePlansResponseSchema` with active plans only. Property routes: `object` query (`z.enum(PROPERTY_OBJECTS).default('lead')`); `websiteVisible` accepted only for `object = 'plan'` (400 `invalid_request` otherwise); `GET /properties?object=plan` returns the plan catalogue with one layout row keyed `''`; usage counts for plans: `{ leadCount: 0, active: n, trashed: 0, restricted: 0 }` → rename nothing, just count plans holding the key (`planCount` added to `propertyUsageSchema` as optional).

- [ ] **Step 1: Write the failing tests** (store: create/list/get/update, name taken ignoring case, limit, version conflict, custom values validated against plan properties, website listing shows only active plans and only website-visible values, isolation across sites, a plan update changes no lead's `order_details`; routes: role matrix, status/error codes, `object=plan` on properties with `websiteVisible`, `websiteVisible` on a lead property → 400; website route: scope required, inactive plans hidden, `leadType` filter, `no-store` header).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** backend suite, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): plans store and routes; website plans; plan properties`

---

### Task 6: Backend: order details on leads, intake with a plan, archive aliases

**Files:**

- Modify: `apps/backend/src/leads/store.ts` (intake: `order` on create and on the submitting update → freeze), `apps/backend/src/leads/work-store.ts` (`updateLead` with `order`; stage check against the new list; archive naming internally), `apps/backend/src/leads/staff-queries.ts` (storage `order` over `l.order_details`; one condition builder parameterised by the JSON column expression for `custom` and `order`; `order` on the detail; `DEFAULT_LEAD_ORDER` applied on read), `apps/backend/src/routes/staff.ts` (`/archive` route beside `/trash`; `view` normalised; summary `archived`; catalogue built with `planStore.options`), `apps/backend/src/routes/website.ts` (`order` passthrough), `apps/backend/src/http/domain-errors.ts` (`lead_trashed` wording → Archive; `plan_not_available`)
- Test: `apps/backend/tests/lead-order.integration.test.ts`, `lead-work-routes.test.ts`, `website-routes.test.ts` (or the existing intake test file), `lead-custom-values.integration.test.ts` (shared builder unchanged behaviour)

**Rules:** Intake (`createLead` with `submit: true`, or the `updateLead` that submits): when `order` is present the lead type must be an order type (else 400 `invalid_request`), the plan must exist in the site, be active and of that type (else `400 plan_not_available`), then `order_details = { planId, plan: freezePlan(plan, visibleKeys, now), quantity, paymentStatus: initialPaymentStatus(plan), carrierCommission: 'not_yet' }`; a draft saved without `submit` stores `planId` and `quantity` only and freezes at submission. Staff `updateLead({ order })`: `planId` (non-null) re-freezes from the current plan (must be active), `planId: null` clears link and snapshot, the other three fields set directly; refused on an archived or restricted lead (`not_found`/`trashed` as today); one `edit` activity lists the changed keys (`planId`, `quantity`, …); audit before/after hold the order fields (no PII). Reads: `order` on the detail only with contact access (`withoutPersonalDetails` strips it); the list's `properties` include order keys when requested as columns; filters/sorts on `order` storage use `l.order_details` with the same guards; `planId` filter values are plan ids. Summary gains `archived` (and `trash` as the same number). `POST /leads/:id/archive` and `/trash` share the handler; `view=trash|archived` both work; timeline system event kinds stay `trashed`/`restored` in storage (the admin labels them Archive).

- [ ] **Step 1: Write the failing tests** (website: submit with a valid plan → snapshot equals the plan at that moment, `paymentStatus` pending/not_needed per `paymentRequired`, `quantity` default 1; inactive, foreign-site and wrong-type plan → 400 `plan_not_available` and no lead; a plan edit after submission leaves the snapshot unchanged; draft then submit freezes at submit time; staff change `planId` → re-frozen and `edit` activity names `planId`; `paymentStatus` filter and `planId` column on the list; sort by `quantity`; `view=trash` and `view=archived` return the same rows; `/archive` and `/trash` both archive; summary has `archived`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** whole backend suite (with the DB env), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): order details with a frozen plan on leads; archive aliases`

---

### Task 7: Admin: Settings → Plans and plan properties

**Files:**

- Create: `apps/admin/src/app/w/[workspace]/settings/plans/page.tsx`, `apps/admin/src/components/plans/plans-settings.tsx`, `plan-editor.tsx`, `apps/admin/src/components/plans/use-plans.ts`
- Modify: `apps/admin/src/lib/api.ts` (`listPlans`, `createPlan`, `updatePlan`, `getPropertyModel(…, object)` etc.), the settings navigation, `apps/admin/src/components/properties/properties-settings.tsx` (an `object` prop: a "Plan properties" tab with the _Show on website_ switch)
- Test: `plans-settings.test.tsx`, `plan-editor.test.tsx`, `properties-settings.test.tsx`

**Interfaces:**

```ts
export function PlansSettings(props: { workspaceSlug: string }): JSX.Element; // one list per order lead type; add/edit; Active switch; inactive plans shown greyed with "Inactive"; write controls only with order.manage (from /access)
export function PlanEditor(props: {
  leadType: string;
  initial?: Plan;
  catalog: PropertyCatalog /* object plan */;
  documentTypes: readonly string[];
  onSave(input: CreatePlanRequest | UpdatePlanRequest): Promise<string | undefined>;
}): JSX.Element; // price typed in dollars, stored in cents; billing period select; payment required and active switches; required documents checkboxes; custom plan properties via PropertyValueControl
export function usePlans(
  workspaceId: string | undefined,
  options?: { includeInactive?: boolean },
): { plans: Plan[]; reload(): Promise<void>; error?: string };
```

Errors: `plan_name_taken` → "A plan with that name already exists for this type.", `plan_limit` → "This site already has 200 plans.", `version_conflict` → "This plan changed elsewhere. Reload and try again." (remount on conflict as the property editors do).

- [ ] **Step 1: Write the failing tests** (list per type; create sends cents and `leadType`; edit sends `expectedVersion`; inactive toggle; required documents; a leads-role user sees no write controls; plan properties tab shows the Show on website switch and sends `websiteVisible`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** admin suite, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(admin): plans settings and plan properties`

---

### Task 8: Admin: the Order section on the record, order columns and filters, Archive copy

**Files:**

- Modify: `apps/admin/src/components/leads/lead-record.tsx` (the `Order` section renders through `PropertySections` with `storage: 'order'` values from `lead.order`; `planId` shows a plan select of active plans plus the frozen copy summary "Frozen at <date>: <name>, $<price> / <period>"; saving sends `order` edits), `property-sections.tsx` (`order` storage values and `onSave({ order })`), `use-property-model.ts` (builds the catalogue with the site's plans), `leads-inbox.tsx`/`inbox-query.ts`/`view-state.ts`/`leads-table.tsx`/`lead-timeline.tsx`/`related-requests.tsx`/`properties-settings.tsx`/`lib/api.ts` (Archive wording; URL `archived=1` written, `trash=1` still read; `setLeadArchived` calls `/archive`; tab "Archive"; "Archive"/"Restore" buttons; banner "This lead is archived (since …)"; "The archive is empty."; timeline "archived this"), `lead-display.tsx` (`STAGE_TONES`/`STAGE_DOTS` for the eight `sim_order` stages), `dashboard.tsx` copy if it says trash
- Test: `lead-record.test.tsx`, `leads-inbox.test.tsx`, `leads-table.test.tsx`, `view-state.test.ts`, `lead-timeline.test.tsx`

- [ ] **Step 1: Write the failing tests** (Order section shows the four fields and the frozen summary; changing the plan sends `order.planId`; `paymentStatus` appears in the filter menu with its three options; `?trash=1` and `?archived=1` both open the Archive tab and the URL is written as `archived=1`; a saved view with `trash: true` opens the Archive tab; the record's archive button posts to `/archive`; copy contains no "trash").
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (grep `apps/admin/src` for `trash`/`Trash` and leave only the legacy URL/API parsing). **Step 4:** admin suite, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(admin): order section with the frozen plan; archive replaces trash`

---

### Task 9: Playwright journey and the e2e harness

**Files:**

- Modify: `apps/backend/tests/e2e/harness.ts` (seed two Get Canada Sim plans; create one SIM order through the website route with `order.planId`), `apps/admin/e2e/leads.spec.ts` (update the trash journey to Archive wording; new journey)

- [ ] **Step 1: Add the journey**: as the owner, Settings → Plans → add "Fido 75GB" ($35, month, payment required on) → inbox SIM orders → open the seeded order in the side panel → Order section shows the frozen plan and `Payment status: Pending` → set Payment status Paid → filter by Payment status = Paid → one row → Archive the lead → Archive tab shows it → Restore. Assert no `paid`/`invoiced` stage option exists in the stage select.
- [ ] **Step 2: Run** `pnpm --filter admin test:e2e:leads` → PASS (all journeys).
- [ ] **Step 3: Commit** — `test(e2e): plans, order section, archive journey`

---

### Task 10: Docs

- Modify: `AGENTS.md` (vocabulary: plan, frozen plan, order details, payment status, carrier commission, archive; where things live: `apps/backend/src/plans/`, `components/plans/`), `docs/HANDOFF.md` (§2.3 routes: plans staff routes, website `GET /plans`, `/archive`; §2.6 website contract: `order` on intake and the plans route; §3.6 done list; §5.1 owner step: apply 0011/0012 with the reconciliation; §5.2: phase 3b for the deferred CRM items; §5.3 follow-ups), `docs/PLAN.md` (§7 status), `docs/RUNBOOKS/database.md` (done in Task 4), `docs/superpowers/specs/…` untouched.
- [ ] **Step 1: Edit, format, commit** — `docs: phase 3 plans, stage clean-up, archive`

---

### Task 11: Final gate, pull request, migrations with reconciliation, merge

- [ ] **Step 1:** `pnpm run typecheck && pnpm run lint && pnpm run format && pnpm run test` (DB env) and `pnpm --filter admin test:e2e:leads` → PASS.
- [ ] **Step 2:** Open the PR (title `Plans, stage clean-up and archive (merge phase 3)`), subscribe, drive CI green.
- [ ] **Step 3: Apply 0011 + 0012 to `xykrphbgpwisqacpyeiv` before merging** (the backend on `main` would select `order_details`): run the paste file's pre-check and **the before counts** (`sim_order` by stage, plus `count(*)` of leads), apply as two migrations named `0011_plans` and `0012_plans_runtime` (verbatim plus Drizzle tracker rows), run the verification selects and **the after counts**: `paid` 0, `pending` = 34 + 25 + 20 (= 79 incl. archived), `invoiced` 0, six seeded plans for `getcanadasim`, 20 system activities, every `sim_order` lead with a `paymentStatus`, every other lead `order_details = '{}'`; record the numbers in `docs/RUNBOOKS/database.md`.
- [ ] **Step 4:** Merge; confirm the Railway deploy and the backend health; open the live admin: Settings → Plans lists the six plans, the SIM orders inbox filters by Payment status.
