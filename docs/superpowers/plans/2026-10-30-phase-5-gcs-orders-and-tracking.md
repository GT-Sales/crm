# Phase 5: Get Canada Sim Orders and Customer Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Canada Sim's checkout sends every new SIM order to the CRM under the next `MS-<n>` number and staff work orders only in the CRM (Part A); then a customer opens the website's `/track`, gets a 6-digit code by email, sees their orders and asks for changes, and staff approve or reject them on the lead page, so a real customer's change request is approved in the CRM (Part B).

**Architecture:** Part A models `sim_order` intake in the lead-type registry and numbers new SIM orders from a per-site counter (`app.site_counters`) advanced inside the `POST /website/leads` transaction; the website's two-step checkout creates a CRM draft at step 1 and submits it with an `Idempotency-Key` at step 2, behind `CRM_ORDERS`, and the import runs one last time on switch day. Part B ports Canadian Plans' email-only tracking (keyed hashes, sealed code, signed 30-minute grant bound to site and normalized email) into `apps/backend/src/tracking/`, adapted to leads: challenges and change requests are two new tables, a customer's documents are ordinary lead files held back from the Documents card until the request is approved, approval goes through the same locked lead update staff edits use (extracted as `applyLeadUpdate`), and the code mail is a job type of its own that carries the code sealed and renders at send time. The two decision emails are always sent through phase 4's composer in the decision's transaction. The website's `/track` switches to the CRM behind `CRM_TRACKING`.

**Tech Stack:** TypeScript (strict), Zod 4, Express 5, Drizzle + PostgreSQL 17, Next.js 16 + React 19 + Tailwind 4 + shadcn, Vitest, Testing Library, Playwright. Get Canada Sim: Next.js 16.3, server actions, plain Node test scripts (`scripts/test-*.mts`, `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-30-phase-5-gcs-orders-and-tracking-design.md` (owner decisions §3 and rulings §4 are binding; read it beside this plan). Hand-off page: `docs/superpowers/phases/phase-5-customer-tracking.md`; shared rules, gate and shipping: `docs/superpowers/phases/README.md`. Ported, adapted to leads: Canadian Plans `apps/backend/src/tracking/{secrets,cipher,service,store,delivery}.ts` and their tests, `packages/contracts/src/tracking.ts`, `createTrackingRouter` in `apps/backend/src/routes/website.ts`. Out of scope (spec §8): partner screens, commissions and invoices; partner applications and contact messages; payments; "ask the customer for…"; custom automation rules.

**Execution:** subagent-driven development, already chosen (README "Working method"). CRM work branch `phase-5-customer-tracking`; worktrees `/home/user/crm-wt/t<n>` on `p5/t<n>`. Get Canada Sim tasks run in `/home/user/get-canada-sim` worktrees `/home/user/gcs-wt/t<n>` on `p5/gcs-t<n>`, merged into `claude/crm-orders` (Part A) and `claude/crm-tracking` (Part B, cut from `main` after Part A's website PR merges).

**Owner decision on the plan (2026-10-30), D10: one switch day, after both parts are live.** Part A's code still merges to `main` and deploys first with `CRM_ORDERS` off; the switch day (Task A11) runs only after Part B is deployed, and moves orders and `/track` to the CRM on the same day (`CRM_ORDERS` on, the final import, then `CRM_TRACKING` on). Customers never lose online change requests. This supersedes S4's interim read-only `/track` as a live state: Task A8 still builds it as the safe fallback, but no customer sees it unless a step of switch day fails. Task A11 runs after Task B15's deploy, and Task B15's `/track` switch becomes A11's last step.

**Pre-flight corrections (controller, 2026-10-30), binding over the task text below:**

- **PF1 (D10 carried through).** Waves row A4 ends at A10. Wave B6 ends "… → B14 → B15 → A11". B15 Step 6 deploys with `CRM_TRACKING` unset and stops; B15 Step 7 ("done when") moves to A11. A11 "Before the day" adds "B15's deploys live"; A11 gets Step 5 "owner sets `CRM_TRACKING=on`" after the test order and Step 6 "a real customer's change request approved in the CRM, recorded".
- **PF2 (pre-switch test orders).** Before the first production test order (A11 "Before the day", B15 Step 5), run the SEED block with `+ 1000` in place of `+ 9`; the switch-day seed's `greatest` keeps the gap. A5 adds a test: a CRM order after a `+1000` seed, then `public.orders` rows numbered up to the gap, import with no unique violation.
- **PF3 (change request numbers).** The SEED block of `docs/RUNBOOKS/manual/gcs-switch-day.sql` also seeds `change_request_no` from `max(public.order_edit_requests.request_no) + 9` (`+ 1000` before any pre-switch test request) with `greatest`; B7 adds a test; A11 Step 2 runs it with the order seed.
- **PF4.** B10 moves to wave B2 (it shares four files with B1).
- **PF5.** `trackingOrderSchema`, `trackingPendingChangeSchema` and their types move from B2 to B1; B5 consumes "B1 `TrackingOrder`".
- **PF6.** B7: `attachDocument` joining a pending request sets `version + 1` and `updated_at`; a request it creates starts at 1; B7's test asserts version 2 after one `requestChange` and one `attachDocument`.
- **PF7.** B5's "no code in the payload" test asserts the payload contains no `code` key and that the sealed value does not contain the issued code's six digits as a substring of any string field other than ids and hashes; never `/\d{6}/` over the whole payload.
- **PF8 (wording).** A11 Step 3: the final import updates the CRM copies of imported orders from `public.orders` and adds missing ones (`on conflict (id) do update`); it is safe on switch day because staff worked those orders in the old admin until then.
- The 23 minor findings in the SDD workspace's `preflight-scan.md` are corrections each implementer applies to its own tasks.

**Rulings added by the planner** (each: ruling — why — cost if wrong):

- **S1.** The switch-day seed sets the counter's last issued number to the highest `order_no` in `public.orders` plus 9, so the CRM's first order is that number plus 10; it only ever raises the counter (`greatest`). — An order started on the old checkout between the seed and the flag flip takes the next `order_no`; without a gap the CRM's first order would take the same number and the unique index on `(workspace_id, lead_type, external_ref)` would make the final import fail. — Up to nine numbers never used; numbers were never promised consecutive.
- **S2.** Unseeded, the counter seeds itself from the highest `MS-<n>` among the site's `sim_order` leads. — A test order before switch day must not collide with an imported number. — None beyond S1.
- **S3.** With `CRM_ORDERS` on, a draft cookie that carries no CRM grant (a checkout started before the flip) is treated as no draft: the customer starts at step 1 again; their half-finished `public.orders` row comes in with the final import as an `incomplete` lead. — Mixing two backends inside one checkout would need a second completion path. — A customer mid-checkout at the flip retypes step 1.
- **S4.** With `CRM_ORDERS` on and `CRM_TRACKING` off, `/track` lists only `public.orders` read-only (no change requests, no uploads) with a notice, and the old admin's change requests are no longer decidable. — After the final import nothing flows from `public.orders` to the CRM, so an edit made there would be lost. — Between the two steps customers change orders by replying to their confirmation email.
- **P1.** The website matches its plan slug to a CRM plan through a website-visible custom plan property labelled "Website slug" (key `custom_website_slug`); the checkout refuses to submit when no active plan, or more than one, carries the slug. — Plan names differ in format between the two systems; a property is explicit and testable (spec §9 risk). — The owner creates the property and fills six plans before switch day.
- **P2.** The website sends `attribution.partnerCode` as `PT-<partner_no>` of the approved partner it credits today (the Reference email or the `ms_ref` link), never the raw `ms_ref` uuid, and writes no `partner_earnings` while `CRM_ORDERS` is on. — Imported leads already carry `PT-<n>`; commissions are paused (decision 2). — None until the partners phase.
- **P3.** `CRM_ORDERS=on` with `CRM_API_URL` or `CRM_SITE_KEY` missing makes the checkout answer "temporarily unavailable" and logs `crm_orders_misconfigured`; it never falls back to `public.orders`. `CRM_TRACKING` behaves the same for `/track`. — A silent fallback after switch day would put orders where nobody works them. — A misconfigured deploy stops orders visibly until fixed.
- **P4.** Both checkout steps send `consentVersion: 'getcanadasim-order-2026-10'`; at submit "a plan" means the order's CRM plan (`order.planId`), and `form.planId` keeps the website's slug as submitted. — The CRM requires a consent version on every create; the plan sold is the CRM's. — None.
- **P5.** The checkout's partner-variant documents are sent by the website server (intent with the draft grant, server `PUT` of the bytes it already holds, finalize), and HEIC is refused up front ("Use a JPG, PNG, or PDF file."). — The step-2 action already holds the files; the CRM accepts PDF, JPEG, PNG and WebP only. — None.
- **T1.** Change requests apply to `sim_order` leads only; `internet` and `mobility` leads are listed read-only (`canRequestChange: false`). — Ruling 4's fields are SIM order fields. — None on Get Canada Sim.
- **T2.** A tracked order carries the current value of each field the customer may change (their own answers), so `/track` can show what they are changing; never staff-only fields, payment, commission, notes, tasks or assignee. — The website shows current values beside the edit today. — None.
- **T3.** `/track` shows each document's state (`missing`, `received`, `approved`, `needs_replacement`), not a link to open the file. — No customer download route is in scope. — A customer cannot re-open the passport they sent.
- **T4.** With `CRM_TRACKING` on, the confirmation email's sign-in link (`/track/continue`) still checks the website's own link token, then asks the CRM for a code for that email and lands on the code step; the CRM never trusts the website's token. — Only a code proves the email to the CRM. — The customer types one code.
- **T5.** Change request numbers continue after the highest `requestNo` the import wrote on the site's timeline (counter `change_request_no` in `app.site_counters`, self-seeded on first use); a replaced request keeps its number. — Imported and CRM requests share one numbering on a lead's timeline. — None.
- **T6.** Approve and reject carry the request's `expectedVersion` (a replaced request is version + 1) and answer `409 version_conflict` when it moved; an approval and a staff edit of the same field serialize on the lead row lock (the lead is always locked before the request), the one committed last wins, and both are on the timeline. — Staff must never approve values they did not see; a staff correction is deliberate either way. — A staff edit made seconds before an approval of the same field is overwritten by the customer's value the staff member approved.
- **T7.** A customer's document is a lead file with `held_for_change_request = true`: finalize does not make it current, `currentLeadDocuments` ignores it, approval clears the flag and supersedes the older file, rejection tombstones it and deletes its object after commit. — 0001's `guard_restricted_file` forbids changing a file's `record_type` or `record_id`, so a staged parent type could never become a lead document. — One boolean column on `app.files`.
- **T8.** The code job type is `tracking_code_email`, registered in code only (`app.outbox_jobs.job_type` has no CHECK), payload version 1; it replaces the never-registered `tracking_otp_email` case in the outbox scrub; `sealTrackingCode` binds `{ workspaceId, challengeId }` (the unused `orderId` goes). — Email-only tracking has no order id. — None: nothing calls the old binding.
- **T9.** `change_approved` and `change_rejected` may use exactly `{first name}`, `{site name}` and `{tracking link}`; their starters use only `{first name}` and `{site name}`. — A site without a site address would otherwise skip every decision mail (`missing_fill_in`). — An owner adds the link by editing the template.
- **T10.** Challenges are pruned 24 hours after they expire; change requests are kept. Website tracking adds endpoint limit `tracking: 30 per 60 s` per visitor, Canadian Plans' per-visitor buckets (20 code requests, 40 verifications per 10 minutes) and bot actions `tracking-request`, `tracking-verify`; the neutral answer's floor is a route dependency `minLatencyMs` (default 500), not an environment variable. — Canadian Plans' values; tests need a short floor. — None.
- **T11.** Tracking unconfigured (`TRACKING_HASH_SECRET` unset or under 32 characters): the code route answers neutrally and sends nothing, every other tracking route answers `409 feature_not_ready`. — Ruling 8 ("reads fail closed") in the CRM's own code for a disabled feature. — None.

**Dependency waves** (2–3 implementers per wave; whoever merges last in a wave re-runs `pnpm --filter @gt-sales/contracts build` for `docs/api/openapi.json`; GCS = Get Canada Sim repository):

| Wave | Tasks                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | A1 contracts (hard) ∥ A2 database 0015/0016 (hard) ∥ A6 GCS CRM client and plan match (easy)                                          |
| A2   | A3 SIM order intake (hard; A1) ∥ A8 GCS read-only Orders board and `/track` notice (easy)                                             |
| A3   | A4 order numbers (hard; A1–A3) ∥ A7 GCS checkout through the CRM (hard; A6)                                                           |
| A4   | A5 final-import rehearsal and seed (hard; A2, A4) → A9 docs (easy) → A10 gate, PRs, migrations, deploy (easy) → A11 switch day (easy) |
| B1   | B1 contracts vocabulary (hard) ∥ B3 database 0017/0018 (hard) ∥ B4 tracking secrets (hard) ∥ B10 remove `EMAIL_SENDERS_JSON` (easy)   |
| B2   | B2 contracts API (easy; B1) ∥ B5 tracking store and service (hard; B1, B3, B4)                                                        |
| B3   | B6 code mail (hard; B1, B3–B5, B10) ∥ B7 change requests and held documents (hard; B2, B3, B5)                                        |
| B4   | B8 approve and reject (hard; B7) ∥ B11 admin card and copy (hard; B2, mocks)                                                          |
| B5   | B9 routes (easy; B2, B5–B8) ∥ B13 GCS `/track` through the CRM (hard; B2, mocked CRM)                                                 |
| B6   | B12 done-when test and Playwright (hard; B9, B11) → B14 docs (easy) → B15 gate, PRs, migrations, deploy, switch (easy)                |

## Global Constraints

- Strict TypeScript, no `any`, no `as`; parse with Zod; typecheck, lint, format clean before every commit; every SQL value bound. Contracts hold every schema and the endpoint registry; after a contracts change run `pnpm --filter @gt-sales/contracts build` (regenerates `docs/api/openapi.json`).
- `ENV(n)` means (database created once with `psql -h localhost -U postgres -c 'create database gt_sales_t<n>_test'`): `TEST_MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gt_sales_t<n>_test MIGRATION_DATABASE_SSL_MODE=disable DB_TEST_ALLOW_DESTRUCTIVE=1 DATABASE_URL=postgresql://app_runtime:local_ci_runtime_password@localhost:5432/gt_sales_t<n>_test DATABASE_SSL_MODE=disable EMAIL_CONTACT_HASH_SECRET=ci-email-contact-hash-secret-0123456789`. Part A task An uses `ENV(n)`; Part B task Bn uses `ENV(20+n)`. Integration suites are re-runnable on a persistent `_test` database, clean what they assert on, and use the fixed UUID range named in their task (last segment `…00000000NNxx`, `NN` unique per suite).
- Every new table: `workspace_id`, `tenantPolicy`, `backupReadPolicy`, `.enableRLS()` in `schema.ts`; FORCE RLS and `app_runtime` grants without DELETE in the custom migration, safe to run twice. Part A: `0015_order_numbers` (generated) + `0016_order_numbers_runtime` (custom), paste file `docs/RUNBOOKS/manual/0015-0016-order-numbers.sql`. Part B: `0017_customer_tracking` + `0018_customer_tracking_runtime`, paste file `docs/RUNBOOKS/manual/0017-0018-customer-tracking.sql`. Never edit an applied migration. Paste files: header with each file's `sha256sum` and journal `when`, a pre-check select, `BEGIN` … both files verbatim and the four tracker rows (`drizzle.__drizzle_migrations`, `supabase_migrations.schema_migrations`) … `COMMIT`, then verification selects run one at a time; rehearsed on a local database migrated to the previous migration. Applying: plain DDL and grants through `execute_sql` in small batches, any statement that trips the confirmation prompt (`ALTER`, `REVOKE`, a function replacement such as `CREATE OR REPLACE FUNCTION app.prune_operational_rows`) handed to the owner as a paste, tracker rows by hand, verification against the catalog (`pg_class`, `pg_policies`, `pg_proc`, `has_table_privilege`), never the trackers.
- Order numbers: `MS-<n>` (`SIM_ORDER_REF_PREFIX = 'MS-'`) as `leads.external_ref`, from counter `sim_order_ref` in `app.site_counters`, advanced in the `POST /website/leads` transaction for a `sim_order` create with no `externalRef`; the create and update responses return `lead.externalRef`. A submitted `sim_order` needs contact `fullName` and `email`, `order.planId` and `form.payload.delivery` (`esim` or `pickup`; `pickup` needs `shippingAddress`); a draft may be partial. Refusals: `400 validation_error` with `details.field` one of `leadType`, `submit`, `form`, `contact`, `order`, never a value.
- Tracking limits (spec ruling 7): code `^\d{6}$`, lives 10 minutes (`TRACKING_CODE_TTL_MS = 600000`), 5 tries per code (`TRACKING_MAX_ATTEMPTS = 5`); per normalized email per 10 minutes (`TRACKING_EMAIL_WINDOW_SECONDS = 600`): 5 code requests, 10 verifications, 30 customer writes; the code request answers `200 { status: 'code_sent' }` in at least 500 ms (`TRACKING_MIN_LATENCY_MS = 500`) whether or not the email has orders; grant `X-Customer-Grant`, valid 30 minutes (`TRACKING_GRANT_TTL_MS = 1800000`), bound to one site and the normalized email (`trim().toLowerCase()`); `TRACKING_HASH_SECRET` at least 32 characters keys the code, email and rate-bucket hashes and signs the grant. No raw email or code is stored or logged.
- Listed orders (ruling 2): `status = 'submitted'`, `deleted_at is null`, not restricted, `lead_type in ('sim_order','internet','mobility')`, the grant's site, `lower(btrim(leads.email))` = the grant's email, newest first (`created_at desc, id desc`), at most 50 (`MAX_TRACKED_ORDERS`). A cancelled order shows as "Cancelled". No payment status, carrier commission, notes, tasks, assignee or custom values.
- Changes (ruling 4): `fullName`, `phone`, `planId` (a CRM plan id, checked as `PATCH` does: `plan_not_available`), `delivery`, `arrivalDate`, `permitType`, `canadaAddress`, `shippingAddress`, `flightBooked`, and new `passport` or `visa` files; never `email`. Only while the lead is a `sim_order` at stage `pending`, `verified` or `on_hold` (`CHANGE_REQUEST_STAGES`); else `409 change_request_not_allowed`. At most one pending request per lead; a new one replaces the customer's own pending one, keeping its documents and number (ruling 3).
- Staff: approve and reject need `lead.manage` (owner, Leads); the documents an approval attaches still need an `order.manage` review. Approval applies the fields through `applyLeadUpdate` (timeline `edit` naming keys, audit `lead.updated`, plan re-frozen on a plan change). Timeline system events `change_requested`, `change_approved`, `change_rejected` carry `requestNo`, `changeRequestId`, field keys and document types, never values; the requested values live only in `app.change_requests.requested`. The "Waiting in the old admin" wording stays only for imported requests (actor `LEGACY_IMPORT_ACTOR_ID`).
- Email: templates `change_approved` ("Change approved") and `change_rejected` ("Change rejected") join the seven (nine in all); `tracking_code`, `change_approved` and `change_rejected` are always sent (never automation rules), the code mail whenever the site has saved email settings. Decision mails are queued in the decision's transaction with dedupe `${leadId}:${template}:${changeRequestId}`; a site with no sender or a lead with no address skips and the response says so (`emailSkipped`). After Part B, `EMAIL_SENDERS_JSON` and `lead_sim_number_email` are gone; a site without saved settings cannot send (`no_sender`).
- Privacy: no PII in logs, audit, timeline or automation runs (keys, ids, versions, request numbers only); an address outside a job payload only as `hashContact`; the code job's payload holds the code sealed and is scrubbed to `{ challengeId }` when the job ends.
- Admin copy in sentence case, every control labelled, keyboard-usable; the PR #5 look.
- Get Canada Sim (its `AGENTS.md`): demo mode keeps working with every variable unset (both flags off); server-side validation in every action; no client-side Supabase and no CRM key in the browser; tests are `scripts/test-*.mts` plain programs using `check`/`ok`/`done` from `scripts/assert.mts`, each with a `test:<name>` script in `package.json` and a row in its AGENTS.md test table; `npm run lint`, `npm test` and `npm run build` pass before every commit; no new dependency (the CRM client checks the fields it reads by hand); pushes to `main` deploy, so its PRs merge only with the owner's approval and ship dark (`CRM_ORDERS`, `CRM_TRACKING` unset).
- Commits end with `Co-Authored-By: <the model that wrote the commit> <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01S7vCkKVt1JewpyMJKT2gwB`.

## Review Focus

1. **Switch day: one order is started on the old checkout between the seed and the flag flip, another on the new checkout right after.** Expected: the final import brings the first in under its own `MS-<order_no>`, the second is `MS-<max + 10>` or later, no number is on two orders, a second run of the seed never lowers the counter, and reconciliation shows `rows_missing` 0. Test in Task A5.
2. **A code is guessed or reused: six wrong codes, a correct code after it was used, an older challenge's code after a new request.** Expected: wrong codes answer `invalid` five times then `exhausted`; a used code is `not_found`; the older code is `invalid`; the route answers one `400 tracking_challenge_invalid` for all. Tests in Tasks B5 and B9.
3. **A code is requested for an email with no orders on this site (it has orders on another site).** Expected: the same `200 { status: 'code_sent' }` after at least 500 ms as for a known email, no challenge row and no job; and a grant issued on another site reads nothing (`401 not_found`). Tests in Tasks B5 and B9.
4. **The customer sends two change requests at once (two tabs).** Expected: one pending row with one request number and version 2, the second's values, two `change_requested` entries with the same number; the partial unique index holds. Test in Task B7.
5. **Staff approve a request while another staff member edits the same phone number.** Expected: both finish without deadlock, the request is approved once, the phone is whichever write committed last, both writes are on the timeline, and an approval with the version from before a customer replaced the request answers `409 version_conflict`. Test in Task B8.

---

## Part A: orders move in (step A, first pull request)

### Task A1: Contracts: SIM order payload, order reference, the reference on the lead summary

Wave A1. Model: hard.

**Files:**

- Modify: `packages/contracts/src/lead-types.ts`, `packages/contracts/src/leads.ts`, `packages/contracts/src/index.ts`
- Test: create `packages/contracts/src/sim-order-intake.test.ts`; update `packages/contracts/src/schemas.test.ts`
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// lead-types.ts
export const SIM_ORDER_DELIVERIES = ['esim', 'pickup'] as const;
export const SIM_ORDER_PERMIT_TYPES = ['newcomer', 'student', 'worker', 'tourist'] as const;
export const simOrderLeadPayloadSchema: z.ZodObject; // strict, every key optional:
//   planId (1–60, the website's slug), planLabel (1–80), delivery (enum above), arrivalDate (YYYY-MM-DD),
//   permitType (enum above), gotVisa, flightBooked (boolean), shippingAddress (1–400),
//   canadaAddress (1–300), reference (1–120). No simNumber, customerNotes or email.
export type SimOrderLeadPayload = z.infer<typeof simOrderLeadPayloadSchema>;
export const SIM_ORDER_REF_PREFIX = 'MS-';
export function simOrderRef(n: number): string; // simOrderRef(153) === 'MS-153'; throws below 1
export function parseSimOrderRef(ref: string): number | undefined; // /^MS-([1-9]\d{0,8})$/
// leads.ts
leadSummarySchema += { externalRef: leadExternalRefSchema.nullable() };
```

- [ ] **Step 1: Write the failing tests.** `sim-order-intake.test.ts`: the schema accepts `{}` and `{ planId: 'unlimited-data-rogers', delivery: 'pickup', shippingAddress: '12 King St W, Toronto ON', arrivalDate: '2026-11-20', permitType: 'student', gotVisa: true, flightBooked: false, reference: 'agent@example.com' }`; refuses `simNumber: '+16475550123'`, `email`, `delivery: 'airport'`, `permitType: 'visitor'`, `arrivalDate: '20-11-2026'`, a 401-character `shippingAddress`; `SIM_ORDER_DELIVERIES` and `SIM_ORDER_PERMIT_TYPES` equal the option values of `leadTypeProperties.sim_order`'s `delivery` and `permitType`; `simOrderRef(153)` is `'MS-153'`; `parseSimOrderRef('MS-153')` 153, `('MS-0')`, `('PT-5')`, `('MS-12a')` undefined. `schemas.test.ts`: `createLeadResponseSchema` needs `lead.externalRef` (string or null).
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- sim-order-intake schemas` → FAIL.
- [ ] **Step 3: Implement**; `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the contracts suite and `pnpm run typecheck` (fails in `apps/backend/src/leads/store.ts` `toSummary`, which Task A3 fixes: add `externalRef: null` there now so the tree compiles) → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): SIM order payload, MS- order references and the reference on the lead summary`

---

### Task A2: Database: 0015 and 0016 (the per-site counter)

Wave A1. Model: hard.

**Files:**

- Modify: `packages/db/src/schema.ts` (`siteCounters`, a `siteCounterList` beside `idempotencyScopeList`)
- Create: `packages/db/drizzle/0015_order_numbers.sql` (`pnpm --filter @gt-sales/db db:generate -- --name order_numbers`), `0016_order_numbers_runtime.sql` (`--custom --name order_numbers_runtime`), journal entries, `docs/RUNBOOKS/manual/0015-0016-order-numbers.sql`
- Modify: `docs/RUNBOOKS/database.md` (two sections, "not yet applied")
- Test: create `packages/db/tests/order-numbers.integration.test.ts`; update `packages/db/tests/order-tools.integration.test.ts` (backup read policies 35 → 36)

**Interfaces (exact columns):** `app.site_counters`: `workspace_id uuid not null → workspaces on delete cascade`, `counter text not null` check `in ('sim_order_ref')`, `last_value integer not null` check `>= 0` (the last number issued), `updated_at`; primary key `(workspace_id, counter)`; `tenantPolicy('site_counters_tenant_policy')`, `backupReadPolicy('site_counters')`, `.enableRLS()`. 0016: `ALTER TABLE "app"."site_counters" FORCE ROW LEVEL SECURITY;`, `GRANT SELECT, INSERT, UPDATE ON TABLE "app"."site_counters" TO app_runtime;`. No function change. Paste file: A pre-check (`to_regclass('app.site_counters')` null, 0 tracker rows), `BEGIN` … `COMMIT`, verification selects: (1) forced; (2) its policies (tenant and backup read); (3) 36 backup read policies; (4) `has_table_privilege('app_runtime', …)` true for select, insert, update and false for delete; `backup_reader` select; (5) the counter check's definition; (6) both Drizzle rows.

- [ ] **Step 1: Write the failing tests** (RLS and FORCE on; no rows across sites; `app_runtime` cannot DELETE; counter `change_request_no` and `x` refused (Part B widens it); `last_value` −1 refused; two rows for one site and counter refused; 0016's statements re-run in a rolled-back transaction succeed; backup read policies 36).
- [ ] **Step 2: Run** `ENV(2) pnpm --filter @gt-sales/db test -- order-numbers order-tools` → FAIL.
- [ ] **Step 3: Implement** (schema, generate, the custom file, paste file with `sha256sum` of each file, runbook sections).
- [ ] **Step 4: Run** `ENV(2) pnpm --filter @gt-sales/db test` and `ENV(2) pnpm --filter backend test -- rls isolation backup-reader` → PASS.
- [ ] **Step 5: Commit** — `feat(db): per-site counters for order numbers (0015, 0016)`

---

### Task A3: Backend: SIM order intake in the lead-type registry

Wave A2. Model: hard.

**Files:**

- Modify: `apps/backend/src/leads/types.ts`, `apps/backend/src/leads/store.ts` (`updateLeadInTransaction` submit check; the grant select adds `leads.fullName`, `leads.phone`, `leads.payload`), `apps/backend/src/routes/website.ts` (POST and PATCH)
- Test: create `apps/backend/tests/sim-order-intake.test.ts`; update `apps/backend/tests/leads.test.ts`, `apps/backend/tests/leads-store.integration.test.ts`

**Interfaces:**

- Consumes: A1 `simOrderLeadPayloadSchema`.
- Produces:

```ts
// types.ts
export type LeadIntakeProblem = 'leadType' | 'submit' | 'form' | 'contact' | 'order';
export interface SubmittableLead {
  contact: LeadContact;
  payload: Readonly<Record<string, unknown>> | null;
  planId: string | null;
}
interface LeadTypeDefinition { …; /** What a submission must carry beyond `requiredContact`; undefined = ready. */
  submitCheck?: (lead: SubmittableLead) => LeadIntakeProblem | undefined }
export function checkLeadForm(leadType: string, form: LeadForm | undefined): LeadIntakeCheck; // a modelled type's PATCH form
export function checkLeadSubmit(leadType: string, lead: SubmittableLead): LeadIntakeCheck;
// checkLeadIntake(input & { order?: LeadOrderIntake }) also runs checkLeadSubmit when submit is true
// store.ts
UpdateLeadOutcome += { status: 'submission_incomplete'; problem: LeadIntakeProblem }
```

`leadTypes.sim_order = { payload: simOrderLeadPayloadSchema, oneShot: false, requiredContact: [], submitCheck }`: no `fullName` or `email` → `contact`; no `planId` → `order`; no `payload.delivery` → `form`; `delivery: 'pickup'` without a non-blank `shippingAddress` → `form`. In `updateLead`, the submit check runs on the lead as the save leaves it (incoming contact over stored, incoming form else stored payload, `order.planId` else the draft's) and refuses with `UpdateRefused` before anything is written. The PATCH route runs `checkLeadForm` on `body.data.form` (400 `{ field: 'form' }`) and maps `submission_incomplete` to `400 validation_error { field: problem }`.

- [ ] **Step 1: Write the failing tests.** Unit (`sim-order-intake.test.ts`): a draft create with only `{ fullName: 'Nadia Khan' }` is ok; a submitted create without email → `contact`, without `order` → `order`, without delivery → `form`, `pickup` without address → `form`, with `simNumber` in the payload → `form`; a complete one ok; `checkLeadForm('sim_order', { schemaVersion: 1, payload: { delivery: 'drone' } })` → `form`; `checkLeadForm('contact_message', …)` any payload ok. Route (`leads.test.ts`, mocked store): POST with a refused submit → 400 `{ field: 'order' }` and the store not called; PATCH with an unknown payload key → 400 `{ field: 'form' }`; `submission_incomplete` → 400 with its `field`. Integration (`leads-store.integration.test.ts`, `ENV(3)`, `…-0000000053xx`): a draft with name, email and arrival saved; PATCH `submit: true` with no plan → `submission_incomplete order`, the lead still `incomplete`, no `idempotency_keys` row; with plan and `delivery: 'esim'` → submitted, plan frozen; a CanadaWide `internet` create behaves as before.
- [ ] **Step 2: Run** `pnpm --filter backend test -- sim-order-intake leads` and `ENV(3) pnpm --filter backend test -- leads-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `ENV(3) pnpm --filter backend test -- lead-idempotency lead-order` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): SIM order intake checks in the lead-type registry`

---

### Task A4: Backend: order numbers from the per-site counter

Wave A3. Model: hard.

**Files:**

- Create: `apps/backend/src/leads/site-counter.ts`
- Modify: `apps/backend/src/leads/store.ts` (`createLead`, `toSummary`, `replayCreatedLead`, the update's summary)
- Test: create `apps/backend/tests/order-number.integration.test.ts`; update `apps/backend/tests/leads.test.ts`

**Interfaces:**

- Consumes: A1 `simOrderRef`; A2 `siteCounters`; A3 store.
- Produces:

```ts
export type SiteCounter = 'sim_order_ref';
/** The next number of `counter` for the site, in the caller's transaction (row-locked until commit). */
export async function nextSiteNumber(
  tx: TenantTransaction,
  workspaceId: string,
  counter: SiteCounter,
): Promise<number>;
```

One statement; unseeded, it starts after the site's highest imported `MS-<n>` (ruling S2):

```sql
insert into app.site_counters (workspace_id, counter, last_value)
values (${ws}, 'sim_order_ref', (
  select coalesce(max((substring(l.external_ref from '^MS-([0-9]{1,9})$'))::int), 0) + 1
  from app.leads l where l.workspace_id = ${ws} and l.lead_type = 'sim_order'))
on conflict (workspace_id, counter)
  do update set last_value = app.site_counters.last_value + 1, updated_at = now()
returning last_value
```

`createLead` takes the number after the idempotency claim and the order check, only for `leadType === 'sim_order'` with no `externalRef`, so a replay or a refused create consumes none; every summary carries `externalRef`.

- [ ] **Step 1: Write the failing tests** (`ENV(4)`, `…-0000000054xx`): a site whose imported leads are `MS-140` and `MS-143` (and a `partner_application` `PT-5`) → the first draft create is `MS-144`, the next `MS-145`; ten concurrent creates → ten distinct numbers, `MS-146` to `MS-155`; a create with `externalRef: 'MS-9000'` keeps it and the next is `MS-156`; an `internet` lead gets no reference; another site starts at `MS-1`; a keyed create replayed → the same `externalRef`, counter unchanged; a create refused `plan_not_available` → counter unchanged; the counter set to 200 by SQL → next `MS-201`; `PATCH` returns the reference. Route (`leads.test.ts`): the 201 body carries `lead.externalRef`.
- [ ] **Step 2: Run** `ENV(4) pnpm --filter backend test -- order-number leads` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole backend suite with `ENV(4)` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): number new SIM orders MS-<n> from the site's counter`

---

### Task A5: The final import: rehearsal with CRM orders present, the switch-day seed

Wave A4. Model: hard.

**Files:**

- Create: `docs/RUNBOOKS/manual/gcs-switch-day.sql`
- Modify: `apps/backend/tests/getcanadasim-legacy-import.integration.test.ts`, `docs/RUNBOOKS/legacy-import.md` (new section "The final run (switch day)")

**Interfaces:** the SQL file has a block between `-- SEED BEGIN` and `-- SEED END` that the test executes verbatim:

```sql
insert into app.site_counters (workspace_id, counter, last_value)
select w.id, 'sim_order_ref', coalesce((select max(o.order_no) from public.orders o), 0) + 9
from app.workspaces w where w.slug = 'getcanadasim'
on conflict (workspace_id, counter) do update
  set last_value = greatest(app.site_counters.last_value, excluded.last_value), updated_at = now();
```

and, after it, reconciliation selects: (1) `public.orders` count beside the count of `getcanadasim` `sim_order` leads with the same ids (`rows_missing` = the difference, expect 0); (2) `MS-` references held by more than one lead (expect no rows); (3) CRM orders since the flip (`MS-` leads whose id is not in `public.orders`); (4) the counter's `last_value`. The runbook section says: run as the import is run (Supabase SQL editor, `postgres`), the order is flip first, then the import, then reconcile, and the import never touches a CRM order (its ids are not in `public.orders`).

- [ ] **Step 1: Write the failing test** (`…-0000000055xx`, the suite's own `public.orders` fixture with `order_no` 141–143): the seed → `last_value` 152; a CRM `createLead` → `MS-153`; a `public.orders` row 144 inserted afterwards (the old checkout in the window) and the import re-run → lead `MS-144` imported, no unique violation; `MS-153` untouched by the import (stage, payload, timeline unchanged); the seed run again after the counter reached 160 → still 160; reconciliation (1) `rows_missing` 0, (2) no rows, (3) one CRM order.
- [ ] **Step 2: Run** `ENV(5) pnpm --filter backend test -- getcanadasim-legacy-import` → FAIL.
- [ ] **Step 3: Write** the SQL file and the runbook section (the import script itself needs no change; if the test shows one, fix it there with a test).
- [ ] **Step 4: Run** the same → PASS; `pnpm run format`.
- [ ] **Step 5: Commit** — `test(db): final Get Canada Sim import beside CRM orders, and the switch-day counter seed`

---

### Task A6 (Get Canada Sim repository): the CRM client and plan matching

Wave A1. Model: easy. Repository `/home/user/get-canada-sim`, branch `claude/crm-orders`.

**Files:**

- Create: `src/lib/crm.ts` (`import "server-only"`), `src/lib/crm-plans.ts`, `scripts/test-crm-client.mts`
- Modify: `package.json` (`test:crm-client`), `AGENTS.md` (environment table rows `CRM_ORDERS`, `CRM_API_URL`, `CRM_SITE_KEY` (secret); tests table row; `src/lib` map)

**Interfaces (Produces):**

```ts
// crm.ts
export const CRM_CONSENT_VERSION = 'getcanadasim-order-2026-10';
export interface CrmConfig {
  apiUrl: string;
  siteKey: string;
}
/** Both variables set and `apiUrl` https (http only for localhost); else null. */
export function crmConfig(env?: NodeJS.ProcessEnv): CrmConfig | null;
export type CrmMode = 'off' | 'on' | 'misconfigured';
export function crmOrdersMode(env?: NodeJS.ProcessEnv): CrmMode; // CRM_ORDERS === 'on'
export type CrmResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: string | null;
      field: string | null;
      retryAfter: number | null;
    };
export interface CrmCallOptions {
  visitorIp: string | null;
  draftGrant?: string;
  idempotencyKey?: string;
  customerGrant?: string;
}
export function crmVisitorId(siteKey: string, ip: string): string; // hex HMAC-SHA256(siteKey, ip)
/** The one HTTP path every call below uses (headers, timeout, error envelope). */
export async function crmRequest(
  config: CrmConfig,
  input: { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown },
  options: CrmCallOptions,
): Promise<CrmResult<unknown>>;
export interface SimOrderForm {
  planId?: string;
  planLabel?: string;
  delivery?: 'esim' | 'pickup';
  arrivalDate?: string;
  permitType?: string;
  gotVisa?: boolean;
  flightBooked?: boolean;
  shippingAddress?: string;
  canadaAddress?: string;
  reference?: string;
}
export interface SimOrderContact {
  fullName: string;
  email: string;
  phone: string;
  countryCode?: string;
}
export async function createSimOrderDraft(
  config: CrmConfig,
  input: { contact: SimOrderContact; form: SimOrderForm },
  options: CrmCallOptions,
): Promise<CrmResult<{ leadId: string; externalRef: string; draftGrant: string }>>;
export async function updateSimOrderDraft(
  config: CrmConfig,
  leadId: string,
  input: { contact: SimOrderContact; form: SimOrderForm },
  options: CrmCallOptions,
): Promise<CrmResult<{ leadId: string; externalRef: string }>>;
export async function submitSimOrder(
  config: CrmConfig,
  leadId: string,
  input: { form: SimOrderForm; planId: string; partnerCode: string | null },
  options: CrmCallOptions,
): Promise<CrmResult<{ leadId: string; externalRef: string; replayed: boolean }>>;
export async function uploadCheckoutDocument(
  config: CrmConfig,
  input: {
    leadId: string;
    documentType: 'passport' | 'visa';
    bytes: Uint8Array;
    contentType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  },
  options: CrmCallOptions,
): Promise<CrmResult<{ fileId: string }>>; // intent → PUT → finalize (sha256 hex)
export function parseOrderNo(externalRef: string): number | null; // 'MS-153' → 153
// crm-plans.ts
export const CRM_PLAN_SLUG_PROPERTY = 'custom_website_slug';
export interface CrmPlan {
  id: string;
  name: string;
  priceMinor: number;
  billingPeriod: string;
  properties: Record<string, unknown>;
}
export async function listCrmSimPlans(
  config: CrmConfig,
  options: CrmCallOptions,
): Promise<CrmResult<CrmPlan[]>>;
/** The one plan whose `custom_website_slug` equals `slug`; null for none or several. */
export function matchCrmPlan(slug: string, plans: readonly CrmPlan[]): CrmPlan | null;
```

Requests: `Authorization: Bearer <siteKey>`, `content-type: application/json`, `x-website-visitor-id` when an IP is known, `X-Draft-Grant` / `Idempotency-Key` / `X-Customer-Grant` when given, an 8 s timeout; create body `{ leadType: 'sim_order', contact, form: { schemaVersion: 1, payload: form }, consentVersion }`; update body `{ contact, form, consentVersion }`; submit body `{ form, order: { planId, quantity: 1 }, consentVersion, submit: true, attribution? }` with `attribution: { partnerCode }` only when given; plans `GET /api/v1/website/plans?leadType=sim_order`. A non-2xx answer reads `error.code` and `error.details.field` from `{ error: { code, message, requestId, details } }`; a network error or timeout is `{ ok: false, status: 0 }`. Nothing logs the key, the grant, the email or the body.

- [ ] **Step 1: Write the failing test** (`scripts/test-crm-client.mts`, `globalThis.fetch` replaced): the create request's URL, method, headers and exact body; the visitor id is 64 hex, the same for one IP, and never contains the IP; a 201 `{ lead: { id, externalRef: 'MS-153' }, draftGrant: { token: 'gtdg_x' } }` → `{ ok: true, data: { leadId, externalRef: 'MS-153', draftGrant: 'gtdg_x' } }`; a 400 `validation_error` with `details.field: 'order'` → `{ ok: false, code: 'validation_error', field: 'order' }`; a thrown fetch → `status: 0`; the submit sends `Idempotency-Key: gcs-order:<leadId>` only when given and no `attribution` key without a partner; `matchCrmPlan` finds each of the six slugs `unlimited-data-120gb-rogers`, `unlimited-data-rogers`, `75gb-fido`, `95gb-chatr`, `25gb-chatr`, `75gb-chatr` in a six-plan fixture, returns null for an unknown slug and for a slug two plans carry; `crmOrdersMode` is `off` unset, `misconfigured` with `CRM_ORDERS=on` and no key, `on` with both; `parseOrderNo('MS-153')` 153, `('PT-5')` null.
- [ ] **Step 2: Run** `npm run test:crm-client` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** — `feat(order): CRM website API client and plan matching (dark)`

---

### Task A7 (Get Canada Sim repository): the checkout through the CRM

Wave A3. Model: hard. Repository `/home/user/get-canada-sim`, branch `claude/crm-orders`.

**Files:**

- Modify: `src/app/order/actions.ts` (`startOrder`, `submitOrder`), `src/lib/order-draft.ts` (`OrderDraft` gains `crm: { leadId: string; grant: string; externalRef: string } | null`, validated), `src/app/order/confirmation/page.tsx` (unchanged reading of `orderNo`; check only), `AGENTS.md` ("Data flow" order paragraph)
- Create: `scripts/test-crm-checkout.mts`; modify `package.json` (`test:crm-checkout`)

**Interfaces:**

- Consumes: A6 everything; A4's `lead.externalRef`.
- Produces: with `crmOrdersMode() === 'on'`:
  - `startOrder`: same validation and spam/bot checks; the website's own throttles run when Supabase is configured; no `public.orders` write. A draft cookie with `crm` set → `updateSimOrderDraft` on that lead (a `401`/`409` answer starts a new draft); otherwise `createSimOrderDraft` with contact (`countryCode` from `x-vercel-ip-country`) and form `{ arrivalDate?, flightBooked, gotVisa, permitType, reference?, planId?, planLabel? }`; the cookie stores `crm` and `orderNo = parseOrderNo(externalRef)`. A cookie without `crm` is ignored (ruling S3).
  - `submitOrder`: a cookie without `crm` → "Your session expired. Please start again from step 1."; partner lookup as today but selecting `partner_no` too, `partnerCode = 'PT-' + partner_no`; for the partner variant each file is sniffed (HEIC/HEIF → "Use a JPG, PNG, or PDF file.") and sent with `uploadCheckoutDocument`; `listCrmSimPlans` + `matchCrmPlan(values.plan)` → none: "This plan can't be ordered right now. Please choose another plan or contact us." and nothing submitted; `submitSimOrder` with the full form (step-1 values from the cookie plus step 2: `delivery`, `shippingAddress` when `pickup`, `canadaAddress`, `reference`, `planId` slug, `planLabel`) and `Idempotency-Key: gcs-order:<leadId>`; a `409 draft_already_submitted` counts as a double submit (no mail, redirect); success → the website's confirmation and internal alert through `enqueueAndSend` keyed `order_confirmation:<leadId>` / `order_internal_alert:<leadId>` with `orderNo` from the reference; `ms_order` cookie; no `partner_earnings`; redirect `/order/confirmation`. A CRM 5xx or `status: 0` → "We couldn't save your order just now. Please try again in a moment.".
  - `misconfigured` → both actions answer "This form is temporarily unavailable. Please try again later or contact support." and log `crm_orders_misconfigured` (ruling P3). `off` → today's code path unchanged.

- [ ] **Step 1: Write the failing test** (`scripts/test-crm-checkout.mts`, stubs `next/headers` and `next/navigation`, `fetch` replaced, a form token from `issueFormToken()`, Supabase unset): flag on, step 1 → one `POST /api/v1/website/leads` with `leadType: 'sim_order'` and no `submit`, cookie `ms_draft` holds `crm.leadId`, `orderNo` 153; step 1 again with that cookie → one `PATCH` to the same lead, no second create; step 2 → one `GET /plans`, one `PATCH` with `submit: true`, `order.planId` the matched uuid, header `Idempotency-Key: gcs-order:<leadId>`, form `delivery: 'pickup'` and `shippingAddress`; redirect `NEXT_REDIRECT:/order/confirmation`, `ms_order.orderNo` 153; a slug no CRM plan carries → the plan copy, no submit request; a `409 draft_already_submitted` → redirect, no error; an old-style cookie (`crm` absent) at step 2 → the session copy; `CRM_ORDERS=on` without a key → the unavailable copy and no fetch; flag off → no fetch at all; no request body or log line holds the site key.
- [ ] **Step 2: Run** `npm run test:crm-checkout` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** — `feat(order): send SIM orders to the CRM behind CRM_ORDERS`

---

### Task A8 (Get Canada Sim repository): read-only Orders board and the interim `/track`

Wave A2. Model: easy. Repository `/home/user/get-canada-sim`, branch `claude/crm-orders`.

**Files:**

- Create: `src/lib/crm-switch.ts` (`ordersMovedToCrm(env?: NodeJS.ProcessEnv): boolean` = `crmOrdersMode(env) !== 'off'`; `crmTrackingMode(env?: NodeJS.ProcessEnv): CrmMode` = `CRM_TRACKING === 'on'` with the same config check as `crmOrdersMode`; the two notice texts), `src/app/admin/CrmOrdersNotice.tsx`, `scripts/test-orders-read-only.mts`
- Modify: `src/app/admin/orders/page.tsx`, `src/app/admin/orders/archive/page.tsx`, `src/app/admin/page.tsx` (`live` false when moved, the notice), every order mutation in `src/app/admin/actions.ts` (refuse first: `{ ok: false, error: "Orders are worked in the CRM now." }`), `src/app/track/page.tsx`, `src/app/track/actions.ts` (`submitEditRequest`, `authorizeTrackDocumentUpload`, `finalizeTrackDocumentUpload` refuse with "Changes are made by email for now: reply to your order confirmation." while `ordersMovedToCrm() && crmTrackingMode() === 'off'`), `src/app/track/TrackOrders.tsx` (no edit or upload controls, the notice), `package.json` (`test:orders-read-only`), `AGENTS.md`

**Interfaces:** Consumes A6 `crmOrdersMode`. Copy: board notice "Orders are now worked in the GT Sales CRM. This board shows orders placed before the move, read-only."; `/track` notice "Orders placed from the move to our new system don't show here yet. To change an order, reply to your order confirmation email." (ruling S4). Internet and mobility boards untouched (ruling 9).

- [ ] **Step 1: Write the failing test** (`scripts/test-orders-read-only.mts`): with `CRM_ORDERS=on` each order mutation action named in `admin/actions.ts` returns the CRM copy before touching Supabase (a stub client records no call); the mobility and internet actions still run; `submitEditRequest` and the two upload actions return the email copy; with the flag off all behave as before.
- [ ] **Step 2: Run** `npm run test:orders-read-only` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** — `feat(admin): Orders board read-only once orders move to the CRM`

---

### Task A9: Docs for Part A

Wave A4. Model: easy.

- Modify: `AGENTS.md` (vocabulary: **order number**, `MS-<n>` from the site's counter `app.site_counters`, a website's own `externalRef` kept as sent; where things live: `src/leads/site-counter.ts`), `docs/HANDOFF.md` (§2.4 `site_counters`; §2.6 item 3 `sim_order` modelled (the submit rules, the payload keys, the refusals) and a new item on order numbers; §3.8 "merge phase 5, step A"; §5.1 owner steps: apply 0015/0016, create the Get Canada Sim site key (`leads:write`, `uploads:customer`), the "Website slug" plan property and six plans, the switch day (Task A11)), `docs/PLAN.md` (§7 status, §10 owner items), `docs/RUNBOOKS/legacy-import.md` (cross-link from the Get Canada Sim section to the final run), `docs/superpowers/phases/README.md` (phase 5 row: "Step A built"), `docs/superpowers/phases/phase-5-customer-tracking.md` (status; migrations are 0015–0018).
- [ ] **Step 1: Edit, `pnpm run format`, commit** — `docs: phase 5 step A, Get Canada Sim orders in the CRM`

---

### Task A10: Part A gate, pull requests, migrations, deploy

Wave A4. Model: easy.

- [ ] **Step 1: Gate (CRM):** `pnpm run lint && pnpm run typecheck && pnpm run format`; `ENV(10) pnpm run test`; `pnpm --filter admin test:e2e:leads` (and once under `TZ=UTC`); `pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json` → all green, no diff.
- [ ] **Step 2: CRM PR** "Get Canada Sim orders into the CRM (merge phase 5, step A)" from `phase-5-customer-tracking` with the footer; subscribe to its activity and schedule a check-in (`send_later`); drive `verify` green.
- [ ] **Step 3: Apply 0015 + 0016 to `xykrphbgpwisqacpyeiv` before merging** (the new backend writes `app.site_counters`): pre-check A; the `CREATE TABLE`, constraint, index and policy statements through `execute_sql` in small batches; `ALTER TABLE … FORCE ROW LEVEL SECURITY`, the `ENABLE` and the grant handed to the owner as a paste from the paste file if the prompt trips; the four tracker rows by hand; the six verification selects one at a time; record date, versions, hashes and results in `docs/RUNBOOKS/database.md` and HANDOFF §5.1.
- [ ] **Step 4: Deploy:** merge with a merge commit; Railway backend build from `main`, `GET /api/v1/health` 200; Vercel admin from `main`. Live check: the admin opens a Get Canada Sim order; `GET /api/v1/website/plans?leadType=sim_order` with the Get Canada Sim key lists the site's plans; CanadaWide's intake is untouched (its newest lead after the deploy arrived as before).
- [ ] **Step 5: Get Canada Sim PR** `claude/crm-orders` → `main` ("Send SIM orders to the CRM, dark"), its CI green (`npm run lint`, `npm test`, `npm run build`); merge only with the owner's approval; Vercel production deploy with `CRM_API_URL` and `CRM_SITE_KEY` set and `CRM_ORDERS` unset; the checkout behaves exactly as before.

---

### Task A11: Switch day (owner-run, the day the owner picks)

Runs after Task B15's deploy (owner decision D10); add as a final step: `CRM_TRACKING` on in Vercel production, then a real customer's change request approved in the CRM (spec §12 done when).

Wave A4. Model: easy. The session prepares the commands and records results; the owner runs each step.

Before the day: Tasks A10's both deploys live; the Get Canada Sim site key holds `leads:write` and `uploads:customer`; six active `sim_order` plans carry the six slugs in "Website slug"; a Vercel preview with `CRM_ORDERS=on` placed one test order that appears in the CRM with an `MS-` number, then staff archived it; the import rehearsal of Task A5 passed against a copy of production counts.

Switch day, exactly as spec §5:

- [ ] **Step 1:** Staff resolve the pending change requests in the old admin.
- [ ] **Step 2:** The order counter is seeded from the highest `MS-` number in `public.orders` (the SEED block of `docs/RUNBOOKS/manual/gcs-switch-day.sql`); the website's `CRM_ORDERS` flag goes on (Vercel production, redeploy), so every new order now lands in the CRM.
- [ ] **Step 3:** The import runs one final time (`packages/db/sql/getcanadasim-legacy-import.sql`; it only fills what the CRM lacks, so orders placed just before the flip are caught); counts reconciled (the reconciliation selects: `rows_missing` 0, no duplicated `MS-` reference).
- [ ] **Step 4:** A test order goes through and is checked in the CRM (its `MS-` number above the seed, plan frozen, the website's confirmation email received); the old admin's Orders board is read-only.
- [ ] **Step 5:** Record the day, the seed value and the reconciliation results in HANDOFF §3.8 and §5.1; commit `docs: Get Canada Sim switch day recorded`.

---

## Part B: customer tracking (step B, second pull request)

### Task B1: Contracts: tracking vocabulary, two decision templates, the code job, scope and error codes

Wave B1. Model: hard.

**Files:**

- Modify: `packages/contracts/src/customer-email.ts`, `lead-work.ts` (system entry), `common.ts`, `website-bot.ts`, `index.ts`; `packages/types/src/index.ts` (`websiteScopeNames`); `packages/adapters/src/messaging.ts` (`siteContentEmailTemplates` += the two); `apps/backend/src/email/starters.ts` (two starters)
- Create: `packages/contracts/src/tracking.ts` (constants and field schemas; endpoints come in B2)
- Test: create `packages/contracts/src/tracking.test.ts`; update `customer-email.test.ts`, `schemas.test.ts`, `apps/backend/tests/email-starters.test.ts`, `packages/adapters/src/messaging.test.ts`
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// tracking.ts
export const TRACKING_CODE_TTL_MS = 600_000; export const TRACKING_MAX_ATTEMPTS = 5;
export const TRACKING_EMAIL_WINDOW_SECONDS = 600; export const TRACKING_CODE_REQUESTS_PER_EMAIL = 5;
export const TRACKING_VERIFICATIONS_PER_EMAIL = 10; export const TRACKING_WRITES_PER_EMAIL = 30;
export const TRACKING_MIN_LATENCY_MS = 500; export const TRACKING_GRANT_TTL_MS = 1_800_000;
export const MAX_TRACKED_ORDERS = 50; export const TRACKING_GRANT_HEADER = 'X-Customer-Grant';
export const CHANGE_REQUEST_STAGES = ['pending', 'verified', 'on_hold'] as const;
export const CHANGE_REQUEST_DOCUMENTS = ['passport', 'visa'] as const;
export const CHANGEABLE_FIELD_KEYS = ['fullName','phone','planId','delivery','arrivalDate','permitType','canadaAddress','shippingAddress','flightBooked'] as const;
export const changeRequestFieldsSchema: z.ZodObject; // strict, all optional: fullName trim 2–160, phone trim 7–40 (≥7 digits),
//   planId uuid, delivery SIM_ORDER_DELIVERIES, arrivalDate calendar date, permitType SIM_ORDER_PERMIT_TYPES,
//   canadaAddress trim 1–300 | null, shippingAddress trim 5–400 | null, flightBooked boolean
export type ChangeRequestFields = z.infer<typeof changeRequestFieldsSchema>;
export const TRACKING_STAGE_WORDS: Readonly<Record<OrderLeadType, Readonly<Record<string, string>>>>;
export function trackingStageWord(leadType: string, stage: string): string; // 'In progress' when unlisted
export const trackingDocumentStateSchema = z.enum(['missing', 'received', 'approved', 'needs_replacement']);
// customer-email.ts
CUSTOMER_EMAIL_TEMPLATES += 'change_approved', 'change_rejected' (after 'sim_number_ready'); labels 'Change approved', 'Change rejected'
export const ALWAYS_SENT_TEMPLATES: readonly CustomerEmailTemplate[] = ['tracking_code', 'change_approved', 'change_rejected'];
export const TRACKING_CODE_JOB_TYPE = 'tracking_code_email';
export const trackingCodeJobPayloadSchema = z.object({ challengeId: z.uuid(), toAddress: z.email(), contactHash: z.string().min(1), sealedCode: z.string().min(1).max(100), expiresAt: isoDateTimeSchema }).strict();
export const trackingCodeScrubbedPayloadSchema = z.object({ challengeId: z.uuid() }).strict();
// types: websiteScopeNames = ('leads:write', 'uploads:customer', 'tracking')
// website-bot: websiteBotActions += 'tracking-request', 'tracking-verify'
// common: domainErrorCodeSchema += 'change_request_not_allowed'
// lead-work: system entry += { changeRequestId: z.uuid().optional() }; `fields`/`documents` documented for change_requested and change_approved
```

Stage words: `sim_order` pending "Received", verified "Confirmed", on_hold "Waiting on you", delivered "On its way", activated "Active", completed "Completed", cancelled "Cancelled"; `internet` new "Received", contacted / qualified / existing_shaw / old_due "In progress", non_serviceable_address and lost "Closed", installed "Installed", won "Completed"; `mobility` new "Received", contacted / qualified "In progress", activated "Active", won "Completed", lost "Closed". Fill-ins (ruling T9): `first name`, `site name`, `tracking link` add both decision templates; `last name`, `plan`, `price` exclude them. Starters: `change_approved` subject "Your change request was approved", body "Hi {first name},\n\nThe changes you asked for on your order with {site name} have been made.\n\nReply to this email if anything looks wrong."; `change_rejected` subject "About your change request", body "Hi {first name},\n\nWe could not make the changes you asked for on your order with {site name}. Reply to this email and we will help."; `listEmailTemplatesResponseSchema` length 9.

- [ ] **Step 1: Write the failing tests.** `tracking.test.ts`: `changeRequestFieldsSchema` accepts `{ phone: '+1 647 555 0123', arrivalDate: '2026-11-20' }`, refuses `email`, `planId: 'unlimited-data-rogers'`, `arrivalDate: '2026-02-30'`, `delivery: 'airport'`, `shippingAddress: 'x'`; `trackingStageWord('sim_order','on_hold')` 'Waiting on you', `('sim_order','cancelled')` 'Cancelled', `('sim_order','paid')` 'In progress'; every listed stage of the three types has a word; `CHANGE_REQUEST_STAGES` are `sim_order` stages. `customer-email.test.ts`: nine templates; `fillInsForTemplate('change_approved')` equals `['first name','site name','tracking link']`; `ALWAYS_SENT_TEMPLATES` exact; the code job payload refuses `code: '123456'` (extra key) and a 101-character `sealedCode`. `schemas.test.ts`: a `change_approved` entry with `requestNo`, `changeRequestId`, `fields`, `documents` parses. `email-starters.test.ts`: the nine starters parse, render with samples, fit the limits. Adapters: the two keys are site-content templates (no built-in copy).
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- tracking customer-email schemas`, `pnpm --filter @gt-sales/adapters test -- messaging`, `pnpm --filter backend test -- email-starters` → FAIL.
- [ ] **Step 3: Implement**; `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the three suites and `pnpm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): tracking vocabulary, change decision templates, the code job and the tracking scope`

---

### Task B2: Contracts: tracking and change request API shapes, endpoints, client

Wave B2. Model: easy.

**Files:**

- Modify: `packages/contracts/src/tracking.ts`, `lead-work.ts`, `workspace-leads.ts` (`leadAccessSchema`), `endpoints.ts`, `client.ts`, `index.ts`
- Test: `packages/contracts/src/openapi.test.ts`, `tracking.test.ts`, `schemas.test.ts`, `client.test.ts`
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// tracking.ts (website)
const trackingEmailSchema = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/); // as leadContactSchema.email
export const trackingCodeRequestSchema = z.object({ email: trackingEmailSchema }).strict();
export const trackingCodeResponseSchema = z.object({ status: z.literal('code_sent'), requestId });
export const trackingVerifyRequestSchema = z
  .object({ email: trackingEmailSchema, code: z.string().regex(/^\d{6}$/) })
  .strict();
export const trackingGrantSchema = z.object({
  token: z.string().min(1).max(2048),
  expiresAt: isoDateTimeSchema,
});
export const trackingVerifyResponseSchema = z.object({ grant: trackingGrantSchema, requestId });
export const trackingReferenceSchema = z.string().trim().min(1).max(128);
export const trackingPendingChangeSchema = z.object({
  requestNo: z.int().positive(),
  fields: changeRequestFieldsSchema,
  documents: z.array(z.enum(CHANGE_REQUEST_DOCUMENTS)),
  createdAt,
  updatedAt,
});
export const trackingOrderSchema = z
  .object({
    reference: trackingReferenceSchema,
    leadType: orderLeadTypeSchema,
    stage: leadStageSchema,
    stageLabel: z.string(),
    submittedAt: isoDateTimeSchema,
    plan: z
      .object({
        id: z.uuid().nullable(),
        name: z.string(),
        priceMinor: z.int().min(0),
        billingPeriod: billingPeriodSchema,
      })
      .nullable(),
    quantity: z.int().min(1).max(99),
    delivery: z.enum(SIM_ORDER_DELIVERIES).nullable(),
    courier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    dispatchedAt: orderDateSchema.nullable(),
    simNumber: z.string().nullable(),
    details: z.object({
      fullName,
      phone,
      arrivalDate,
      permitType,
      canadaAddress,
      shippingAddress,
      flightBooked,
    }), // each nullable
    documents: z.array(
      z.object({ documentType: documentChecklistKeySchema, state: trackingDocumentStateSchema }),
    ),
    canRequestChange: z.boolean(),
    pendingChange: trackingPendingChangeSchema.nullable(),
  })
  .strict(); // no payment, commission, notes, tasks, assignee or custom values
export const trackingOrdersResponseSchema = z.object({
  orders: z.array(trackingOrderSchema).max(MAX_TRACKED_ORDERS),
  requestId,
});
export const createTrackedChangeRequestSchema = z
  .object({ fields: changeRequestFieldsSchema.refine(non - empty) })
  .strict();
export const trackedChangeResponseSchema = z.object({
  changeRequest: trackingPendingChangeSchema,
  requestId,
});
export const trackingUploadIntentRequestSchema = z
  .object({
    documentType: z.enum(CHANGE_REQUEST_DOCUMENTS),
    contentType: documentMediaTypeSchema,
    sizeBytes: z.int().positive().max(MAX_DOCUMENT_BYTES),
  })
  .strict();
// lead-work.ts (staff)
export const staffChangeRequestSchema = z.object({
  id: z.uuid(),
  requestNo: z.int().positive(),
  status: z.enum(['pending', 'approved', 'rejected']),
  fields: changeRequestFieldsSchema,
  documents: z.array(
    z.object({ fileId: z.uuid(), documentType: z.enum(CHANGE_REQUEST_DOCUMENTS) }),
  ),
  version: z.int().positive(),
  createdAt,
  updatedAt,
});
getWorkspaceLeadResponseSchema += {
  changeRequest: staffChangeRequestSchema.nullable().default(null),
}; // the pending one; null without contact access
leadAccessSchema += { decideChanges: z.boolean().optional() }; // lead.manage
export const resolveChangeRequestRequestSchema = z
  .object({ expectedVersion: z.int().positive() })
  .strict();
export const changeDecisionEmailSkippedSchema = z.object({
  template: z.enum(['change_approved', 'change_rejected']),
  reason: z.enum(['no_sender', 'no_customer_email', 'missing_fill_in']),
  missing: z.array(z.enum(EMAIL_FILL_IN_KEYS)).optional(),
});
export const resolveChangeRequestResponseSchema = z.object({
  lead: leadDetailSchema,
  activities: z.array(leadActivitySchema),
  allowedMoves: z.array(leadStageSchema),
  emailSkipped: changeDecisionEmailSkippedSchema.optional(),
  requestId,
});
// Each schema exports its type: TrackingOrder, TrackingPendingChange, TrackingOrdersResponse, StaffChangeRequest,
// ResolveChangeRequestRequest, ResolveChangeRequestResponse, ChangeDecisionEmailSkipped, TrackingUploadIntentRequest.
```

Endpoints (website ones `auth: 'customer'` except the first two, `'website'`): `requestTrackingCode` POST `/api/v1/website/tracking/code` 200; `verifyTrackingCode` POST `/api/v1/website/tracking/verify` 200; `listTrackedOrders` GET `/api/v1/website/tracking/orders` 200; `createTrackedOrderChange` POST `/api/v1/website/tracking/orders/{reference}/changes` 201; `createTrackedOrderUpload` POST `/api/v1/website/tracking/orders/{reference}/uploads/intents` 201 (response `createUploadIntentResponseSchema`); `finalizeTrackedOrderUpload` POST `/api/v1/website/tracking/orders/{reference}/uploads/{uploadId}/finalize` 200 (request `finalizeUploadRequestSchema`, response `trackedChangeResponseSchema`); the four `customer` ones carry header `{ name: 'X-Customer-Grant', required: true, description: 'The 30-minute grant from verifyTrackingCode, bound to this site and email.' }`. Staff: `approveLeadChangeRequest` and `rejectLeadChangeRequest` POST `/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/change-requests/{changeRequestId}/approve|reject` 200. Client: `client.tracking.{ requestCode(body), verify(body), orders({ customerGrant }), requestChange(reference, body, { customerGrant }), createUpload(reference, body, { customerGrant }), finalizeUpload(reference, uploadId, body, { customerGrant }) }`; `client.staff.{ approveChangeRequest, rejectChangeRequest }(workspaceId, leadId, changeRequestId, body)`.

- [ ] **Step 1: Write the failing tests** (the eight operation ids, methods, paths and success codes; the four customer ones document `X-Customer-Grant`; a tracked order with `paymentStatus` refused; `createTrackedChangeRequestSchema` refuses `{ fields: {} }` and `{ fields: { email: 'a@b.co' } }`; a lead response without `changeRequest` parses to null; the client sends `x-customer-grant` and parses each response).
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- openapi tracking schemas client` → FAIL.
- [ ] **Step 3: Implement**, `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the contracts suite, `pnpm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): customer tracking and change request endpoints`

---

### Task B3: Database: 0017 and 0018 (challenges, change requests, held files, two templates, pruning)

Wave B1. Model: hard.

**Files:**

- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0017_customer_tracking.sql` (`db:generate -- --name customer_tracking`), `0018_customer_tracking_runtime.sql` (`--custom --name customer_tracking_runtime`), journal entries, `docs/RUNBOOKS/manual/0017-0018-customer-tracking.sql`
- Modify: `docs/RUNBOOKS/database.md` (two sections, "not yet applied")
- Test: create `packages/db/tests/customer-tracking.integration.test.ts`; update `packages/db/tests/order-tools.integration.test.ts` and `order-numbers.integration.test.ts` (backup read policies 36 → 38; the counter list), `apps/backend/tests/operational-retention.integration.test.ts`

**Interfaces (exact columns):**

- `tracking_challenges`: `id uuid pk`, `workspace_id → workspaces cascade`, `email_hash text not null` and `code_hash text not null`, each check `~ '^[0-9a-f]{64}$'`, `attempts integer not null default 0` check `>= 0`, `status text not null default 'pending'` check `in ('pending','consumed')`, `expires_at timestamptz not null`, `consumed_at timestamptz`, `created_at`; check `(status = 'consumed') = (consumed_at is not null)`; index `tracking_challenges_workspace_email_idx (workspace_id, email_hash, status, created_at desc)`.
- `change_requests`: `id uuid pk`, `workspace_id → workspaces cascade`, `lead_id uuid not null` (FK `(workspace_id, lead_id)` → `leads (workspace_id, id)` cascade), `request_no integer not null` check `> 0`, `status text not null default 'pending'` check `in ('pending','approved','rejected')`, `requested jsonb not null default '{}'` (personal data, never copied), `staged_file_ids uuid[] not null default array[]::uuid[]`, `version integer not null default 1` check `> 0`, `created_by uuid not null`, `resolved_by uuid`, `resolved_at timestamptz`, `created_at`, `updated_at`; check `(status = 'pending') = (resolved_at is null and resolved_by is null)`; unique `(workspace_id, id)`, unique `change_requests_workspace_request_no_unique (workspace_id, request_no)`; partial unique index `change_requests_one_pending (workspace_id, lead_id) where status = 'pending'`; index `(workspace_id, lead_id, created_at desc)`.
- `files.held_for_change_request boolean not null default false`.
- `emailTemplateKeyList` += `'change_approved'`, `'change_rejected'` (both `email_templates` and `email_template_versions` checks); `site_counters` counter check `in ('sim_order_ref','change_request_no')`.
- The two tables: `tenantPolicy`, `backupReadPolicy`, `.enableRLS()` (backup read policies 36 → 38). 0018: FORCE RLS on both; `GRANT SELECT, INSERT, UPDATE` on both (no DELETE); `CREATE OR REPLACE FUNCTION app.prune_operational_rows` = 0014's body plus one block, `tracking_challenges` with `expires_at < p_now - interval '1 day'`, `LIMIT 1000`, `table_name 'tracking_challenges'`, then the same `REVOKE` / `GRANT EXECUTE` as 0014 (owner paste).
- Paste file as `0013-0014-order-tools.sql`: pre-check (two `to_regclass` null, no `held_for_change_request` column, 0 tracker rows); `BEGIN` … `COMMIT`; verification selects: (1) the two forced; (2) their four policies; (3) 38 backup read policies; (4) grants per table and verb (no DELETE; `backup_reader` select); (5) the column with its default; (6) the two template checks name both new keys and the counter check names `change_request_no`; (7) the prune function's `prosrc` names `tracking_challenges`; (8) both Drizzle rows.

- [ ] **Step 1: Write the failing tests** (RLS and FORCE on both; no rows across sites; `app_runtime` cannot DELETE either; a second pending request on one lead refused, a pending beside an approved allowed; request number unique per site, the same number on two sites allowed; `approved` without `resolved_at` refused; `email_hash` 'abc' refused; `attempts` −1 refused; `consumed` without `consumed_at` refused; template key `change_approved` accepted, `change_cancelled` refused; counter `change_request_no` accepted; a file defaults to `held_for_change_request false`; 0018 re-run in a rolled-back transaction succeeds. Retention: a challenge expired 25 h ago pruned, 23 h kept; change requests never pruned; the prune result lists `tracking_challenges`.)
- [ ] **Step 2: Run** `ENV(23) pnpm --filter @gt-sales/db test -- customer-tracking` → FAIL.
- [ ] **Step 3: Implement** (schema, generate, the custom file, paste file with `sha256sum` of each file, runbook sections).
- [ ] **Step 4: Run** `ENV(23) pnpm --filter @gt-sales/db test` and `ENV(23) pnpm --filter backend test -- operational-retention rls isolation backup-reader` → PASS.
- [ ] **Step 5: Commit** — `feat(db): tracking challenges, change requests, held files and the decision templates (0017, 0018)`

---

### Task B4: Backend: tracking secrets, grant and sealed values (pure, ported)

Wave B1. Model: hard.

**Files:**

- Create: `apps/backend/src/tracking/secrets.ts`
- Modify: `apps/backend/src/crypto/cipher.ts`, `apps/backend/src/crypto/cipher.test.ts`
- Test: create `apps/backend/tests/tracking-secrets.test.ts` (ported from Canadian Plans `tracking/secrets.test.ts` and `cipher.test.ts`)

**Interfaces (Produces):**

```ts
// secrets.ts (normalization is normalizeContactEmail from ../leads/store.js)
export function emailBindingHash(
  secret: string,
  workspaceId: string,
  normalizedEmail: string,
): string; // hmac 'email:v1\n<ws>\n<email>'
export function codeBindingHash(
  secret: string,
  workspaceId: string,
  normalizedEmail: string,
  code: string,
): string;
export function emailRateBucket(
  secret: string,
  workspaceId: string,
  normalizedEmail: string,
  purpose: 'code' | 'verify' | 'write',
): string; // 'tracking:<purpose>:<hex>'
export function generateTrackingCode(): string; // randomInt(0, 1_000_000), 6 digits
export function hashesEqual(a: string, b: string): boolean; // timing-safe, false for empty or unequal length
export interface TrackingGrantIdentity {
  workspaceId: string;
  normalizedEmail: string;
  emailHash: string;
}
export function signTrackingGrant(
  secret: string,
  input: { workspaceId: string; normalizedEmail: string },
  nowMs: number,
): { token: string; expiresAt: string }; // TRACKING_GRANT_TTL_MS
export function verifyTrackingGrant(
  secret: string,
  token: string,
  nowMs: number,
): TrackingGrantIdentity | undefined;
export function loadTrackingSecret(env?: NodeJS.ProcessEnv): string | undefined; // TRACKING_HASH_SECRET trimmed, ≥ 32 chars
// cipher.ts
export interface TrackingCodeBinding {
  workspaceId: string;
  challengeId: string;
} // orderId removed (ruling T8)
export function sealTrackingEmail(
  secret: string,
  binding: { workspaceId: string; emailHash: string },
  normalizedEmail: string,
): string;
export function openTrackingEmail(
  secret: string,
  binding: { workspaceId: string; emailHash: string },
  sealed: string,
): string | undefined;
```

Grant body `{ v: 1, workspaceId, emailHash, sealedEmail, exp }`, base64url JSON, `.` HMAC-SHA256 base64url, parsed strictly; key purposes `gt-sales-crm:tracking-code:v2` and `gt-sales-crm:tracking-grant-email:v1`.

- [ ] **Step 1: Write the failing tests** (ported: hashes differ by site, email and code; `normalizeContactEmail(' Nadia@Example.COM ')` gives the same hash as `nadia@example.com`; a grant verifies within 30 minutes and not at `nowMs + 1_800_000`; a grant for site A verifies as site A only (the caller compares); a tampered body, signature or sealed email → undefined; a code sealed for one challenge does not open for another or another site; `openTrackingCode` refuses a 101-character input; `generateTrackingCode()` matches `/^\d{6}$/` over 1000 draws; `loadTrackingSecret` undefined for unset and a 31-character value; rate buckets never contain the email).
- [ ] **Step 2: Run** `pnpm --filter backend test -- tracking-secrets cipher` → FAIL.
- [ ] **Step 3: Implement** (no database, no environment reads outside `loadTrackingSecret`).
- [ ] **Step 4: Run** → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): tracking hashes, signed grant and sealed code, ported from Canadian Plans`

---

### Task B5: Backend: tracking store and service (challenges and the customer's orders)

Wave B2. Model: hard.

**Files:**

- Create: `apps/backend/src/tracking/store.ts`, `apps/backend/src/tracking/service.ts`
- Test: create `apps/backend/tests/tracking-store.integration.test.ts` (port the matching cases of Canadian Plans' `tracking-store.integration.test.ts`)

**Interfaces:**

- Consumes: B1 constants and `TRACKING_CODE_JOB_TYPE`; B3 tables; B4 secrets and cipher.
- Produces:

```ts
// store.ts
export type ConsumeOutcome = 'verified' | 'invalid' | 'expired' | 'exhausted' | 'not_found';
export interface WebsiteScope {
  workspaceId: string;
  actorId: string;
} // actor = the credential id
export interface QueueChallengeInput extends WebsiteScope {
  challengeId: string;
  normalizedEmail: string;
  emailHash: string;
  codeHash: string;
  sealedCode: string;
  contactHash: string;
  expiresAt: Date;
  now: Date;
}
export interface TrackedLeadRef {
  leadId: string;
  leadType: string;
  stage: string;
}
export interface TrackingStore {
  hasTrackableLeads(input: WebsiteScope & { normalizedEmail: string }): Promise<boolean>;
  /** Supersedes the email's pending challenge and its unsent job, then inserts one challenge and one job. */
  createChallengeAndQueue(input: QueueChallengeInput): Promise<'queued' | 'no_leads'>;
  consume(
    input: WebsiteScope & {
      normalizedEmail: string;
      emailHash: string;
      candidateCodeHash: string;
      now: Date;
    },
  ): Promise<ConsumeOutcome>;
  listOrders(input: WebsiteScope & { normalizedEmail: string }): Promise<TrackingOrder[]>;
  resolveLead(
    input: WebsiteScope & { normalizedEmail: string; reference: string },
  ): Promise<TrackedLeadRef | undefined>;
}
/** In the caller's transaction: the challenge is still pending, unexpired and under 5 attempts. */
export async function pendingDelivery(
  tx: TenantTransaction,
  input: { workspaceId: string; challengeId: string; now: Date },
): Promise<{ codeHash: string; emailHash: string } | undefined>;
export class DatabaseTrackingStore implements TrackingStore {}
// service.ts
export class TrackingService {
  constructor(dependencies: {
    store: TrackingStore;
    secret: string | undefined;
    contactHash: (email: string) => string;
    now?: () => Date;
  });
  get configured(): boolean;
  requestCode(input: WebsiteScope & { email: string }): Promise<void>; // never reveals a match
  verifyCode(
    input: WebsiteScope & { email: string; code: string },
  ): Promise<
    | { status: 'verified'; grant: { token: string; expiresAt: string } }
    | { status: Exclude<ConsumeOutcome, 'verified'> }
  >;
  identify(token: string | undefined, workspaceId: string): TrackingGrantIdentity | undefined;
  listOrders(scope: WebsiteScope, identity: TrackingGrantIdentity): Promise<TrackingOrder[]>;
  resolveLead(
    scope: WebsiteScope,
    identity: TrackingGrantIdentity,
    reference: string,
  ): Promise<TrackedLeadRef | undefined>;
}
```

As Canadian Plans: `createChallengeAndQueue` takes `pg_advisory_xact_lock(hashtextextended('tracking-challenge\n' || workspaceId || '\n' || emailHash, 0))`, re-checks trackable leads, marks the pending challenge consumed and completes its pending `tracking_code_email` job with `provider_id 'skipped:superseded'` and payload `{ challengeId }`, then inserts the challenge and the job (dedupe key the challenge id, payload version 1, payload per `trackingCodeJobPayloadSchema`); `consume` locks the newest pending challenge `for update`: expired or `attempts >= 5` → consumed and `expired`/`exhausted`; a wrong hash → `attempts + 1`, `invalid`; right → consumed, then `verified` only if the email still has trackable leads. Listing (Global Constraints) builds each `TrackingOrder`: `reference` = `external_ref` else the lead id; `stageLabel` from `trackingStageWord`; plan from the frozen plan (`toLeadOrder`); courier, tracking number, dispatch date and `simNumber` (form); `details` from contact and form; documents for each type in the frozen plan's `requiredDocuments` plus each type with a current file (`currentLeadDocuments` and `LATEST_REVIEW`: no review `received`, approved `approved`, rejected `needs_replacement`, required and absent `missing`); `canRequestChange` = `sim_order` and stage in `CHANGE_REQUEST_STAGES`; `pendingChange` from the lead's pending change request (B7 fills it; until then null). `resolveLead` matches the reference **and** the email in one query.

- [ ] **Step 1: Write the failing tests** (`ENV(25)`, `…-0000000065xx`, a site with two submitted SIM orders for `nadia@example.com`, one cancelled, one archived, one `incomplete`, a `contact_message` by her, and an order by her on a second site): unknown email → `no_leads`, no challenge, no job; Nadia → one challenge, one job whose payload has no six-digit run (`/\d{6}/` does not match `JSON.stringify(payload)` without `expiresAt`) and whose `toAddress` is normalized; a second request → the first challenge consumed, its job completed `skipped:superseded` with payload `{ challengeId }`; **five wrong codes → `invalid` ×5, then the right code → `exhausted`**; **the right code → `verified`, again → `not_found`; the first challenge's code after a second request → `invalid`**; at `expires_at + 1 ms` → `expired`; the list holds the two submitted orders and the cancelled one ("Cancelled"), newest first, never the archived, incomplete, contact message or other site's order; 51 orders → 50; a passport approved → `approved`, then a newer unreviewed upload → `received`; `resolveLead` with Nadia's reference and another email → undefined; **`identify` of a grant signed for site A with site B → undefined**; `pendingDelivery` false after `verified`.
- [ ] **Step 2: Run** `ENV(25) pnpm --filter backend test -- tracking-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): tracking challenges and the customer's order list`

---

### Task B6: Backend and jobs: the tracking code mail (sealed until send, scrubbed after)

Wave B3. Model: hard.

**Files:**

- Create: `apps/backend/src/tracking/delivery.ts`
- Modify: `apps/backend/src/email/compose.ts` (recipient `tracking_code`), `apps/backend/src/jobs/providers.ts` (register the handler), `apps/backend/src/jobs/store.ts` (the terminal scrub case: `tracking_code_email` → `jsonb_build_object('challengeId', payload->>'challengeId')`, replacing `tracking_otp_email`), `jobs/src/index.ts` (`outboxJobTypes` += `TRACKING_CODE_JOB_TYPE`; export `sendRenderedCustomerEmail`, used by `customerEmailHandler` too), `packages/adapters/src/messaging.ts` (remove `tracking_otp` and its copy)
- Test: create `apps/backend/tests/tracking-code-mail.integration.test.ts`; update `apps/backend/tests/jobs-providers.test.ts`, `apps/backend/tests/email-compose.integration.test.ts`, `apps/backend/tests/outbox-store.integration.test.ts`, `packages/adapters/src/messaging.test.ts`, `jobs/tests/customer-email-handler.test.ts`

**Interfaces:**

- Consumes: B1 payload schemas; B4 secrets and `openTrackingCode`; B5 `pendingDelivery`; B10's sender resolution (settings only).
- Produces:

```ts
// compose.ts
ComposeRecipient += { kind: 'tracking_code'; toAddress: string; code: string } // values { 'site name': sender name, code }; no leadId, no test
// jobs/src/index.ts
export async function sendRenderedCustomerEmail(
  dependencies: { email: EmailAdapter; eligibility: EmailEligibilityChecker; delivery?: EmailDeliveryRecorder },
  job: ClaimedJob,
  payload: CustomerEmailJobPayload,
): Promise<JobHandlerResult>; // suppression check, prepare (template version, siteSender), send, record
// delivery.ts
export function createTrackingCodeHandler(options: {
  email: EmailAdapter; eligibility: EmailEligibilityChecker; delivery?: EmailDeliveryRecorder;
  environment: CustomerEmailEnvironment; secret: string | undefined;
  database?: Pick<DatabaseClient, 'withTenantTx'>; now?: () => Date;
}): JobHandler;
```

Handler: payload version other than 1 → permanent `unsupported_payload_version`; a scrubbed payload → completed `skipped:tracking_challenge_inactive`; parse else permanent `invalid_job_payload`; expired → skip; no secret → permanent `tracking_not_configured`; in one tenant transaction (the job's actor): `pendingDelivery`, the queued address's `emailBindingHash` equal to the challenge's, `contactHash` equal, the code opens and its `codeBindingHash` equals the challenge's (any failure → skip), then `composeCustomerEmail('tracking_code', …)` (`no_sender` → completed `skipped:no_sender`); after the transaction `sendRenderedCustomerEmail`. The rendered mail exists only in memory.

- [ ] **Step 1: Write the failing tests** (`ENV(26)`, `…-0000000066xx`, real stores, `FakeEmailAdapter`, the site's settings saved, `tracking_code` saved twice (version 2)): `requestCode` then one outbox run → one message to the normalized address whose text contains the code and "expires 10 minutes", from the site's sender, `email_messages.template_version` 2, `template 'tracking_code'`; afterwards the job's payload equals `{ challengeId }`; a retried scrubbed job sends nothing; the code verified before the run → nothing sent, `skipped:tracking_challenge_inactive`; a superseded job → never sent; a site without settings → `skipped:no_sender`; no secret → failed `tracking_not_configured`; providers register `tracking_code_email`; the adapters no longer know `tracking_otp`; the customer-email handler still sends exactly its payload through `sendRenderedCustomerEmail`.
- [ ] **Step 2: Run** `ENV(26) pnpm --filter backend test -- tracking-code-mail jobs-providers email-compose outbox-store`, `pnpm --filter @gt-sales/jobs test`, `pnpm --filter @gt-sales/adapters test -- messaging` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): send the tracking code mail from the site's template, sealed until sent`

---

### Task B7: Backend: change requests from the customer, and held documents

Wave B3. Model: hard.

**Files:**

- Create: `apps/backend/src/tracking/change-requests.ts`
- Modify: `apps/backend/src/leads/site-counter.ts` (`SiteCounter` += `'change_request_no'`, self-seeded from the site's highest `requestNo` among `system` `change_requested` entries), `apps/backend/src/documents/service.ts` and `store.ts` and `memory-store.ts` (`CreateIntentInput.held?: true` writes `held_for_change_request`; `attachVerified` skips `supersedeEarlier` for a held file), `apps/backend/src/leads/documents-check.ts` (`currentLeadDocuments` adds `and not f.held_for_change_request`), `apps/backend/src/tracking/store.ts` (`pendingChange` in the list)
- Test: create `apps/backend/tests/change-requests.integration.test.ts`; update `apps/backend/tests/documents-store.integration.test.ts`, `documents-service.test.ts`

**Interfaces:**

- Consumes: B2 `ChangeRequestFields`, `CHANGE_REQUEST_STAGES`; B3 tables; B5 `TrackedLeadRef`.
- Produces:

```ts
export interface ChangeRequestRow {
  id: string;
  leadId: string;
  requestNo: number;
  status: 'pending' | 'approved' | 'rejected';
  requested: ChangeRequestFields;
  stagedFiles: Array<{ fileId: string; documentType: 'passport' | 'visa' }>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export type CustomerChangeOutcome =
  | { status: 'saved'; changeRequest: ChangeRequestRow; removedObjectKeys: string[] }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  | { status: 'invalid_field'; field: string };
export interface ChangeRequestStore {
  requestChange(
    input: WebsiteScope & {
      requestId: string;
      leadId: string;
      fields: ChangeRequestFields;
      now: Date;
    },
  ): Promise<CustomerChangeOutcome>;
  /** A finalized held file joins the lead's pending request (made if none); an earlier held file of its type is tombstoned. */
  attachDocument(
    input: WebsiteScope & { requestId: string; leadId: string; fileId: string; now: Date },
  ): Promise<CustomerChangeOutcome>;
  pendingForLead(
    tx: TenantTransaction,
    workspaceId: string,
    leadId: string,
  ): Promise<ChangeRequestRow | undefined>;
}
export class DatabaseChangeRequestStore implements ChangeRequestStore {}
export function toTrackingPendingChange(row: ChangeRequestRow): TrackingPendingChange;
export function toStaffChangeRequest(row: ChangeRequestRow): StaffChangeRequest;
```

Rules: lock the lead row `for update` first (always lead before request); the lead is a submitted, unarchived, unrestricted `sim_order` at a `CHANGE_REQUEST_STAGES` stage, else `not_allowed`; `planId` checked with `loadPlanForFreeze` + `isPlanAvailable` (`invalid_field 'planId'`); `delivery: 'pickup'` needs a shipping address requested or stored (`invalid_field 'shippingAddress'`); a pending request is replaced in place (`requested` wholesale, `version + 1`, `updated_at`, documents kept), else inserted with `nextSiteNumber(tx, ws, 'change_request_no')`; each save writes a timeline `system change_requested { requestNo, changeRequestId, fields: <keys>, documents: <types added> }` and an audit `lead.change_requested { changeRequestId, requestNo, fields, documents }` (actor label `website credential`), never values. Removed held files' object keys are returned for deletion after commit.

- [ ] **Step 1: Write the failing tests** (`ENV(27)`, `…-0000000067xx`, a site whose imported timeline holds requests up to `requestNo` 69): a pending SIM order: `requestChange({ phone, arrivalDate })` → request #70, version 1, one `change_requested` entry `fields: ['phone','arrivalDate']`, an audit with no phone in its JSON; again with `{ fullName }` → still #70, version 2, `requested` only `fullName`; **two `requestChange` at once → one pending row, version 2, one number, two entries both #70**; delivered order → `not_allowed`; an `internet` lead → `not_allowed`; an inactive plan → `invalid_field planId`; `pickup` with no address anywhere → `invalid_field shippingAddress`; a held passport intent and finalize → `available`, the current passport still current (not superseded), the lead's Documents list and `findMissingDocuments` ignore the held one; `attachDocument` → the request lists it, an entry `documents: ['passport']`; a second held passport → the first tombstoned, its key in `removedObjectKeys`; `attachDocument` with no pending request → a new request #71 with no fields; the customer list shows `pendingChange` with the fields and documents.
- [ ] **Step 2: Run** `ENV(27) pnpm --filter backend test -- change-requests documents-store documents-service tracking-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole backend suite with `ENV(27)` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): customer change requests with held documents, one pending per lead`

---

### Task B8: Backend: approve and reject, through the lead update, with the decision emails

Wave B4. Model: hard.

**Files:**

- Modify: `apps/backend/src/leads/work-store.ts` (extract and export `applyLeadUpdate` and `lockLead`; `DatabaseLeadWorkStore.updateLead` wraps it), `apps/backend/src/tracking/change-requests.ts` (approve, reject, `ChangeRequestService`), `apps/backend/src/documents/store.ts` (`releaseHeldFiles`, `tombstoneHeldFiles`, both in the caller's transaction), `apps/backend/src/leads/staff-queries.ts` (`selectLeadWithWork` returns the pending request)
- Test: create `apps/backend/tests/change-request-decisions.integration.test.ts`; update `apps/backend/tests/lead-work-store.integration.test.ts`

**Interfaces:**

- Consumes: B7 store; phase 4 `composeCustomerEmail`, `queueComposedEmail`, `readAutomationLead`.
- Produces:

```ts
// work-store.ts
export interface LeadUpdateContext { emailEnvironment: CustomerEmailEnvironment; automations: AutomationStore }
export async function applyLeadUpdate(tx: TenantTransaction, context: LeadUpdateContext, input: UpdateLeadWorkInput): Promise<UpdateLeadWorkOutcome>;
export async function lockLead(tx: TenantTransaction, workspaceId: string, leadId: string): Promise<LockedLead | undefined>;
LeadWorkResult += { changeRequest: StaffChangeRequest | null }
// change-requests.ts
export type DecisionOutcome =
  | { status: 'approved' | 'rejected'; lead: LeadDetail; activities: LeadActivity[]; emailSkipped?: ChangeDecisionEmailSkipped }
  | { status: 'not_found' | 'resolved' | 'version_conflict' | 'trashed' } | { status: 'invalid_field'; field: string };
export interface DecideInput extends WriteScope { leadId: string; changeRequestId: string; expectedVersion: number; catalog: PropertyCatalog }
export class ChangeRequestService {
  constructor(dependencies: { store: ChangeRequestStore; context: LeadUpdateContext; objects?: Pick<R2DocumentStore, 'deleteObject'>; bucket?: string; database?: Pick<DatabaseClient, 'withTenantTx'> });
  requestChange(…): Promise<CustomerChangeOutcome>; attachDocument(…): Promise<CustomerChangeOutcome>; // delegate, then delete removed objects best-effort
  approve(input: DecideInput): Promise<DecisionOutcome>;
  reject(input: DecideInput): Promise<DecisionOutcome>;
}
```

Approve, one transaction: `lockLead` (archived → `trashed`), the request `for update` on that lead (`not_found`; not pending → `resolved`; version differs → `version_conflict`), then `applyLeadUpdate` with `contact { fullName, phone }`, `form { delivery, arrivalDate, permitType, canadaAddress, shippingAddress, flightBooked }` and `order { planId }` from `requested` (a refusal rolls back and returns `invalid_field`), `releaseHeldFiles` (flag cleared, `supersedeEarlier`, audit `file.released`), the request `approved` with `resolved_by`/`resolved_at`, timeline `change_approved { requestNo, changeRequestId, fields, documents }`, audit `lead.change_request_approved` (keys only), then `change_approved` composed for the lead and queued with dedupe `${leadId}:change_approved:${changeRequestId}` and `automation: null`, or `emailSkipped`. Reject: same locks; `tombstoneHeldFiles`; `rejected`; `change_rejected` entry and audit; the `change_rejected` mail; the files' objects deleted after commit (a failed delete is logged as code only).

- [ ] **Step 1: Write the failing tests** (`ENV(28)`, `…-0000000068xx`, settings saved, a pending request for `{ fullName, phone, delivery: 'pickup', shippingAddress, arrivalDate, planId: <other plan> }` with a held passport, an in-memory object store): approve → the lead carries the five values and the other plan frozen, an `edit` entry naming `fullName, phone, delivery, shippingAddress, arrivalDate, plan`, a `change_approved` entry with `fields` and `documents: ['passport']`, the passport current with no review, the old passport superseded, one `change_approved` job, `emailSkipped` absent; no timeline or audit row contains the new phone; **approve again → `resolved`; approve with `expectedVersion` 1 after the customer replaced it → `version_conflict`, nothing written; approve concurrently with a staff `updateLead({ contact: { phone: '+1 416 555 0000' } })` → both settle within 5 s, approved once, the phone is the value of whichever transaction's `edit` entry is later, two `edit` entries**; the plan made inactive first → `invalid_field plan`, the request still pending; reject → files tombstoned, objects gone, `change_rejected` entry and job; a site with no settings → approved with `emailSkipped { template: 'change_approved', reason: 'no_sender' }`; a lead with no email → `no_customer_email`; `getLead` returns the pending request and null once decided; `DatabaseLeadWorkStore.updateLead` behaves as before (the existing suite passes).
- [ ] **Step 2: Run** `ENV(28) pnpm --filter backend test -- change-request-decisions lead-work-store lead-stage-gate automatic-emails` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole backend suite with `ENV(28)` → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `feat(backend): approve and reject change requests through the lead update, with decision emails`

---

### Task B9: Backend routes: website tracking, staff decisions, the tracking scope

Wave B5. Model: easy.

**Files:**

- Create: `apps/backend/src/routes/tracking.ts` (`createTrackingRouter(dependencies: TrackingRouteDependencies)`, mounted under `/api/v1/website` in `app.ts`)
- Modify: `apps/backend/src/app.ts`, `apps/backend/src/routes/staff.ts` (lead GET `changeRequest`, `access.decideChanges`; the two decision routes), `apps/backend/src/website/session.ts` (`DEFAULT_ENDPOINT_RATE_LIMITS.tracking = { windowSeconds: 60, maxCount: 30 }`, `loadEndpointRateLimits` reads `RATE_LIMIT_TRACKING_*`), `apps/backend/src/http/domain-errors.ts`
- Test: create `apps/backend/tests/tracking-routes.test.ts` (port Canadian Plans' `tracking-routes.test.ts`); update `apps/backend/tests/lead-work-routes.test.ts`, `website-endpoint-rate-limit.test.ts`

```ts
export interface TrackingRouteDependencies {
  auth: WebsiteAuthDependencies;
  tracking: TrackingService;
  changeRequests: ChangeRequestService;
  documents?: { service: Pick<DocumentService, 'createIntent' | 'finalize'> };
  secret: string | undefined;
  minLatencyMs?: number; // default TRACKING_MIN_LATENCY_MS
}
```

`createApp` takes `options.tracking?: TrackingRouteDependencies`; its default builds `DatabaseTrackingStore`, `TrackingService` (secret `loadTrackingSecret()`, `contactHash` from `customerEmailEnvironmentFromEnv()`), `ChangeRequestService` (objects from `createR2DocumentStoreFromEnv`, absent when unconfigured) and the document service from `createDocumentServiceFromEnv`.

Rules: every route `requireWebsiteCredential` then `requireScope('tracking')`; code and verify add `requireHumanProof('tracking-request' | 'tracking-verify')`, uploads `'upload-intent'` / `'upload-finalize'`; all the `tracking` endpoint limit. Code: body invalid → 400; else per-email bucket `emailRateBucket(…,'code')` (5 / 600 s) and per-visitor `tracking-code:visitor:<ws>:<visitor>` (20 / 600 s), `requestCode` only when both allow, errors logged as code only, then wait until `minLatencyMs` since the start, `200 { status: 'code_sent' }`. Verify: unconfigured → 409 `feature_not_ready`; buckets `'verify'` (10) and visitor (40) → 429 with `retry-after`; any non-verified outcome → 400 `tracking_challenge_invalid`; else 200 with the grant. Grant routes: unconfigured → 409 `feature_not_ready`; a missing, forged, expired or other-site grant → 401 `not_found`; writes check the `'write'` bucket (30) → 429; reference unknown for this email → 404 `order_not_found`; outcomes `not_allowed` → 409 `change_request_not_allowed`, `invalid_field` → 400 `validation_error { field }`; upload intent creates a `held` lead intent for the resolved lead (`createIntent` outcomes as `/uploads/intents`); finalize calls `finalize` with `ownedLeadId` then `attachDocument`. Staff: approve and reject need `lead.manage` (else 403); outcomes `not_found` → 404 `change_request_not_found`, `resolved` → 409 `change_request_resolved`, `version_conflict` → 409, `trashed` → 409 `lead_trashed`, `invalid_field` → 400 `validation_error { field }`; success `{ lead, activities, allowedMoves, emailSkipped?, requestId }`. Lead GET: `changeRequest` only with contact access, `access.decideChanges = lead.manage`. Messages: `change_request_not_allowed` "This order can no longer be changed online.", `tracking_challenge_invalid` "The code is wrong or has expired. Request a new code.".

- [ ] **Step 1: Write the failing tests** (mocked service and stores, `minLatencyMs` 500): **a known and an unknown email both answer `200 { status: 'code_sent', requestId }` with identical bodies apart from `requestId`, each after at least 500 ms**; the sixth code request in a window → still 200, `requestCode` called five times; the eleventh verify → 429; a 31st write → 429; a key without `tracking` → 403 `scope_denied`; **a grant issued for another site → 401 `not_found`**; verify outcomes `invalid`, `expired`, `exhausted`, `not_found` → one 400 `tracking_challenge_invalid`; unconfigured: code 200 and no store call, orders 409 `feature_not_ready`; a change body with `email` → 400; delivered → 409 `change_request_not_allowed`; upload `documentType: 'sim_photo'` → 400; finalize passes `ownedLeadId` and calls `attachDocument`; the captured logger never holds the email, the code or the grant; staff: a `leads` member approves, an `orders`-only member and a `viewer` get 403, each outcome's status and code, `emailSkipped` passes through, a viewer's lead GET has `changeRequest: null`; the `tracking` endpoint limit is 30 per 60 s.
- [ ] **Step 2: Run** `pnpm --filter backend test -- tracking-routes lead-work-routes website-endpoint-rate-limit` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite (`ENV(29)`), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): website tracking routes and staff change request decisions`

---

### Task B10: Remove `EMAIL_SENDERS_JSON` and `lead_sim_number_email`

Wave B1. Model: easy.

**Files:**

- Modify: `apps/backend/src/email/senders.ts` (drop `loadEmailSenders`, `SiteSender`, `EmailSenders`, `fallbackSenders`, `CustomerEmail.fallback` and the fallback branch of `resolveSiteSender`), `apps/backend/src/jobs/providers.ts` (no sender map; `resendAccountForWorkspace(env, registry, workspaceId)` = registry account else `RESEND_ACCOUNT_ID`; Resend adapter without `senderForWorkspace`), `apps/backend/src/routes/email-settings.ts` (no `fallback`), `jobs/src/index.ts` (`lead_sim_number_email` out of `outboxJobTypes`, `emailJobTypeToTemplate`, the registry; `leadEmailHandler` deleted if unused), `packages/adapters/src/messaging.ts` (`senderForWorkspace` option and `renderSimNumberReady` removed if unused), `packages/contracts/src/customer-email.ts` (`emailSettingsResponseSchema` without `fallback`), `apps/admin/src/components/email/email-settings.tsx` (no fallback notice; an unsaved site shows "Not saved yet: this site sends no email until you save these settings."), `apps/backend/tests/e2e/harness.ts`, `docs/ENV.md`
- Test: update `apps/backend/tests/customer-email.test.ts`, `jobs-providers.test.ts`, `email-compose.integration.test.ts`, `email-settings-routes.test.ts`, `packages/adapters/src/messaging.test.ts`, `jobs/tests/*`, `apps/admin/src/components/email/email-settings.test.tsx`, `packages/contracts/src/customer-email.test.ts`

- [ ] **Step 1: Write the failing tests** (a site with no saved settings and `EMAIL_SENDERS_JSON` set in the test env → compose `no_sender`; `createOutboxJobHandlers` has no `lead_sim_number_email` handler; the settings response has no `fallback` key; the admin shows the unsaved copy).
- [ ] **Step 2: Run** `ENV(30) pnpm --filter backend test -- customer-email jobs-providers email-compose email-settings-routes`, `pnpm --filter @gt-sales/jobs test`, `pnpm --filter @gt-sales/adapters test`, `pnpm --filter admin test -- email-settings` → FAIL.
- [ ] **Step 3: Implement**; `pnpm --filter @gt-sales/contracts build`; `rg -n "EMAIL_SENDERS_JSON|lead_sim_number_email|fallbackSenders" apps packages jobs` finds nothing.
- [ ] **Step 4: Run** the same → PASS; typecheck, lint, format.
- [ ] **Step 5: Commit** — `refactor(email): remove the EMAIL_SENDERS_JSON fallback and the old SIM number job`

---

### Task B11: Admin: the change request card, timeline words, Settings → Email, the tracking scope

Wave B4. Model: hard.

**Files:**

- Create: `apps/admin/src/components/leads/change-request-card.tsx`
- Modify: `apps/admin/src/components/leads/lead-record.tsx` (the card above the timeline; the "Waiting in the old admin" banner only when the pending request's actor is `LEGACY_IMPORT_ACTOR_ID`), `lead-timeline.tsx` (`pendingChangeRequest` considers imported entries only; CRM entries' words), `apps/admin/src/components/email/template-list.tsx`, `apps/admin/src/components/service-credentials-manager.tsx` (scope option `tracking`, label "Order tracking"), `apps/admin/src/lib/api.ts` (`approveChangeRequest`, `rejectChangeRequest`)
- Test: create `change-request-card.test.tsx`; update `lead-record.test.tsx`, `lead-timeline.test.tsx`, `template-list.test.tsx`

```ts
export function ChangeRequestCard(props: {
  lead: LeadDetail;
  changeRequest: StaffChangeRequest;
  catalog: PropertyCatalog;
  canDecide: boolean;
  canDownload: boolean;
  onDecide(
    decision: 'approve' | 'reject',
    expectedVersion: number,
  ): Promise<ResolveChangeRequestResponse>;
  onDone(result: ResolveChangeRequestResponse): void;
  openDocument(fileId: string): Promise<void>;
}): JSX.Element;
```

Copy: heading "Change request #<n>", "The customer asked for these changes <relative time>." and a table (`th` Field, Now, Asked for; plan by name, delivery by option label, dates as dates); "Documents sent with it: Passport" with View (only `canDownload`); buttons "Approve changes" and "Reject" for `canDecide`, otherwise "Only someone with the Leads role can decide this."; after approve "Approved. The documents now wait for an Orders review." (when any), after reject "Rejected. The customer will be told by email."; `version_conflict` "The customer changed this request. Reload to see the latest."; `emailSkipped` "The Change approved email was not sent: this site has no sender yet (Settings → Email)." / "…: the customer has no email address." / "…: it needs the <keys>.". Timeline: a CRM `change_requested` → "The customer asked to change the phone, arrival in canada (request #70)"; `change_approved` by staff → "approved the customer's change request #70"; `change_rejected` → "rejected the customer's change request #70". Template list: the three `ALWAYS_SENT_TEMPLATES` read "Always sent: when a customer asks for a code on the tracking page" / "Always sent: when staff approve a customer's change request" / "Always sent: when staff reject a customer's change request".

- [ ] **Step 1: Write the failing tests** (`vi.mock('../../lib/api')`: the card lists Phone with now and asked-for values; Approve sends `expectedVersion: 2` and shows the approved copy, the record reloads; a `version_conflict` rejection shows its copy; without `canDecide` no buttons and the Leads copy; View calls `openDocument` only with `canDownload`; an `emailSkipped` notice; the record shows no "Waiting in the old admin" for a CRM request and still shows it for an imported one; the timeline strings; the template list's three always-sent lines and no switch; the credentials form offers "Order tracking").
- [ ] **Step 2: Run** `pnpm --filter admin test -- change-request-card lead-record lead-timeline template-list` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the admin suite, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(admin): change request card on the lead page and always-sent emails in Settings → Email`

---

### Task B12: "Done when": the tracking flow test, harness seeds, Playwright journey

Wave B6. Model: hard.

**Files:**

- Create: `apps/backend/tests/tracking-flow.integration.test.ts`
- Modify: `apps/backend/tests/e2e/harness.ts` (a pending change request on Nadia Khan's order through `DatabaseChangeRequestStore.requestChange` with `phone` and `arrivalDate`, actor `WEBSITE_ACTOR_ID`; the header comment says so), `apps/admin/e2e/leads.spec.ts` (a tenth journey)

- [ ] **Step 1: Write the integration test** (`ENV(32)`, `…-0000000072xx`, `createApp` with real stores, `FakeEmailAdapter`, `InMemoryR2DocumentStore`, a stub staff verifier for a `leads` member and an `orders` member): a submitted SIM order `MS-…` for `nadia@example.com`; `POST /website/tracking/code` → 200; one outbox run → one message carrying a code; `verify` → grant; `GET /tracking/orders` → the order with "Received", its plan, `canRequestChange: true`; `POST …/changes { phone, arrivalDate }` → 201 request #1; upload intent and finalize of a passport → the request lists it; the staff lead GET shows `changeRequest` and the lead's Documents card without the held passport; approve (leads member, `expectedVersion` 2) → the lead's phone and arrival changed, timeline `change_requested` ×2 (the website credential), `edit`, `change_approved`, `customer_emailed change_approved`; one outbox run sends the `change_approved` mail; the customer list: `pendingChange` null, passport `received`; the Orders member approves the passport → `approved`; the `tracking_code_email` job's payload is `{ challengeId }`; no audit or timeline row holds the new phone.
- [ ] **Step 2: Run** `ENV(32) pnpm --filter backend test -- tracking-flow` → PASS (a failure is a bug in an earlier task: fix it there, with a test).
- [ ] **Step 3: Add the journey** "a customer's change request is approved on the lead page": open Nadia Khan's order → the card "Change request #1" shows the phone now and asked for → "Approve changes" → "Approved." → the contact shows the new phone → the timeline "approved the customer's change request #1".
- [ ] **Step 4: Run** `pnpm --filter admin test:e2e:leads` (all journeys, and once under `TZ=UTC`) → PASS.
- [ ] **Step 5: Commit** — `test: a customer's change request from tracking code to approval`

---

### Task B13 (Get Canada Sim repository): `/track` through the CRM

Wave B5. Model: hard. Repository `/home/user/get-canada-sim`, branch `claude/crm-tracking`.

**Files:**

- Create: `src/lib/crm-tracking.ts` (server-only client), `src/lib/crm-tracking-map.ts` (pure mapping), `scripts/test-crm-tracking.mts`
- Modify: `src/app/track/auth.ts` (grant cookie), `src/app/track/actions.ts`, `src/app/track/page.tsx`, `src/app/track/continue/route.ts`, `src/app/track/TrackOrders.tsx` (CRM uploads: intent → browser `PUT` with the returned headers → SHA-256 of the file via `crypto.subtle` → finalize), `src/app/track/types.ts`, `package.json` (`test:crm-tracking`), `AGENTS.md` (`CRM_TRACKING`, data flow, tests table)

**Interfaces:**

Consumes A6 `crmRequest`, `CrmResult`, `CrmConfig`, `CrmCallOptions`, `CrmPlan`, `matchCrmPlan`; A8 `crmTrackingMode`. `CrmTrackedOrder`, `CrmPendingChange` and `CrmChangeFields` are the website's own TypeScript shapes of B2's `trackingOrderSchema`, `trackingPendingChangeSchema` and `changeRequestFieldsSchema`, checked by hand field by field (no new dependency).

```ts
// crm-tracking.ts
export async function requestTrackingCode(
  config: CrmConfig,
  email: string,
  options: CrmCallOptions,
): Promise<CrmResult<null>>;
export async function verifyTrackingCode(
  config: CrmConfig,
  email: string,
  code: string,
  options: CrmCallOptions,
): Promise<CrmResult<{ token: string; expiresAt: string }>>;
export async function listTrackedOrders(
  config: CrmConfig,
  options: CrmCallOptions & { customerGrant: string },
): Promise<CrmResult<CrmTrackedOrder[]>>;
export async function requestTrackedChange(
  config: CrmConfig,
  reference: string,
  fields: CrmChangeFields,
  options: CrmCallOptions & { customerGrant: string },
): Promise<CrmResult<CrmPendingChange>>;
export async function createTrackedUpload(
  config: CrmConfig,
  reference: string,
  input: { documentType: 'passport' | 'visa'; contentType: string; sizeBytes: number },
  options,
): Promise<CrmResult<{ uploadId: string; url: string; headers: Record<string, string> }>>;
export async function finalizeTrackedUpload(
  config: CrmConfig,
  reference: string,
  uploadId: string,
  checksumSha256: string,
  options,
): Promise<CrmResult<CrmPendingChange>>;
// crm-tracking-map.ts
export function toTrackOrder(order: CrmTrackedOrder, plans: readonly CrmPlan[]): TrackOrder; // dbId = reference, status = stage
export function toCrmChangeFields(
  proposed: Partial<Record<EditableOrderField, OrderFieldValue>>,
  plans: readonly CrmPlan[],
): { ok: true; fields: CrmChangeFields } | { ok: false; error: string };
// auth.ts
export const TRACK_GRANT_COOKIE = 'canadaesim_track_grant';
export async function setTrackGrant(grant: { token: string; expiresAt: string }): Promise<void>; // httpOnly, Secure in prod, sameSite lax, path /track, maxAge until expiresAt (≤ 1800)
export async function getTrackGrant(): Promise<string | null>;
```

Field map: `full_name` → `fullName`, `phone` → `phone`, `plan` (slug, `matchCrmPlan`) → `planId`, `delivery` → `delivery`, `arrival` → `arrivalDate`, `permit_type` → `permitType`, `canada_address` → `canadaAddress`, `shipping_address` → `shippingAddress`, `flight_booked` → `flightBooked`; never `email`. With `crmTrackingMode() === 'on'`: the email step asks the CRM (the website's own spam, bot and IP throttles first) and always advances; the code step verifies with the CRM and sets the grant cookie (the website's own OTP and session are not used); the page lists `listTrackedOrders`; a CRM 401 clears the cookie and shows the email step with "Your session expired. Please verify your email again."; a 409 `change_request_not_allowed` → "This order can no longer be changed online."; documents show their state (ruling T3); HEIC is refused before the intent; `/track/continue` verifies the link token, asks the CRM for a code for its email and lands on the code step (ruling T4); `misconfigured` → "Tracking is unavailable right now. Please try again later." (ruling P3); `off` → today's behaviour (with A8's notice when orders moved).

- [ ] **Step 1: Write the failing test** (`scripts/test-crm-tracking.mts`, stubs, `fetch` replaced): flag on, the email step → one `POST /tracking/code` with the email, the code step shown whatever the CRM answers; the code step → `POST /tracking/verify`, the grant cookie written with path `/track` and `maxAge` ≤ 1800; `toTrackOrder` of a CRM order gives `reference 'MS-153'`, `status 'pending'`, `editable true`, `pending` mapped back to website keys and the slug; `toCrmChangeFields({ plan: '75gb-fido', arrival: '2026-11-20', phone: '+1 647 555 0123' })` gives the matched uuid, `arrivalDate` and `phone`, and no `email` key even when `email` is passed; an unknown slug → "Choose a valid plan."; a CRM 401 → the session copy and the cookie cleared; a 409 `change_request_not_allowed` → its copy; `/track/continue` with a valid link token → one code request and the code step; flag off → no fetch.
- [ ] **Step 2: Run** `npm run test:crm-tracking` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** — `feat(track): customer tracking through the CRM behind CRM_TRACKING`

---

### Task B14: Docs for Part B

Wave B6. Model: easy.

- Modify: `AGENTS.md` (vocabulary: **tracking code** and **challenge**, **grant**, **change request** (one pending per lead, replaced in place), **held document**, **always-sent email**; where things live: `src/tracking/` (`secrets`, `store`, `service`, `delivery`, `change-requests`), `src/routes/tracking.ts`, `components/leads/change-request-card.tsx`; remove the `EMAIL_SENDERS_JSON` sentence), `docs/HANDOFF.md` (§2.3 the two staff routes and the six website tracking routes with scope `tracking`; §2.4 `tracking_challenges`, `change_requests`, `files.held_for_change_request`, 38 tables with backup read policies; §2.6 new item 10, customer tracking: scope, grant header, limits, neutral answer, what is listed, what may change; §3.8 step B; §5.1 owner steps: `TRACKING_HASH_SECRET` on Railway, a site key with `tracking`, apply 0017/0018, remove `EMAIL_SENDERS_JSON` from Railway after the deploy, `CRM_TRACKING` on; §5.3 the two clean-ups done), `docs/PLAN.md` (§7, §10), `docs/ENV.md` (`TRACKING_HASH_SECRET`; `RATE_LIMIT_TRACKING_MAX`/`_WINDOW`; `EMAIL_SENDERS_JSON` removed), `docs/RUNBOOKS/database.md` (B3 wrote the sections; cross-check), `docs/superpowers/phases/README.md` (phase 5 row), `docs/superpowers/phases/phase-5-customer-tracking.md` (status and the checklist).
- [ ] **Step 1: Edit, `pnpm run format`, commit** — `docs: phase 5 step B, customer tracking`

---

### Task B15: Part B gate, pull requests, migrations, deploy, the `/track` switch, the live check

Wave B6. Model: easy.

- [ ] **Step 1: Gate (CRM):** `pnpm run lint && pnpm run typecheck && pnpm run format`; `ENV(35) pnpm run test`; `pnpm --filter admin test:e2e:leads` (and under `TZ=UTC`); `pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json` → green, no diff.
- [ ] **Step 2: Before merging, two production checks (ruling 10):** `select w.slug, (s.workspace_id is not null) as saved from app.workspaces w left join app.workspace_email_settings s on s.workspace_id = w.id` shows `saved` true for every site that sends mail; `select count(*) from app.outbox_jobs where job_type = 'lead_sim_number_email' and status in ('pending','processing','failed')` is 0. If either fails, the owner saves Settings → Email or the job finishes first; record both results.
- [ ] **Step 3: CRM PR** "Customer tracking (merge phase 5)" with the footer; subscribe and schedule a check-in; `verify` green.
- [ ] **Step 4: Apply 0017 + 0018 to `xykrphbgpwisqacpyeiv` before merging:** pre-check A; the `CREATE TABLE`, constraints, indexes and policies through `execute_sql` in small batches; the `ALTER TABLE` statements (the new column, the widened checks, FORCE RLS) and `CREATE OR REPLACE FUNCTION app.prune_operational_rows` handed to the owner as pastes, waiting for "done"; grants; the four tracker rows by hand; the eight verification selects one at a time; record in `docs/RUNBOOKS/database.md` and HANDOFF §5.1.
- [ ] **Step 5: Deploy in order:** the owner sets `TRACKING_HASH_SECRET` (≥ 32 characters) on Railway; merge with a merge commit; Railway build, health 200; Vercel admin; the owner removes `EMAIL_SENDERS_JSON` from Railway after this deploy. Live check: Settings → Email lists nine templates with three always sent; the owner adds `tracking` to the Get Canada Sim key; from a staff test address with a test order: a code arrives from Get Canada Sim's sender, verify, the order lists, a change request appears on the lead page, approve, the decision mail arrives; archive the test order.
- [ ] **Step 6: Get Canada Sim PR** `claude/crm-tracking` → `main` (its CI green), merged with the owner's approval and deployed with `CRM_TRACKING` unset; then the owner sets `CRM_TRACKING=on` and redeploys after the test above passes through the website too.
- [ ] **Step 7: Done when (spec §12):** a real customer's change request is approved in the CRM, with `change_requested` and `change_approved` on the timeline and the change on the lead; record it in HANDOFF §3.8 and the phases README row; commit `docs: phase 5 live check recorded`.
