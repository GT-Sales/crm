# GT Sales CRM — decisions and rules

**Status:** in production · **Owner:** Md Takibuddin (builds and runs it) ·
**Client:** GT Sales (owns it)

The decisions in force and the rules the system is built on. What is live
and what waits for an owner step is in [HANDOFF.md](HANDOFF.md); how the
system works is in [ARCHITECTURE.md](ARCHITECTURE.md). Section numbers here
are cited from code comments, so keep them stable.

## 1. Decisions

| #   | Decision                                                                                                                                                                    | Notes                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Websites today: **Get Canada Sim** and **CanadaWide**. More will follow.                                                                                                    | A new site must need no new tables or admin pages.                                              |
| 2   | **This repo** holds the backend, the admin and the shared packages. Each website stays in its own repo.                                                                     | Backend and admin change together; websites rarely touch the API.                               |
| 3   | **Every SIM order is also a lead** in the shared inbox.                                                                                                                     | An order is a lead carrying order tools.                                                        |
| 4   | **People are merged by email** across sites.                                                                                                                                | Trimmed and lower-cased. Email only, never name or phone.                                       |
| 5   | **The database stays where it is**: the Get Canada Sim Supabase project (Mumbai, `ap-south-1`).                                                                             | Additive changes only.                                                                          |
| 6   | **Copied and adapted from the Canadian Plans platform** (the owner's own code).                                                                                             | Its structure, auth, admin shell and tooling were reused; its business data and brand were not. |
| 7   | **Drizzle over a pooled Postgres connection with row-level security**, **Supabase Auth for staff**, **a service credential per website**, **S3-compatible object storage**. |                                                                                                 |
| 8   | **One product, built from this repository, deployed per business** (2026-10-28).                                                                                            | Stages, payment status and carrier commission are separate properties.                          |
| 9   | In code a website is a **`workspace`**; the UI says **Site**.                                                                                                               |                                                                                                 |

Reuse note: Canadian Plans has no LICENSE file and is owned solely by the
owner, so copying it into this private client repo is the owner granting the
client a copy. The admin's look adapts the Shadcnblocks admin kit and blocks
the owner supplied (Shadcnblocks.com License); no Twenty source is in the
repository.

### 1.1 Merge decisions (owner, 2026-10-28)

"Merge decision _n_" in the code and runbooks:

1. The owner owns all the code; no ownership constraint on reuse.
2. A reusable product: one codebase, one deployment and database per
   business, each configured for its own modules, rules and branding.
3. One set of order tools (lead → sale → dispatch → activation →
   commission), configured per business.
4. Websites are outside the product, each in its own repository, calling the
   API with a site key.
5. Multi-factor sign-in is off in every deployment.
6. The same person on several sites of one business is merged by email;
   businesses never share customers.
7. Only GT Sales' data is live.
8. Base: this repository and its migration history; additive migrations.
9. Plans are an object managed in the admin; no Sanity sync.
10. Plans are built on the shared property engine; staff create no object
    types.
11. Each plan belongs to one site.
12. No quote step: the backend reads the plan's price at submission, ignores
    any browser price and freezes a copy on the lead.
13. An order is a lead; each website form is a lead type; order lead types
    carry the order tools.
14. Order state is separate properties: stage (progress only), payment
    status, carrier commission.
15. Partners later: the partner code stays on leads; no partner screens or
    payouts yet.
16. Every change is on the lead's timeline (who, when, which field),
    customer actions too. A customer's own save of an unfinished form shows
    the changed fields **with the values they filled in** (21 Nov 2026):
    kept where a customer's erasure nulls them, shown only with a lead's
    details, never in a log or an audit event, never for a sensitive field.
    Staff edits still name fields only.
17. Customer tracking: email → one-time code → orders → change requests that
    staff approve. A document sent for an order that has none of that type
    is added at once, without a decision (23 Nov 2026: Get Canada Sim's
    customers send their passport and visa after checkout, and they were
    waiting unseen on the change request card).
18. No admin feature deletes customer data: requests come through the
    website's contact page and a developer deletes in the database; staff
    can only archive.
19. Backups: database and documents, encrypted, to Backblaze B2, with a
    practised restore; the archive key may write but never delete.
20. The source report is part of the CRM.
21. No province waitlist.
22. The intake check: a test lead to a hidden test site every 15 minutes, an
    alert on failure, the check cleans up after itself.
23. Admin look: the CRM's colours and fonts with a compact layout (tables,
    view bar, side panel, board).
24. Saved views are private only.
25. A full automation builder.
26. Analytics are read-only from the self-hosted Umami; the CRM sends
    nothing to Umami.
27. The repository stays at `GT-Sales/crm` with the `@gt-sales/*` names for
    now.
28. Order tools: plan with frozen price, dispatch and activation details,
    the documents check with a recorded override, double-submit protection,
    automatic customer emails off until switched on.
29. One lead is one sale, with a quantity.
30. Canadian Plans itself does not move in (dropped 2026-10-31): GT Sales
    only.
31. No blog editor and no partner portal in the CRM.
32. Customer email: one shared layout, site branding, editable text.

Hard to change once built on: an order is a lead; each plan belongs to one
site; contacts merged by email; stage keys (labels change freely, keys are
referenced by reports, emails and automations); the repository location and
package names.

### 1.2 Later owner decisions in force

| Date        | Decision                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-25  | No multi-factor step: a privileged action needs only the role or permission that grants it.                                               |
| 2026-10-27  | A verified staff session is cached for 60 seconds per token.                                                                              |
| 2026-11-06  | One GitHub Environment, `backup-gt-sales`, with one bucket-only B2 key for the backup, monitor and retention workflows.                   |
| 2026-11-20  | The old Get Canada Sim admin keeps receiving a copy of every submitted CRM order until the owner retires it.                              |
| 13 Nov 2026 | A mail to a lead's customer keeps its subject and plain text on its timeline entry.                                                       |
| 21 Nov 2026 | A site key lists the lead types it may send; anything else is refused and nothing is stored.                                              |
| 21 Nov 2026 | The leads search (a name, email or phone) is in no URL: page state and a request body only. The non-personal filters stay in the address. |
| 21 Nov 2026 | Every storage copy of a document is deleted, and a failed delete is retried until storage confirms.                                       |
| 21 Nov 2026 | One current file per lead and document type, enforced by the database; the newest upload wins and no approval is carried over.            |
| 21 Nov 2026 | Order tracking dates an order by when it was submitted.                                                                                   |
| 21 Nov 2026 | Older restricted drafts get the same erasure as current ones.                                                                             |
| 21 Nov 2026 | A rescued Get Canada Sim order reaches the old admin once its contact is complete (migration 0048, not applied yet).                      |
| Nov 2026    | A backup run that completes with documents missing from storage stays green with a warning and one owner alert.                           |
| 21 Nov 2026 | When a member's access is reduced, their saved Ask AI chats follow the rule in [design/ai-chat.md](design/ai-chat.md) §2.                 |
| 21 Nov 2026 | Testing: no staging environment exists yet, traffic is low, no site takes card payments ([TESTING-PLAN.md](TESTING-PLAN.md)).             |

## 2. Sources

The Canadian Plans platform gave the monorepo tooling, the backend core,
staff auth and RBAC, website credentials, documents, the outbox and email
module, audit, retention and the admin shell. Get Canada Sim gave what the
business does: the order flow and statuses, plans, email texts. CanadaWide
gave the field rules for internet and mobility leads and the ID step.

## 3. Architecture and rules

```
getcanadasim.com ──┐
CanadaWide site ───┼── service credential ──►  Backend (Express, Railway) ──► Supabase Postgres
next website ──────┘                                   ▲          │             (pooled, RLS)
                                                       │          └──► Supabase Storage (S3 API)
                                            Admin / CRM (Next.js, Vercel)
                                            Supabase Auth session
```

Hosting: the backend on Railway in Singapore (`asia-southeast1`), the region
nearest the Mumbai database, because every staff request is a chain of
sequential database round trips; the admin on Vercel; database, Auth and
Storage in the one Supabase project. Details: [HANDOFF.md](HANDOFF.md) §1 and
[ARCHITECTURE.md](ARCHITECTURE.md).

### Rules

1. **The backend is the only database client.** Websites and the admin never
   hold a database key. (Browser-direct upload through a backend-issued
   signed URL is the one documented exception.)
2. **Every tenant table carries `workspace_id NOT NULL`.** `contacts` is the
   documented global table (§5.4).
3. **Isolation is enforced twice:** the backend authorizes each request, and
   Postgres RLS reads `app.workspace_id` set per transaction. Missing context
   denies.
4. **Each website authenticates with its own service credential**, stored
   hashed, revocable, scoped, and limited to the lead types it may submit
   (`service_credentials.lead_types`). A lead of another type, draft or
   submitted, is refused and nothing is stored.
5. **Server-side validation per lead type**: length caps, allow-listed
   enums, date formats, file signatures from magic bytes.
6. **Admin access = role × site membership.** A member of CanadaWide only
   never sees a Get Canada Sim lead, including on a merged contact.
7. **Sensitive values are protected.** ID documents stay private behind
   short-lived signed URLs; SINs are encrypted and shown masked; every
   reveal or download is audited.
8. **External side effects go through the outbox**, executed after commit.
9. **No PII in logs, errors or URLs.** No service-role key in application
   code. The leads search is in no URL.
10. **Strict TypeScript, no `any`.** Types, schemas and DB rows derive from
    one source; API responses expose only the fields each audience may see.
11. **"Not configured" and "the query failed" are different states.** A
    failed load shows an error, never sample data. A website never fakes
    success.

## 4. Scope

Orders are leads with order tools. Not in the CRM: Get Canada Sim's partner
screens and payouts, invoices, the blog editor and the partner portal
(decisions 15 and 31); Canadian Plans' own catalogue, quotes, orders and CMS.

## 5. Key design points

### 5.1 Site = workspace

A site is a row of `app.workspaces` (`slug`, `domain`, `status`). Service
credentials are site keys; their `scopes` say what the site may do
(`leads:write`, `uploads:customer`, `tracking`).

### 5.2 "All sites" reads

RLS allows one workspace per transaction. A cross-site inbox would run one
query per site the member belongs to and merge the results, with no RLS
change. Not built.

### 5.3 Leads

**Lead types are a registry in backend code**
(`apps/backend/src/leads/types.ts`): the payload schema, the intake rules,
which fields are personal. Adding a form is a registry entry and the lead
type on the site's key. The per-type working statuses are the lead's `stage`,
with labels, stages, allowed moves and gates in `leadTypeCatalog` in the
contracts so the admin shares them; `status` stays the form's lifecycle. The
stages per type are in [ARCHITECTURE.md](ARCHITECTURE.md) §6.1. A partner
code stays in `attribution` verbatim until partners come.

### 5.4 Contacts (merge by email)

`app.contacts` is global by design: unique by `lower(btrim(email))`, with
name, phone and country. Its RLS policy requires only a verified actor,
because intake on site B must find the contact site A created before any
lead of B references it. Tenant scoping is therefore enforced by the backend,
which only ever exposes a contact through a lead of the current workspace and
never lists the table. Intake refreshes name, phone and country from the
latest submission without erasing earlier values. Gmail dots and `+tags` are
not stripped. Split and merge are not built.

### 5.5 Activities and tasks

`lead_activities` is the append-only timeline; `lead_tasks` the follow-ups
and plain tasks.

### 5.6 Documents on Supabase Storage

The S3 adapter's endpoint is the Supabase project's Storage S3 endpoint with
Storage S3 access keys. Supabase serves S3 under `/storage/v1/s3`, and SigV4
signs that path too.

### 5.7 Staff auth and roles

Supabase Auth, email and password, no authenticator step. Roles: `owner`,
`leads`, `orders`, `partners`, `finance`, `content`, `viewer`. Recovery of a
locked-out owner goes through the Supabase Auth dashboard.

### 5.8 Intake API

[ARCHITECTURE.md](ARCHITECTURE.md) §2 and §5.

### 5.9 Sensitive values

A SIN (CanadaWide mobility) is sealed with `cipher.ts` (AES-256-GCM, key
`SENSITIVE_FIELDS_KEY` held only by the backend) on intake; shown as
`*** *** 123`; a full reveal needs `sensitive.reveal` and writes an audit
event. Documents: private bucket, signed URLs, audited downloads.
CanadaWide's `public.mobility_id_uploads` (SINs in plain text) are not
imported.

### 5.10 Left out or optional

Sanity and the CMS contracts, catalogue sync, offer versions and quotes, the
region waitlist, SES. Turnstile is optional: production runs
`WEBSITE_BOT_CHECK=delegated` (ENV.md). Lead intake queues no analytics jobs;
websites keep their own conversion events.

## 6. Database

- **Schemas:** CRM tables in `app` (RLS, Drizzle migrations). The websites'
  old tables stay in `public`.
- **Roles:** `app_runtime` (no `BYPASSRLS`, no superuser) for the backend
  over the pooled `DATABASE_URL`; migrations as the project's `postgres` role.
  `withTenantTx` sets `app.workspace_id` and `app.actor_id` per transaction,
  which works under the transaction-mode pooler.
- **Migrations** are additive and applied deliberately, never by a deploy
  ([RUNBOOKS/database.md](RUNBOOKS/database.md)).
- **Token prefixes:** site keys are `gtsk_…`, draft grants `gtdg_…`.
- **Legacy data:** both sites' histories were imported by re-runnable
  scripts ([RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md)). The two
  legacy mirrors keep the old admins supplied until the owner retires them.

## 7. Phases

Built and live: the CRM screens, backups, the property engine and saved
views, plans and Archive, order tools and customer email, Get Canada Sim's
orders and customer tracking, the source report and the intake check,
automation flows, and Ask AI. Not finished:

| Work                                                | State                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| CanadaWide's ID step through the CRM                | Built; waits for `CRM_ID_STEP=on` on CanadaWide.                                        |
| CanadaWide's staff cutover and the cutover clean-up | Waits for the owner's day; then drop the 0002 mirror and the identity mirror functions. |
| Retiring the old Get Canada Sim admin               | The owner's call; then drop the 0041 mirror.                                            |
| Cross-site inbox, contact page, split and merge     | Not started.                                                                            |
| Modelling `partner_application`, `contact_message`  | Not started.                                                                            |
| Backups' restore drill                              | Not recorded as done.                                                                   |

The full list with owner steps is [HANDOFF.md](HANDOFF.md) §3 and §4.

## 8. Verification

CI must be green: boundary lint (no `@gt-sales/db` outside the backend),
typecheck, lint, format, Vitest (including the RLS negative tests against a
disposable Postgres), build, admin e2e. A data migration is rehearsed with
reconciled counts before the real run. Nothing reaches production without
the owner's approval.

## 9. Risks

| Risk                                        | Mitigation                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Two admins in parallel until the cutovers   | The mirrors copy new rows to the old admins; staff should work each lead in one place.               |
| Duplicate customer emails                   | Every flow starts off; the owner switches each on after checking the website sends no copy.          |
| Wrong merges by email                       | Email-only matching; split and merge to come.                                                        |
| PII (SIN, IDs, DOB, addresses) under PIPEDA | Sealed fields, private storage, signed URLs, audited access, least privilege, erasure of old drafts. |

## 10. Decisions only the owner can make

- When CanadaWide's staff move to the CRM, and when the old Get Canada Sim
  admin is retired.
- Whether the Orders role alone may override the documents check (ruling D1,
  §11).
- When to switch `OPERATIONAL_RETENTION_ENABLED` on (after a verified
  backup).
- The list of admins to invite and who is `owner` or `finance`.
- The product name (working title: GT Sales CRM) and brand tokens.

## 11. Decisions and rulings cited from the code

Short definitions of the rulings and review findings that comments in the code
cite by name. The full write-ups are in `git log`.

**Phase 4 owner rulings (2026-10-30).** D1: the documents override is action
`order.override`, roles `owner` and `orders`, no individual permission; moving
a stage still needs `lead.manage`. D2: Activated is gated on `sim_order` and
`mobility`. D3: `EMAIL_SENDERS_JSON` was the fallback sender until phase 5
(removed). D4: customer tracking is phase 5. D5: automatic emails are
automation rules on the Automations page, all off until switched on; a template
is content only.

**Phase 5 (2026-10-30).** D10: one switch day after both parts are live:
`CRM_ORDERS` on, the final import, then `CRM_TRACKING` on. PF2: before the
first production test order, the switch-day seed runs with `+ 1000`. PF3: the
seed also sets the change request counter `change_request_no`. S1: the seed
leaves a gap of 9 past the old system's highest number (details in
docs/RUNBOOKS/legacy-import.md and `manual/gcs-switch-day.sql`).

**Phase 6 rulings (2026-10-31; intake check and source report).** R1: no
migration; deleting the test lead needs only `DELETE` on `app.leads`, its rows
elsewhere cascade. R2: no new index; revisit past about 100 000 leads on one
site. R3: the test lead's form is a fixed fictional internet form. R4: the
check goes through the website route's own checks; a refusal is a `create`
failure `intake_refused_<part>`. R5: the check runs as the scheduler entry,
which must hold `synthetic:check`; the site id comes only from
`INTAKE_CHECK_WORKSPACE_ID`; misconfigured, the check is left out and the
other tasks run. R6: only scheduled runs alert; the manual route returns the
result. R7: the production controlled failure removes and re-creates the test
site row (paste sections C and D), not a variable change. R8: a campaign row
carries `other`. R9: the alert subject is "GT Sales CRM: intake check failed".
R10: the manual route stays out of the endpoint registry. R11: the report
opens on the last 30 days.

**Phase 8 owner decisions (2026-10-31; automation flows).** O1: flows use
today's per-type stages. O2: triggers are submitted, enters a stage, time in a
stage (once per stay), task overdue, N days after submitted. O3: actions are
email the customer, create a task, assign the lead, notify staff (a link and
the flow's name, no customer details). O4: conditions on plan, lead type or a
non-sensitive property. O5: site-made email templates. O6: building and
switching need `integration.manage`; reading needs `workspace.read`. O7: a
visual canvas like Twenty's. O8: yes/no branches. O9: the first staff move out
of Incomplete counts as submitted, so the flows fire. O10: a built-in and a
custom flow on one event both send; the page warns. O11: flexible rules, a
Twenty-like canvas, the order emails as flows. O12: a rescued checkout counts
as submitted for every lead type. O13: the customer can no longer finish a
checkout staff rescued.

**Phase 8 design rulings.** R1: the 50-flow limit counts every flow not
archived, built-ins included. R2: a waiting run continues on the version it
started with; switching off or archiving cancels its waiting runs. R3: time
triggers never back-fill. R4: a submission counts as entering the stage the
lead stands in, so stage flows fire after the submitted flows. R5: lead changes
a flow makes are on the authority of the member who activated it, who needs
`lead.manage` too; each run re-checks it. R6: a flow naming something no
longer usable is skipped whole and marked "Needs attention". R7: an if/else is
the last step of its sequence. R8: flow moves chain at most 3 deep, never the
same flow twice. R9: staff notification mail goes to the member's sign-in
address recorded at sign-in, never shown. R10: the canvas is `@xyflow/react`
with our own auto-layout plus a list view. Controller ruling (2026-10-31): a
rescued checkout moved into a closing stage stays unsubmitted and fires
nothing; if the customer then submits it, it is submitted afresh at Pending
(SIM order) or the first stage (other types).

**Phase 8 plan rulings.** P5: chain depth 0 to 3; the fourth move is skipped
`chain_too_deep` while its emails still go. P6: a resumed run's chain comes from
`parent_run_id`. P7: every bulk change to waits and
timers claims rows `FOR UPDATE SKIP LOCKED`. P8: a staff notification job
carries no address. P10: the empty draft. P11: no flow sends `tracking_code`.
P12: unknown fill-ins refused; unusable properties are a site issue. P13: at
most 50 site-made templates, counted under a lock. P14: the 50-flow count
under an advisory lock. P15: changes are audited, draft saves are not. P17:
timers have no attempts column. P18: 200 items per site per tick. P19: lead
changes are written as the activator (a queued start as its write's actor).
P22: a write's response covers the flows it set off. P23: the site snapshot is
read lazily, once per write. P24: the test seam. P25: cancelling a waiting
run.

**Security review (2026-11-10).** M-1: the admin's per-request nonce CSP
(`apps/admin/src/proxy.ts`, `src/lib/csp.ts`). M-2: restricting an abandoned
draft erases its files, tasks, identities, note texts, contact link and
unreferenced contacts (migration 0030). L-1: a draft grant uploads and
downloads only while its lead is an unarchived draft. L-2: tracking-code
verification capped at 30 per email per 24 hours. L-3: a sent
`lead_customer_email` job is scrubbed to `{ leadId, template,
templateVersion }`. L-4: a per-visitor `uploads` budget and at most 10 open
upload intents per record. L-6, L-7, L-8: a malformed `MACHINE_REGISTRY_JSON`
disables machine routes only; process-level handlers and `GET /api/v1/ready`;
deadlines on Auth `getUser` (5 s) and tenant transactions (15 s statement, 30 s
idle). L-9, L-11: honest error statuses and no-store/nosniff/no-referrer on
`/api`. L-10: `/api/internal/jobs/run` is POST only and both job routes count
attempts per IP first. L-12: unsubscribe by POST (RFC 8058). L-13: set
`AI_ACTION_SIGNING_SECRET`. L-16: invitations expire after 14 days (migration
0031). I-1: pnpm override `qs@<6.16.1`. I-2: row security on and forced for
`app.workspaces` (0032, 0033). CW-B1: a website may send the lead's own id on
create (`409 lead_id_taken` when taken), so CanadaWide's fallback copy and a
late CRM save are one lead.

**AI and automation review (2026-11-05).** Chat: CHAT-1 the lead's name and
reference travel as a labelled data block, not in the system prompt; CHAT-2
the server replays only whole turns with a signed answer; CHAT-3
`AI_ACTION_SIGNING_SECRET` signs cards and proposals; CHAT-4 prepared cards
survive a failed explanation; CHAT-5 a failed request reports its own error;
CHAT-6 `app.ai_turns` usage rows and a 500-question daily ceiling per site;
CHAT-7 the replay guard goes through the shared limiter; CHAT-8 a named
authoring output limit; CHAT-9 a per-member budget on confirm and revise;
CHAT-10 fixed-window wording; CHAT-11 oversized chunks split; CHAT-12
per-tool progress labels. Actions: ACT-1 gated stage moves are marked and
refused with the staff edit's own errors; ACT-2 a revision supersedes its
card; ACT-3 a card signs a digest of the field's value; ACT-4 assignees beyond
24 members by name; ACT-5 no name or phone in clear in the token. Authoring:
AUTH-1 "assignee is" takes "me" or a name; AUTH-2 simulation applies allowed
moves and gates; AUTH-3 a simulated edit uses the edited flow's schema; AUTH-4
proposal statements name their actor and site; AUTH-5 revisions keep step ids;
AUTH-6 the three-card slot is taken before the row is written; AUTH-7 404 and
410 for missing and expired proposals; AUTH-8 simulation reads without
locking; AUTH-9 built-ins seeded as the system with an audit row; AUTH-10 NFKC
member names; AUTH-11 receipts and expired proposals leave the 100-row cap.
Engine: ENG-1 a Test run mails only the caller's own address; ENG-2 a flow
set off by an automation runs at most 3 times per lead in a rolling day; ENG-3 the switch-off advisory lock;
ENG-4 overdue work on a site the scheduler does not list is logged and
alerted; ENG-5 flows are matched inside the write and run after it commits;
ENG-6 archiving a lead cancels its waits and timers; ENG-7 a stay timer fires
only while its entry is the latest move (migration 0023); ENG-8 runs act as
the scheduler once the activator has left; ENG-9 the tick drains in passes and
reports a backlog; ENG-L1 runs keep their chain (migration 0026); ENG-L2
failed resumes back off 5/10/20/40 minutes; ENG-L3 built-ins are seeded
as the system, not by the viewer who opened the page; ENG-L4 switching on may carry `expectedRevision`; ENG-L5 the builder's
Test run follows live semantics; ENG-L6 staff notification links need an https
`ADMIN_ORIGIN`; ENG-L7 a step record that does not fit fails the step, not the
run; ENG-L8 (open) the lock order of `restore()` and `create()` differs. Admin:
UI-1 an automation card keeps its state when the panel closes; UI-2 card parts
merge by id; UI-3 a pending autosave is saved on leaving; UI-4 Reload says it
discards edits; UI-5 cards expire on time with specific errors; UI-6 no
placeholder ids; UI-7 no consecutive questions after Stop or an error; UI-8
abort-signal fallbacks; UI-9 Confirm and Edit wait while an answer streams;
UI-10 timeout and over-budget answers have their own advice.

**Saved chat review (2026-11-19).** B2: a customer's erasure reaches saved
chats, and a turn about a restricted lead is never replayed. B6: without a
signing key Ask AI is off. B7: a daily budget on file bytes sent to the
model. B8: a follow-up question has two to five choices of at most 80
characters, and a picked choice is never a confirmation. C13: the chats of a
member gone from a site for 30 days are deleted.

**Audit of 21 Nov 2026.** Issues #81 to #114, all fixed in PR #115; a code
comment that cites one of those numbers refers to that audit.
