# Merge phase 5: customer tracking

Status on 2026-10-30: planned
([plan](../plans/2026-10-30-phase-5-gcs-orders-and-tracking.md)) and built,
not deployed. Step A (Get Canada Sim's orders into the CRM) is built on the
CRM side, with migrations 0015 and 0016 (order numbers) applied to the hosted
project on 2026-10-30. Step B (customer tracking) is built on the CRM side
(docs/HANDOFF.md §3.8, step B; the done-when test
`apps/backend/tests/tracking-flow.integration.test.ts` and the tenth lead
journey pass) and on the website side (Get Canada Sim's `/track` behind
`CRM_TRACKING`, not merged); its migrations 0017 and 0018 are **not applied**
yet. Left: the gate, the pull requests, 0017 and 0018, the deploys (plan Task
B15), then the switch day (Task A11), where `CRM_TRACKING` goes on and a real
customer's change request is approved. The migrations of this phase are 0015
to 0018: 0015 and 0016 are step A's order numbers, 0017 and 0018 step B's
tracking tables. Shared rules, the gate, the shipping procedure and the
working method are in [README.md](README.md#shared-conventions); this page
adds what is particular to phase 5.

## 1. Purpose and done when

Spec §12 row 5: "Customer tracking (§8); Get Canada Sim's `/track` switches".
Done when: **a real customer's change request is approved in the CRM.**

In plain words. A Get Canada Sim customer opens the website's `/track` page,
types their email address and receives a 6-digit code by email (it lives 10
minutes, and there are per-email limits). With the code they see their orders
on that site: the stage, the plan, the dispatch details and the SIM number.
They can ask for a change to some answers and send a new document. Staff see
the request on the lead page in the CRM, approve or reject it, and both the
request and the decision appear on the lead's timeline. The `/track` page stays
in the Get Canada Sim repository and calls the CRM's website API (spec §8). The
backend parts are ported from Canadian Plans' `tracking/` (challenges, sealed
codes, limits, change requests) and adapted to leads.

Two clean-ups belong to this phase too (ruling D3, HANDOFF §5.3): remove the
`EMAIL_SENDERS_JSON` fallback sender once every site has saved Settings →
Email, and remove the old `lead_sim_number_email` job type with it.

Today the `tracking_code` template exists and can be edited, but nothing sends
it (ruling D4).

## 2. Read first

1. [README.md](README.md): the shared rules, gate, shipping and method.
2. `AGENTS.md`: rules, vocabulary (email settings, templates, fill-ins,
   automation rules, idempotency key) and where things live.
3. `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §2
   (decisions 6, 13, 16, 17, 18), §7, §8, §12, §13: what the owner decided.
4. `docs/HANDOFF.md` §2.6 (the website contract, items 3, 5, 8 and 9),
   §3.4 item 11 (how Get Canada Sim's change requests were imported),
   §3.7 (phase 4), §5.1 (owner steps per site), §5.3 (phase 4 follow-ups).
5. `docs/GCS_ADMIN_INVENTORY.md`, "Order drawer" and "Automatic behaviour and
   emails": what Get Canada Sim's change requests do today.
6. `docs/RUNBOOKS/legacy-import.md`, "Get Canada Sim historical import": the
   CRM's copy of Get Canada Sim's orders is refreshed by a re-runnable import,
   and change requests arrive as timeline entries.
7. `docs/superpowers/plans/2026-10-30-phase-4-order-tools-email.md`: the plan
   style to reproduce, and the email and automation design this phase extends.
8. Canadian Plans (`/home/user/canadianplans-web-app`): `AGENTS.md`,
   `PLATFORM_CONTEXT.md` §4 (its invariants), `apps/backend/src/tracking/`
   (`service.ts`, `store.ts`, `secrets.ts`, `cipher.ts`, `delivery.ts`),
   `packages/contracts/src/tracking.ts`, the `/tracking/*` routes in
   `apps/backend/src/routes/website.ts`, the change request routes in
   `apps/backend/src/routes/staff.ts`, `packages/db/drizzle/0027_email_only_tracking.sql`,
   `docs/ENV.md` "Customer tracking (T22)", the tests
   `apps/backend/tests/tracking-routes.test.ts` and
   `tracking-store.integration.test.ts`, and the storefront page
   `apps/site-1/src/app/(track-order)/track/` with
   `apps/site-1/src/components/track/` (a reference for the website side only).
9. The Get Canada Sim repository (`Md-Takibuddin/Get-Canada-Sim`): its `/track`
   page and its change request flow (`order_edit_requests`). It was not
   attached to the hand-off session, so its file names are not listed here:
   add it and find them before planning.

## 3. What already exists to build on

Customer email (phase 4):

- The **`tracking_code` template**: one of the seven keys in
  `CUSTOMER_EMAIL_TEMPLATES` (`packages/contracts/src/customer-email.ts`), a
  starter text in `apps/backend/src/email/starters.ts` ("Your {site name}
  tracking code"; the body names `{code}` and says it expires 10 minutes after
  the request), editable in Settings → Email. Nothing sends it yet.
- **Fill-ins**: `{code}` is allowed only in `tracking_code`, and `{site name}`
  in every template (`emailFillIns`, `fillInsForTemplate`). `{tracking link}`
  is allowed in every template except `tracking_code` and becomes
  `<site address>/track` (`trackingLink` in `apps/backend/src/email/fill-in-values.ts`);
  `fillInValuesForLead` never supplies `code`.
- **The site address** comes from `app.workspace_email_settings.site_url`
  (Settings → Email, "site address", `https` only), else the site's
  `EMAIL_SENDERS_JSON` entry's `siteUrl` (`resolveSiteSender` in
  `apps/backend/src/email/senders.ts`).
- **The composer** `composeCustomerEmail` (`apps/backend/src/email/compose.ts`)
  takes a recipient of kind `lead` or `staff_test`; a tracking-code mail has no
  lead and needs a third kind (to do). It skips with `no_sender`,
  `no_customer_email` or `missing_fill_in`, and throws when a mail does not fit
  `customerEmailJobPayloadSchema`. `queueComposedEmail`
  (`apps/backend/src/email/queue.ts`) queues one `lead_customer_email` job
  (`CUSTOMER_EMAIL_JOB_TYPE`) with the mail already rendered.
- **The `EMAIL_SENDERS_JSON` fallback** that this phase removes:
  `loadEmailSenders` and the fallback branch of `resolveSiteSender` in
  `apps/backend/src/email/senders.ts`, `CustomerEmail.fallback`, the sender
  map in `createOutboxJobHandlers` (`apps/backend/src/jobs/providers.ts`), the
  `fallback` field of `emailSettingsResponseSchema` (contracts) and the admin's
  fallback notice in Settings → Email (`apps/admin/src/components/email/`), and
  ENV.md. The old job type `lead_sim_number_email` is in `outboxJobTypes`, its
  template map and its handler in `jobs/src/index.ts`.

Tracking pieces inherited from the copy of Canadian Plans, none wired:

- `sealTrackingCode` / `openTrackingCode` in `apps/backend/src/crypto/cipher.ts`
  (AES-256-GCM, bound to `{ workspaceId, orderId, challengeId }`), used only by
  its test.
- `apps/backend/src/jobs/store.ts` scrubs the payload of a job of type
  `tracking_otp_email` to its ids when the job ends; no job type of that name
  is registered in `jobs/src/index.ts`.
- `packages/adapters/src/messaging.ts` still has a hard-coded `tracking_otp`
  template (subject "Your GT Sales tracking code", in `renderTemplateBody`).
  The phase 5 mail should be the site's `tracking_code` template instead; the
  old one can go.
- Error codes in `domainErrorCodeSchema` (`packages/contracts/src/common.ts`):
  `tracking_challenge_invalid`, `tracking_expired`,
  `tracking_attempts_exceeded`, `change_request_not_found`,
  `change_request_resolved`. No route answers them yet.

Leads, documents and the timeline:

- **Timeline entries** for change requests exist: system events
  `change_requested` (with `requestNo`, `fields` and `documents`, never
  values), `change_approved` and `change_rejected` (`leadActivitySchema` in
  `packages/contracts/src/lead-work.ts`). The Get Canada Sim import writes them
  from `public.order_edit_requests` (`packages/db/sql/getcanadasim-legacy-import.sql`:
  fields `fullName`, `phone`, `planId`, `delivery`, `arrivalDate`, `permitType`,
  `canadaAddress`, `shippingAddress`, `flightBooked`; documents `passport`,
  `visa`). The admin shows them (`changeRequestText`, `pendingChangeRequest` in
  `apps/admin/src/components/leads/lead-timeline.tsx`) and the lead page says a
  request is waiting "in the old admin" (`apps/admin/src/components/leads/lead-record.tsx`).
- **Documents**: lead files, revisions and reviews (`app.files`,
  `app.file_revisions`, `app.file_review_events`), the review route
  `POST /workspaces/:id/files/:fileId/review` (`order.manage`), the documents
  check (`apps/backend/src/leads/documents-check.ts`) and the lead page's
  Documents card with Approve and Reject. A website upload
  (`POST /website/uploads/intents`, scope `uploads:customer`) needs a draft
  grant (`requireDraftGrant` in `apps/backend/src/routes/website.ts`), and a
  submitted lead has none, so a customer cannot send a document for a
  submitted order today.
- **Idempotency**: `app.idempotency_keys` with one scope, `lead_submission`
  (the CHECK list `idempotencyScopeList` in `packages/db/src/schema.ts`), and
  `apps/backend/src/leads/idempotency.ts` (`claimIdempotencyKey`,
  `completeIdempotencyKey`, `requestFingerprint`). A new scope needs a new
  migration.
- **Lead edits**: `DatabaseLeadWorkStore.updateLead` (`apps/backend/src/leads/work-store.ts`)
  already applies contact, form, custom and order edits with a timeline entry
  and an audit naming field keys, in one locked tenant transaction. Approving a
  change request should go through it.
- **Contacts** are global and merged by `lower(btrim(email))`; a lead belongs to
  one site. A customer's leads on a site are the site's leads with that email.
- **Permissions**: `lead.manage` (owner, Leads) for any lead change;
  `order.manage` (owner, Orders) for document reviews and plans;
  `order.override` (owner, Orders). See README rule 11.
- **Website routes** (`apps/backend/src/routes/website.ts`): each has a
  per-endpoint limit through `admit('<name>')` (`lead-save`, `upload-intent`,
  `upload-finalize`, `file-download`, `identity-submit`) on top of the
  credential and visitor limits (`apps/backend/src/website/session.ts`); scopes
  are `leads:write` and `uploads:customer` (`websiteScopeNames` in
  `packages/types/src/index.ts`).
- **Test seams**: `apps/backend/tests/e2e/harness.ts` seeds Get Canada Sim with
  email settings saved, two plans, SIM orders and a passport waiting for review;
  `apps/admin/e2e/leads.spec.ts` has nine journeys;
  `apps/backend/tests/order-flow.integration.test.ts` is the phase 4 "done
  when" test to copy for this phase's.

What does not exist: any tracking table, route, store or page in the CRM, and
any CRM-side change request record (only the imported timeline entries).

**Get Canada Sim's orders do not live in the CRM yet.** The Get Canada Sim
website writes its orders to its own `public.orders`; staff work them in its
own admin; the CRM's copy is refreshed by re-running the import, and nothing
the CRM changes flows back to `public.orders`, which `/track` reads today
(HANDOFF §3.4, last paragraph; §2.6 item 3: `sim_order` intake is "not
modelled yet"). This shapes the first open decision below.

## 4. Decisions already made (binding)

Shared rules 1 to 23 in [README.md](README.md#rules-that-bind-every-phase) bind
this phase. In particular: no PII in logs, audit, timeline or runs (8);
sensitive properties never in filters, columns, views or the timeline (9); never
edit an applied migration (3); contracts hold every schema and the endpoint
registry (5); admin copy in sentence case, labelled, keyboard-usable (15);
strict TypeScript, no `any` or `as` (6); integration suites on a `_test`
database with fixed UUID ranges (16); the Orders-only member cannot reach the
documents override (11); rescued incomplete checkouts get no rule mail (13);
every rule off until switched on (12).

Decisions for this phase:

| Decision                                                                                                                                                                                        | Why                                                                | Where recorded                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Customer tracking follows Get Canada Sim's flow: email, one-time code, see orders, request changes, staff approve. Canadian Plans' "ask the customer for…" (`order_info_requests`) is left out. | The owner's choice; Get Canada Sim's customers already use it.     | Spec §2 decision 17; §8                                        |
| The code is 6 digits, lives 10 minutes, with per-email limits; it shows the customer's leads on that site: stage, plan, dispatch and SIM number.                                                | Spec text.                                                         | Spec §8                                                        |
| `/track` stays in the Get Canada Sim repository and calls the CRM.                                                                                                                              | Websites are outside the product.                                  | Spec §8; §2 decision 4                                         |
| Staff approve or reject in the CRM; the request and the decision both go on the timeline, the customer's action too.                                                                            | Every change is on the lead's timeline, customer actions included. | Spec §8; §2 decision 16                                        |
| Port Canadian Plans' `tracking/` (challenges, cipher, limits, change requests), adapted to leads, not its order tables.                                                                         | Its code assumes a separate `orders` table.                        | Spec §8; §4; §15 "Ported code assumes a separate orders table" |
| Businesses never share customers; a person on several sites of one business is one contact, merged by email.                                                                                    | One database per business.                                         | Spec §2 decision 6                                             |
| An order is a lead; one lead is one sale.                                                                                                                                                       | Tracking, email and reports attach to leads.                       | Spec §2 decisions 13 and 29; §14                               |
| No customer-data deletion feature; staff only archive.                                                                                                                                          | Requests come through the website; a developer deletes.            | Spec §2 decision 18                                            |
| Customer tracking (sending `tracking_code`, the tracking page) is phase 5; the template is editable now and sent in phase 5.                                                                    | Kept phase 4 to its scope.                                         | Ruling D4 (owner, 2026-10-30), R1; HANDOFF §3.7                |
| `EMAIL_SENDERS_JSON` stays the fallback sender until a site's Settings → Email is saved; phase 5 removes it, with the old `lead_sim_number_email` job type.                                     | The SIM number mail kept working through the phase 4 deploy.       | Ruling D3, R6; HANDOFF §5.3; ENV.md                            |
| Templates are content only; when an automatic email goes out is an automation rule, off until switched on.                                                                                      | One place decides sending; no duplicate mails.                     | Ruling D5; AGENTS.md vocabulary                                |
| Fill-ins are a fixed list (`EMAIL_FILL_IN_KEYS`); `{code}` is for `tracking_code` only; a misspelt or disallowed fill-in is refused on save; values are escaped.                                | Safe templates staff can edit.                                     | Ruling R8; phase 4 Global Constraints                          |
| The backend renders a mail when it queues it, and the outbox job only sends it; a sent mail records its template version.                                                                       | One render path, versions on every message.                        | Phase 4 plan, Architecture; HANDOFF §3.7 item 5                |
| A website's `Idempotency-Key` is stored as a SHA-256 hash with a request fingerprint, replayed for 24 hours, pruned after 7 days, scope `lead_submission`.                                      | A retry never makes a second lead.                                 | Ruling R5; HANDOFF §2.6 item 9                                 |
| The documents review stays `order.manage`; the override is `order.override` (owner and Orders), always with a reason.                                                                           | Owner choice.                                                      | Rulings R4, D1; AGENTS.md                                      |
| Every email starts off per site; the owner switches each on after checking the website sends no duplicate.                                                                                      | Websites may already send their own mails.                         | Spec §15; HANDOFF §5.1                                         |

## 5. Open decisions to put to the owner before planning

Ask them one at a time, in this order, each with a plain explanation and the
recommended default. "Spec answers" marks what is already decided.

1. **Do Get Canada Sim's orders move into the CRM first?** Tracking from the
   CRM can only show and change what the CRM holds. Today the CRM holds a copy
   that the import refreshes, and an approval in the CRM would not reach
   `public.orders`. Spec silent on the order of work. Recommended: yes, as the
   first part of this phase: model `sim_order` intake (the lead-type registry
   in `apps/backend/src/leads/types.ts`), the Get Canada Sim checkout sends
   orders to `POST /api/v1/website/leads` with `order: { planId, quantity }`
   and an `Idempotency-Key`, its documents through the upload intents, staff
   stop working orders in the old admin on a day the owner picks, the import is
   re-run one last time, and only then does `/track` switch. Ask also whether
   partner applications and contact messages move in the same step (PLAN §10
   "Confirm storing contact-form messages as leads").
2. **Per customer or per order.** Spec answers: one code covers every lead of
   that email on that site (as Canadian Plans' email-only tracking, its
   migration 0027).
3. **Which leads the customer sees.** Recommended: submitted leads of the
   three order types (`sim_order`, `internet`, `mobility`) on that site, not
   archived, newest first, at most 50 (Canadian Plans' `MAX_TRACKED_ORDERS`).
   Ask: Get Canada Sim's `/track` still shows archived orders today
   (`docs/GCS_ADMIN_INVENTORY.md`); keep that or not?
4. **What the customer sees on an order.** Spec answers stage, plan, dispatch
   and SIM number. Recommended detail: a customer wording per stage (in code),
   the frozen plan's name and price, quantity, courier, tracking number and
   dispatch date, the SIM number, each required document with its state
   (received, approved, needs replacement) and any pending change request.
   Never payment status, carrier commission, notes, tasks, assignee or custom
   values. Ask whether payment status should show.
5. **What the customer may change, and when.** Spec answers "fields and
   documents". Recommended: Get Canada Sim's list (name, phone, plan,
   delivery, arrival date, permit type, Canada address, shipping address,
   flight booked; passport and visa files), never the email address, and only
   while the order is `pending` (Get Canada Sim allows pending and incomplete).
   Ask whether `verified` and `on_hold` should allow it too.
6. **How many pending requests per order.** Recommended: one, as Get Canada
   Sim (Canadian Plans allows three).
7. **Who approves, and what approval does.** Recommended: `lead.manage`
   approves or rejects (it changes the lead); approval applies the fields
   through the normal lead edit (timeline and audit name the fields) and adds
   the customer's documents as new revisions that still need a review
   (`order.manage`); rejection discards the staged documents. A plan change
   re-freezes the plan as a staff plan change does today. Ask: should the
   Orders role approve too?
8. **Emails about the decision.** Get Canada Sim emails the customer on
   approve and on reject today. Recommended: two new templates and two
   built-in rules, off by default like every rule. That changes the CHECK
   lists of `email_templates`, `email_template_versions`, `automations` and
   `automation_runs`, so it goes in this phase's migration. The alternative is
   no mail and the result shown on `/track`.
9. **Grant lifetime and limits.** Spec answers 10 minutes and per-email
   limits. Recommended, from Canadian Plans: 5 tries per code, 5 code requests
   and 10 verifications per email per 10 minutes, 30 customer writes per email
   per window, a neutral answer whether or not the email has orders, with a
   500 ms minimum latency, and a signed grant valid 30 minutes.
10. **The tracking secret.** Recommended: a new backend-only variable
    (Canadian Plans calls it `TRACKING_HASH_SECRET`, at least 32 characters)
    that keys the code and email hashes and the grant; unset, `/track`
    answers neutrally and reads fail closed. The owner sets it on Railway.
11. **Is the code mail an automation rule?** Recommended: no. It answers the
    customer's own request, like the staff "email this number" send, so it
    goes out whenever the site has a sender, and is never switched off.
12. **When to remove `EMAIL_SENDERS_JSON`.** Spec and D3 answer "phase 5".
    Recommended: in the same release, once a production query shows a saved
    `app.workspace_email_settings` row for every site that sends mail, and no
    `lead_sim_number_email` job is still queued or retryable.
13. **Technical, for the planner, not the owner: where the code lives in the
    outbox.** A rendered `lead_customer_email` payload would hold the code in
    clear until the job ends. Recommended: a job type of its own that carries
    the code sealed (`sealTrackingCode` exists) and renders at send time after
    checking the challenge is still open, as Canadian Plans' `delivery.ts`
    does, with its payload scrubbed to ids when it ends (extend the case in
    `apps/backend/src/jobs/store.ts`). This is an exception to "render when
    queued"; record it as a ruling in the plan.

## 6. Constraints and conventions

[README.md shared conventions](README.md#shared-conventions) first. Then:

- Every new table follows README rule 2. Change request rows hold the values
  the customer asked for: that is personal data, so it never goes into the
  timeline, audit, logs or runs (they name field keys and the request number).
- No raw email address or code is stored: challenges hold keyed hashes bound to
  the site and the normalized email; the grant carries the email sealed; rate
  limit buckets use a keyed hash of the email (Canadian Plans' `secrets.ts`).
- The request-code route answers the same way, in the same minimum time,
  whether or not the email has orders, so it cannot be used to find customers.
- A grant is bound to one site; every read and write re-resolves the lead by
  its reference **and** the grant's email.
- The website never sends a price; a plan change names a plan id the backend
  checks as `PATCH` does today (`plan_not_available`).
- Customer uploads go through the existing signed-upload pipeline
  (`apps/backend/src/documents/`), bound to the tracking grant and the lead
  instead of a draft grant.
- The removal of `EMAIL_SENDERS_JSON` keeps a site without saved settings
  unable to send (`no_sender`), as a site without an entry is today.
- Migrations: step A ships `0015_order_numbers` and
  `0016_order_numbers_runtime` (paste file
  `docs/RUNBOOKS/manual/0015-0016-order-numbers.sql`); tracking is
  `0017_customer_tracking` generated and `0018_customer_tracking_runtime`
  custom, with the paste file
  `docs/RUNBOOKS/manual/0017-0018-customer-tracking.sql`. If 0018 replaces
  `app.prune_operational_rows` (to prune old challenges), plan for the owner to
  paste it (README "How to ship" step 2).

## 7. Suggested task breakdown

An outline for the planner, not the plan. Names are suggestions.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                         | Files (main)                                                                                                                                                                                  | Tests                                                                                                                                                | Model | Depends on   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| 0   | (If decision 1 is yes) Get Canada Sim order intake: model `sim_order` intake, the import's last run, the old admin's order pages retired; its own small plan or the first wave.                                                                                                                                                                                                              | `apps/backend/src/leads/types.ts`, `packages/contracts/src/lead-types.ts`, the Get Canada Sim checkout (its repo), `docs/RUNBOOKS/legacy-import.md`                                           | Intake unit and integration tests; a rehearsed import with reconciled counts (spec §13).                                                             | hard  | none         |
| 1   | Contracts: tracking request and verify, grant, the customer's lead list and detail, change request create, staff list, approve and reject, error codes, timeline additions (for example a change request id on the entries), endpoints and the typed client.                                                                                                                                 | `packages/contracts/src/tracking.ts` (new), `lead-work.ts`, `common.ts`, `endpoints.ts`, `client.ts`, `index.ts`; regenerate `docs/api/openapi.json`                                          | Contracts unit tests.                                                                                                                                | hard  | decisions    |
| 2   | Database: `0017` (generated; `0015` and `0016` went to step A's order numbers) with a challenges table and a change requests table (lead FK `(workspace_id, lead_id)`, a per-site request number, status `pending`/`approved`/`rejected`, resolved by and at, staged documents), and any CHECK list changes from decisions 8 and 13; `0018` runtime: FORCE RLS, grants (no DELETE), pruning. | `packages/db/src/schema.ts`, `packages/db/drizzle/0017_*.sql`, `0018_*_runtime.sql`, journal, `docs/RUNBOOKS/manual/0017-0018-*.sql`, `docs/RUNBOOKS/database.md`                             | `packages/db/tests/*.integration.test.ts` (RLS, FORCE, grants, checks, re-run 0018); `apps/backend/tests/operational-retention.integration.test.ts`. | hard  | none         |
| 3   | Backend: tracking secrets and service, ported from Canadian Plans: code generation, keyed hashes, attempts, expiry, neutral answer with minimum latency, signed grant.                                                                                                                                                                                                                       | `apps/backend/src/tracking/` (new), `apps/backend/src/crypto/cipher.ts`                                                                                                                       | Unit tests ported with the code; store integration test on `ENV(n)`.                                                                                 | hard  | 1, 2         |
| 4   | Backend: the tracking-code mail: a composer recipient without a lead, its job type and handler, payload scrub at the end.                                                                                                                                                                                                                                                                    | `apps/backend/src/email/compose.ts`, `queue.ts`, `jobs/src/index.ts`, `apps/backend/src/jobs/providers.ts`, `apps/backend/src/jobs/store.ts`                                                  | Unit (render, missing sender); integration (one job, scrubbed after send).                                                                           | hard  | 2, 3         |
| 5   | Backend: the customer's read model: leads by site and normalized email, shaped for the customer only.                                                                                                                                                                                                                                                                                        | `apps/backend/src/tracking/store.ts`                                                                                                                                                          | Integration: another site's lead and another email's lead never show; archived per decision 3.                                                       | hard  | 2, 3         |
| 6   | Backend: change requests: create (one pending per lead), staged documents through the upload pipeline, approve through `updateLead`, reject; timeline and audit with keys only.                                                                                                                                                                                                              | `apps/backend/src/tracking/`, `apps/backend/src/leads/work-store.ts`, `apps/backend/src/documents/`                                                                                           | Integration: approve applies the fields and writes `change_approved`; reject writes `change_rejected`; a second pending request refused.             | hard  | 5            |
| 7   | Backend routes: website `/tracking/*` with per-email limits; staff change request routes (list on the lead, approve, reject) with the permission from decision 7.                                                                                                                                                                                                                            | `apps/backend/src/routes/website.ts`, `apps/backend/src/routes/staff.ts`, `apps/backend/src/http/domain-errors.ts`                                                                            | Route tests with mocked stores (each code and status).                                                                                               | easy  | 1, 4, 5, 6   |
| 8   | Remove `EMAIL_SENDERS_JSON` and `lead_sim_number_email`.                                                                                                                                                                                                                                                                                                                                     | `apps/backend/src/email/senders.ts`, `apps/backend/src/jobs/providers.ts`, `jobs/src/index.ts`, `packages/contracts/src/customer-email.ts`, `apps/admin/src/components/email/`, `docs/ENV.md` | Update the tests that use it (`customer-email.test.ts`, `jobs-providers.test.ts`, `email-compose.integration.test.ts`, the harness).                 | easy  | none         |
| 9   | Admin: the change request card on the lead page (current and requested values, Approve, Reject), the timeline from CRM requests, the "waiting in the old admin" wording only for imported ones; Settings → Email says when `tracking_code` is sent.                                                                                                                                          | `apps/admin/src/components/leads/`, `apps/admin/src/components/email/`, `apps/admin/src/lib/api.ts`                                                                                           | Component tests (Testing Library).                                                                                                                   | hard  | 1 (mocks), 7 |
| 10  | Done when: an integration test of the whole flow (request code, verify, list, request a change with a document, staff approve, timeline); harness seeds; a Playwright journey that approves a change request.                                                                                                                                                                                | `apps/backend/tests/tracking-flow.integration.test.ts` (new), `apps/backend/tests/e2e/harness.ts`, `apps/admin/e2e/leads.spec.ts`                                                             | The tests themselves; all journeys pass.                                                                                                             | hard  | 7, 9         |
| 11  | Get Canada Sim `/track` calls the CRM (a pull request in that repository).                                                                                                                                                                                                                                                                                                                   | The Get Canada Sim repository                                                                                                                                                                 | That repository's own checks, then a test against the live CRM.                                                                                      | hard  | 7 deployed   |
| 12  | Docs: AGENTS.md (vocabulary: challenge, grant, change request; where things live), HANDOFF §2.3, §2.4, §2.6, §3, §5.1, §5.3, PLAN §7 and §10, ENV.md (the tracking secret; `EMAIL_SENDERS_JSON` removed), `docs/RUNBOOKS/database.md`, this README's status row.                                                                                                                             | docs                                                                                                                                                                                          | Prettier.                                                                                                                                            | easy  | all          |
| 13  | Gate, PR, migrations, deploy, the `/track` switch, the live check with a real customer's change request.                                                                                                                                                                                                                                                                                     | none                                                                                                                                                                                          | The gate.                                                                                                                                            | easy  | all          |

Parallel worktrees: 1 ∥ 2 ∥ 8 first; then 3; then 4 ∥ 5; then 6; then 7 ∥ 9
(admin against mocks); then 10, 12, 13; 11 after the backend is live.

## 8. How to ship

The gate (README "Commands and the gate"):

```sh
pnpm run lint && pnpm run typecheck && pnpm run format
ENV(n) pnpm run test
pnpm --filter admin test:e2e:leads
pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json
```

Then, as in README "How to ship": PR titled "Customer tracking (merge phase
5)" with the footer, subscribe and schedule a check-in; apply `0015` to `0018`
to `xykrphbgpwisqacpyeiv` before the merge, through `execute_sql` in small
batches with the owner pasting what trips the prompt, the tracker rows by hand,
the verification selects one at a time, the record in
`docs/RUNBOOKS/database.md`; merge; Railway backend, health 200; Vercel admin.

Phase-specific order:

1. Set the tracking secret on Railway before the deploy (unset means tracking
   is off, not broken).
2. Before removing `EMAIL_SENDERS_JSON` from Railway, check every sending site
   has saved Settings → Email; remove the variable only after the deploy that
   no longer reads it.
3. Switch Get Canada Sim's `/track` to the CRM only after the CRM side is live
   and tried with a test order and a staff test address.
4. Live check: a real customer's change request, approved in the CRM, with the
   request and decision on the timeline and the change on the lead.

## 9. Working method

As in [README.md](README.md#working-method). For this phase:

- Brainstorm the thirteen decisions above one at a time, in order; decision 1
  may turn into a plan of its own.
- Tasks 0, 3, 4, 5, 6, 9 and 10 are Opus work (security and integration);
  7, 8 and 12 suit Sonnet.
- Port Canadian Plans' tracking tests with the code they cover (spec §13).
- The Review Focus should include: a guessed or reused code; a code requested
  for an email with no orders (neutral answer, same timing); a grant used on
  another site; two change requests sent at once; an approval that races a
  staff edit of the same field; a document sent with a request and then
  rejected.

## 10. Definition of done checklist

- [x] The owner's answers to section 5 are recorded in the plan header.
- [x] The plan is approved and committed in `docs/superpowers/plans/`.
- [ ] Get Canada Sim's orders are worked in the CRM (if decision 1 is yes).
- [x] A customer can request a code, see their orders and request a change
      through the CRM's website API; limits and the neutral answer are tested.
      (Built and tested, 2026-10-30; not deployed.)
- [x] Staff approve and reject on the lead page; both are on the timeline with
      field keys only; approvals go through the normal lead edit. (Built and
      tested, including the tenth lead journey; not deployed.)
- [x] The `tracking_code` mail is sent from the site's sender at its template's
      current version, and no code stays readable in a finished job. (Built
      and tested; not deployed.)
- [ ] `EMAIL_SENDERS_JSON` and `lead_sim_number_email` are gone from code,
      Railway and ENV.md. (Code and ENV.md done; Railway after the deploy.)
- [ ] Migrations `0015` to `0018` applied to the hosted project and recorded
      in `docs/RUNBOOKS/database.md`. (0015 and 0016 applied 2026-10-30; 0017
      and 0018 not applied yet.)
- [ ] The gate is green; the PR is merged with a merge commit; Railway and
      Vercel deployed in order.
- [ ] Get Canada Sim's `/track` calls the CRM.
- [ ] A real customer's change request was approved in the CRM (spec §12).
- [ ] HANDOFF, PLAN, ENV, AGENTS.md and this folder's README are current.
      (Current for the build, 2026-10-30; the deploy and the switch day update
      them again.)
