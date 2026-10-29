# jobs

Backend-invoked outbox orchestration and provider handlers. The runner receives a
tenant-scoped store from `apps/backend`; it never imports the database or discovers
tenants itself. The backend scheduler registry supplies the explicit workspace set.

Each handler runs under a per-handler abort timeout (the signal is passed as the
handler's optional second argument) and the whole run stops claiming new jobs
after a run deadline. A timeout is recorded `uncertain` with `handler_timeout`.
`createFailingJobHandlerRegistry(code)` builds a registry whose handlers fail
permanently with one code, used when no provider adapter is configured.

Jobs are claimed one at a time immediately before execution, up to `batchSize`
per authorized workspace. Pending jobs do not spend their lease waiting behind
earlier handlers, and the run deadline is checked before each claim. Provider
timeouts remain uncertain and require reconciliation; this is not an exactly-once
delivery guarantee across process crashes.

Ordinary handlers receive database operations from backend-owned orchestration;
`jobs/**` has no blanket database-import exemption. Any future offline migration,
restore or database-test entry point that imports `@gt-sales/db` must have its exact
file path added to `offlineDbFiles` in `packages/config/boundaries.js`, with its
responsibility and exception documented in the same task.

## Backup CLIs

Four command-line entry points keep the encrypted backups
([docs/RUNBOOKS/backup.md](../docs/RUNBOOKS/backup.md)). None of them imports
database code: they reach Postgres only through `pg_dump`, `pg_dumpall` and `psql`
child processes, with the connection passed as `PG*` environment variables, so
they need no `offlineDbFiles` exemption. Every variable each one reads, and where
it is set, is in [docs/ENV.md](../docs/ENV.md) "Backups". Each logs one JSON line
per outcome with ids and counts only, and exits non-zero on any failure.

### Backup (`src/backup/cli.ts`)

`pnpm --filter @gt-sales/jobs run backup`, nightly from `.github/workflows/backup.yml`.
Dumps the database as `backup_reader`, copies every referenced document from
Supabase Storage, encrypts everything with `age` to the recovery recipient,
uploads it with the B2 writer key and publishes the heartbeat last. Needs `age` and
the PostgreSQL 17 client tools on `PATH`. ENV.md "Backup run".

### Monitor (`src/monitor/cli.ts`)

`pnpm --filter @gt-sales/jobs run monitor`, hourly from
`.github/workflows/backup-monitor.yml`. Reads the heartbeat with the B2 reader key
and alerts the owner when it is older than 26 hours, missing, malformed or another
deployment's ([docs/RUNBOOKS/backup-alert-response.md](../docs/RUNBOOKS/backup-alert-response.md)).
ENV.md "Backup monitor".

### Retention (`src/retention/cli.ts`)

`pnpm --filter @gt-sales/jobs run retention`, weekly from
`.github/workflows/backup-retention.yml`. Keeps 30 daily and 12 monthly restore
points and deletes the rest with the B2 retention key, from the archive listing
alone; a dry run unless `RETENTION_DRY_RUN=false`, which the workflow sets for
its scheduled runs. ENV.md "Backup retention".

### Restore (`src/restore/cli.ts`)

`pnpm --filter @gt-sales/jobs run restore`, on the owner's computer only, never in
GitHub. Verifies a run with the B2 reader key and the recovery private key, and
with a target loads it into an empty project
([docs/RUNBOOKS/restore.md](../docs/RUNBOOKS/restore.md)). Needs `age` and the
PostgreSQL 17 `psql` on `PATH`. ENV.md "Restore".
