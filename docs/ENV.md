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

## Backups (GitHub Actions, never the runtime service)

Every deployment is backed up by the same workflows, each run inside a GitHub
Environment named after the deployment: `backup-<deployment>` (the daily
backup), `backup-monitor-<deployment>` (the hourly heartbeat check) and
`backup-retention-<deployment>` (pruning old restore points). The first
deployment is `gt-sales`. Each deployment has its own Backblaze B2 archive
bucket and its own B2 application keys, one per environment. No environment
holds both a delete-capable archive key and the recovery private key; the
restore runs on the owner's machine, never in GitHub. Every value below is a
secret of the named environment unless the "Set where" column says otherwise.

| B2 application key | Capabilities (restricted to the deployment's bucket) | Held by                         |
| ------------------ | ---------------------------------------------------- | ------------------------------- |
| Writer             | `listFiles`, `writeFiles`                            | `backup-<deployment>`           |
| Reader             | `listFiles`, `readFiles`                             | `backup-monitor-<deployment>`   |
| Retention admin    | `listFiles`, `readFiles`, `deleteFiles`              | `backup-retention-<deployment>` |
| Recovery reader    | `listFiles`, `readFiles`                             | The owner, for a restore only   |

### Backup run (`backup-<deployment>`)

`pnpm --filter @gt-sales/jobs run backup`. A missing required variable stops
the run with `<NAME> is required`, before anything is read or written.

| Variable                                                            | Set where                                    | Value / purpose                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_DEPLOYMENT`                                                 | Workflow matrix (`${{ matrix.deployment }}`) | Required. The deployment's name (`gt-sales`); recorded in the manifest and the heartbeat.                                                                                                                                                                                       |
| `SOURCE_DATABASE_URL`                                               | GitHub Environment secret                    | Required. The `backup_reader` login through the session pooler: `postgresql://backup_reader.<project-ref>:<url-encoded password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`. Port 5432, never 6543 (the transaction pooler breaks `pg_dump`). URL-encode the password. |
| `SOURCE_STORAGE_ENDPOINT`                                           | GitHub Environment secret                    | Required. `https://<project-ref>.storage.supabase.co/storage/v1/s3`.                                                                                                                                                                                                            |
| `SOURCE_STORAGE_REGION`                                             | GitHub Environment secret                    | Required. `ap-south-1` for `gt-sales`.                                                                                                                                                                                                                                          |
| `SOURCE_STORAGE_BUCKET`                                             | GitHub Environment secret                    | Required. `documents` for `gt-sales`. A referenced object in any other bucket fails the run.                                                                                                                                                                                    |
| `SOURCE_STORAGE_ACCESS_KEY_ID` / `SOURCE_STORAGE_SECRET_ACCESS_KEY` | GitHub Environment secret                    | Required. A Storage S3 access key pair of its own (not the backend's), so either can be revoked alone. The runner only reads.                                                                                                                                                   |
| `SUPABASE_PROJECT_REF`                                              | GitHub Environment secret                    | Required. Recorded in the manifest's source ids.                                                                                                                                                                                                                                |
| `RECOVERY_AGE_RECIPIENT`                                            | GitHub Environment secret                    | Required. The public `age1…` recipient every artifact and the manifest are encrypted to. The private identity is never in GitHub.                                                                                                                                               |
| `B2_ARCHIVE_ENDPOINT` / `B2_ARCHIVE_REGION` / `B2_ARCHIVE_BUCKET`   | GitHub Environment secret                    | Required. The deployment's archive bucket: `https://s3.<region>.backblazeb2.com`, `<region>`, the bucket name.                                                                                                                                                                  |
| `B2_ARCHIVE_WRITER_KEY_ID` / `B2_ARCHIVE_WRITER_APPLICATION_KEY`    | GitHub Environment secret                    | Required. The writer key (`listFiles`, `writeFiles` only).                                                                                                                                                                                                                      |
| `BACKUP_AUTH_DATA`                                                  | GitHub Environment secret                    | `include` (default) or `skip`. `skip` is the operator fallback when `backup_reader` cannot read `auth`; the manifest records `auth_data_skipped_by_operator` and a restore re-invites staff. With `include`, an unreadable `auth` table fails the run.                          |
| `BACKUP_HISTORY`                                                    | GitHub Environment secret                    | `include` (default) or `skip`. `skip` leaves out the `supabase_migrations` history; the manifest records `supabase_migrations_skipped_by_operator`.                                                                                                                             |
| `BACKUP_RUN_ID`                                                     | GitHub Environment secret, normally unset    | Defaults to `run-<timestamp>-<uuid>`. A run refuses an id whose prefix already holds objects.                                                                                                                                                                                   |
| `BACKUP_MAX_SNAPSHOT_BYTES`                                         | GitHub Environment secret, normally unset    | The in-memory snapshot limit in bytes; default 2 GiB. Above it the run stops with `backup_snapshot_too_large_for_runner` before copying any document.                                                                                                                           |
| `AGE_VERSION`, `PG_DUMP_VERSION`                                    | The workflow, from the installed binaries    | Recorded in the manifest's tool versions; `unknown` when unset.                                                                                                                                                                                                                 |
| `SENTRY_DSN`, `RELEASE_SHA`, `DEPLOYMENT_ENV`                       | GitHub Environment secret / the workflow     | Optional error tracking for a failed run.                                                                                                                                                                                                                                       |

### Backup monitor (`backup-monitor-<deployment>`)

`pnpm --filter @gt-sales/jobs run monitor`, hourly. It reads
`heartbeat/latest.json` with the reader key and emails the owner
(`backup_stale`) and exits 1 when the heartbeat is missing, malformed, older
than the threshold or names another deployment, or when the check itself fails
(alert detail `stale:age_seconds:<n>`, `missing`, `malformed`,
`wrong_deployment:<deployment>` or `monitor_failed`).

| Variable                                                                       | Set where                                    | Value / purpose                                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `BACKUP_DEPLOYMENT`                                                            | Workflow matrix (`${{ matrix.deployment }}`) | Required. A heartbeat naming any other deployment alerts.                                    |
| `B2_ARCHIVE_ENDPOINT` / `B2_ARCHIVE_REGION` / `B2_ARCHIVE_BUCKET`              | GitHub Environment secret                    | Required. The deployment's archive bucket, as for the backup run.                            |
| `B2_ARCHIVE_READER_KEY_ID` / `B2_ARCHIVE_READER_APPLICATION_KEY`               | GitHub Environment secret                    | Required. The reader key (`listFiles`, `readFiles` only).                                    |
| `BACKUP_MONITOR_MAX_AGE_SECONDS`                                               | GitHub Environment secret, normally unset    | The alert threshold in seconds; default 93600 (26 hours). Must be a positive whole number.   |
| `OWNER_ALERT_EMAIL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME` | GitHub Environment secret                    | The owner alert email. Unset, the alert is only logged (`owner_alert_channel_unconfigured`). |
| `OWNER_ALERT_WEBHOOK_URL` / `OWNER_ALERT_WEBHOOK_SECRET`                       | GitHub Environment secret, optional          | An optional chat webhook that receives the same alert.                                       |
| `SENTRY_DSN`, `RELEASE_SHA`, `DEPLOYMENT_ENV`                                  | GitHub Environment secret / the workflow     | Optional error tracking when the check itself fails.                                         |

### Backup retention (`backup-retention-<deployment>`)

`pnpm --filter @gt-sales/jobs run retention`, weekly. It keeps the newest run
of each of the last `RETENTION_DAILY_POINTS` days and `RETENTION_MONTHLY_POINTS`
months, deletes the other runs and the attempts that never wrote a manifest
once they are past the grace period, and never deletes `heartbeat/latest.json`.
It works from the archive listing alone and never holds the recovery key. It
exits 1 when a run's age cannot be read (`retention_unreadable_manifests`);
that run is kept.

| Variable                                                               | Set where                                    | Value / purpose                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `B2_ARCHIVE_ENDPOINT` / `B2_ARCHIVE_REGION` / `B2_ARCHIVE_BUCKET`      | GitHub Environment secret                    | Required. The deployment's archive bucket, as for the backup run.                            |
| `B2_ARCHIVE_RETENTION_KEY_ID` / `B2_ARCHIVE_RETENTION_APPLICATION_KEY` | GitHub Environment secret                    | Required. The retention admin key (`listFiles`, `readFiles`, `deleteFiles`).                 |
| `RETENTION_DRY_RUN`                                                    | The workflow, from its `dry_run` input       | Reports without deleting unless the value is exactly `false` (any case). Unset is a dry run. |
| `RETENTION_DAILY_POINTS` / `RETENTION_MONTHLY_POINTS`                  | GitHub Environment secret, normally unset    | Daily and monthly restore points kept; default 30 and 12. Positive whole numbers.            |
| `RETENTION_GRACE_SECONDS`                                              | GitHub Environment secret, normally unset    | Nothing younger than this is deleted; default 86400 (24 hours). A positive whole number.     |
| `BACKUP_DEPLOYMENT`                                                    | Workflow matrix (`${{ matrix.deployment }}`) | Optional. Recorded in the log lines.                                                         |
| `SENTRY_DSN`, `RELEASE_SHA`, `DEPLOYMENT_ENV`                          | GitHub Environment secret / the workflow     | Optional error tracking for a failed run.                                                    |

### Restore (owner-run, never in GitHub)

`pnpm --filter @gt-sales/jobs run restore`, on the owner's machine with `age`
and PostgreSQL 17 `psql` on PATH. Without `TARGET_DATABASE_URL` it only
verifies the run: the manifest and every artifact must decrypt and match their
recorded size and SHA-256. With it, it first checks the target (its role must
bypass RLS, `restore_target_role_cannot_bypass_rls`; no `app` or `drizzle`
schema may exist yet, `restore_target_not_empty`), then loads the database in
one transaction, uploads the documents again and compares every table's row
count with the manifest. It prints one `restore_report` line and exits 0 only
when the run verified and, with a target, restored with every count matching.
The values are set in the owner's shell for that one run, never stored in
GitHub or a deployment.

| Variable                                                                                                                                            | Value / purpose                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESTORE_RUN_ID`                                                                                                                                    | Required. The run to restore, `run-<id>`, as its archive prefix shows it.                                                                                                                                                                                                                                                                                                                                                 |
| `B2_ARCHIVE_ENDPOINT` / `B2_ARCHIVE_REGION` / `B2_ARCHIVE_BUCKET`                                                                                   | Required. The deployment's archive bucket, as for the backup run.                                                                                                                                                                                                                                                                                                                                                         |
| `B2_ARCHIVE_READER_KEY_ID` / `B2_ARCHIVE_READER_APPLICATION_KEY`                                                                                    | Required. The recovery reader key (`listFiles`, `readFiles` only).                                                                                                                                                                                                                                                                                                                                                        |
| `RECOVERY_PRIVATE_KEY_PATH`                                                                                                                         | Required. Path to a local file holding the `age` recovery private key, supplied at restore time only (from the password manager or the offline copy) and deleted afterwards. It must exist and be readable; only `age` reads it, and its contents are never logged.                                                                                                                                                       |
| `TARGET_DATABASE_URL`                                                                                                                               | Optional; unset means verify only. The isolated target project's `postgres` login through the session pooler (port 5432), URL-encoded password. It reaches `psql` only as PG\* variables.                                                                                                                                                                                                                                 |
| `RESTORE_SKIP_ROLES`                                                                                                                                | Optional. `1`, `true` or `yes` leaves out `roles.sql`, for a target that already holds the roles.                                                                                                                                                                                                                                                                                                                         |
| `TARGET_STORAGE_ENDPOINT` / `TARGET_STORAGE_REGION` / `TARGET_STORAGE_BUCKET` / `TARGET_STORAGE_ACCESS_KEY_ID` / `TARGET_STORAGE_SECRET_ACCESS_KEY` | Required with `TARGET_DATABASE_URL` (all five) unless `RESTORE_SKIP_OBJECTS` is set; refused without it. The target project's Storage S3 endpoint, region, `documents` bucket (created first) and an S3 access key pair. Each archived document is uploaded to `workspaces/<workspace>/<key>`. They are checked before anything is read, because the documents are uploaded after the database transaction has committed. |
| `RESTORE_SKIP_OBJECTS`                                                                                                                              | Optional. `1`, `true` or `yes` restores without target storage (any `TARGET_STORAGE_*` is ignored). Only for a backup that holds no documents, or a deliberate database-only drill: a run that holds documents then fails with `restore_storage_not_configured` at the documents stage, after the database is loaded, and that loaded target must be discarded before another attempt (`restore_target_not_empty`).       |
| `INCIDENT_DETECTED_AT`                                                                                                                              | Optional. An ISO 8601 date-time; the report then measures the loss window from the run's capture time.                                                                                                                                                                                                                                                                                                                    |
| `PGSSLMODE`                                                                                                                                         | Optional. Defaults to `require`; set `disable` only for a local `supabase start` target.                                                                                                                                                                                                                                                                                                                                  |
| `SENTRY_DSN`, `RELEASE_SHA`, `DEPLOYMENT_ENV`                                                                                                       | Optional error tracking when the restore itself fails.                                                                                                                                                                                                                                                                                                                                                                    |
