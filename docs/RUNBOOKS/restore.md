# Restore runbook

How to bring a backup back: into a fresh, empty project, never over
production. The owner runs it on their own computer with
`pnpm --filter @gt-sales/jobs run restore` (`jobs/src/restore/cli.ts`); it
never runs in GitHub, because it needs the recovery private key. Practise it
on a drill target first ("Drill" below); a restore nobody has tried is a hope,
not a backup. Setup is in [backup.md](backup.md), every variable in
[docs/ENV.md](../ENV.md) "Restore".

## Immediate incident actions

1. **Stop writes.** In Railway, open project GT Sales CRM → service `crm` and
   remove its active deployment (the deployment's ⋯ menu → Remove;
   redeploying brings it back). The admin and the websites' forms then fail,
   which is better than writing into a damaged database.
2. **Note when the damage started**, in UTC. It becomes
   `INCIDENT_DETECTED_AT`, and it decides which run to restore: the newest one
   captured before it.
3. **Keep the evidence.** Do not repair, delete or overwrite anything in the
   production project or its storage. Save the GitHub Actions logs of the
   recent Backup runs.
4. **Hold retention.** Disable the Backup retention workflow (GitHub →
   Actions → Backup retention → ⋯ → Disable workflow) until the incident is
   closed: its Monday run could prune the restore point you need. The
   nightly Backup can keep running; it only adds restore points.
5. **Stop at the first failed check** below (decryption, size, checksum, row
   count). Do not reopen on a partial restore.

## What you need

- **The reader key** (`B2_ARCHIVE_READER_KEY_ID` and
  `B2_ARCHIVE_READER_APPLICATION_KEY`, the same key the monitor uses) and the
  archive bucket's endpoint, region and name, from the password manager.
- **The recovery private key**, from the password manager or the offline copy
  ([backup.md](backup.md) step 4), saved to a file outside the repository
  only for the restore, for example `~/gt-sales-recovery-key.txt`.
- **The run id.** Backblaze → Buckets → `gt-sales-crm-archive` → Browse Files
  shows one folder per run, `run-<capture time>-<uuid>`, so sorting by name
  sorts by time. The Backup workflow's `backup_completed` lines give the same
  ids.
- **This repository** checked out, with Node 22 and pnpm
  (`pnpm install --frozen-lockfile`), `age`, and the PostgreSQL 17 client
  `psql` on `PATH`. On macOS: `brew install age postgresql@17`, then put
  `$(brew --prefix postgresql@17)/bin` first on `PATH`.
- **A target**, for a real restore or a drill:
  - a new Supabase project in the same organisation (the Free plan allows two
    active projects per organisation, and production is one), or
  - `supabase start` on your computer (Docker), for a drill.

  The target must be empty: no `app` or `drizzle` schema. Its `postgres` role
  must bypass row security, which Supabase's `postgres` does; the restore
  checks both before it loads anything. Create a private `documents` bucket
  on it first (Storage → New bucket), and a Storage S3 access key (Project
  Settings → Storage → S3 Access Keys). The same page shows its S3 endpoint
  and region.

Set every value in the shell for this one run, never in a file in the
repository. `read -rs NAME` asks for a value without showing it or saving it
in the shell history; paste the value and press Enter.

## 1. Verify the run first

Without a target the restore only downloads and checks the run: the manifest
and every file must decrypt and match their recorded size and SHA-256.

```sh
export RESTORE_RUN_ID=run-<the run id>
export B2_ARCHIVE_ENDPOINT=https://s3.<region>.backblazeb2.com
export B2_ARCHIVE_REGION=<region>
export B2_ARCHIVE_BUCKET=gt-sales-crm-archive
read -rs B2_ARCHIVE_READER_KEY_ID && export B2_ARCHIVE_READER_KEY_ID
read -rs B2_ARCHIVE_READER_APPLICATION_KEY && export B2_ARCHIVE_READER_APPLICATION_KEY
export RECOVERY_PRIVATE_KEY_PATH=~/gt-sales-recovery-key.txt
pnpm --filter @gt-sales/jobs run restore
```

Expect one `restore_report` line with `"mode":"verify_only"`,
`"verified":true` and `"restored":false`, and exit code 0. Anything else:
see "If it fails".

## 2. Restore into the target

Add the target to the same shell and run it again:

```sh
read -rs TARGET_DATABASE_URL && export TARGET_DATABASE_URL
export TARGET_STORAGE_ENDPOINT=https://<target ref>.storage.supabase.co/storage/v1/s3
export TARGET_STORAGE_REGION=<target region>
export TARGET_STORAGE_BUCKET=documents
read -rs TARGET_STORAGE_ACCESS_KEY_ID && export TARGET_STORAGE_ACCESS_KEY_ID
read -rs TARGET_STORAGE_SECRET_ACCESS_KEY && export TARGET_STORAGE_SECRET_ACCESS_KEY
export INCIDENT_DETECTED_AT=<UTC time from incident step 2, e.g. 2026-11-03T09:40:00Z>
pnpm --filter @gt-sales/jobs run restore
```

- `TARGET_DATABASE_URL` is the target's `postgres` login through its session
  pooler, port 5432:
  `postgresql://postgres.<target ref>:<url-encoded password>@<pooler host>:5432/postgres`
  (Connect → Session pooler on the target project). For `supabase start`:
  `postgresql://postgres:postgres@127.0.0.1:54322/postgres` with
  `export PGSSLMODE=disable`; storage is `http://127.0.0.1:54321/storage/v1/s3`
  with the region and S3 keys that `supabase status` prints.
- The five `TARGET_STORAGE_*` values are required with `TARGET_DATABASE_URL`.
  The documents are uploaded after the database has committed, so the
  restore checks they are all set before it starts.
- `RESTORE_SKIP_OBJECTS=1` restores without storage. Only for a backup that
  holds no documents, or a deliberate database-only drill: a run that holds
  documents then fails at `objects_apply`, after the database is loaded.
- `RESTORE_SKIP_ROLES=1` leaves out `roles.sql`. Only when the target already
  has the `app_runtime` and `backup_reader` roles; a fresh project does not.
- `INCIDENT_DETECTED_AT` is optional; with it the report gives the loss
  window (`measuredLossWindowMs`, from the run's capture time).

What it does, in order: checks the target (`target_preflight`), loads
`roles.sql`, `schema.sql` and `data.sql` in one transaction with triggers
off, then the migration history in a second one (`database_apply`), uploads
every document to `workspaces/<workspace>/<key>` in the target bucket
(`objects_apply`), and compares every table's row count with the manifest
(`row_count_check`). The decrypted dump is written to a private temporary
folder that is removed afterwards. **If you interrupt it (Ctrl-C), that
folder can stay behind with every lead's details in it: delete it with
`rm -rf "${TMPDIR:-/tmp}"/gt-sales-restore-*`.**

## 3. Read the report

The `restore_report` line holds:

- `verified`, `restored`: both `true`, and exit code 0, is a good restore.
- `rowCountMismatches`: must be `[]`.
- `restoreDurationMs`, `measuredLossWindowMs`: record them.
- `manifest`: the run's deployment, `capturedAt`, source project, tool
  versions, row counts, `counts.referencedObjects` and `exclusions`.

`manifest.exclusions` tells you what the restore did not bring back. It
always lists the platform items (project settings, keys, passwords, SMTP,
`storage.objects` metadata). Two entries need action:

- `auth_data_skipped_by_operator`: the backup ran with
  `BACKUP_AUTH_DATA=skip`, so there are no staff accounts on the target.
  Every member must be invited again, and their memberships linked to the new
  accounts.
- `supabase_migrations_skipped_by_operator`: no Supabase migration history.
  Record the applied migrations by hand ([database.md](database.md)).

Restored documents carry no stored `Content-Type`. That is fine: nothing
sniffs a document at serve time; the backend's download link sets
`response-content-type` itself, from the file row's `detected_mime` for an
inline view (and `application/octet-stream` for an attachment), and the row
is restored with the database, so downloads keep their type. Check it anyway:
download one document from a lead in the admin once the backend points at the
target (step 5 and "Reopen criteria"; on a drill, from the target's Storage
page).

## 4. Checks on the target

In the target's SQL Editor, one at a time:

```sql
select count(*) from app.leads;        -- equals manifest.rowCounts["app.leads"]
select count(*) from storage.objects;  -- equals manifest.counts.referencedObjects
select count(*) from auth.users;       -- equals manifest.rowCounts["auth.users"], when auth was included
select count(*) from auth.identities;  -- equals manifest.rowCounts["auth.identities"], likewise
alter role app_runtime password '<openssl rand -base64 36>';
alter role backup_reader password '<openssl rand -hex 16>';
```

Dumped roles carry no passwords, hence the two `alter role` lines. Then
connect as `app_runtime` with its new password (session pooler, user
`app_runtime.<target ref>`) and run `select count(*) from app.leads;`: it must
return 0, because without `app.workspace_id` set the row policies show
nothing. If it returns rows, stop: the tenant isolation did not survive.

## 5. Moving production onto the target

Only for a real incident, after steps 1–4 passed:

1. **Supabase settings** are not in the backup. On the target: Authentication
   → URL Configuration (Site URL and redirect URLs as on production, the
   admin's address), Authentication → Emails → SMTP (as in
   [HANDOFF.md](../HANDOFF.md) §5.1 step 4), leaked-password protection, and
   new Storage S3 keys for the backend.
2. **Point the backend at the target.** Railway → service `crm` →
   Variables: `DATABASE_URL` (`app_runtime.<target ref>` with its new
   password, transaction pooler port 6543), `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` and the storage variables ([ENV.md](../ENV.md)
   "Documents"). Vercel → `gt-sales-crm-admin` → Environment Variables:
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Redeploy
   both.
3. **Get Canada Sim's own site and admin** read its `public` tables straight
   from Supabase with their own keys; point them at the target too.
4. **Staff sign in afresh.** The new project has new signing keys, so every
   old session is invalid. With auth data restored, staff keep their
   passwords; without it, invite them again.
5. **Redo deletions** made since the restore point ([backup.md](backup.md)
   step 8).
6. **Point the backups at the target.** First, in the target's SQL Editor,
   re-run `packages/db/drizzle/0007_backup_reader.sql` (paste the whole
   file; it is idempotent, and the dump does not carry the grants on `auth`
   and `supabase_migrations`), then run the verification selects of
   [`manual/0007-0008-backup-reader.sql`](manual/0007-0008-backup-reader.sql)
   one at a time, and set a new `backup_reader` password (step 4's
   `alter role` line, if not already run; never production's). Then in the
   `backup-gt-sales` environment update `SOURCE_DATABASE_URL` (the target's
   `backup_reader` and its new password), the `SOURCE_STORAGE_*` values and
   `SUPABASE_PROJECT_REF`. Run Backup by hand and check `backup_completed`.
7. **Delete the private-key file** from the machine
   (`rm ~/gt-sales-recovery-key.txt`, or wherever step "What you need" put
   it) and any leftover `"${TMPDIR:-/tmp}"/gt-sales-restore-*` folder. The
   key stays in the password manager and the offline copy only.

## Reopen criteria

Open traffic again only when all of these hold:

- the report has `verified: true`, `restored: true` and
  `rowCountMismatches: []`;
- the step 4 counts match, and `app_runtime` sees no rows without a site;
- staff sign in, see the leads of every site, and one document downloads;
- a new Backup run against the new project completes and the monitor is
  green.

Until then the safe state is the backend stopped. A failed attempt never
touches the source; discard the target and start again.

## If it fails

The report's `failedStage` and `failureReason` name the step. A
`restore_failed` line instead means the setup was wrong before anything ran
(`<NAME> is required`, `RECOVERY_PRIVATE_KEY_PATH is not a readable file`,
`RESTORE_RUN_ID must look like run-<id>`).

| `failedStage`                | What it means                                                                                        | What to do                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest_fetch`             | No manifest under that run id, or the key or bucket is wrong.                                        | Check the run id and the reader key. A folder without `manifest.json.enc` is an unfinished run: pick the one before it.                                                        |
| `manifest_decrypt`           | The private key does not open this archive.                                                          | Use the right key file (the offline copy if in doubt).                                                                                                                         |
| `artifact_fetch_and_decrypt` | A file is missing or does not match its size or SHA-256 (`missingArtifacts`, `mismatchedArtifacts`). | Do not use this run. Try the run before it, and tell the developer.                                                                                                            |
| `target_preflight`           | `restore_target_role_cannot_bypass_rls` or `restore_target_not_empty`.                               | Use the target's `postgres` login; use a fresh, empty target.                                                                                                                  |
| `database_apply`             | `psql` stopped; `failureReason` holds its error lines (never row values).                            | The main load is one transaction, so a failure there leaves the target empty: fix and run again. A failure in the history load leaves the database loaded: discard the target. |
| `objects_apply`              | A document upload failed, or `restore_storage_not_configured`.                                       | The database is already loaded, so the target is no longer empty: discard it (delete the project, or `supabase db reset`) and start again.                                     |
| `row_count_check`            | A table's count differs from the manifest (`rowCountMismatches`).                                    | Do not reopen. Keep the target and the report for the developer.                                                                                                               |

## Drill

Practise on a scratch target, never on production: a second Free project
named `gtsales-crm-restore-drill` with a private `documents` bucket and S3
keys, or `supabase start`. Run steps 1–4 with last night's run, then check
that one document downloads (on a drill project, from its Storage page).

The CI rehearsal (`apps/backend/tests/backup-restore-rehearsal.integration.test.ts`)
restores without `roles.sql` (the test cluster's roles are shared by every
suite) and without `auth` and the migration history (neither exists there),
so the first drill is where these three are first exercised. Check each:

- **`roles.sql`:** `select rolname from pg_roles where rolname in ('app_runtime', 'backup_reader');`
  returns both, and the step 4 `app_runtime` check passes.
- **The `auth` tables:** the step 4 counts of `auth.users` and
  `auth.identities` equal the manifest's, and one staff member signs in to an
  admin pointed at the drill project (or the account shows under
  Authentication → Users).
- **The history:** `select name from supabase_migrations.schema_migrations order by version;`
  lists the same migrations as the same query on production (the manifest
  counts only `data.sql`'s tables, not the history).

Record the run id, the durations, the counts and anything that surprised
under a `## Drill <date>` heading here. Then **delete the drill project**: it
holds real customer data. Delete the key file too.

**Every quarter, a verify-only drill:** step 1 alone (no target) with last
night's run, then delete the key file. It proves the private key still opens
the archive and every file matches its checksum. Record the date and run id
under a `## Verify <date>` heading here.

## What a restore never brings back

- Supabase project settings: Auth URL configuration, SMTP, providers, leaked
  password protection, API and JWT keys, Storage S3 keys.
- Database and role passwords (`app_runtime`, `backup_reader`).
- The `storage.objects` rows as they were: they are recreated by the upload.
- The `mobility-ids` and `blog-images` buckets (not backed up; see
  [backup.md](backup.md), "Known gaps").
- Staff accounts, when the run recorded `auth_data_skipped_by_operator`.
- Railway, Vercel and GitHub settings, the B2 keys and the recovery key.

Recreate these from [HANDOFF.md](../HANDOFF.md) §1, [ENV.md](../ENV.md) and
the password manager.
