# Backup runbook

Every night a GitHub Actions workflow copies the CRM's database and every
verified document into a private Backblaze B2 bucket, encrypted with `age` to
a recovery key only the owner holds. An hourly workflow alerts the owner when
the last copy is more than 26 hours old, and a weekly one prunes old copies.
This file is the setup, in the order the owner does it, and the facts the
design rests on. Restoring is in [restore.md](restore.md); what to do when the
alert fires is in [backup-alert-response.md](backup-alert-response.md); every
variable is in [docs/ENV.md](../ENV.md) "Backups".

| Workflow                                  | Schedule (UTC) | GitHub Environment              | B2 key                                             |
| ----------------------------------------- | -------------- | ------------------------------- | -------------------------------------------------- |
| Backup (`backup.yml`)                     | daily 06:17    | `backup-<deployment>`           | writer: `listFiles`, `writeFiles`                  |
| Backup monitor (`backup-monitor.yml`)     | hourly at :08  | `backup-monitor-<deployment>`   | reader: `listFiles`, `readFiles`                   |
| Backup retention (`backup-retention.yml`) | Mondays 07:43  | `backup-retention-<deployment>` | retention: `listFiles`, `readFiles`, `deleteFiles` |

The first deployment is `gt-sales`. Three B2 keys, not four: the reader key
is shared by the monitor and the owner's restore, because both only list and
read. No environment holds both a delete-capable key and the recovery private
key, and the private key is never in GitHub at all.

Order: the setup (steps 3–6) comes **before** the pull request that adds the
workflows is merged, so no scheduled run ever fails for want of a secret.
GitHub Environments and their secrets can be created before the workflow
files exist on `main`. Then merge, then the first run (step 7). If the setup
cannot happen before the merge, disable the three workflows in the Actions
tab (each workflow → ⋯ → Disable workflow) and enable them again at step 7.

## 1. Facts checked on 2026-10-29

Read on 2026-10-29 from Supabase project `gtsales-crm`
(`xykrphbgpwisqacpyeiv`, Mumbai) through the Supabase MCP `execute_sql`
connector. Every query was a `SELECT`; nothing was created, altered or granted.

### Server and roles

- **Postgres version:** major **17** (Supabase image `17.6.1.141`, engine 17,
  release channel `ga`). Full `version()` string:
  `PostgreSQL 17.6 on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit`.
- **Connector role:** the MCP connector runs as `postgres`
  (`current_user` = `session_user` = `postgres`). Every privilege check below
  was therefore made as `postgres`, which is, per 0001, the role that runs
  the migrations (an inference from the migration files, not checked live).
- **`postgres` role attributes:** `rolsuper = false`, `rolcreaterole = true`,
  `rolbypassrls = true`. It is not a superuser on Supabase, but it can create
  roles and bypasses row-level security.
- **Existing roles:** of the roles checked, `anon`, `app_runtime`,
  `authenticated` and the Supabase service role exist. **`backup_reader` does
  not exist yet.**

### Auth data

- `postgres` has `USAGE` on schema `auth` and `SELECT` on `auth.users`.
- In `information_schema.role_table_grants` for `auth.users`, `postgres` holds
  `SELECT` **with grant option** (`is_grantable = YES`). Its `INSERT`,
  `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` and `TRIGGER` privileges are
  not grantable (`is_grantable = NO`), which does not matter for a read-only
  role.
- Only `auth.users` was checked for grantability. The other `auth` tables,
  and row security on every `auth` table, are checked after 0007 by
  verification selects 4 and 5 of the manual SQL (step 5 below).

### Tables in `app` and `public`

Every table in both schemas is owned by `postgres`. All have row-level
security enabled except `app.workspaces`, which has none by design. Per 0001
(`drizzle/0001_runtime_functions.sql`; the grants were not read live), no
role but the owner has a grant on it, and staff reach sites through the
`list_staff_workspaces()` function.

| Schema   | Table                     | Owner      | RLS |
| -------- | ------------------------- | ---------- | --- |
| `app`    | `audit_events`            | `postgres` | yes |
| `app`    | `contacts`                | `postgres` | yes |
| `app`    | `deleted_email_messages`  | `postgres` | yes |
| `app`    | `draft_grants`            | `postgres` | yes |
| `app`    | `email_messages`          | `postgres` | yes |
| `app`    | `email_provider_events`   | `postgres` | yes |
| `app`    | `email_suppressions`      | `postgres` | yes |
| `app`    | `file_review_events`      | `postgres` | yes |
| `app`    | `file_revisions`          | `postgres` | yes |
| `app`    | `files`                   | `postgres` | yes |
| `app`    | `follow_up_schedules`     | `postgres` | yes |
| `app`    | `lead_activities`         | `postgres` | yes |
| `app`    | `lead_identities`         | `postgres` | yes |
| `app`    | `lead_tasks`              | `postgres` | yes |
| `app`    | `leads`                   | `postgres` | yes |
| `app`    | `marketing_consents`      | `postgres` | yes |
| `app`    | `membership_permissions`  | `postgres` | yes |
| `app`    | `membership_roles`        | `postgres` | yes |
| `app`    | `memberships`             | `postgres` | yes |
| `app`    | `outbox_job_alerts`       | `postgres` | yes |
| `app`    | `outbox_jobs`             | `postgres` | yes |
| `app`    | `permissions`             | `postgres` | yes |
| `app`    | `rate_limit_buckets`      | `postgres` | yes |
| `app`    | `roles`                   | `postgres` | yes |
| `app`    | `service_credentials`     | `postgres` | yes |
| `app`    | `workspaces`              | `postgres` | no  |
| `public` | `admin_activity`          | `postgres` | yes |
| `public` | `admins`                  | `postgres` | yes |
| `public` | `internet_leads`          | `postgres` | yes |
| `public` | `mobility_id_uploads`     | `postgres` | yes |
| `public` | `mobility_leads`          | `postgres` | yes |
| `public` | `notifications`           | `postgres` | yes |
| `public` | `order_edit_requests`     | `postgres` | yes |
| `public` | `orders`                  | `postgres` | yes |
| `public` | `partner_earnings`        | `postgres` | yes |
| `public` | `partner_invoice_items`   | `postgres` | yes |
| `public` | `partner_invoices`        | `postgres` | yes |
| `public` | `partners`                | `postgres` | yes |
| `public` | `posts`                   | `postgres` | yes |
| `public` | `posts_backup_pickup_fix` | `postgres` | yes |
| `public` | `rate_limits`             | `postgres` | yes |

That is 26 tables in `app` (25 with RLS) and 15 in `public` (all with RLS),
41 in all. This is the inventory the 0007 migration loop must cover
(`docs/HANDOFF.md` §1 gives the same 26 for `app`).

### Migration history

Schema `supabase_migrations` exists and `postgres` has `USAGE` on it
(`has_history = true`, `history_usage = true`).

### Sizes

| What                                                  | Count | Bytes      | About    |
| ----------------------------------------------------- | ----- | ---------- | -------- |
| Referenced documents (`app.files` with an object key) | 122   | 72,095,045 | 68.8 MiB |
| Whole database (`pg_database_size`)                   | —     | 22,113,427 | 21.1 MiB |

### Storage

| Bucket         | Public |
| -------------- | ------ |
| `documents`    | no     |
| `blog-images`  | yes    |
| `mobility-ids` | no     |

`has_table_privilege` says `postgres` has `SELECT` on `storage.objects`.
That check ignores row security, and it is moot: the backup fetches the
documents through the Storage S3 API, never through the table.

### What this means for the design

- **pg_dump client:** the workflows install the PostgreSQL **17** client tools
  (`pg_dump`, `pg_dumpall`, `psql`), pinned to 17: `backup.yml` stops if
  `pg_dump --version` is not 17. The server is 17.6, and the client must be
  the same major or newer; pinning it means a future 18 client never dumps
  without someone choosing it.
- **`BACKUP_AUTH_DATA`:** keep the default **`include`**. `postgres` holds
  `SELECT` on `auth.users` with grant option, so the migration can grant it to
  `backup_reader` and staff accounts can be in the backup. The grant itself has
  not been tried (this spike was read-only); applying 0007/0008 is where it is
  proven, and `skip` stays the documented fallback if the grant is refused.
- **RLS owners:** no `public` table with RLS is owned by a role other than
  `postgres`, so the 0007 policy loop over tables owned by the migration role
  covers all of them and no table needs a manual policy. The pre-paste check
  in step 5 confirms this again on the day. `app.workspaces` has no RLS, so it
  needs only the `SELECT` grant, not a policy.
- **Sizes:** the database (about 21 MiB) and the referenced documents (about
  69 MiB) together are about 90 MiB, far below the 2 GiB in-memory guard.
- **Connection:** the backup connects through the session pooler (port 5432,
  not the transaction pooler on 6543 that the backend uses), with a connection
  string of the shape
  `postgresql://backup_reader.xykrphbgpwisqacpyeiv:<url-encoded password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`.
  The password lives only in the workflow's secret store.

## 2. What is backed up and what is not

Each run writes one folder, `run-<timestamp>-<uuid>/`, in the archive bucket.
Every file in it is encrypted to the recovery recipient and stored as
`<name>.enc`:

- `roles.sql`: the database roles, without passwords.
- `schema.sql` and `data.sql`: the schemas `app` (the CRM), `public` (Get
  Canada Sim's and CanadaWide's own tables) and `drizzle` (the migration
  record); `data.sql` also holds the rows of `auth.users` and
  `auth.identities` (staff accounts, password hashes and sign-in identities)
  unless `BACKUP_AUTH_DATA=skip`. No other `auth` table is read: sessions,
  refresh tokens and MFA state are never in a backup, and after a restore
  every member signs in again.
- `history_schema.sql` and `history_data.sql`: Supabase's migration history
  (`supabase_migrations`), unless `BACKUP_HISTORY=skip`.
- `objects/<workspace>/<key>`: every document an `app.files` row or a kept
  file revision points at, in the `documents` bucket, checked against its
  recorded size and SHA-256. One missing or changed document fails the run.
- `manifest.json`: written last. It lists every file with its size and
  SHA-256, the row count of every table, the tool versions and what the run
  left out (`exclusions`).

After all of that is uploaded and listed back, the run overwrites
`heartbeat/latest.json` (not encrypted; ids and counts only), which is what
the monitor reads.

Not backed up, by design: the `storage.objects` table itself (a restore
recreates it by uploading the documents again), Supabase project settings,
JWT and API keys, database and role passwords, SMTP and OAuth secrets,
Storage S3 keys, the B2 keys and the recovery private key. The manifest
records these as exclusions on every run. See also "Known gaps" below.

## 3. Backblaze B2: one bucket, three keys

1. Sign in to Backblaze → B2 Cloud Storage → Buckets → Create a Bucket. Name
   `gt-sales-crm-archive`, Files in Bucket **Private**, Default Encryption
   on, **Object Lock on**. Bucket names are global; if that one is taken, pick
   another and use it everywhere below. Then on the new bucket open Object
   Lock and set the default retention: mode **Governance**, **30 days**.
   Why: the writer key lives in GitHub, and a stolen one can overwrite or
   hide files, including the heartbeat the monitor reads (it is plaintext, so
   a forged one would keep the monitor quiet). With Object Lock no key can
   purge a file version inside its 30 days, so every restore point of the
   last month survives whatever the writer key does. Turn it on while
   creating the bucket; do not skip it.
   None of the three keys below may hold `bypassGovernance`, the capability
   that lifts governance mode; the retention key especially must not.
   Every upload carries a `Content-MD5` header, as Object Lock buckets
   require.
2. On the new bucket, open Lifecycle Settings and choose **Keep prior versions
   for this number of days: 30**. Why: B2 keeps every version of a file, and a
   delete through the S3 API only hides the file. Without a lifecycle rule,
   retention's deletes free no space at all. Thirty days rather than one, to
   match the Object Lock window: if the writer key were ever stolen and used
   to overwrite or hide old restore points, the originals could still be
   recovered for a month.
3. Note the bucket's **Endpoint** from the Buckets page, for example
   `s3.us-west-004.backblazeb2.com`. The region is the middle part
   (`us-west-004`). `B2_ARCHIVE_ENDPOINT` is `https://` plus the endpoint.
4. Create the three application keys with the B2 command-line tool (version
   4; `pipx install b2` or `brew install b2-tools`). The web console's access
   presets (Read and Write, Read Only, Write Only) do not give these exact
   capability sets, and the exact sets are the point: the writer can never
   read or delete, the reader can never write or delete.

   ```sh
   b2 account authorize   # paste the master application key id and key when asked
   b2 key create --bucket gt-sales-crm-archive gt-sales-backup-writer listFiles,writeFiles
   b2 key create --bucket gt-sales-crm-archive gt-sales-backup-reader listFiles,readFiles
   b2 key create --bucket gt-sales-crm-archive gt-sales-backup-retention listFiles,readFiles,deleteFiles
   b2 key list --long     # check each key's bucket and capabilities; none has bypassGovernance
   b2 account clear       # sign the tool out of the master key
   ```

   Each `key create` prints the key id and the key once. Put both straight
   into the password manager, one entry per key. They go into GitHub in step
   6 and nowhere else; the reader key is also what a restore uses.

## 4. The recovery key ceremony

The recovery key decides whether any backup can ever be read. Do this once,
on the owner's own computer, with `age` installed (`brew install age`, or
`sudo apt-get install age`):

```sh
age-keygen -o gt-sales-recovery-key.txt
age-keygen -y gt-sales-recovery-key.txt
```

The second command prints the recipient, a line starting `age1…`. That line
is public: it becomes the `RECOVERY_AGE_RECIPIENT` secret in step 6.

The file `gt-sales-recovery-key.txt` is the private key. Store its contents
in the password manager, make one offline copy (printed, or on a USB stick
kept somewhere safe away from the computer), check the offline copy can be
read, and only then delete the file. It is never pasted into GitHub,
Railway, Vercel, Supabase or any chat, and never committed. **Losing it
makes every backup unreadable**; there is no reset.

If the private key is lost: make a new key pair as above, set the new
`RECOVERY_AGE_RECIPIENT` in `backup-gt-sales`, and verify the next run
decrypts ([restore.md](restore.md) §1, verify only). Every earlier restore
point is unreadable.

## 5. Supabase: the `backup_reader` role

Migrations 0007 and 0008 create `backup_reader`, the read-only login the
backup dumps with ([database.md](database.md#0007_backup_reader--0008_backup_reader_policies)).

1. **Pre-paste check.** In Supabase → SQL Editor, run:

   ```sql
   select c.relname, c.relkind, pg_get_userbyid(c.relowner) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','S','f') and pg_get_userbyid(c.relowner) <> 'postgres';
   ```

   It must return no rows. 0007 grants `SELECT ON ALL TABLES` and `ALL
SEQUENCES IN SCHEMA public`, and a `public` object owned by another role
   makes that grant fail loudly: the whole paste rolls back with "permission
   denied", or, where `postgres` holds a privilege on it without grant
   option, PostgreSQL prints a "no privileges were granted" WARNING and the
   role cannot read it. If rows come back, grant each object to
   `backup_reader` by hand as its owner (and add a read policy if it has row
   security) before going on. The same applies to any future `public` table
   another role creates.

2. **Apply.** Open
   [`manual/0007-0008-backup-reader.sql`](manual/0007-0008-backup-reader.sql),
   paste everything from `BEGIN;` to `COMMIT;` into the SQL Editor and run it
   once. It is one transaction with all four tracker rows. A WARNING that the
   `auth` (or `supabase_migrations`) schema was not granted, or PostgreSQL's
   own "no privileges were granted" WARNING, is not a failure; step 4 shows
   what it means.
3. **Password.** On your computer run `openssl rand -hex 16` (hex, so it
   needs no URL-encoding). In the SQL Editor run
   `alter role backup_reader password '<that value>';` on its own. The SQL
   Editor keeps a query history: do not save that statement as a snippet,
   and close its tab afterwards. Put the value in the password manager; it
   goes into `SOURCE_DATABASE_URL` in step 6 and nowhere else.
4. **Verify.** The SQL Editor shows only the last result of a run, so run
   the five verification selects at the end of the manual file one at a time:
   1. the role's attributes: `true, false, false, false, false, false, true`;
   2. `25` read policies in `app`;
   3. no rows: no `public` table the backup's guard would stop on (no
      `SELECT`, or row security without a `USING (true)` read policy for
      `backup_reader`, or with a restrictive policy that applies to it);
   4. `true, true, true, 0`: `backup_reader` has `USAGE` on `auth`, reads
      `auth.users` and `auth.identities`, and reads no other `auth` table;
   5. no rows: neither of those two tables has row security on.

   If 4 shows a `false` or 5 returns rows, the `auth` grant did not fully
   work: set the `BACKUP_AUTH_DATA` secret to `skip` in step 6 (staff are
   then re-invited after a restore) and tell the developer. With `include`,
   the backup would refuse to run rather than save empty staff tables. If
   the last column of 4 is not `0`, `backup_reader` can read session or token
   tables: run
   `revoke select on all tables in schema auth from backup_reader; grant select on auth.users, auth.identities to backup_reader;`
   and check again.

5. Record the date applied under 0007 + 0008 in
   [database.md](database.md).

Also create a Storage S3 key for the backup: Supabase → Project Settings →
Storage → S3 Access Keys → New access key, named "backup". Supabase's S3 keys
cannot be limited to reading, so this key is as strong as the backend's; it
is a separate key only so it can be revoked on its own. The same page shows
the S3 endpoint and region.

## 6. GitHub: three environments

In GitHub → `GT-Sales/crm` → Settings → Environments → New environment,
create `backup-gt-sales`, `backup-monitor-gt-sales` and
`backup-retention-gt-sales`. On each:

- **Deployment branches and tags:** Selected branches and tags → add `main`.
  The repository is public; this keeps the secrets away from any other branch.
- **Environment secrets:** add the secrets below. The names must match
  exactly. Leave the optional ones unset unless there is a reason.
- No required reviewers on any of them: a scheduled run must never wait for
  an approval. The protection is the branch limit above and that each
  environment holds only its own key.

| Secret                                                                                              | `backup-gt-sales` | `backup-monitor-gt-sales` | `backup-retention-gt-sales` | Value                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------- | ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `B2_ARCHIVE_ENDPOINT`, `B2_ARCHIVE_REGION`, `B2_ARCHIVE_BUCKET`                                     | yes               | yes                       | yes                         | Step 3: `https://s3.<region>.backblazeb2.com`, `<region>`, `gt-sales-crm-archive`.                                                                                     |
| `B2_ARCHIVE_WRITER_KEY_ID`, `B2_ARCHIVE_WRITER_APPLICATION_KEY`                                     | yes               |                           |                             | The writer key.                                                                                                                                                        |
| `B2_ARCHIVE_READER_KEY_ID`, `B2_ARCHIVE_READER_APPLICATION_KEY`                                     |                   | yes                       |                             | The reader key.                                                                                                                                                        |
| `B2_ARCHIVE_RETENTION_KEY_ID`, `B2_ARCHIVE_RETENTION_APPLICATION_KEY`                               |                   |                           | yes                         | The retention key.                                                                                                                                                     |
| `RECOVERY_AGE_RECIPIENT`                                                                            | yes               |                           |                             | Step 4: the `age1…` line. Never the private key.                                                                                                                       |
| `SOURCE_DATABASE_URL`                                                                               | yes               |                           |                             | `postgresql://backup_reader.xykrphbgpwisqacpyeiv:<password from step 5>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`                                            |
| `SOURCE_STORAGE_ENDPOINT`, `SOURCE_STORAGE_REGION`, `SOURCE_STORAGE_BUCKET`                         | yes               |                           |                             | `https://xykrphbgpwisqacpyeiv.storage.supabase.co/storage/v1/s3`, `ap-south-1`, `documents`.                                                                           |
| `SOURCE_STORAGE_ACCESS_KEY_ID`, `SOURCE_STORAGE_SECRET_ACCESS_KEY`                                  | yes               |                           |                             | The "backup" Storage S3 key from step 5.                                                                                                                               |
| `SUPABASE_PROJECT_REF`                                                                              | yes               |                           |                             | `xykrphbgpwisqacpyeiv`.                                                                                                                                                |
| `OWNER_ALERT_EMAIL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`                      |                   | yes                       |                             | Where the alert goes and who sends it: the owner's address and the Resend key and sender the backend uses (or a key of its own). Without them an alert is only logged. |
| Optional: `BACKUP_AUTH_DATA`, `BACKUP_HISTORY`, `BACKUP_MAX_SNAPSHOT_BYTES`                         | optional          |                           |                             | ENV.md. `BACKUP_AUTH_DATA=skip` only if step 5's checks 4 or 5 failed.                                                                                                 |
| Optional: `BACKUP_MONITOR_MAX_AGE_SECONDS`, `OWNER_ALERT_WEBHOOK_URL`, `OWNER_ALERT_WEBHOOK_SECRET` |                   | optional                  |                             | ENV.md.                                                                                                                                                                |
| Optional: `RETENTION_DAILY_POINTS`, `RETENTION_MONTHLY_POINTS`, `RETENTION_GRACE_SECONDS`           |                   |                           | optional                    | ENV.md. Defaults 30, 12 and 24 hours.                                                                                                                                  |
| Optional: `SENTRY_DSN`                                                                              | optional          | optional                  | optional                    | Error tracking for a failed run.                                                                                                                                       |

The repository is public, so its Actions logs are too. The jobs log ids,
counts, table names and object keys only, never a value or a row. Object
keys may appear in a `backup_failed` line; they are opaque server-generated
ids (`candidate/<workspace id>/<random token>`, `<run id>/<artifact>.enc`),
never a filename or anything a customer typed.

## 7. Merge, then the first run

With steps 3–6 done, merge the pull request that adds the workflows. Then in
GitHub → Actions (enable the three workflows first if they were disabled):

1. **Backup** → Run workflow → branch `main` → Run workflow. Open the run,
   the job `backup (gt-sales)`, the step "Run the backup". The last line is
   `{"event":"backup_completed",…}` with `artifactCount` at least 3 and
   `referencedObjectCount` 122 (the count on 2026-10-29, or today's count:
   `select count(*) from (select workspace_id, bucket, object_key from app.files where object_key is not null union select r.workspace_id, f.bucket, r.object_key from app.file_revisions r join app.files f on f.workspace_id = r.workspace_id and f.id = r.file_id) s;`).
   A `backup_failed` line names the problem instead; see
   [backup-alert-response.md](backup-alert-response.md).
2. **Backup monitor** → Run workflow. The step's log shows
   `{"event":"monitor_status","deployment":"gt-sales","status":"ok",…}`.
3. **Prove the alert reaches you.** In `backup-monitor-gt-sales` add the
   secret `BACKUP_MONITOR_MAX_AGE_SECONDS` with the value `1`, run Backup
   monitor by hand, and confirm the `backup_stale` email arrives at
   `OWNER_ALERT_EMAIL` (the run itself fails, as it should). Then **delete
   that secret** and run the monitor once more: it is green again.
4. **Backup retention** → Run workflow, leave **Dry run** ticked. The log
   shows `retention_completed` with `dryRun: true` and
   `candidateDeletionCount: 0`. Read the report: `retainedRunCount`,
   `candidateRunIds` (empty) and `pendingRunIds` should make sense. Then run
   it once more with **Dry run** unticked; the log shows `dryRun: false`
   and `deletedCount: 0`. From then on the Monday schedule prunes on its own.
5. The next morning, check that the 06:17 scheduled Backup ran green on its
   own and the hourly monitor stays green.
6. Then practise a restore ([restore.md](restore.md), "Drill").

## 8. Deleting customer data by hand

Customers ask through the website's contact page, and a developer deletes in
the database (merge design decision 18). For documents the order matters:
**delete or null the `app.files` rows (and their `app.file_revisions`) first,
then the storage objects; never the other way round.** The backup copies every
object a row points at and fails the whole run when one is missing
(`backup_incomplete`), so an object deleted before its row breaks every
nightly backup until the row is fixed.

A deleted customer stays in the restore points taken before the deletion
until retention prunes them: up to 30 days in the daily points and up to 12
months in the monthly ones. A restore brings them back, so after any restore
redo every deletion made since that restore point.

## 9. Retention and costs on the free tiers

- **What retention keeps:** the newest run of each of the last 30 days and of
  each of the last 12 months, so at most 42 restore points, plus anything
  younger than 24 hours.
- **Scheduled runs delete; manual runs default to a dry run.** The Monday
  run prunes with no one watching. What keeps it safe is the policy: the
  kept points above are never deleted, nothing younger than the 24-hour grace
  is touched, a run counts as complete only once its manifest (uploaded last)
  exists, and `heartbeat/latest.json` is never deleted. A human read the dry
  run once, at step 7. Its log lists `candidateRunIds` every week.
- **Size:** each run stores the full document set, not changes. Today that
  is about 90 MiB a run, so 42 points are about 3.7 GiB, plus up to 30 days
  of pruned versions kept by the lifecycle rule (step 3). B2 stores 10 GB
  free and bills per GB above that; downloads and the jobs' requests stay
  inside B2's free daily allowances. If documents grow, lower
  `RETENTION_DAILY_POINTS` in the retention environment.
- **GitHub:** the repository is public, so Actions minutes are free.

## 10. What stops the schedule

- **A paused Supabase project.** Free projects pause after a week without
  activity. A paused project refuses the dump, the backup fails and the
  monitor alerts within 26 hours. The backend's scheduler queries the
  database every minute, so while it runs the project stays awake.
- **GitHub's 60-day rule.** GitHub disables scheduled workflows in a public
  repository after 60 days without a commit, and emails a warning first. The
  monitor stops with the backup, so no alert would come. Re-enable both in
  the Actions tab, or push a commit.

## 11. Ongoing care

- **Every quarter, a verify-only restore** of last night's run
  ([restore.md](restore.md) §1, no target): it proves the private key in the
  password manager still opens the archive and every file matches its
  checksum. Record the date and run id under a `## Verify <date>` heading in
  restore.md, then delete the key file.
- **After any restore**, re-run 0007 on the new project and give
  `backup_reader` a new password before pointing the backups at it
  ([restore.md](restore.md) §5).
- **GitHub's 60-day warning email** (§10): push a commit or re-enable the
  workflows the same week.

## Known gaps

- **Legacy buckets.** `mobility-ids` (CanadaWide's ID photos, not yet
  imported into `app.files`) and `blog-images` (public) are outside this
  backup until the cutover and the import (merge design §12). Only the
  `documents` bucket is copied.
- **`public.posts_backup_pickup_fix`** is a leftover one-off table. It is
  dumped like any other `public` table, which does no harm.
- **An interrupted restore** (Ctrl-C) can leave the decrypted dump under
  `$TMPDIR/gt-sales-restore-*`; delete it ([restore.md](restore.md)).
