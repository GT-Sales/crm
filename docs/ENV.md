# Environment variables

Every variable the backend and the admin read, where it is set, and what
happens when it is missing. Secrets are set in the host (Railway, Vercel, CI)
and never committed; `.env*` files are gitignored.

Values that end in `_test` or `_e2e` database names, and anything named
`DB_TEST_*` / `E2E_*`, are for disposable local or CI databases only.

## Backend (Railway service `backend`)

### Required to boot and serve `/api/v1`

| Variable                    | Purpose                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Pooled Postgres URL for the **restricted `app_runtime` role** through the Supabase transaction-mode pooler (port 6543): `postgresql://app_runtime.<project-ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`. Never the `postgres` role. |
| `DATABASE_SSL_MODE`         | `require` (default, Supabase) or `disable` (local Postgres only).                                                                                                                                                                                          |
| `DATABASE_SSL_CA`           | Optional PEM for a private CA.                                                                                                                                                                                                                             |
| `DATABASE_POOL_MAX`         | Application-side pool size, `1`–`50`; defaults to `8`.                                                                                                                                                                                                     |
| `SUPABASE_URL`              | `https://<project-ref>.supabase.co`. The backend verifies staff access tokens against Supabase Auth.                                                                                                                                                       |
| `SUPABASE_ANON_KEY`         | The project's **publishable** key (`sb_publishable_…`). Not a secret; grants nothing by itself.                                                                                                                                                            |
| `ADMIN_ORIGIN`              | The one browser origin allowed by CORS for staff routes, e.g. `https://crm.gtsales.example`. Defaults to `http://localhost:3000`.                                                                                                                          |
| `TRUST_PROXY_HOPS`          | `1` behind Railway's edge so client IPs (rate limits, audit) are read from `X-Forwarded-For`. Default `0` ignores forwarded headers.                                                                                                                       |
| `DEPLOYMENT_ENV`            | `production`, `preview` or `development`. Unknown values resolve to "unknown", never to production.                                                                                                                                                        |
| `PORT`                      | Listen port; Railway injects it. Defaults to `4000`.                                                                                                                                                                                                       |
| `EMAIL_CONTACT_HASH_SECRET` | ≥16 characters. Keys the HMAC that turns an email address into the `contact_hash` stored on email, suppression and consent rows, so those tables never hold a raw address. Rotating it orphans existing suppressions.                                      |

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

| Variable                                                 | Purpose                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                                         | `resend` in production; `fake` only in CI/previews (a fake never sends in production).                                                 |
| `RESEND_API_KEY`                                         | Secret. Required when `EMAIL_PROVIDER=resend`.                                                                                         |
| `RESEND_ACCOUNT_ID`                                      | Label of the Resend account (any stable string); stored as `provider_account` on sends and matched against inbound webhook identities. |
| `RESEND_FROM_EMAIL`                                      | Verified sender, e.g. `crm@<verified-domain>`.                                                                                         |
| `RESEND_FROM_NAME`                                       | Display name, e.g. `GT Sales`.                                                                                                         |
| `RESEND_REPLY_TO_EMAIL`                                  | Optional reply-to.                                                                                                                     |
| `OWNER_ALERT_EMAIL`                                      | Where operational alerts (scheduler not started, stuck jobs) are sent; needs `RESEND_API_KEY`.                                         |
| `OWNER_ALERT_WEBHOOK_URL` / `OWNER_ALERT_WEBHOOK_SECRET` | Optional chat webhook for the same alerts, HMAC-signed when the secret is set.                                                         |

Resend delivery events arrive at `POST /api/v1/email/events/:selector`; the
selector and its signing secret live in `MACHINE_REGISTRY_JSON.webhooks`.

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

| Variable                                                                             | Purpose                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAMES`                                        | Cloudflare Turnstile human check on website writes. Unset = no bot check.                                                                                |
| `UMAMI_EVENTS_URL`, `UMAMI_WORKSPACE_WEBSITES`, `UMAMI_HOSTNAME`, `UMAMI_USER_AGENT` | Server-side analytics events per site (`UMAMI_WORKSPACE_WEBSITES` is JSON `[{"workspaceId":"…","websiteId":"…"}]`). Unset = analytics jobs fail visibly. |
| `OUTBOX_ADAPTERS`                                                                    | `fake` swaps analytics for an in-memory sink. Ignored in production.                                                                                     |
| `SENTRY_DSN`, `RELEASE_SHA`                                                          | Error tracking and release tagging.                                                                                                                      |

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
