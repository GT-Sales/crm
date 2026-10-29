# Database runbook

Project: Supabase `gtsales-crm` (`xykrphbgpwisqacpyeiv`, Mumbai). The CRM
owns the `app` schema. Get Canada Sim's live tables stay in `public` until
the cutover (merge design §12); nothing here touches them.

## How migrations are tracked

Two trackers must agree:

1. **Drizzle** — `drizzle.__drizzle_migrations` (`hash`, `created_at`). The
   migrator (`pnpm --filter @gt-sales/db db:migrate`) applies every entry of
   `packages/db/drizzle/meta/_journal.json` whose `when` is newer than the
   last row, then records `sha256(file)` + `when`.
2. **Supabase** — `supabase_migrations.schema_migrations`, written only when a
   migration is applied through the Supabase MCP `apply_migration` or the CLI.

The normal path is the Drizzle migrator with `MIGRATION_DATABASE_URL`. When a
migration is instead applied through `apply_migration` (no database password at
hand), add the Drizzle row by hand in the same sitting:

```sql
insert into drizzle.__drizzle_migrations (hash, created_at)
values ('<sha256 of the .sql file>', <journal "when">);
```

Verify against the schema, not the trackers: `select … from pg_tables /
pg_proc / pg_policies where schemaname = 'app'`.

## First install (2026-10-25)

- `0000_app_foundation` applied via `apply_migration` and recorded in both
  trackers.
- `0001_runtime_functions`: the Supabase tool applied the grants, the
  DELETE-free functions and the four triggers, but holds every statement that
  contains REVOKE, ALTER or DELETE for a confirmation prompt the owner never
  received. The remainder (revokes, FORCE RLS, `accept_staff_invitations`,
  `rate_limit_hit`, `prune_operational_rows`, both tracker rows) is in
  [`manual/0001-remaining.sql`](manual/0001-remaining.sql): paste it into the
  SQL editor once. Staff sign-in and website writes need it.
- `app_runtime` role created by `0000`; its password was set the same day and
  lives only in the Railway service's `DATABASE_URL`. The project's pooler is
  the `aws-1-ap-south-1` cluster.
- Sites `getcanadasim` and `canadawide` inserted with the fixed ids from
  `packages/db/src/seed.ts`, each with the seven roles and six permissions, and
  a pending `owner` invitation for the developer's email in both.

## 0002_canadawide_legacy_mirror (2026-10-26)

- Applied with `apply_migration` (Supabase tracker row written by the tool) and
  the Drizzle row added by hand: hash
  `1f725d6481de5750f030e7a03eb11f8e7cc2f8f9c003889b37732e70823a31bc`,
  `created_at` `1793042297882`.
- Verified against the catalog: trigger `leads_mirror_canadawide_legacy` on
  `app.leads`; function `app.mirror_canadawide_legacy_lead()` SECURITY DEFINER,
  owner `postgres` (which has BYPASSRLS, so it can read the site and write the
  legacy tables), `search_path` empty.
- Temporary: drop the trigger and the function in a new migration once phase 2
  retires the old Internet/Mobility Leads pages (docs/HANDOFF.md §2.4).

## 0003_lead_stages_and_staff_names (2026-10-26)

- Additive only, so it went in before the code that reads it: `leads.stage`
  (`text not null default 'new'`, slug check), `memberships.display_name`
  (1–80 characters, trimmed), the board index
  `(workspace_id, lead_type, stage, updated_at)`, the "my tasks" index on
  `lead_tasks`, and covering indexes for the five foreign keys the performance
  advisor flagged (`email_messages`, `follow_up_schedules`,
  `marketing_consents` and `outbox_job_alerts` on their workspace + parent,
  `leads.contact_id`).
- Applied with `apply_migration`; Drizzle row added by hand: hash
  `510072fd8b2d52bb2bc4f39922bf7e5cc89214955184230ddb71a0b179b0e5f1`,
  `created_at` `1793049061874`. Verified against the catalog: both columns,
  all seven indexes, both checks.

## 0004_staff_access_snapshot (2026-10-27)

- Additive: `app.staff_access_snapshot(workspace, actor)`, SECURITY DEFINER
  with an empty `search_path`, EXECUTE for `app_runtime` only. It returns the
  actor's staff membership in one site with role names and permission
  overrides, so every staff request's authorization read is one autocommit
  call instead of a tenant transaction (four round trips to the pooler).
- Applied with `apply_migration` before the code that calls it; Drizzle row
  added by hand: hash
  `83c04de60ce6af095009cfc105c38ef3f5ca04632e84fcb01e9f3fbf462db914`,
  `created_at` `1793071632834`. Verified against the catalog: definer, owner
  `postgres`, `search_path=""`, PUBLIC cannot execute, `app_runtime` can; the
  owner's CanadaWide snapshot returns one row with `owner`.

## 0005_lead_identities (2026-10-27)

- `app.lead_identities`: the identity a customer gives for a credit check
  (CanadaWide's mobility order, step 2), a licence photo as a `files` row or a
  SIN sealed with AES-256-GCM under `SENSITIVE_FIELDS_KEY` (only its last
  three digits readable). Tenant policy, FORCE RLS, `app_runtime` SELECT and
  INSERT only (append-only), a guard against attaching one to a restricted
  lead. `files` now also accepts `image/webp`, which CanadaWide's form allows.
- Transitional `app.mirror_canadawide_legacy_identity(...)`, SECURITY DEFINER,
  EXECUTE for `app_runtime` only: writes the same identity into
  `public.mobility_id_uploads` (SIN in plain text, as the old admin always
  had) for a CanadaWide mobility lead of the caller's own site. Drop it with
  the 0002 trigger at the staff cutover.
- Applied with `apply_migration`; Drizzle row added by hand: hash
  `1f5d8279451e43700e472cb9166c3797c568066a60f965660aa27db803c5caa7`,
  `created_at` `1793080995362`. Verified against the catalog: RLS forced, one
  policy, no UPDATE or DELETE for the runtime role, the guard trigger, the
  mirror definer and its grants, the widened `files` type check.

## 0006_legacy_identity_mirror_result (2026-10-27)

- Replaces 0005's mirror, which raised for any lead that is not a CanadaWide
  mobility lead: `app.mirror_canadawide_legacy_identity(...)` now returns
  whether it wrote (false: nothing to do, nothing written; also false for a
  licence without its copied photo path), and the new read-only
  `app.canadawide_legacy_identity_applies(lead)` answers the same question
  first, so the backend knows whether to copy a licence photo into
  `mobility-ids`. Both SECURITY DEFINER, empty `search_path`, EXECUTE for
  `app_runtime` only, and both read the site from the tenant transaction.
- Applied 2026-10-27 by the owner from the SQL editor with
  [`manual/0006-legacy-identity-mirror.sql`](manual/0006-legacy-identity-mirror.sql)
  (the Supabase tool's confirm prompt for the `DROP FUNCTION` had timed out
  twice), which recorded both tracker rows: Drizzle hash
  `063cfe0eff5e3a986f093c1cca8b1c1c3255e5e90763beb1b206ddae3d1877ac`,
  `created_at` `1793082645098`. Verified against the catalog: both functions
  return `boolean`, SECURITY DEFINER, `search_path=""`, `app_runtime` can
  execute and `anon` cannot.

## 0007_backup_reader + 0008_backup_reader_policies

- The backup job's read-only login `backup_reader` (merge design spec §10,
  [backup.md](backup.md)):
  `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
  no password. It dumps with `pg_dump --enable-row-security`, so instead of
  `BYPASSRLS` or `pg_read_all_data` (both need a superuser, which Supabase's
  `postgres` is not) it has `USAGE` on `app`, `public` and `drizzle`,
  `SELECT` on every table and sequence there, default privileges so later
  `app` and `public` tables and sequences are readable too (`public` because
  Get Canada Sim's legacy tables live there, all owned by the migration
  role), and a
  `PERMISSIVE FOR SELECT TO backup_reader USING (true)` policy named
  `<table>_backup_reader_read` on every RLS table. No INSERT, UPDATE or
  DELETE anywhere.
- Where each policy comes from: the 25 `app` RLS tables (all but
  `app.workspaces`, which has no RLS) declare `backupReadPolicy(...)` in
  `packages/db/src/schema.ts`, generated into 0008, so every future table
  carries one too. The `public` RLS tables the migration role owns get theirs
  from 0007's loop; a `public` table added later needs one by hand.
- Best effort on Supabase's own schemas, where they exist: `USAGE` + `SELECT`
  on `supabase_migrations`, and `USAGE` on `auth` with `SELECT` on exactly
  `auth.users` and `auth.identities`, never the whole schema: the token,
  session and MFA tables must never be readable by the backup role, and a
  restore brings back accounts, never sessions. Neither case fails 0007: where the
  migration role holds a privilege without grant option, PostgreSQL grants
  nothing for it and prints its own "no privileges were granted" WARNING;
  where it holds none at all, 0007's handler turns the error into a WARNING
  (`auth schema not granted to backup_reader`). Either way the backup cannot
  read what was not granted (docs/RUNBOOKS/backup.md step 5).
- Not yet applied in production. Apply with
  [`manual/0007-0008-backup-reader.sql`](manual/0007-0008-backup-reader.sql)
  from the SQL editor, after the pre-paste check in
  [backup.md](backup.md) step 5: one transaction with both migrations and
  all four tracker rows. Drizzle hashes:
  0007 `4518ddd1a136f26ccdd848a39799de7a888b70121a4d4ce390b5a88b7d9d3587`,
  `created_at` `1793273916007`; 0008
  `6d87bd3afd04885626c3d7d1b656de93a4267bf59ffe98a00de01ee947effcfd`,
  `created_at` `1793273993722`. Then set the password separately
  (`alter role backup_reader password '<openssl rand -hex 16>'`), stored only
  in the backup job's secrets.
- Verify with the five selects at the end of the manual file, one at a time
  (the SQL editor shows only the last result): the role's attributes
  (`rolcanlogin` true, `rolsuper`, `rolbypassrls`, `rolcreaterole` false);
  25 `_backup_reader_read` policies in `app`; no `public` table the backup's
  guard would stop on (no `SELECT`, or row security without a PERMISSIVE
  SELECT/ALL `USING (true)` policy naming `backup_reader`, or with a
  RESTRICTIVE SELECT/ALL policy for it or `public`); `USAGE` on `auth` and
  `SELECT` on `auth.users` and `auth.identities` with no other `auth` table
  readable (a false means the `auth` grant warned); and neither of those two
  tables with row security on. A false or a row in the last two means
  `backup_reader` would miss staff accounts (under `--enable-row-security` an
  RLS table it has no policy on reads as empty, and `postgres` cannot add a
  policy to a table it does not own): set `BACKUP_AUTH_DATA=skip` for the
  backup job until that is fixed.
- Locally and in CI neither `auth` nor `supabase_migrations` exists, so those
  grants are skipped; `packages/db/tests/backup-reader.integration.test.ts`
  checks the role, the policies, the privileges, the `public` default
  privileges, a re-run of 0007 against a stand-in `auth` schema (idempotent,
  only `users` and `identities` readable) and a real connection as
  `backup_reader` (password from `setTestBackupReaderPassword`).

## Historical CanadaWide import (2026-10-27)

Not a migration: a re-runnable data script, `packages/db/sql/canadawide-legacy-import.sql`,
run as `postgres`. Procedure, mapping and the run log: [legacy-import.md](legacy-import.md).

## Set or rotate the runtime password

```sql
alter role app_runtime password '<generate with: openssl rand -base64 36>';
```

Then update `DATABASE_URL` on the Railway service and redeploy. Rotation
signs nothing out (staff sessions are Supabase Auth); in-flight requests on the
old pool fail once and retry.

## Add a site

```sql
insert into app.workspaces (slug, name, domain) values ('<slug>', '<Name>', '<host>');
insert into app.roles (workspace_id, name)
  select id, r from app.workspaces, unnest(enum_range(null::app.role_name)) as r where slug = '<slug>';
insert into app.permissions (workspace_id, name)
  select id, p from app.workspaces, unnest(enum_range(null::app.permission_name)) as p where slug = '<slug>';
```

Then invite the first owner from the admin (or insert a pending membership
with the `owner` role) and create the site's key under Settings so the
website can send leads.

## Local database

```sh
createdb crm_test
MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/crm_test MIGRATION_DATABASE_SSL_MODE=disable \
  pnpm --filter @gt-sales/db db:migrate
DB_SEED_ALLOW_SYNTHETIC=1 MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/crm_test MIGRATION_DATABASE_SSL_MODE=disable \
  pnpm --filter @gt-sales/db db:seed
```

Integration suites need `TEST_MIGRATION_DATABASE_URL` (same URL) and
`DB_TEST_ALLOW_DESTRUCTIVE=1`; they set `app_runtime`'s password to a fixed
CI value on that database, which is why the name must end in `_test`.
