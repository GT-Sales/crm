# Environment variables

Every variable the backend and the admin read, where it is set, and what
happens when it is missing. Secrets are set in the host (Railway, Vercel, CI)
and never committed; `.env*` files are gitignored.

Values that end in `_test` or `_e2e` database names, and anything named
`DB_TEST_*` / `E2E_*`, are for disposable local or CI databases only.

## Backend (Railway service `backend`)

### Required to boot and serve `/api/v1`

| Variable                    | Purpose                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Pooled Postgres URL for the **restricted `app_runtime` role** through the Supabase transaction-mode pooler (port 6543). This project's pooler is the `aws-1` cluster; `aws-0` answers "tenant/user not found": `postgresql://app_runtime.<project-ref>:<password>@aws-1-ap-south-1.pooler.supabase.com:6543/postgres`. Never the `postgres` role. |
| `DATABASE_SSL_MODE`         | `require` (default, Supabase) or `disable` (local Postgres only).                                                                                                                                                                                                                                                                                 |
| `DATABASE_SSL_CA`           | Optional PEM for a private CA.                                                                                                                                                                                                                                                                                                                    |
| `DATABASE_POOL_MAX`         | Application-side pool size, `1`–`50`; defaults to `8`.                                                                                                                                                                                                                                                                                            |
| `SUPABASE_URL`              | `https://<project-ref>.supabase.co`. The backend verifies staff access tokens against Supabase Auth.                                                                                                                                                                                                                                              |
| `SUPABASE_ANON_KEY`         | The project's **publishable** key (`sb_publishable_…`). Not a secret; grants nothing by itself.                                                                                                                                                                                                                                                   |
| `ADMIN_ORIGIN`              | The one browser origin allowed by CORS for staff routes, e.g. `https://crm.gtsales.example`. Defaults to `http://localhost:3000`.                                                                                                                                                                                                                 |
| `TRUST_PROXY_HOPS`          | `1` behind Railway's edge so client IPs (rate limits, audit) are read from `X-Forwarded-For`. Default `0` ignores forwarded headers.                                                                                                                                                                                                              |
| `DEPLOYMENT_ENV`            | `production`, `preview` or `development`. Unknown values resolve to "unknown", never to production.                                                                                                                                                                                                                                               |
| `PORT`                      | Listen port. Set to `4000` on the Railway service so the public domain's target port never drifts (Railway would otherwise inject its own value). Defaults to `4000` locally.                                                                                                                                                                     |
| `EMAIL_CONTACT_HASH_SECRET` | ≥16 characters. Keys the HMAC that turns an email address into the `contact_hash` stored on email, suppression and consent rows, so those tables never hold a raw address. Rotating it orphans existing suppressions.                                                                                                                             |

### Scheduler (outbox, document cleanup, retention)

The scheduler is opt-in. Without it, leads are still captured; emails and
analytics jobs stay queued until a runner drains them.

| Variable                        | Purpose                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_SCHEDULER`              | `1` to run the in-process scheduler. Exactly one replica should have it on.                                                                                                                                                                                                               |
| `MACHINE_REGISTRY_JSON`         | Server-only registry of machine identities: `{"webhooks":[…],"schedulers":[{"selector":"railway-scheduler","secret":"<≥16 chars>","actorId":"<uuid>","workspaceIds":["<site uuid>",…],"scopes":["outbox:run"]}]}`. Every tenant write a job makes is attributed to the entry's `actorId`. |
| `JOB_RUNNER_SELECTOR`           | Which scheduler entry this process runs as (its `selector`).                                                                                                                                                                                                                              |
| `CRON_SECRET`                   | Must equal that entry's `secret`; also authorizes `POST /api/internal/jobs/*` for manual runs.                                                                                                                                                                                            |
| `OPERATIONAL_RETENTION_ENABLED` | `1` to let the daily task prune completed outbox jobs (30 d), resolved alerts (30 d) and applied provider events (180 d). Off by default; turn on only after a verified backup exists.                                                                                                    |

### Email (Resend)

| Variable                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                                         | `resend` in production; `fake` only in CI/previews (a fake never sends in production).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RESEND_API_KEY`                                         | Secret. Required when `EMAIL_PROVIDER=resend`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RESEND_ACCOUNT_ID`                                      | Label of the Resend account (any stable string); stored as `provider_account` on sends and matched against inbound webhook identities.                                                                                                                                                                                                                                                                                                                                                   |
| `RESEND_FROM_EMAIL`                                      | Verified sender, e.g. `crm@<verified-domain>`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RESEND_FROM_NAME`                                       | Display name, e.g. `GT Sales`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RESEND_REPLY_TO_EMAIL`                                  | Optional reply-to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EMAIL_SENDERS_JSON`                                     | Each site's own sender for mail to its customers: `[{"workspaceId":"<site uuid>","fromAddress":"order@getcanadasim.com","fromName":"Get Canada Sim","replyToAddress":"…","siteUrl":"https://…"}]` (reply-to and site address optional; the site address adds links such as `/track`). No secrets. A site without an entry cannot email its customers; a malformed list, or a site listed twice, counts as none. Every domain must be verified in the Resend account of `RESEND_API_KEY`. |
| `OWNER_ALERT_EMAIL`                                      | Where operational alerts (scheduler not started, stuck jobs) are sent; needs `RESEND_API_KEY`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `OWNER_ALERT_WEBHOOK_URL` / `OWNER_ALERT_WEBHOOK_SECRET` | Optional chat webhook for the same alerts, HMAC-signed when the secret is set.                                                                                                                                                                                                                                                                                                                                                                                                           |

Resend delivery events arrive at `POST /api/v1/email/events/:selector`; the
selector and its signing secret live in `MACHINE_REGISTRY_JSON.webhooks`. A
site can send before its webhook exists: its mail is then recorded against
`RESEND_ACCOUNT_ID` without bounce and complaint events, which a webhook adds
(and a webhook from a different account stops the site's mail).

### Documents (Supabase Storage, S3 protocol)

The document adapter speaks S3. Point it at Supabase Storage's S3 endpoint
with S3 access keys created in the Supabase dashboard (Project Settings →
Storage → S3 access keys). Unset = document endpoints answer
`feature_not_ready`; everything else keeps working.

| Variable                                    | Value for Supabase Storage                                |
| ------------------------------------------- | --------------------------------------------------------- |
| `R2_ACCOUNT_ID`                             | Any non-empty label (the adapter's name is historical).   |
| `R2_ENDPOINT`                               | `https://<project-ref>.storage.supabase.co/storage/v1/s3` |
| `R2_REGION`                                 | `ap-south-1` (the project's region).                      |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Secret. The S3 access key pair.                           |
| `R2_BUCKET`                                 | `documents` (private bucket, already exists).             |

### Optional

| Variable                                                                             | Purpose                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSITE_BOT_CHECK`                                                                  | How website writes prove a human: `turnstile` (default; any other value means this too) verifies a forwarded Turnstile token and **refuses every write when Turnstile is not configured**; `delegated` trusts the calling site's own screening, with the site key and all rate limits still applied. Production: `delegated`. |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAMES`                                        | Cloudflare Turnstile verification, used only when `WEBSITE_BOT_CHECK` is `turnstile`.                                                                                                                                                                                                                                         |
| `UMAMI_EVENTS_URL`, `UMAMI_WORKSPACE_WEBSITES`, `UMAMI_HOSTNAME`, `UMAMI_USER_AGENT` | Server-side analytics events per site (`UMAMI_WORKSPACE_WEBSITES` is JSON `[{"workspaceId":"…","websiteId":"…"}]`). Lead intake queues no analytics jobs (websites keep their own events until phase 3); unset = any analytics job fails visibly.                                                                             |
| `OUTBOX_ADAPTERS`                                                                    | `fake` swaps analytics for an in-memory sink. Ignored in production.                                                                                                                                                                                                                                                          |
| `SENTRY_DSN`, `RELEASE_SHA`                                                          | Error tracking and release tagging.                                                                                                                                                                                                                                                                                           |

## Admin (Vercel project, root `apps/admin`)

| Variable                                                                          | Purpose                                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                                                        | Same as the backend's `SUPABASE_URL`. Staff sign in with Supabase Auth in the browser.                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                                                   | The publishable key. Public by design.                                                                     |
| `NEXT_PUBLIC_API_BASE_URL`                                                        | The backend's public URL (Railway). The production build refuses to start without it and the Supabase URL. |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_DEPLOYMENT_ENV`, `NEXT_PUBLIC_RELEASE_SHA` | Optional error tracking and release tagging.                                                               |

`NEXT_PUBLIC_E2E_STAFF_BEARER` and `ADMIN_DIST_DIR` exist only for the browser
test build; `next.config.ts` refuses the first on Vercel.

## Migrations, seed and tests (never in the runtime service)

| Variable                                                                             | Purpose                                                                                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL`, `MIGRATION_DATABASE_SSL_MODE`, `MIGRATION_DATABASE_SSL_CA` | Direct (port 5432) connection as the project's `postgres` role for `pnpm --filter @gt-sales/db db:migrate`. See `docs/RUNBOOKS/database.md`. |
| `TEST_MIGRATION_DATABASE_URL` + `DB_TEST_ALLOW_DESTRUCTIVE=1`                        | Enable the integration suites against a disposable database whose name ends in `_test`.                                                      |
| `DB_SEED_ALLOW_SYNTHETIC=1`                                                          | Allow `db:seed` (synthetic sites and staff); refused on hosted Supabase unless the database name ends in `_test`/`_dev`.                     |
| `E2E_ALLOW_REMOTE_DATABASE`                                                          | Deliberate override for destructive browser-test setup on a non-local database.                                                              |
