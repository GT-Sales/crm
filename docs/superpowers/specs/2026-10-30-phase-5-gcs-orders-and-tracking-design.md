# Merge phase 5: Get Canada Sim orders and customer tracking (design)

Status: approved in conversation on 2026-10-30; this file is the written
design for the owner's review. It refines the merge design
([2026-10-28-merge-canadian-plans-design.md](2026-10-28-merge-canadian-plans-design.md)
§8 and §12 row 5) and the hand-off page
[phases/phase-5-customer-tracking.md](../phases/phase-5-customer-tracking.md).
Branch: `phase-5-customer-tracking`.

## 1. Goal

Done when (merge design §12): **a real Get Canada Sim customer's change request
is approved in the CRM.** That needs two things the CRM does not have today, so
the phase has two steps, each shipped on its own and each leaving Get Canada Sim
working:

- **Step A, orders move in.** Get Canada Sim's checkout sends new SIM orders to
  the CRM, staff work orders only in the CRM, and the old import runs one last
  time.
- **Step B, customer tracking.** A customer opens `/track` on the website, gets a
  code by email, sees their orders and asks for changes; staff approve or
  reject on the lead page.

## 2. Facts this design rests on (checked 2026-10-30)

- Get Canada Sim has no CRM wiring. Its checkout (`src/app/order/actions.ts`:
  `startOrder` creates a draft row, `submitOrder` completes it) writes
  `public.orders`; staff work orders in its own admin; `/track`
  (`src/app/track/`) reads `public.orders` and writes `public.order_edit_requests`.
- The CRM holds a copy refreshed by the re-runnable import
  (`docs/RUNBOOKS/legacy-import.md`); imported leads keep `MS-<order_no>` as
  `leads.external_ref`; nothing flows back.
- Production numbers: 143 orders, 30 in the last 30 days; 67 change requests in
  the last 90 days, 3 pending; 5 partners, 2 approved, 1 partner-referred order
  ever, 0 partner invoices.
- The partner portal (`src/app/portal/`), commissions and the monthly invoice
  job (`src/lib/invoices.ts`) read `public.orders` and its status.
- The CRM website API already accepts a `sim_order` as a resumable draft and
  freezes the plan on submit (HANDOFF §2.6 items 3, 8, 9), but the lead-type
  registry (`apps/backend/src/leads/types.ts`) does not check SIM order fields
  yet.
- `/track` today: 6-digit code, 15-minute code, 1-hour session, one pending
  edit request per order replaced in place, edits while `pending` or
  `incomplete`, passport and visa uploads staged for approval, decision emails
  on approve and reject.

## 3. Owner decisions (2026-10-30)

| #   | Question                                     | Answer                                                                                                                                                |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Get Canada Sim's orders live outside the CRM | **Move them in first** (step A), then tracking (step B).                                                                                              |
| 2   | Partner portal, commissions, invoices        | **Pause until the partners phase.** The portal keeps showing orders from before the switch; new leads keep the partner code.                          |
| 3   | Archived orders on `/track`                  | **Hidden.** A cancelled order still shows, as Cancelled.                                                                                              |
| 4   | Stages that allow a change request           | **Pending, Verified and On hold.** Not Incomplete.                                                                                                    |
| 5   | Who approves or rejects                      | **The Leads permission** (`lead.manage`: owner and Leads role). Sent documents still need an Orders review (`order.manage`).                          |
| 6   | Other Get Canada Sim forms                   | **SIM orders only.** Partner applications and contact messages stay on the website.                                                                   |
| 7   | Order confirmation email                     | **The website keeps sending it** (and the new-order alert). The CRM's `order_received` rule stays off; the owner may switch later, website first off. |
| 8   | Change approved / rejected emails            | **Always sent**, like the tracking code: two new editable templates, no automation rule.                                                              |
| 9   | Payment status on `/track`                   | **Not shown.**                                                                                                                                        |

## 4. Rulings (made for the owner, recorded here)

Each: ruling, why, cost if wrong.

1. **Order numbers continue in the CRM.** A new Get Canada Sim order gets the
   next `MS-<n>` as its `external_ref`, from a per-site counter the backend
   advances inside the create transaction, seeded on switch day from the
   highest imported number. Customers and staff keep one number format; cost:
   a small table and a seed step.
2. **`/track` lists submitted, non-archived order leads** (`sim_order`,
   `internet`, `mobility`) of the site whose contact email matches, newest
   first, at most 50. Unfinished checkouts (`status = 'incomplete'`) are not
   listed: they cannot be changed (decision 4) and were never orders. Cost: a
   customer who abandoned checkout sees nothing, as before they submitted.
3. **A new change request replaces the customer's own pending one** on the same
   lead (Get Canada Sim's behaviour), so there is at most one pending request
   per lead. Documents already sent with the pending request are kept.
4. **What a customer may change**: full name, phone, plan, SIM type
   (`delivery`), arrival date, permit type, Canada address, shipping address,
   flight booked, and new passport or visa files. Never the email address.
   These are the website's `EDITABLE_ORDER_FIELDS` mapped to the CRM's
   `sim_order` field keys (`delivery`, `arrivalDate`, `permitType`,
   `canadaAddress`, `shippingAddress`, `flightBooked`, the plan through
   `order.planId`, the name and phone on the contact).
5. **The tracking code email is not an automation rule**: it answers the
   customer's own request, uses the site's `tracking_code` template and goes
   out whenever the site has a sender. Its job carries the code sealed
   (`sealTrackingCode`) and renders at send time after checking the challenge
   is still open; the payload is scrubbed to ids when the job ends. This is a
   deliberate exception to phase 4's "render when queued", so no code sits
   readable in the outbox.
6. **The two decision emails** use new templates `change_approved` and
   `change_rejected` (fill-ins `{first name}`, `{site name}`, `{tracking link}`),
   queued through phase 4's composer in the approve or reject transaction. A
   site with no sender or a lead with no email skips silently and says so in
   the response (`emailSkipped`), as rules do.
7. **Limits** (from Canadian Plans): 6-digit code, 10 minutes (merge design
   §8), 5 tries per code; 5 code requests and 10 verifications per email per
   10 minutes; 30 customer writes per email per 10 minutes; the request-code
   answer is the same, in at least 500 ms, whether or not the email has
   orders; a signed grant lasts 30 minutes and is bound to one site and one
   normalized email.
8. **One new backend secret**, `TRACKING_HASH_SECRET` (at least 32
   characters), keys the code and email hashes and signs the grant. Unset
   means tracking answers neutrally and reads fail closed; it is not an error.
9. **The old admin's Orders board becomes read-only** on switch day, with a
   notice that orders are worked in the CRM (a Get Canada Sim change). Its
   internet and mobility boards (fed by the CRM's 0002 mirror) are untouched.
10. **`EMAIL_SENDERS_JSON` and the `lead_sim_number_email` job type are removed**
    in step B, once a production query shows saved email settings for every
    sending site and no such job queued or retryable (ruling D3).
11. **Step order in git**: both steps are built on `phase-5-customer-tracking`;
    step A goes to `main` in its own pull request before the switch day, step
    B in a second pull request after.

## 5. Step A: orders move in

### CRM changes

- **Intake for `sim_order`** in the lead-type registry: a submitted SIM order
  needs a contact email and name, a plan and a delivery choice; a draft may be
  partial (step 1 of the checkout). Refusals use the registry's existing codes,
  never values.
- **Order number**: a per-site counter (new table in `0015`, its FORCE RLS
  and grants in `0016`), advanced in the
  `POST /website/leads` transaction for `sim_order` creates that carry no
  `externalRef`; the response returns the reference. Seeded from the highest
  imported `MS-` number.
- **Documents at checkout** (partner variant): the existing upload intents
  with the draft grant; nothing new.
- **Attribution**: the website sends the partner code (`ms_ref`) in the lead's
  attribution as other sites do.

### Get Canada Sim changes (its repository)

- `startOrder` creates the CRM draft (`POST /api/v1/website/leads`,
  `leadType: 'sim_order'`, no `submit`), stores the draft grant in its existing
  draft cookie, and no longer writes `public.orders` once the switch flag is on.
- `submitOrder` submits it (`PATCH … submit: true`) with
  `order: { planId, quantity: 1 }` and an `Idempotency-Key` derived from the
  draft, reading the CRM plan id from `GET /api/v1/website/plans?leadType=sim_order`
  matched to the website's plan slug.
- The confirmation page and the website's own confirmation email show the
  CRM's `MS-` number. The new-order alert stays.
- A switch flag (`CRM_ORDERS=on`, with `CRM_API_URL` and `CRM_SITE_KEY`) so the
  change ships dark and flips on switch day; unset keeps today's behaviour.
- The Orders board read-only notice (ruling 9).

### Switch day (owner picks the day)

1. Staff resolve the pending change requests in the old admin.
2. The order counter is seeded from the highest `MS-` number in
   `public.orders`; the website's `CRM_ORDERS` flag goes on, so every new
   order now lands in the CRM.
3. The import runs one final time (it only fills what the CRM lacks, so
   orders placed just before the flip are caught); counts reconciled (merge
   design §13).
4. A test order goes through and is checked in the CRM; the old admin's
   Orders board is read-only.

## 6. Step B: customer tracking

### Data (migrations `0017` generated and `0018` runtime; step A ships `0015` and `0016`)

- `app.tracking_challenges`: site, keyed email hash, keyed code hash, attempts,
  expiry, consumed time. No raw email or code.
- `app.change_requests`: site, lead (`(workspace_id, lead_id)` FK), request
  number per site, status `pending` / `approved` / `rejected`, the requested
  values (personal data: never copied to timeline, audit, logs or runs),
  staged file ids, resolved by and at.
- CHECK lists widened for the two new template keys (`email_templates`,
  `email_template_versions`), a new outbox job type for the code mail, and
  pruning of old challenges in `prune_operational_rows` (that function's
  replacement is the statement the owner pastes, as in phase 4).
- FORCE RLS, tenant and backup read policies, grants without DELETE, as every
  table.

### Website API (scope: a new `tracking` scope on the site key)

- `POST /website/tracking/code`: email in, neutral answer, queues the code mail.
- `POST /website/tracking/verify`: email and code in, a grant out.
- `GET /website/tracking/orders`: the customer's orders (ruling 2) with stage
  (a customer wording per stage), plan name and price, quantity, delivery,
  courier, tracking number, dispatch date, SIM number, each required
  document's state and any pending change request.
- `POST /website/tracking/orders/:ref/changes`: fields per ruling 4, only in
  Pending, Verified or On hold.
- Upload intents for a passport or visa bound to the grant and the lead,
  through the existing signed-upload pipeline; the files join the pending
  request.

### Staff side

- Lead page: a change request card (current and requested values, the sent
  documents, Approve and Reject) for `lead.manage`. Approve applies the fields
  through `DatabaseLeadWorkStore.updateLead` (timeline `change_approved` with
  field keys, audit with keys, plan re-frozen on a plan change) and attaches
  the documents as new revisions awaiting review; reject discards staged
  files. Both queue the decision email (ruling 6).
- Timeline `change_requested` for CRM requests; the existing "waiting in the
  old admin" wording stays only for imported ones.
- Settings → Email lists the three new templates and says they are always
  sent.

### Get Canada Sim changes

- `/track` calls the CRM's tracking endpoints instead of `public.orders` and
  `public.order_edit_requests`, behind a flag, switched on after the CRM side
  is live and tried with a test order.

## 7. Testing

- Unit tests ported with Canadian Plans' tracking code (secrets, cipher,
  limits).
- Integration on a `_test` database: intake checks and the order counter under
  concurrent creates; a tracking flow from code request to approved change with
  the timeline, audit and decision email; another site's and another email's
  leads never listed; a guessed or reused code refused; two change requests at
  once leave one pending; an approval that races a staff edit; a rejected
  request's files removed.
- Playwright: a journey that approves a change request on the lead page.
- Get Canada Sim: its `npm test`, lint and build, plus a test order against a
  staging or live CRM before each flag flips.
- The final import rehearsed with reconciled counts before switch day.

## 8. Out of scope

Partner screens, commissions and invoices (paused, decision 2); partner
applications and contact messages (decision 6); payments; Canadian Plans' "ask
the customer for…" requests (merge design decision 17); custom automation
rules (phase 8).

## 9. Risks

- **Switch-day order loss**: an order placed between the final import and the
  flag flip would be missed. Mitigation: flip the flag first, then run the final
  import (it only fills what the CRM lacks), and reconcile.
- **Plan mapping drift**: a plan renamed on one side breaks the slug match.
  Mitigation: the checkout refuses to submit when no CRM plan matches, and a
  test pins the six current plans.
- **Customers mid-edit on switch day**: pending requests resolved in the old
  admin first (switch day step 1).
