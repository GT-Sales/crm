# Backup alert response

What to do when the backup monitor alerts: an email "backup_stale" to the
owner, a failed "Backup monitor" run in GitHub Actions, or both. Setup is in
[backup.md](backup.md); if a real restore turns out to be needed, that is
[restore.md](restore.md).

## What raises it

`.github/workflows/backup-monitor.yml` runs `jobs/src/monitor/cli.ts` every
hour at :08 UTC for each deployment. It reads `heartbeat/latest.json` from
the deployment's B2 archive with the reader key (list and read only). The
nightly Backup writes that file as its very last step, after every file and
the manifest are uploaded and listed back, so a run that stops part-way leaves
the previous heartbeat in place and the alert comes from its age.

The alert's detail says which case it is:

| Detail                    | Meaning                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale:age_seconds:<n>`   | The last complete backup is older than 26 hours (`BACKUP_MONITOR_MAX_AGE_SECONDS`): at least one nightly run failed or did not run.                                           |
| `missing`                 | No heartbeat at all: no backup has ever completed in this bucket, or the monitor reads the wrong bucket.                                                                      |
| `malformed`               | The heartbeat exists but is not the expected JSON. The backup only ever writes it through a schema check, so treat this as tampering or a wrong bucket until shown otherwise. |
| `wrong_deployment:<name>` | The heartbeat belongs to another deployment: the monitor's environment points at another deployment's bucket.                                                                 |
| `monitor_failed`          | The check itself failed (a missing secret, B2 refused the key, a network error); the run log has `monitor_failed` with the reason.                                            |

The alert on its own is not an incident: no data is lost, the newest restore
point is just older than it should be. Do not stop the backend or start a
restore because of it.

## Response

1. **Open the failed Backup monitor run** (GitHub → Actions → Backup monitor)
   and read the step "Check the latest backup's heartbeat". The
   `monitor_status` or `monitor_failed` line gives the case and the reason.
2. **Open the recent Backup runs** (Actions → Backup). If they are failing,
   the `backup_failed` line in "Run the backup" names the problem:

   | `message`                                                                       | Likely cause and fix                                                                                                                                                                                                                                                                                                                                                 |
   | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `<NAME> is required`                                                            | A secret is missing in the `backup-gt-sales` environment ([backup.md](backup.md) step 6).                                                                                                                                                                                                                                                                            |
   | `backup_source_unreadable:<n>_tables`                                           | `backup_reader` cannot fully read the tables or sequences listed in `tables` in the same line: usually a new `public` table without the grant or read policy, a schema it has no `USAGE` on, a restrictive policy that applies to everyone, or an `auth` table. Grant it by hand (below), or set `BACKUP_AUTH_DATA=skip` for `auth` ([backup.md](backup.md) step 5). |
   | `backup_incomplete:<n>_objects`                                                 | A document a file row points at is missing or changed in storage (`missingOrMismatchedObjects` in the same line). Usually an object deleted before its row ([backup.md](backup.md) step 8): fix the rows.                                                                                                                                                            |
   | `backup_upload_incomplete:<n>_keys`                                             | After the upload, B2's listing did not show the keys in `missingKeys`. Run Backup again; if it repeats, check the writer key still has `listFiles` and `writeFiles` on this bucket ([backup.md](backup.md) step 3).                                                                                                                                                  |
   | `age_failed:<code>:…`                                                           | `age` could not encrypt: the `RECOVERY_AGE_RECIPIENT` secret is not a valid `age1…` recipient (a private key pasted by mistake must be treated as leaked: make a new key pair, [backup.md](backup.md) step 4).                                                                                                                                                       |
   | `storage_source_bucket_mismatch:<bucket>`                                       | A file row names a bucket other than `SOURCE_STORAGE_BUCKET`: the secret is wrong (it is `documents`), or a row points at another bucket. Tell the developer before changing any row.                                                                                                                                                                                |
   | `malformed_referenced_object_row:<ws>/<key>`                                    | A file row (or kept revision) has an object key but no valid SHA-256 or size, so its copy could not be verified. Tell the developer: the row needs fixing, never skipping.                                                                                                                                                                                           |
   | `errorCode` `TimeoutError` (message "The operation was aborted due to timeout") | A Storage read (10 minutes) or an archive upload (15 minutes) did not finish: Supabase Storage or B2 is slow or down. Run Backup again later; if it repeats, tell the developer.                                                                                                                                                                                     |
   | `backup_snapshot_too_large_for_runner:…`                                        | The database and documents no longer fit the 2 GiB in-memory limit. Tell the developer; raising `BACKUP_MAX_SNAPSHOT_BYTES` is only safe up to what the runner holds.                                                                                                                                                                                                |
   | `pg_dump_failed:…`, `pg_dumpall_failed:…` or `psql_failed:…`                    | The dump could not connect or read: a paused Supabase project (restore it in the dashboard), a changed `backup_reader` password, or the pooler host.                                                                                                                                                                                                                 |
   | `storage_source_get_failed:<status>`                                            | Supabase Storage refused the backup's S3 key (revoked or wrong): create a new one ([backup.md](backup.md) step 5) and update the secrets.                                                                                                                                                                                                                            |
   | `archive_put_failed:<status>` or `archive_list_failed:<status>`                 | B2 refused the writer key (expired, deleted or wrong capabilities) or the bucket name is wrong. Recreate the key ([backup.md](backup.md) step 3) and update the secrets.                                                                                                                                                                                             |
   | `backup_run_id_already_exists`                                                  | A `BACKUP_RUN_ID` was set; remove it.                                                                                                                                                                                                                                                                                                                                |

   **Granting a new table by hand** (a `public` table another tool created;
   `app` tables get theirs from `packages/db/src/schema.ts` in a migration,
   never by hand). In Supabase → SQL Editor, as `postgres`, for each name in
   `tables`:

   ```sql
   GRANT SELECT ON <schema>.<table> TO backup_reader;
   -- for each sequence the table owns, or a sequence named in `tables`:
   GRANT SELECT ON SEQUENCE <schema>.<sequence> TO backup_reader;
   -- only when the table has row security on:
   CREATE POLICY <table>_backup_reader_read ON <schema>.<table> AS PERMISSIVE FOR SELECT TO backup_reader USING (true);
   ```

   A schema without `USAGE` needs `GRANT USAGE ON SCHEMA <schema> TO backup_reader;`.
   A restrictive `SELECT` (or `ALL`) policy without a `TO` clause applies to
   `backup_reader` too and hides rows from it: tell the developer, who narrows
   it to the roles it is meant for. Then re-run select 3 of
   [`manual/0007-0008-backup-reader.sql`](manual/0007-0008-backup-reader.sql):
   it returns no rows.

   After fixing, run Backup again by hand (Actions → Backup → Run workflow).
   Prefer this to running the CLI locally: the workflow uses the same
   environment and secrets as the nightly run.

3. **If Backup is green but the monitor still alerts**, the two environments
   do not point at the same place. Compare `B2_ARCHIVE_ENDPOINT`,
   `B2_ARCHIVE_REGION` and `B2_ARCHIVE_BUCKET` in `backup-gt-sales` and
   `backup-monitor-gt-sales`. For `wrong_deployment`, the monitor's bucket is
   another deployment's: each deployment has its own bucket.
4. **If Backup did not run at all**, check that the workflow is enabled
   (GitHub disables scheduled workflows after 60 days without a commit in a
   public repository) and that GitHub Actions had no outage.
5. **Confirm:** run Backup monitor by hand (Actions → Backup monitor → Run
   workflow). Its log shows `"status":"ok"` and no email follows.

## Read-only check that all is well

1. Actions → Backup: the newest scheduled run is green and less than 26 hours
   old.
2. Actions → Backup monitor: the newest hourly run is green. A green monitor
   run is itself the proof that a complete backup is under 26 hours old.

## When to escalate

Tell the developer at once if the detail is `malformed` or
`wrong_deployment` (a wrong configuration or tampering, not a missed night),
if Backup has failed two nights running, or if the fix needs more than
updating a secret.
