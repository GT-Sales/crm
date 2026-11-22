# GT Sales CRM — handoff

The current state, for whoever (person or AI session) picks this up next:
where it runs, what is live, what waits for an owner step, and what comes
next. When something below stops being true, change it here; `git log` holds
the history.

Reading order: [AGENTS.md](../AGENTS.md) (rules, commands, where things
live) → this file → [ARCHITECTURE.md](ARCHITECTURE.md) (how it works) →
[PLAN.md](PLAN.md) (decisions) → [ENV.md](ENV.md) (every variable) →
[RUNBOOKS/](RUNBOOKS/) (database, backups, imports, intake check, Ask AI).

## 1. Where everything is

- **GitHub**: `GT-Sales/crm`. `main` deploys both apps; work goes through pull
  requests. CI (`.github/workflows/ci.yml`, job `verify`) runs on PRs and on
  `main`: lint, format, typecheck, migrations on a disposable Postgres, the
  full test suite, the OpenAPI drift check, affected builds, the browser
  checks. The backup workflows run from here too.
- **Backend**: Railway project `GT Sales CRM`
  (`ea4ffa36-d587-45b8-a64d-9f8f84fbd42f`), service `crm`
  (`01c9dcfa-644d-4c52-ade1-b08d65114443`), environment `production`
  (`112461fd-4e06-44bc-a5ae-13f40438f69e`), region Singapore
  `asia-southeast1`, one replica. Follows `main`; build per `railway.json`;
  health check `GET /api/v1/ready`. Public URL
  `https://crm-production-cf2e.up.railway.app`, `PORT` 4000. In the
  developer's personal Railway workspace for now.
- **Admin**: Vercel team `gt-sales` (`team_PDmnYZIjHmPgGmDSYFB0Ru3K`), project
  `gt-sales-crm-admin` (`prj_cjhH8QnFnO5RdOHHRZVhOrxsStnp`), root
  `apps/admin`, Node 22.x, production branch `main`, functions in `iad1`. Live
  at **`https://gt-sales-crm-admin.vercel.app`**, which is also the CORS
  origin (`ADMIN_ORIGIN`). Other aliases and preview deployments sit behind
  Vercel's login wall.
- **Database**: Supabase project `xykrphbgpwisqacpyeiv` (`gtsales-crm`),
  region `ap-south-1` (Mumbai), shared with the Get Canada Sim website's
  `public` schema. The CRM owns the `app` schema and the `app_runtime` role.
  The backend connects through the transaction pooler
  `aws-1-ap-south-1.pooler.supabase.com:6543` as
  `app_runtime.xykrphbgpwisqacpyeiv` (the `aws-0` host does not know this
  tenant).
- **Storage**: Supabase Storage on the same project through its S3 endpoint
  (`/storage/v1/s3`); the backend's `R2_*` variables hold the Storage S3 keys.
  Bucket `documents` holds the CRM's files (and Get Canada Sim's originals,
  which the CRM only reads).
- **Auth**: Supabase Auth on the same project: email and password,
  confirmation required, sign-ups allowed (the invitation flow needs them).
  Site URL `https://gt-sales-crm-admin.vercel.app`, redirect URL
  `https://gt-sales-crm-admin.vercel.app/**`. Custom SMTP (Authentication →
  Emails → SMTP): host `smtp.resend.com`, port 465, user `resend`, password a
  Resend API key of Get Canada Sim's account, a sender on `getcanadasim.com`
  (for example `GT Sales CRM <crm@getcanadasim.com>`). No multi-factor step.
- **Email**: Get Canada Sim's Resend account (domain `getcanadasim.com`).
  Railway holds `EMAIL_PROVIDER=resend` and `RESEND_API_KEY`, a full-access
  key (a sending-only key gets 401 when reading a reply). Each site's sender
  and look are its Settings → Email. Customer replies come in through the
  account's receiving domain `ropsoo.resend.app` (`EMAIL_INBOUND_DOMAIN`,
  `EMAIL_INBOUND_SITES`) and a Resend `email.received` webhook.
- **Backups**: GitHub Actions: nightly Backup, hourly Backup monitor, weekly
  Backup retention, in the GitHub Environment `backup-gt-sales`, into the
  private Backblaze B2 bucket `gt-sales-crm-archive`, encrypted with `age` to
  a recovery key only the owner holds
  ([RUNBOOKS/backup.md](RUNBOOKS/backup.md)).
- **Umami**: Self-hosted on Coolify, version 3.4.1
  (`https://umami.gtsales.ca`); the Analytics page reads it through the
  backend.
- **Owner**: Md Takibuddin, gamertakib@gmail.com: GitHub org owner, Railway
  workspace, Vercel team, Supabase org. First `owner` of both sites (Auth user
  `b8fbfaea-a3a8-4cfd-b609-d9d422fa7b7e`).
- **Websites**: Get Canada Sim (`Md-Takibuddin/Get-Canada-Sim`, Next.js on
  Vercel, its own admin and tables in `public`). CanadaWide
  (`Md-Takibuddin/Canadawide-Sales-website`, Next.js on Vercel in the owner's
  personal team; reference client `lib/crm.ts`).

Secrets never live in this repository. The `app_runtime` password exists
only in Railway's `DATABASE_URL`; every other secret is listed by name in
ENV.md and set on Railway, Vercel or GitHub.

## 2. What is live

- **Release of 21 Nov 2026.** PR #115 (the 34 audit issues #81 to #114) is
  merged to `main` and deployed to Railway and Vercel. Migrations 0000 to
  0047 are applied on the hosted project (48 tracker rows); 0046 went in
  before the deploy and 0047 after it, as each requires. A fresh backup ran
  successfully right before the release. **Migration 0048 is not applied**
  (§3).
- **Intake.** CanadaWide's internet and mobility forms send to the CRM since
  2026-10-27; the 0002 mirror copies each lead into the old `public` tables
  so the old admin and the ID step keep working. Get Canada Sim's checkout
  writes every order to the CRM since about 2026-11-12 (`CRM_ORDERS` on),
  numbered `MS-<n>` from the site's counter; the 0041 mirror copies each
  submitted order into `public.orders` for the old Get Canada Sim admin,
  which the owner keeps until he retires it. Both websites send lead
  attribution since 2026-11-14.
- **Site keys are limited to lead types.** The four active keys carry:
  CanadaWide `internet`, `mobility`, `contact_message`; Get Canada Sim
  `partner_application`, `sim_order`, `contact_message`. `contact_message`
  was added by hand after the backfill so a contact form is not refused.
  An owner changes a key's lead types in Settings → Integrations ("Edit lead
  types").
- **Histories.** All CanadaWide leads and Get Canada Sim's orders and partner
  applications from before the CRM, with notes, reminders as tasks, SIM
  numbers, change request history and document copies, are in the CRM
  ([RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md)).
- **Staff work** for both sites: the leads inbox (table or board, filters,
  private saved views, export to Excel), the lead page and side panel
  (timeline, notes, tasks, documents and their review, the ID check, the Mail
  tab, the change request card), Tasks, the Dashboard with the source report,
  Mail, Analytics, Automations, and Settings (General, Team, Integrations,
  Fields and layouts, Plans, Email, Jobs, AI usage, AI models).
- **Customer email** goes through Resend from each site's saved Settings →
  Email; a site without them sends no customer mail (`no_sender`). CanadaWide
  has saved settings. A customer's reply to a CRM mail lands on the lead
  since 2026-11-14.
- **Automations.** Every site's six built-in flows are seeded off. The
  repository records no flow switched on in production.
- **Ask AI** is on for both sites since 2026-11-04
  (`AI_ASSISTANT_WORKSPACE_IDS` and `AI_AUTOMATION_WORKSPACE_IDS` list both):
  reads, confirmed cards, automation drafts that staff save explicitly, and
  saved conversations. Attachments, High effort and the model menu wait for
  owner steps (§3).
- **The intake check** runs every 15 minutes since 2026-11-06 on the test
  site `intake-check`.
- **Backups** run every night. A document the snapshot holds as available
  but storage no longer has leaves the run green with a warning and one owner
  alert (`backup_objects_missing`).

## 3. Waiting for the owner

- **Migration 0048**. Not applied: the tool asked for the owner's confirmation
  and got no answer. Nothing breaks without it; a rescued Get Canada Sim order
  whose name or email is completed later is still not copied to the old admin.
  On 2026-11-21 no existing order needed the backfill. _How:_
  [RUNBOOKS/database.md](RUNBOOKS/database.md#0048-not-applied-yet): paste in
  the SQL editor, with its tracker row (49 rows).
- **Migration 0049** (an index for the new-leads count). Not applied; it
  follows 0048 so the tracker stays in order. Nothing depends on it. _How:_
  [RUNBOOKS/database.md](RUNBOOKS/database.md#0049-not-applied-yet).
- **Does either site have a contact form?** `contact_message` is on all four
  active keys as a precaution. _How:_ Confirm; remove the type from a key that
  does not need it.
- **Get Canada Sim's Settings → Email**. Not confirmed as saved. Without it
  the site sends no customer mail (SIM numbers, tracking codes, decision
  mails). _How:_ Settings → Email on `getcanadasim`, a test of each template.
  Check:
  `select w.slug, s.from_address from app.workspaces w left join app.workspace_email_settings s on s.workspace_id = w.id;`
- **Get Canada Sim's `/track` through the CRM**. Whether `CRM_TRACKING` is on
  is not recorded, nor whether `TRACKING_HASH_SECRET` is set on Railway.
  _How:_ ENV.md, "Customer tracking". Turning only `CRM_TRACKING` off is
  always safe
  ([RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md#rollback)).
- **CanadaWide's ID step through the CRM**. Built and smoke-tested;
  `CRM_ID_STEP` is not set on CanadaWide, so the step still writes Supabase
  directly. _How:_ Vercel → CanadaWide → Environment Variables:
  `CRM_ID_STEP=on` for Production, redeploy. Then drop the last two anonymous
  policies (§5).
- **CanadaWide's staff cutover**. Staff still use the old admin. _How:_ On a
  day the owner picks: re-run the import
  ([RUNBOOKS/legacy-import.md](RUNBOOKS/legacy-import.md)), then staff work
  only in the CRM; then the cutover clean-up (§4).
- **CanadaWide's email style**. Not recorded as set. _How:_ Settings → Email →
  Style "Website hero", brand colour `#0966ff`, accent `#c0ff72`.
- **CanadaWide intake fallback**. Prepared, not applied. CanadaWide's side is
  on its branch `claude/crm-intake-fallback`. _How:_
  [RUNBOOKS/intake-fallback.md](RUNBOOKS/intake-fallback.md), "Switching it
  on".
- **`AI_ACTION_SIGNING_SECRET`**. Not confirmed as set. Until it is, the
  Gateway key signs AI cards and the startup log warns. _How:_ ENV.md,
  Railway.
- **Ask AI attachments, High effort, model menu**. Off until
  `AI_ATTACHMENT_KINDS`, `AI_HIGH_EFFORT_ENABLED` are set and an owner saves
  more than one model. _How:_
  [RUNBOOKS/ai-assistant.md](RUNBOOKS/ai-assistant.md) §12 to §14.
- **`OPERATIONAL_RETENTION_ENABLED`**. Off: old operational rows are not
  pruned. _How:_ The owner's call after a verified backup; ENV.md lists what
  it prunes.
- **Resend delivery events**. The Resend account has no delivery webhooks, so
  Delivered and Bounced never reach the CRM and mails stay "Sent". _How:_ A
  Resend webhook per site with its entry in `MACHINE_REGISTRY_JSON.webhooks`
  (ENV.md).
- **The Analytics page's Umami connection**. Not confirmed as configured.
  _How:_ `UMAMI_API_URL`, `UMAMI_API_KEY`, `UMAMI_WORKSPACE_WEBSITES`
  (ENV.md).
- **One-off scrub of customer mails sent before the fix**. Prepared; not
  confirmed as run. New ones are scrubbed when their job completes. _How:_
  Paste
  [manual/scrub-sent-customer-email-jobs.sql](RUNBOOKS/manual/scrub-sent-customer-email-jobs.sql)
  in the SQL editor.
- **Restore drill and the monitor's alert**. Neither is recorded as done.
  _How:_ [RUNBOOKS/restore.md](RUNBOOKS/restore.md), "Drill";
  [RUNBOOKS/backup.md](RUNBOOKS/backup.md) step 7.3.
- **The intake check's controlled failure**. Not done. _How:_
  [RUNBOOKS/intake-check.md](RUNBOOKS/intake-check.md), "The controlled
  failure". Record the result here.
- **Automations**. No flow is on. _How:_ Switch a built-in flow on only after
  checking the website does not send the same email. Decide whether the Orders
  role alone may override the documents check (today it also needs
  `lead.manage`).
- **Team**. The other admins are not invited. _How:_ Settings → Team; each
  sets their own name. An invitation older than 14 days no longer works and
  needs a new one.
- **Accounts and secrets**. The Railway project is in a personal workspace;
  several secrets were generated during the build. _How:_ Move the project to
  a GT Sales workspace; rotate the `app_runtime` password, `CRON_SECRET` (32+
  characters), `EMAIL_CONTACT_HASH_SECRET` and the registry secrets; remove
  `EMAIL_SENDERS_JSON` (nothing reads it).
- **Supabase Auth settings**. To confirm. _How:_ "Confirm email" on;
  anonymous, phone and unverified-OAuth sign-ins off; leaked-password
  protection on.

Optional, for each website's developer: send `Idempotency-Key` on a
submission so a retry never makes a second order.

## 4. What comes next

**Engineering work**

- **Cross-site inbox, contact page, split and merge of contacts** (not
  started): one query per site the member belongs to, a page with one
  person's leads across sites, audited split/merge.
- **Cutover clean-up**, once CanadaWide's staff are on the CRM: a migration
  dropping the 0002 mirror and the 0005/0006 identity mirror functions, and
  removing the Internet and Mobility Leads pages from the Get Canada Sim
  admin. The same for the 0041 mirror when the old Get Canada Sim admin is
  retired.
- **Model `partner_application` and `contact_message`**; until then they take
  any payload as resumable drafts.
- **Documents**: staff upload and replace on the lead page.
- **The quality and testing plan**: [TESTING-PLAN.md](TESTING-PLAN.md).
- **Ask AI, deferred**: the writes that stay with a person
  (design/ai-actions.md), documents and knowledge retrieval, cross-site
  analysis, and publishing or switching a flow on from chat. The real-model
  evaluation of automation authoring ([evals](evals/automation-authoring.md))
  is not recorded as run.
- **Not built**: Export on the board's own selection and exports over 5,000
  leads; attachments on a customer reply, an unread count and staff
  notification of a reply, branded reply domains; a `List-Unsubscribe`
  header; a pending-invitations list with revoke; visitors per source beside
  the source report.

**Open follow-ups**

- **Free text still in URLs**: the inbox's property filter values, the
  delivery letter link and the Ask AI conversation title search (the leads
  search itself is fixed).
- **The age of the oldest pending mail is not in the health checks** (#111).
- **Flaky admin test**: `chat-screen.test.tsx`, "renames in place" (being
  looked at separately).
- **A pending change request is not voided when staff change the order's
  email.**
- **Latency.** A warm staff read is one round trip Singapore to Mumbai
  (~58 ms) per statement, Auth's `getUser` (~100 ms, cached 60 s) and the
  data transaction. Levers, safest first: send BEGIN and the tenant context
  together; the session pooler with `prepare: true`; the access read and the
  data in one transaction. The query plans are not the problem.
- **Error tracking is unset** (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`).
- **Turnstile is off by design** (`WEBSITE_BOT_CHECK=delegated`). If a site
  shows abuse, add Turnstile to its forms and switch the mode back.
- **Small, none blocking.** Properties: the restriction guard does not cover
  `custom_values`; `property.manage` cannot be granted per member; a built-in
  label override cannot be cleared from the UI. Plans: a plan property can be
  both `staffOnly` and `websiteVisible`. Email: a sender name with non-ASCII
  characters is quoted, not RFC 2047 encoded; a replayed draft create returns
  a fresh draft grant. Automations: a timer whose item keeps throwing is
  retried by every tick (no attempts column). Backups: a CLI smoke step in
  CI; a SIGINT handler in the restore CLI. Intake check: runs are only in
  the logs and each leaves one `lead.created` audit row on the test site.
  Ask AI: attachment objects are in no backup; an answer that named a
  customer in other words survives that customer's erasure until the member
  deletes the conversation. Umami: recheck the endpoint shapes after an
  upgrade (read at v3.4.1).

## 5. Open security items

- **CanadaWide's anonymous write paths.** Two policies remain until its ID
  step moves to the CRM: `public.mobility_id_uploads` "anon can insert
  mobility id uploads" and `storage.objects` "anon can upload mobility ids"
  (bucket `mobility-ids`). Until then CanadaWide's licence photos are only in
  that bucket, outside the CRM and outside the nightly backup.
- **Supabase Auth settings**, **`AI_ACTION_SIGNING_SECRET`**, **`CRON_SECRET`
  length** and **secret rotation**: §3.

## 6. How it is verified

- **Backend serves, scheduler runs**: `GET /api/v1/health` and `/api/v1/ready`
  200; no `scheduler_task_failed` in the deploy logs
- **Admin is reachable and wired**: `/login` 200 on `gt-sales-crm-admin.vercel.app`
- **Code gates**: CI on every PR and on `main`
- **Tenant isolation**: `apps/backend/tests/isolation.spec.ts` and the RLS
  integration suites; every migration verified against the catalogue
- **Website intake**: One `intake_check` log line every 15 minutes with
  `status` `ok`; an owner alert on failure
- **Backups**: The nightly `backup_completed` line and the hourly monitor
  (alerts when the last copy is over 26 hours old)
