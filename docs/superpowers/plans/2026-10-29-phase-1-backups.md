# Phase 1: Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly, encrypted, independently stored backup of each deployment's database and documents, a monitor that alerts when it goes stale, retention that prunes safely, and a restore tool that has been practised against a scratch target.

**Architecture:** `jobs/` gains four CLIs (`backup`, `monitor`, `retention`, `restore`) ported from Canadian Plans' `jobs/src/{backup,restore,monitor,retention}` and adapted to this product: no Sanity, no backup lease (nothing here physically deletes a referenced document), no deletion ledger, a `backup_reader` role that reads through explicit grants and a per-table `backup_reader_read` policy instead of `BYPASSRLS`, row counts taken from the dump itself, and one GitHub Actions workflow set that runs per deployment through a matrix. Every credential is a GitHub Environment secret; the archive writer can list and write but never read or delete; the recovery private key never enters GitHub.

**Tech Stack:** TypeScript (strict), Node 22.19, pnpm 9.15, Vitest 5, Zod 4, PostgreSQL 17 client tools (`pg_dump`, `pg_dumpall`, `psql`), `age` 1.x, Backblaze B2 over the S3 API (the repo's own SigV4 signer in `@gt-sales/adapters`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §10 (backups), §12 phase 1, §13 (testing), §15 (Supabase Free plan). Source material: `Canadian-Plans/canadianplans-web-app` at `jobs/src/**`, `.github/workflows/backup*.yml`, `docs/RUNBOOKS/{restore,backup-alert-response}.md`, migrations `0019`, `0024`, `0025` (read for reference; the lease parts are deliberately not ported).

## Global Constraints

- Strict TypeScript, no `any`, no unchecked `as` (AGENTS.md rule 10). ESLint, Prettier and `pnpm run typecheck` must pass before every commit.
- Only `apps/backend` and `packages/db` import database code (AGENTS.md rule 1). The jobs CLIs reach Postgres only through `psql`/`pg_dump` child processes; any test that needs `@gt-sales/db` lives in `apps/backend/tests/` or `packages/db/tests/`.
- Migrations are additive, generated with `drizzle-kit generate` (`--custom` for hand-written SQL), applied to the hosted project by the owner, recorded in both trackers (`docs/RUNBOOKS/database.md`). Never edit an applied migration.
- No secrets in the repo, in logs, in commit messages or in error text. `stderrExcerpt` redaction stays on every tool error path.
- Integration tests run only against a database whose name ends in `_test` (`assertDisposableDatabaseUrl`). CI env: `TEST_MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/gt_sales_crm_test`, `DB_TEST_ALLOW_DESTRUCTIVE=1`.
- The archive writer credential has `listFiles` + `writeFiles` only; the monitor's has `listFiles` + `readFiles`; retention's adds `deleteFiles`. No GitHub Environment holds both a delete-capable archive credential and the recovery private key.
- Retention default: 30 daily + 12 monthly restore points; grace 24 h. Monitor default threshold: 26 h. Backup schedule 06:17 UTC daily. In-memory snapshot guard 2 GiB.
- Workflow actions pinned by SHA (copy the SHAs already used in `.github/workflows/ci.yml`).
- Package scope stays `@gt-sales/*`; product rename happens with the repo move (spec decision 27).
- Commit trailer required by the session: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01S7vCkKVt1JewpyMJKT2gwB`.

## Review Focus

1. **A new tenant table without a `backup_reader_read` policy** silently dumps zero rows under `--enable-row-security`. Expected: the backup fails with `backup_source_unreadable:<schema.table>` before writing anything. Test in Task 9 (`PsqlSourceCompletenessGuard`) and Task 6 (catalog test over every RLS table in `app`).
2. **A lead arrives while the dump runs.** Expected: the manifest's row counts match the dump, not the live table, so the restore check still passes. Test in Task 10 (`countCopyRows` on a fixture with two tables) and Task 15 (rehearsal with a row inserted after the dump).
3. **A document referenced by `app.files` is missing from storage** (someone deleted it by hand). Expected: the run fails with `backup_incomplete:1_objects` naming `documents/<key>`, publishes no heartbeat, and the alert fires within 26 h. Test in Task 10.
4. **The restore target role cannot bypass RLS** (a plain Postgres user) so `COPY` into `FORCE ROW LEVEL SECURITY` tables fails half-way. Expected: the restore stops before applying anything with `restore_target_role_cannot_bypass_rls`. Test in Task 14 (`PsqlTargetPreflight`).
5. **Auth data is not readable by `backup_reader` on Supabase** (the `auth` schema belongs to `supabase_auth_admin`). Expected: the run fails loudly unless the operator set `BACKUP_AUTH_DATA=skip`, in which case the manifest records `auth_data_skipped_by_operator` and the restore runbook says to re-invite staff. Test in Task 8 (exporter argument matrix) and Task 10 (manifest exclusions).

---

### Task 0: Record the approved design in PLAN.md and HANDOFF.md

**Files:**

- Modify: `docs/PLAN.md:22` (decision 8), `docs/PLAN.md:325-347` (§7 phases and status)
- Modify: `docs/HANDOFF.md:499-560` (§5 "What comes next")

- [ ] **Step 1: Replace PLAN.md decision 8**

Row 8 becomes: `**One product, built from this repository, deployed per business.** Canadian Plans' features move in where they earn their place; an order is a lead carrying order tools; stages, payment status and carrier commission are separate properties.` with the Notes cell `Decided 2026-10-28; every decision and the phases are in docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md §2 and §12.`

- [ ] **Step 2: Replace PLAN.md §7**

Keep the phase 0–2 rows as history (they happened). Replace rows "3. Move the rest" and "4. Clean-up" with one row: `**3+. Merge phases** | The eight phases of the merge design (spec §12): backups, property engine and layout, plans and stage clean-up, order tools and customer email, customer tracking, reports and checks, Canadian Plans' move, automations. | Each phase's own plan in docs/superpowers/plans/.` Replace the "Status 2026-10-27" paragraph with a "Status 2026-10-29" paragraph: phase 2 core live as before; the merge design approved on 2026-10-28; phase 1 of the merge (backups) is the next engineering work; the CRM's own open items (cross-site inbox, contact page, split/merge, cutover clean-up) are scheduled inside merge phases 2–3. Delete the "Total: about 7.5–8.5 weeks" paragraph (it no longer describes the work).

- [ ] **Step 3: Add to HANDOFF.md §5**

Insert a new `### 5.0 The merge with Canadian Plans (approved 2026-10-28)` before §5.1: three sentences naming the spec, that backups are phase 1 and this plan is its implementation plan, and that until phase 7 the Canadian Plans repository takes bug fixes only.

- [ ] **Step 4: Format and commit**

Run: `pnpm exec prettier --write docs/PLAN.md docs/HANDOFF.md && pnpm run format`
Expected: `All matched files use Prettier code style!`

```bash
git add docs/PLAN.md docs/HANDOFF.md
git commit -m "Docs: record the approved merge design in PLAN and HANDOFF"
```

---

### Task 1: Spike: facts about the production database the design depends on

Read-only. Nothing is created. The answers decide two defaults in later tasks and go into the runbook.

**Files:**

- Create: `docs/RUNBOOKS/backup.md` (only the "Facts checked on 2026-10-29" section for now; the rest comes in Task 17)

- [ ] **Step 1: Run these read-only queries on project `xykrphbgpwisqacpyeiv`** (Supabase MCP `execute_sql`, or the owner in the SQL editor)

```sql
select version();
select rolname, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname in ('postgres', current_user);
select current_user;
select has_schema_privilege('postgres', 'auth', 'USAGE') as auth_usage,
       has_table_privilege('postgres', 'auth.users', 'SELECT') as auth_users_select;
select grantee, privilege_type, is_grantable from information_schema.role_table_grants
 where table_schema = 'auth' and table_name = 'users' and grantee = 'postgres';
select schemaname, tablename, tableowner, rowsecurity from pg_tables
 where schemaname in ('app', 'public') order by 1, 2;
select to_regnamespace('supabase_migrations') is not null as has_history,
       has_schema_privilege('postgres', 'supabase_migrations', 'USAGE') as history_usage;
select count(*) as files, sum(size_bytes) as bytes from app.files where object_key is not null;
select pg_database_size(current_database()) as db_bytes;
select name, public from storage.buckets;
```

- [ ] **Step 2: Record the answers in `docs/RUNBOOKS/backup.md`** under `## Facts checked on 2026-10-29`: Postgres major version (decides the client version the workflows install, Task 16), whether `postgres` can grant `SELECT` on `auth.users` to another role (`is_grantable`; decides whether `BACKUP_AUTH_DATA` can stay at its default `include`), the `public` tables that have RLS and their owner (the 0007 policy loop covers only tables owned by the migration role), the session pooler host (`aws-1-ap-south-1.pooler.supabase.com:5432`, docs/HANDOFF.md §1), database and documents sizes against the 2 GiB guard.

- [ ] **Step 3: Commit**

```bash
git add docs/RUNBOOKS/backup.md
git commit -m "Docs: facts about the production database that the backup design depends on"
```

---

### Task 2: Jobs package scaffolding, process seam and env helpers

**Files:**

- Modify: `jobs/package.json`
- Create: `jobs/src/archive/command.ts`, `jobs/src/archive/env.ts`
- Test: `jobs/tests/command.test.ts`, `jobs/tests/env.test.ts`

**Interfaces:**

- Produces: `type RunCommand = (command: string, args: readonly string[], options?: RunCommandInput) => Promise<RunCommandResult>`; `nodeRunCommand: RunCommand`; `runOrThrow(run, command, args, options?): Promise<Uint8Array>`; `class CommandFailedError extends Error { command; exitCode }`; `stderrExcerpt(stderr: string, max = 400): string`; `requiredEnv(name: string, env = process.env): string`; `optionalEnv(name, env?): string | undefined`; `optionalPositiveInteger(name, env?): number | undefined`; `envFlag(name, env?): boolean` (true only for `1`, `true`, `yes`, case-insensitive).

- [ ] **Step 1: Add exports and scripts to `jobs/package.json`**

`exports`: add `"./archive": "./src/archive/index.ts"`, `"./backup": "./src/backup/index.ts"`, `"./restore": "./src/restore/index.ts"`, `"./retention": "./src/retention/index.ts"`, `"./monitor": "./src/monitor/index.ts"`. `scripts`: add `"backup": "tsx src/backup/cli.ts"`, `"monitor": "tsx src/monitor/cli.ts"`, `"retention": "tsx src/retention/cli.ts"`, `"restore": "tsx src/restore/cli.ts"`. Move `tsx` from `devDependencies` to `dependencies` (the workflows run it from a fresh install; keep the `catalog:` pin).

- [ ] **Step 2: Write the failing tests**

`jobs/tests/command.test.ts`:

```ts
it('stderrExcerpt drops image-pull progress, redacts URL passwords and keeps the end', () => {
  const stderr = `Digest: sha256:abc\npsql: error: connection to server at "h" failed: FATAL: password authentication failed for user "backup_reader.ref"\nconnection string postgresql://backup_reader.ref:s3cret@h:5432/postgres password=s3cret`;
  const excerpt = stderrExcerpt(stderr, 400);
  expect(excerpt).not.toContain('s3cret');
  expect(excerpt).not.toContain('Digest:');
  expect(excerpt).toContain('password authentication failed');
});
it('stderrExcerpt keeps the last `max` characters, prefixed with an ellipsis', () => {
  expect(stderrExcerpt('a'.repeat(500), 100)).toBe(`…${'a'.repeat(100)}`);
});
it('runOrThrow returns stdout on exit 0 and throws CommandFailedError otherwise', async () => { … });
it('nodeRunCommand runs a real process and captures stdout, stderr and exit code', async () => {
  const result = await nodeRunCommand(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
  expect([new TextDecoder().decode(result.stdout), result.stderr, result.exitCode]).toEqual(['out', 'err', 3]);
});
```

`jobs/tests/env.test.ts`: `requiredEnv` throws `NAME is required` on missing or blank; `optionalPositiveInteger` returns `undefined` for unset, throws `NAME must be a positive whole number` for `0`, `-1`, `1.5`, `abc`; `envFlag` is true for `1`/`true`/`YES`, false for unset/`0`/`false`/`no`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @gt-sales/jobs test`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `command.ts` and `env.ts`**

Port `command.ts` from Canadian Plans unchanged apart from the module comment (name this repository's runbooks, not IMPLEMENTATION_PLAN). Write `env.ts` with the four functions; the `env` parameter makes them testable without mutating `process.env`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm --filter @gt-sales/jobs test && pnpm --filter @gt-sales/jobs typecheck && pnpm exec eslint jobs`
Expected: PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add jobs/package.json jobs/src/archive jobs/tests pnpm-lock.yaml
git commit -m "Jobs: process seam and environment helpers for the backup CLIs"
```

---

### Task 3: Archive store (B2 over S3) with the writer/reader/retention split

**Files:**

- Create: `jobs/src/archive/archive-store.ts`
- Test: `jobs/tests/archive-store.test.ts`

**Interfaces:**

- Consumes: `signS3Request`, `presignS3Url`, `S3SigningConfig` from `@gt-sales/adapters` (already exported; `S3SigningConfig = { accessKeyId, secretAccessKey, endpoint, region, bucket }`).
- Produces: `interface ArchiveObjectMeta { key; sizeBytes; versionId?; lastModified?: Date }`; `interface ArchiveWriter { putObject(key, body): Promise<{ versionId?: string }>; listObjects(prefix): Promise<ArchiveObjectMeta[]> }`; `interface ArchiveReader { listObjects; getObject(key): Promise<Uint8Array | undefined> }`; `interface ArchiveRetentionAdmin extends ArchiveReader { deleteObject(key): Promise<void> }`; classes `S3ArchiveWriter`, `S3ArchiveReader`, `S3ArchiveRetentionAdmin` (constructor `(config: S3SigningConfig, fetchImpl = fetch, timeoutMs = 30_000)`); `class InMemoryArchiveBackend { constructor(now?: () => Date); asWriter(); asReader(); asRetentionAdmin(); size() }`; `class ArchiveCredentialDeniedError`.

- [ ] **Step 1: Write the failing tests** (port `archive-store.test.ts` from Canadian Plans; keep these assertions at minimum)

```ts
it('the writer facade can put and list but get and delete throw credential_denied', …)
it('the reader facade can list and get but put and delete throw credential_denied', …)
it('the retention admin can list, get and delete but not put', …)
it('S3ArchiveWriter.listObjects follows IsTruncated/NextContinuationToken and rejects a repeated token', …) // fake fetch returning two XML pages, then the same token again
it('S3ArchiveReader.getObject returns undefined on 404 and throws archive_get_failed:<status> otherwise', …)
it('S3ArchiveRetentionAdmin.deleteObject treats 404 as success', …)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @gt-sales/jobs test tests/archive-store`
Expected: FAIL.

- [ ] **Step 3: Port `archive-store.ts`**

Copy from Canadian Plans; change the import to `@gt-sales/adapters`; rewrite the module comment to reference `docs/RUNBOOKS/backup.md` ("the three B2 application keys").

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add jobs/src/archive/archive-store.ts jobs/tests/archive-store.test.ts
git commit -m "Jobs: archive store with the writer, reader and retention credential split"
```

---

### Task 4: Encryption (age in production, a test envelope for CI)

**Files:**

- Create: `jobs/src/archive/encryptor.ts`
- Test: `jobs/tests/encryptor.test.ts`

**Interfaces:**

- Produces: `interface Encryptor { algorithm: string; encrypt(plaintext: Uint8Array): Promise<Uint8Array> }`; `interface Decryptor { algorithm; decrypt(ciphertext): Promise<Uint8Array> }`; `class AgeCliEncryptor(recipient: string, run = nodeRunCommand, binary = 'age')`; `class AgeCliDecryptor(identityFilePath: string, run = nodeRunCommand, binary = 'age')`; `class TestEnvelopeEncryptor(publicKeyBase64)`, `class TestEnvelopeDecryptor(privateKeyBase64)`, `generateTestRecipientKeyPair(): { publicKeyBase64; privateKeyBase64 }`; `class DecryptionFailedError`; `ageAvailable(run = nodeRunCommand): Promise<boolean>` (runs `age --version`, false on spawn error or non-zero exit).

- [ ] **Step 1: Write the failing tests** (port; add the last two)

```ts
it('test envelope round-trips bytes', …)
it('test envelope rejects a flipped ciphertext byte with DecryptionFailedError', …)
it('test envelope rejects the wrong private key', …)
it('AgeCliEncryptor passes -r <recipient> and the plaintext on stdin', …) // recording RunCommand
it('AgeCliEncryptor refuses an empty recipient', …)
it('real age round-trips when the binary is installed', async () => {
  if (!(await ageAvailable())) return; // CI installs age (Task 15); locally this may skip
  // age-keygen -o <tmp>; age-keygen -y <tmp> → recipient; encrypt; decrypt; equal
});
```

The test envelope's magic bytes and HKDF info string become `GTSV1` and `gt-sales-backup-test-envelope-v1` (a different product; never interchangeable with Canadian Plans' envelopes).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @gt-sales/jobs test tests/encryptor`
Expected: FAIL.

- [ ] **Step 3: Port `encryptor.ts`; add `ageAvailable`**

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add jobs/src/archive/encryptor.ts jobs/tests/encryptor.test.ts
git commit -m "Jobs: age encryption for backups, test envelope for CI"
```

---

### Task 5: Manifest and heartbeat

**Files:**

- Create: `jobs/src/archive/manifest.ts`, `jobs/src/archive/heartbeat.ts`, `jobs/src/archive/index.ts`
- Test: `jobs/tests/manifest.test.ts`, `jobs/tests/heartbeat.test.ts`

**Interfaces:**

- Consumes: `sha256Hex` from `@gt-sales/adapters`.
- Produces: `backupManifestSchema` (Zod, `.strict()`): `{ schemaVersion: 1, deployment: string, runId, capturedAt: iso datetime, sourceIds: Record<string,string>, toolVersions: Record<string,string>, artifacts: ManifestArtifact[] (min 1), rowCounts: Record<string, number> (keys `schema.table`), counts: Record<string, number>, exclusions: string[] }`; `manifestArtifact(name, bytes): ManifestArtifact`; `buildManifest(input): BackupManifest`; `verifyManifestArtifacts(manifest, decrypted: ReadonlyMap<string, Uint8Array>): { ok: true } | { ok: false; missing: string[]; mismatched: string[] }`; `heartbeatSchema` `{ schemaVersion: 1, deployment, runId, completedAt, verified: true, manifestKey, artifactCount }`; `HEARTBEAT_KEY = 'heartbeat/latest.json'`; `publishHeartbeat(writer, heartbeat)`; `readLatestHeartbeat(reader): Promise<{ status: 'ok'; heartbeat } | { status: 'missing' } | { status: 'malformed' }>`. `index.ts` re-exports everything in `archive/`.

- [ ] **Step 1: Write the failing tests** (port; add `deployment` and `rowCounts` cases: a manifest without `deployment` fails parsing; `rowCounts` with a negative value fails)

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Port and adapt `manifest.ts`, `heartbeat.ts`; write `index.ts`**

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add jobs/src/archive jobs/tests/manifest.test.ts jobs/tests/heartbeat.test.ts
git commit -m "Jobs: encrypted manifest and heartbeat for backup runs"
```

---

### Task 6: Database: the `backup_reader` role, its grants and read policies

**Files:**

- Create: `packages/db/drizzle/0007_backup_reader.sql` (custom), `packages/db/drizzle/0008_backup_reader_policies.sql` (generated), journal and snapshot entries
- Modify: `packages/db/src/schema.ts` (new `backupReaderRole`, `backupReadPolicy()` helper, one extra policy per `app` table)
- Modify: `packages/db/src/test-helpers.ts` (`TEST_BACKUP_READER_PASSWORD`, `setTestBackupReaderPassword`)
- Create: `docs/RUNBOOKS/manual/0007-0008-backup-reader.sql`
- Modify: `docs/RUNBOOKS/database.md`
- Test: `packages/db/tests/backup-reader.integration.test.ts`

**Interfaces:**

- Produces: role `backup_reader` (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`, no password); `USAGE` on schemas `app`, `public`, `drizzle`; `SELECT` on all tables and sequences there, plus default privileges for future tables in `app`; a `PERMISSIVE FOR SELECT TO backup_reader USING (true)` policy named `<table>_backup_reader_read` on every RLS table in `app` (declared in `schema.ts`) and on every RLS table in `public` owned by the migration role (0007's loop, since those tables are not in `schema.ts`); best-effort `USAGE` + `SELECT` on `supabase_migrations` and `auth` where they exist, warning instead of failing when the migration role may not grant them. `TEST_BACKUP_READER_PASSWORD = 'local_ci_backup_reader_password'`; `setTestBackupReaderPassword(admin)` with advisory lock key `745284916`.

- [ ] **Step 1: Write the failing integration test** `packages/db/tests/backup-reader.integration.test.ts` (same skip/guard pattern as `rls.integration.test.ts`)

```ts
it('creates backup_reader as a login role without superuser or bypassrls', …)
// select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = 'backup_reader' → [true, false, false, false]
it('every RLS table in app has a SELECT policy for backup_reader', …)
// for each pg_tables row (schemaname 'app', rowsecurity) expect a pg_policies row with cmd 'SELECT' and 'backup_reader' = any(roles)
it('backup_reader can SELECT every app table and cannot INSERT, UPDATE or DELETE', …)
// has_table_privilege('backup_reader', 'app.'||t, 'SELECT') true; the three others false, for every app table
it('backup_reader sees every workspace without tenant context', async () => {
  // admin inserts one lead in WORKSPACE_A and one in WORKSPACE_B (ids fixed, cleaned in afterAll)
  // connect as backup_reader (TEST_BACKUP_READER_PASSWORD) → select count(*) from app.leads where id in (...) → 2
});
it('an insert as backup_reader is refused with permission denied', …)
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_MIGRATION_DATABASE_URL=… DB_TEST_ALLOW_DESTRUCTIVE=1 MIGRATION_DATABASE_SSL_MODE=disable pnpm --filter @gt-sales/db test tests/backup-reader`
Expected: FAIL (role missing).

- [ ] **Step 3: Generate the custom migration BEFORE touching schema.ts**

Run: `pnpm --filter @gt-sales/db exec drizzle-kit generate --custom --name backup_reader`
Expected: `packages/db/drizzle/0007_backup_reader.sql` (empty) and a journal entry.

- [ ] **Step 4: Write `0007_backup_reader.sql`**

In order, with `--> statement-breakpoint` between statements: (1) a `DO` block creating the role if `pg_roles` lacks it; (2) `GRANT USAGE ON SCHEMA app, public, drizzle TO backup_reader`; (3) `GRANT SELECT ON ALL TABLES IN SCHEMA app, public, drizzle TO backup_reader`; (4) `GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, public, drizzle TO backup_reader`; (5) `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO backup_reader` and the same `ON SEQUENCES`; (6) a `DO` block looping over `pg_tables where schemaname = 'public' and rowsecurity and tableowner = current_user`, creating `CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR SELECT TO backup_reader USING (true)` named `<table>_backup_reader_read` where no policy of that name exists; (7) a `DO` block: if `to_regnamespace('supabase_migrations')` is not null, grant `USAGE` and `SELECT ON ALL TABLES` there; then in a nested `BEGIN … EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING 'auth schema not granted to backup_reader; see docs/RUNBOOKS/backup.md' END`, if `to_regnamespace('auth')` is not null grant `USAGE` on `auth` and `SELECT ON ALL TABLES IN SCHEMA auth`. A header comment says why (spec §10; `BYPASSRLS` and `pg_read_all_data` need a superuser, which Supabase's `postgres` is not) and that `app` tables get their policies from `schema.ts` in 0008.

- [ ] **Step 5: Declare the policies in `schema.ts`**

Add `const backupReaderRole = pgRole('backup_reader').existing();` beside `appRuntimeRole`, and

```ts
/** The backup job's read-only login reads every row of every tenant table (spec §10). */
function backupReadPolicy(table: string) {
  return pgPolicy(`${table}_backup_reader_read`, {
    for: 'select',
    to: backupReaderRole,
    using: sql`true`,
  });
}
```

Add `backupReadPolicy('<table name>')` to the extras array of every `appSchema.table(...)` that calls `.enableRLS()` (all of them; count them against `select count(*) from pg_tables where schemaname='app' and rowsecurity` on the test database: expected 26).

- [ ] **Step 6: Generate 0008**

Run: `pnpm --filter @gt-sales/db exec drizzle-kit generate --name backup_reader_policies`
Expected: `0008_backup_reader_policies.sql` containing exactly 26 `CREATE POLICY … FOR SELECT TO "backup_reader" USING (true)` statements and nothing else. If it contains anything else, the schema drifted earlier; stop and report.

- [ ] **Step 7: Add the test-helper password function; run the test**

Run: the Task 6 Step 2 command, then `pnpm --filter @gt-sales/db test` (all suites) and `pnpm --filter backend test` (the backend's integration suites must still pass with the extra policies).
Expected: PASS.

- [ ] **Step 8: Write the owner's manual SQL and the runbook entry**

`docs/RUNBOOKS/manual/0007-0008-backup-reader.sql`: one `BEGIN; … COMMIT;` transaction with both migrations' statements verbatim and the four tracker rows (two `supabase_migrations.schema_migrations`, two `drizzle.__drizzle_migrations` with `hash = sha256sum <file>` and `created_at` = the journal `when`), in the style of `0006-legacy-identity-mirror.sql`, followed by a commented `-- ALTER ROLE backup_reader PASSWORD '<paste a 32-character random password>';` the owner runs separately, and three verification selects (role attributes; count of `_backup_reader_read` policies in `app` = 26; `has_table_privilege('backup_reader','auth.users','SELECT')`). `docs/RUNBOOKS/database.md`: a `## 0007_backup_reader + 0008_backup_reader_policies` section in the existing style (what, how applied, hashes, verification queries, and that the `auth` grant may have warned).

- [ ] **Step 9: Typecheck, lint, format; commit**

```bash
git add packages/db docs/RUNBOOKS/manual/0007-0008-backup-reader.sql docs/RUNBOOKS/database.md
git commit -m "DB: backup_reader role with explicit grants and a read policy on every tenant table"
```

---

### Task 7: Database exporter (`pg_dump` as `backup_reader`)

**Files:**

- Create: `jobs/src/backup/pg-dump.ts`
- Test: `jobs/tests/pg-dump.test.ts`

**Interfaces:**

- Consumes: `RunCommand`, `CommandFailedError` (Task 2).
- Produces: `interface DatabaseDumpArtifacts { roles; schema; data; historySchema?; historyData? }` (all `Uint8Array`); `interface DatabaseExporter { exportAll(): Promise<DatabaseDumpArtifacts> }`; `interface PgDumpOptions { authData: 'include' | 'skip'; history: 'include' | 'skip' }`; `class PgDumpDatabaseExporter(dbUrl: string, run: RunCommand, options: PgDumpOptions, baseEnv: NodeJS.ProcessEnv = process.env)`; `parseConnectionUrl(url): PgConnection`; `filterRoles`, `filterSchema`, `filterData` (ported); constants `APP_SCHEMAS = ['app', 'public', 'drizzle']`, `HISTORY_SCHEMA = 'supabase_migrations'`, `AUTH_SCHEMA = 'auth'`.

- [ ] **Step 1: Write the failing tests** (port `pg-dump.test.ts`; replace the argument assertions with this product's)

```ts
it('runs roles, schema, data and history dumps with explicit schema lists and row security on', async () => {
  // options { authData: 'include', history: 'include' }
  // commands: ['pg_dumpall', 'pg_dump', 'pg_dump', 'pg_dump', 'pg_dump']
  // roles: ['--roles-only', '--quote-all-identifier', '--no-role-passwords', '--no-comments']
  // schema: ['--schema-only', '--quote-all-identifier', '--schema', 'app', '--schema', 'public', '--schema', 'drizzle']
  // data: ['--data-only', '--quote-all-identifier', '--enable-row-security', '--schema', 'app', '--schema', 'public', '--schema', 'drizzle', '--schema', 'auth', '--exclude-table', 'auth.schema_migrations']
  // history schema: ['--schema-only', '--quote-all-identifier', '--schema', 'supabase_migrations']
  // history data: ['--data-only', '--quote-all-identifier', '--schema', 'supabase_migrations']
  // no call contains '--role'
});
it('leaves auth out of the data dump when authData is skip', …) // no 'auth' anywhere in the data args
it('skips both history dumps when history is skip', …) // three commands only; historySchema/historyData undefined
it('passes the connection only through PG* environment variables, never argv', …) // every call's args contain no 'postgres://', no password; options.env has PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and PGSSLMODE 'require' by default
it('a pooler username with a dot survives parsing', …) // backup_reader.xykrphbgpwisqacpyeiv
it('a percent-encoded password is decoded', …)
it('throws CommandFailedError with a redacted excerpt when a dump exits non-zero', …)
// filterRoles/filterSchema/filterData: port the existing assertions unchanged
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Port and adapt `pg-dump.ts`**

Keep the filter functions and `parseConnectionUrl` byte-for-byte. Replace the exclude-list dumps with the include-list dumps the test pins. Keep `PGSSLMODE` default `require`, overridable by `baseEnv`. Module comment: explain the include lists (the reader holds grants only on these schemas), `--enable-row-security` (the reader has no `BYPASSRLS`; its policies grant every row; Task 9's guard proves no table is missed), why `storage` data is never dumped (document bytes are archived separately and `storage.objects` is recreated by the restore upload), and that `auth` DDL is platform-owned so only its data is dumped.

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add jobs/src/backup/pg-dump.ts jobs/tests/pg-dump.test.ts
git commit -m "Jobs: database export as backup_reader with explicit schema lists"
```

---

### Task 8: Backup sources: referenced objects, storage reader, completeness guard, dump row counts

**Files:**

- Create: `jobs/src/backup/sources.ts`, `jobs/src/backup/copy-rows.ts`
- Test: `jobs/tests/sources.test.ts`, `jobs/tests/copy-rows.test.ts`

**Interfaces:**

- Consumes: `signS3Request`, `S3SigningConfig`, `documentObjectKey` from `@gt-sales/adapters`; `runOrThrow`, `RunCommand`.
- Produces:
  - `interface ReferencedObject { workspaceId; bucket; objectKey; checksumSha256; sizeBytes }`; `interface ReferencedObjectManifestSource { listReferencedObjects(): Promise<ReferencedObject[]> }`; `class PsqlReferencedObjectManifestSource(dbUrl, run)` running `REFERENCED_OBJECTS_QUERY` (the union of `app.files where object_key is not null` and `app.file_revisions` joined to `app.files`); a row with a null or malformed checksum throws `malformed_referenced_object_row:<workspaceId>/<objectKey>`; `class FakeReferencedObjectManifestSource(objects)`.
  - `interface StorageSourceReader { getObject(bucket, key): Promise<Uint8Array | undefined> }`; `class S3StorageSourceReader(config: S3SigningConfig, fetchImpl = fetch, timeoutMs = 30_000)`; `class FakeStorageSourceReader(objects: Map<string, Uint8Array>)` keyed `${bucket}/${key}`.
  - `interface SourceCompletenessGuard { unreadableTables(): Promise<string[]> }`; `class PsqlSourceCompletenessGuard(dbUrl, run)` running `UNREADABLE_TABLES_QUERY`: every `pg_tables` row in `app`/`public`/`drizzle` where `not has_table_privilege(current_user, …, 'SELECT')`, or where `rowsecurity` and no `pg_policies` row has `current_user = any(roles)` with `cmd in ('SELECT','ALL')` — unless `(select rolbypassrls from pg_roles where rolname = current_user)`; returns `schema.table` strings; `class FakeSourceCompletenessGuard(tables)`.
  - `copy-rows.ts`: `countCopyRows(dataSql: string): Record<string, number>` — for each `COPY "schema"."table" (…) FROM stdin;` block, the number of lines before the terminating `\.`; keys `schema.table`; a table with an empty block maps to 0.

- [ ] **Step 1: Write the failing tests**

`sources.test.ts`:

```ts
it('PsqlReferencedObjectManifestSource parses tab-separated rows and the exact query', …)
it('PsqlReferencedObjectManifestSource throws malformed_referenced_object_row on an empty checksum', …)
it('PsqlReferencedObjectManifestSource returns [] on empty output', …)
it('S3StorageSourceReader signs a GET for workspaces/<ws>/<key>, returns undefined on 404, throws storage_source_get_failed:<status> otherwise', …)
it('PsqlSourceCompletenessGuard returns the schema.table names psql printed', …)
```

`copy-rows.test.ts`:

```ts
it('counts rows per COPY block and ignores everything outside blocks', () => {
  const sql = `SET x;\nCOPY "app"."leads" ("id", "note") FROM stdin;\n1\tline one\\nstill row one\n2\tb\n\\.\n\nCOPY "app"."contacts" ("id") FROM stdin;\n\\.\n`;
  expect(countCopyRows(sql)).toEqual({ 'app.leads': 2, 'app.contacts': 0 });
});
it('throws copy_block_unterminated when a block has no terminator', …)
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

Port the referenced-object and S3 reader classes (rename `R2`→`Storage`; `S3StorageSourceReader` takes one config, not a per-bucket resolver, since each deployment has one bucket). Write the guard and `countCopyRows` fresh.

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add jobs/src/backup/sources.ts jobs/src/backup/copy-rows.ts jobs/tests/sources.test.ts jobs/tests/copy-rows.test.ts
git commit -m "Jobs: backup sources, the source completeness guard and dump row counts"
```

---

### Task 9: The backup runner

**Files:**

- Create: `jobs/src/backup/run.ts`, `jobs/src/backup/index.ts`
- Test: `jobs/tests/backup-run.test.ts`

**Interfaces:**

- Consumes: Tasks 3, 4, 5, 7, 8.
- Produces:

```ts
export interface BackupRunDependencies {
  deployment: string; runId: string; now?: () => Date;
  encryptor: Encryptor; archiveWriter: ArchiveWriter;
  database: DatabaseExporter; referencedObjects: ReferencedObjectManifestSource;
  storageSource: StorageSourceReader; guard: SourceCompletenessGuard;
  sourceIds: Record<string, string>; toolVersions: Record<string, string>;
  exclusions?: string[]; maxSnapshotBytes?: number;
}
export interface BackupRunSummary { runId; manifestKey; artifactCount; referencedObjectCount; rowCountTables: number; durationMs; heartbeatPublished: true }
export function createBackupRunId(now: Date): string          // run-<iso with : and . as ->-<uuid>
export async function runBackup(deps): Promise<BackupRunSummary>
export class BackupSourceUnreadableError extends Error         // backup_source_unreadable:<n>_tables, .tables
export class BackupIncompleteError extends Error               // backup_incomplete:<n>_objects, .missingOrMismatchedObjects
export class BackupTooLargeError extends Error                 // backup_snapshot_too_large_for_runner:<MiB>><MiB>
export class BackupUploadVerificationError extends Error       // backup_upload_incomplete:<n>_keys
export const DEFAULT_MAX_SNAPSHOT_BYTES = 2 * 1024 ** 3
```

Order inside `runBackup`: (1) `guard.unreadableTables()` → throw if any; (2) refuse a run id whose prefix already has objects (`backup_run_id_already_exists`); (3) `database.exportAll()`; (4) `rowCounts = countCopyRows(data)`; (5) referenced objects; (6) size guard over dump bytes + object sizes; (7) fetch every object, verify sha256 and size, collect `objects/<workspaceId>/<objectKey>`; (8) artifacts `roles.sql`, `schema.sql`, `data.sql`, optional `history_schema.sql`, `history_data.sql`, the objects; (9) manifest with `rowCounts`, `counts: { referencedObjects }`, exclusions = `['storage_objects_metadata', 'supabase_project_settings', 'jwt_and_api_keys', 'database_and_role_passwords', 'smtp_oauth_secrets', 'provider_account_mfa', ...deps.exclusions]`; (10) encrypt and upload each artifact then the manifest last under `<runId>/`; (11) list the prefix and verify every expected key; (12) publish the heartbeat.

- [ ] **Step 1: Write the failing tests** (port `run.test.ts`; adapt and add)

```ts
it('a complete run uploads every artifact encrypted, the manifest last, and publishes a verified heartbeat', …)
// decrypt the manifest from the backend with the test decryptor; artifacts names; rowCounts equals countCopyRows(fake data); heartbeat.deployment === 'gt-sales'
it('fails with backup_source_unreadable before exporting when the guard names a table', …) // database.exportAll never called; backend.size() === 0
it('fails with backup_incomplete naming the missing object and publishes no heartbeat', …) // Review Focus 3
it('fails with backup_incomplete on a checksum mismatch', …)
it('fails with backup_snapshot_too_large_for_runner before fetching any object', …)
it('refuses a run id whose prefix already holds objects', …)
it('fails with backup_upload_incomplete when the listing lacks an uploaded key', …) // writer whose listObjects drops one key
it('records operator exclusions in the manifest', …) // exclusions: ['auth_data_skipped_by_operator'] → present; Review Focus 5
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Port and adapt `run.ts`; write `index.ts`** re-exporting run, pg-dump, sources, copy-rows.

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add jobs/src/backup jobs/tests/backup-run.test.ts
git commit -m "Jobs: the backup runner"
```

---

### Task 10: Backup CLI and its environment contract

**Files:**

- Create: `jobs/src/backup/cli.ts`
- Modify: `docs/ENV.md` (new `## Backups (GitHub Actions, never the runtime service)` section)
- Test: `jobs/tests/backup-cli.test.ts`

**Interfaces:**

- Produces: `buildBackupDependencies(env: NodeJS.ProcessEnv, now: Date): BackupRunDependencies` (exported for the test; `main()` calls it) reading: `BACKUP_DEPLOYMENT` (required), `SOURCE_DATABASE_URL`, `SOURCE_STORAGE_ENDPOINT`, `SOURCE_STORAGE_REGION`, `SOURCE_STORAGE_BUCKET`, `SOURCE_STORAGE_ACCESS_KEY_ID`, `SOURCE_STORAGE_SECRET_ACCESS_KEY`, `SUPABASE_PROJECT_REF`, `RECOVERY_AGE_RECIPIENT`, `B2_ARCHIVE_ENDPOINT`, `B2_ARCHIVE_REGION`, `B2_ARCHIVE_BUCKET`, `B2_ARCHIVE_WRITER_KEY_ID`, `B2_ARCHIVE_WRITER_APPLICATION_KEY` (all required); `BACKUP_AUTH_DATA` (`include` default | `skip`), `BACKUP_HISTORY` (`include` default | `skip`), `BACKUP_RUN_ID`, `BACKUP_MAX_SNAPSHOT_BYTES`, `AGE_VERSION`, `PG_DUMP_VERSION` (optional). Archive writer timeout 15 min, storage reader 10 min. `BACKUP_AUTH_DATA=skip` adds `auth_data_skipped_by_operator`; `BACKUP_HISTORY=skip` adds `supabase_migrations_skipped_by_operator`. Logs one JSON line `backup_completed` with counts and ids only; on failure `backup_failed` with `errorCode` and the (already redacted) message, reports to `createErrorTrackerFromEnv()`, exit code 1.

- [ ] **Step 1: Write the failing test**

```ts
it('builds dependencies from the environment with the documented defaults', …) // deployment, exclusions [], PgDumpOptions include/include, S3 configs
it('BACKUP_AUTH_DATA=skip and BACKUP_HISTORY=skip add their exclusions', …)
it('names the first missing required variable', …) // expect(() => build({})).toThrow('BACKUP_DEPLOYMENT is required')
it('rejects BACKUP_AUTH_DATA values other than include or skip', …)
```

- [ ] **Step 2: Run to verify it fails; Step 3: write `cli.ts`; Step 4: run tests, typecheck, lint**

- [ ] **Step 5: Document in `docs/ENV.md`**

A table per workflow environment (`backup-<deployment>`, `backup-monitor-<deployment>`, `backup-retention-<deployment>`) and one for the owner-run restore, listing every variable above plus Tasks 11–13's, with "set where" = GitHub Environment secret, and the three B2 key capability sets. Note the `SOURCE_DATABASE_URL` form: `postgresql://backup_reader.<project-ref>:<url-encoded password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres` (session pooler, port 5432, never 6543).

- [ ] **Step 6: Commit**

```bash
git add jobs/src/backup/cli.ts jobs/tests/backup-cli.test.ts docs/ENV.md
git commit -m "Jobs: backup CLI and its environment contract"
```

---

### Task 11: Monitor

**Files:**

- Create: `jobs/src/monitor/run.ts`, `jobs/src/monitor/cli.ts`, `jobs/src/monitor/index.ts`
- Test: `jobs/tests/monitor.test.ts`

**Interfaces:**

- Consumes: `readLatestHeartbeat`, `ArchiveReader`, `S3ArchiveReader`; `createOwnerAlertChannelFromEnv`, `createErrorTrackerFromEnv` from `@gt-sales/adapters` (alert kind `backup_stale` already exists).
- Produces: `DEFAULT_MAX_AGE_SECONDS = 26 * 60 * 60`; `type MonitorStatus = { status: 'ok'; heartbeat; ageSeconds } | { status: 'stale'; heartbeat; ageSeconds; maxAgeSeconds } | { status: 'missing' } | { status: 'malformed' } | { status: 'wrong_deployment'; expected: string; actual: string }`; `runMonitor({ reader, deployment, now?, maxAgeSeconds? })`; `requiresAlert(status): boolean`. CLI env: `BACKUP_DEPLOYMENT`, `B2_ARCHIVE_READER_KEY_ID`, `B2_ARCHIVE_READER_APPLICATION_KEY`, `B2_ARCHIVE_ENDPOINT`, `B2_ARCHIVE_REGION`, `B2_ARCHIVE_BUCKET`, optional `BACKUP_MONITOR_MAX_AGE_SECONDS`, plus `OWNER_ALERT_*`/`RESEND_*`. Alert `detail` strings: `stale:age_seconds:<n>`, `missing`, `malformed`, `wrong_deployment:<actual>`, `monitor_failed`.

- [ ] **Step 1: Write the failing tests** (port the five; add `wrong_deployment`: a heartbeat whose `deployment` differs from the one being monitored alerts, so two deployments pointed at one bucket by mistake are caught)

- [ ] **Step 2: Run to verify they fail; Step 3: port and adapt; Step 4: run tests, typecheck, lint; commit**

```bash
git add jobs/src/monitor jobs/tests/monitor.test.ts
git commit -m "Jobs: independent backup monitor"
```

---

### Task 12: Retention

**Files:**

- Create: `jobs/src/retention/select.ts`, `jobs/src/retention/run.ts`, `jobs/src/retention/cli.ts`, `jobs/src/retention/index.ts`
- Test: `jobs/tests/retention-select.test.ts`, `jobs/tests/retention-run.test.ts`, `jobs/tests/retention-cli.test.ts`

**Interfaces:**

- Produces: `selectRetainedRunIds(candidates, policy = defaultRetentionPolicy): Set<string>`; `defaultRetentionPolicy = { dailyPoints: 30, monthlyPoints: 12 }`; `runRetention({ admin, now?, policy?, graceSeconds?, dryRun }): Promise<RetentionRunReport>` (ported shape); `retentionPolicyFromEnv(env): RetentionPolicy` reading `RETENTION_DAILY_POINTS`, `RETENTION_MONTHLY_POINTS` (positive integers, defaults above) and `graceSecondsFromEnv(env)` reading `RETENTION_GRACE_SECONDS` (default 86400). CLI: `RETENTION_DRY_RUN` is true unless exactly `false`; exits 1 on `retention_unreadable_manifests`.

- [ ] **Step 1: Write the failing tests** (port all; add `retentionPolicyFromEnv` defaults/overrides/rejections)

- [ ] **Step 2–4: fail, port, pass; commit**

```bash
git add jobs/src/retention jobs/tests/retention-*.test.ts
git commit -m "Jobs: archive retention with a configurable policy and dry-run default"
```

---

### Task 13: Restore runner

**Files:**

- Create: `jobs/src/restore/run.ts`
- Test: `jobs/tests/restore-run.test.ts`

**Interfaces:**

- Consumes: `ArchiveReader`, `Decryptor`, `backupManifestSchema`, `verifyManifestArtifacts`, `DatabaseDumpArtifacts`.
- Produces:

```ts
export interface RestoreTarget {
  preflight(): Promise<void>; // throws restore_target_role_cannot_bypass_rls, restore_target_not_empty
  applyDatabase(artifacts: DatabaseDumpArtifacts): Promise<void>;
  applyObjects(objects: ReadonlyMap<string, Uint8Array>): Promise<void>; // key = objects/<ws>/<key> → storage key workspaces/<ws>/<key>
  countRows(tables: readonly string[]): Promise<Record<string, number>>;
}
export interface RestoreDependencies {
  runId;
  reader;
  decryptor;
  target?: RestoreTarget;
  now?;
  incidentDetectedAt?: Date;
}
export type RestoreStage =
  | 'manifest_fetch'
  | 'manifest_decrypt'
  | 'artifact_fetch_and_decrypt'
  | 'target_preflight'
  | 'database_apply'
  | 'objects_apply'
  | 'row_count_check';
export interface RestoreReport {
  runId;
  verified: boolean;
  restored: boolean;
  failedStage?;
  failureReason?;
  manifest?;
  missingArtifacts: string[];
  mismatchedArtifacts: string[];
  rowCountMismatches: { table: string; expected: number; actual: number }[];
  measuredLossWindowMs?: number;
  restoreDurationMs: number;
}
export async function runRestore(deps): Promise<RestoreReport>;
```

Rules: `verified` is true once every artifact decrypts and matches the manifest; with no `target`, the run ends there (`restored: false`, no failure). With a target: preflight, apply database, apply objects, then `countRows(Object.keys(manifest.rowCounts))` and compare exactly; `restored` is true only when every stage passed and there are no mismatches. Any thrown error in a stage becomes `failedStage` + `failureReason` (message), and no later stage runs.

- [ ] **Step 1: Write the failing tests**

```ts
it('verify-only: a complete archive is verified and not restored', …)
it('fails closed when the manifest object is missing', …)
it('fails closed on a tampered manifest', …)
it('fails closed on a missing artifact, naming it', …)
it('fails closed on a mismatched artifact and never calls the target', …)
it('stops at target_preflight when the target role cannot bypass RLS', …) // Review Focus 4; applyDatabase not called
it('restores and reports no mismatches when target counts equal the manifest', …)
it('reports a row count mismatch and restored=false', …) // expected 2 actual 1 for app.leads
it('measures the loss window from capturedAt to incidentDetectedAt', …)
```

- [ ] **Step 2–4: fail, implement, pass; commit**

```bash
git add jobs/src/restore/run.ts jobs/tests/restore-run.test.ts
git commit -m "Jobs: restore runner that verifies, applies and reconciles row counts"
```

---

### Task 14: Restore target (psql + S3) and CLI

**Files:**

- Create: `jobs/src/restore/target.ts`, `jobs/src/restore/cli.ts`, `jobs/src/restore/index.ts`
- Test: `jobs/tests/restore-target.test.ts`, `jobs/tests/restore-cli.test.ts`

**Interfaces:**

- Produces: `class PsqlAndS3RestoreTarget implements RestoreTarget` with constructor `({ databaseUrl: string; skipRoles: boolean; storage?: S3SigningConfig; run: RunCommand; withTempDir?: WithTempDir; fetchImpl?: typeof fetch })`:
  - `preflight()`: `psql -tA -c "select (rolsuper or rolbypassrls) from pg_roles where rolname = current_user"` must print `t`, else throw `restore_target_role_cannot_bypass_rls`; `select count(*) from pg_namespace where nspname in ('app','drizzle')` must print `0`, else `restore_target_not_empty`.
  - `applyDatabase(a)`: write the artifacts to a temp dir; `psql <url> --single-transaction --variable ON_ERROR_STOP=1 [--file roles.sql] --file schema.sql --command 'SET session_replication_role = replica' --file data.sql` (roles only when `skipRoles` is false); then, when both history artifacts exist, a second `psql --single-transaction … --file history_schema.sql --file history_data.sql`; temp dir removed in `finally`.
  - `applyObjects(objects)`: with `storage` set, `PUT` each to `workspaces/<ws>/<key>` through an `S3ArchiveWriter`-style signed request (reuse `S3ArchiveWriter`); without `storage`, throw `restore_storage_not_configured` when `objects.size > 0`.
  - `countRows(tables)`: one `psql -tA` query using the `query_to_xml` idiom to count every named table in one round trip; a table missing on the target counts as `-1` (so it mismatches visibly).
  - `type WithTempDir = <T>(fn: (dir: string) => Promise<T>) => Promise<T>` with `nodeWithTempDir` default.
- CLI env: `RESTORE_RUN_ID`, `B2_ARCHIVE_READER_KEY_ID`, `B2_ARCHIVE_READER_APPLICATION_KEY`, `B2_ARCHIVE_ENDPOINT`, `B2_ARCHIVE_REGION`, `B2_ARCHIVE_BUCKET`, `RECOVERY_PRIVATE_KEY_PATH` (required; file must exist); optional `TARGET_DATABASE_URL` (verify-only without it), `RESTORE_SKIP_ROLES`, `TARGET_STORAGE_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `INCIDENT_DETECTED_AT` (ISO). Prints the `RestoreReport` minus the manifest's artifact list as one JSON line; exit 0 only when `verified` and (no target or `restored`).

- [ ] **Step 1: Write the failing tests** (recording `RunCommand`; fake fetch for S3)

```ts
it('preflight throws restore_target_role_cannot_bypass_rls when psql prints f', …)
it('preflight throws restore_target_not_empty when app or drizzle exists', …)
it('applyDatabase runs one single-transaction psql with roles, schema, replica role and data, in that order', …)
it('applyDatabase omits roles.sql when skipRoles is true', …)
it('applyDatabase runs the history pair in a second transaction only when both artifacts exist', …)
it('applyObjects PUTs workspaces/<ws>/<key> for each objects/<ws>/<key> artifact', …)
it('applyObjects throws restore_storage_not_configured when objects exist but no storage is set', …)
it('countRows parses the per-table counts and reports a missing table as -1', …)
it('the CLI refuses to start without the private key file', …)
```

- [ ] **Step 2–4: fail, implement, pass; commit**

```bash
git add jobs/src/restore jobs/tests/restore-target.test.ts jobs/tests/restore-cli.test.ts
git commit -m "Jobs: restore target over psql and S3, and the operator CLI"
```

---

### Task 15: End-to-end rehearsal on a disposable Postgres, in CI

**Files:**

- Create: `apps/backend/tests/backup-restore-rehearsal.integration.test.ts`
- Modify: `.github/workflows/ci.yml` (install PostgreSQL 17 client tools and `age` before `pnpm run test`)
- Modify: `packages/config/boundaries.js` only if the test must import a database client outside `apps/backend` (it should not need to)

**Interfaces:**

- Consumes: everything above; `applyMigrations`, `seedDatabase`, `setTestRuntimePassword`, `setTestBackupReaderPassword`, `assertDisposableDatabaseUrl` from `@gt-sales/db`.

- [ ] **Step 1: Write the test**

Skip (with a printed reason) unless `TEST_MIGRATION_DATABASE_URL` + `DB_TEST_ALLOW_DESTRUCTIVE=1` are set and `pg_dump --version` reports major ≥ the server's major (`select current_setting('server_version_num')`). Then:

1. From the admin URL derive two database names `gt_sales_crm_backup_src_test` and `gt_sales_crm_backup_dst_test`; `DROP DATABASE IF EXISTS` both (`WITH (FORCE)`), create both; `applyMigrations` + `seedDatabase` on the source; set both test role passwords.
2. Insert two leads (workspace A and B) and one finalized `app.files` row in A with `object_key 'docs/passport.pdf'`, `checksum_sha256` = sha256 of a 64-byte fixture, `size_bytes` 64; a `FakeStorageSourceReader` holding `documents/workspaces/<A>/docs/passport.pdf`.
3. `runBackup` with `PgDumpDatabaseExporter(sourceReaderUrl, nodeRunCommand, { authData: 'skip', history: 'skip' }, { ...process.env, PGSSLMODE: 'disable' })`, `PsqlReferencedObjectManifestSource`, `PsqlSourceCompletenessGuard`, `InMemoryArchiveBackend`, `TestEnvelopeEncryptor`, `exclusions: ['auth_data_skipped_by_operator']`.
4. Insert a third lead in the source AFTER the backup (Review Focus 2).
5. `runRestore` into the destination with `PsqlAndS3RestoreTarget({ databaseUrl: dstAdminUrl, skipRoles: true, run: nodeRunCommand })` and an `applyObjects` spy (wrap the target; assert it received `objects/<A>/docs/passport.pdf` with the fixture bytes).
6. Assert: `report.verified && report.restored`, `rowCountMismatches` empty, `manifest.rowCounts['app.leads']` equals the count at dump time (2 plus whatever seed inserted), destination `app.leads` count equals it (not 3+), and an `app_runtime` connection to the destination with `set_config('app.workspace_id', A)` and an actor sees exactly A's lead while a connection without context sees none (RLS, policies and grants survived the dump/restore).
7. Negative: flip one byte of `<runId>/data.sql.enc` in the backend, recreate the empty destination, `runRestore` again → `failedStage: 'artifact_fetch_and_decrypt'`, `restored: false`, destination still has no `app` schema.
8. `afterAll`: drop both databases.

- [ ] **Step 2: Run it locally**

Run with the CI variables from `.github/workflows/ci.yml`. If the local cluster is Postgres 16 and `pg_dump` 17 is absent, the test skips; install `postgresql-client-17` (same apt steps as the workflow) and rerun.
Expected: PASS.

- [ ] **Step 3: Add to `ci.yml`**, after `pnpm install`: the three-line `postgresql-common` / `apt.postgresql.org.sh` / `postgresql-client-17` install with `/usr/lib/postgresql/17/bin` prepended to `GITHUB_PATH`, and `sudo apt-get install -y age`. Add a step that prints `pg_dump --version` and `age --version`.

- [ ] **Step 4: Run the whole gate**

Run: `pnpm run typecheck && pnpm run lint && pnpm run format && pnpm run test`
Expected: all green, including the Task 4 real-`age` test now exercised.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/tests/backup-restore-rehearsal.integration.test.ts .github/workflows/ci.yml
git commit -m "Tests: backup and restore rehearsal on a disposable Postgres, with the real dump tools in CI"
```

---

### Task 16: The three workflows, one matrix entry per deployment

**Files:**

- Create: `.github/workflows/backup.yml`, `.github/workflows/backup-monitor.yml`, `.github/workflows/backup-retention.yml`

- [ ] **Step 1: Write `backup.yml`**

Port Canadian Plans' file with these changes: `strategy: { fail-fast: false, matrix: { deployment: [gt-sales] } }`; `environment: backup-${{ matrix.deployment }}`; `concurrency: { group: backup-${{ matrix.deployment }}, cancel-in-progress: false }`; drop Sanity and the lease URL; env block maps the Task 10 variables from `secrets.*` of the same names plus `BACKUP_DEPLOYMENT: ${{ matrix.deployment }}`; PostgreSQL client major from Task 1's fact; `run: pnpm --filter @gt-sales/jobs run backup`. A header comment: "To add a deployment: one matrix entry here and in the two sibling workflows, three GitHub Environments named after it, their secrets per docs/ENV.md."

- [ ] **Step 2: Write `backup-monitor.yml`** (hourly `8 * * * *`, `environment: backup-monitor-${{ matrix.deployment }}`, reader secrets + alert secrets, `cancel-in-progress: true`).

- [ ] **Step 3: Write `backup-retention.yml`** (weekly `43 7 * * 1`, `workflow_dispatch` input `dry_run` default `true`, `environment: backup-retention-${{ matrix.deployment }}`, retention secrets, `RETENTION_DRY_RUN` from the input exactly as Canadian Plans does).

- [ ] **Step 4: Validate**

Run: `pnpm run format` (prettier checks YAML) and `pnpm run test:tooling`.
Expected: PASS. Then, with the branch pushed, trigger each workflow once by `workflow_dispatch` on this branch: expected to **fail at the first secret-dependent step** with `BACKUP_DEPLOYMENT is required`-style messages or missing-environment errors, proving the files parse and the matrix/environment wiring resolves. Record the run URLs in the PR description.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/backup.yml .github/workflows/backup-monitor.yml .github/workflows/backup-retention.yml
git commit -m "CI: nightly backup, hourly monitor and weekly retention workflows, one environment set per deployment"
```

---

### Task 17: Runbooks and the owner's setup ceremony

**Files:**

- Modify: `docs/RUNBOOKS/backup.md` (complete it)
- Create: `docs/RUNBOOKS/restore.md`, `docs/RUNBOOKS/backup-alert-response.md`
- Modify: `jobs/README.md`, `docs/HANDOFF.md` §5.1 (owner steps), `docs/PLAN.md` §10 (owner items)

- [ ] **Step 1: `docs/RUNBOOKS/backup.md`**

Sections, in the order the owner does them: (1) Facts (Task 1). (2) What is backed up and what is not (database schemas `app`, `public`, `drizzle`; `auth` data unless skipped; `supabase_migrations` history; every verified document; not: `storage.objects` metadata, project settings, keys, passwords, SMTP, the recovery private key). (3) Backblaze B2: create one private bucket `gt-sales-crm-archive`, then three application keys scoped to it with exactly `listFiles+writeFiles`, `listFiles+readFiles`, `listFiles+readFiles+deleteFiles`; the S3 endpoint and region shown in the bucket details. (4) The recovery key ceremony: on the owner's computer, `age-keygen -o gt-sales-recovery-key.txt`, `age-keygen -y gt-sales-recovery-key.txt` → the recipient; the private file goes to the password manager and one offline copy; it is never pasted into GitHub, Railway, Vercel or chat; losing it makes every backup unreadable. (5) Supabase: apply `manual/0007-0008-backup-reader.sql`, set the password, run the verification selects, note the warning case for `auth`. (6) GitHub: three Environments `backup-gt-sales`, `backup-monitor-gt-sales`, `backup-retention-gt-sales`, with the secrets table from ENV.md and "required reviewers: owner" on the retention environment. (7) First run: `workflow_dispatch` Backup → read the `backup_completed` line; then Backup monitor → `monitor_status ok`; then Backup retention in dry-run → `retention_completed`. (8) Manual deletion order (spec decision 18): delete or null the `app.files` rows first, then the storage objects, never the other way round, or every backup fails until fixed. (9) Costs on Free: B2 10 GB free; a run stores the full document set, so 42 restore points × document bytes; lower `RETENTION_DAILY_POINTS` if it matters. (10) Free-plan pause: a paused project fails the dump and the monitor alerts; the backend keeps it awake.

- [ ] **Step 2: `docs/RUNBOOKS/restore.md`**

Port Canadian Plans' runbook minus Sanity, R2, the deletion ledger and the lease. Sections: immediate incident actions; required access (reader key, recovery private key, a target: a fresh Supabase project or `supabase start` locally); the restore CLI in verify-only mode first; applying to the target (`TARGET_DATABASE_URL` as the target's `postgres` role, which has `BYPASSRLS`; `RESTORE_SKIP_ROLES` only when the roles already exist; `TARGET_STORAGE_*` with a `documents` bucket created first); reading the report; after a restore: new `app_runtime` and `backup_reader` passwords, re-invite staff if auth data was skipped, point the backend at the target, staff sign in afresh; reopen criteria; the explicit exclusions.

- [ ] **Step 3: `docs/RUNBOOKS/backup-alert-response.md`**: port, with this repository's paths and the `wrong_deployment` case.

- [ ] **Step 4: `jobs/README.md`**: a section per CLI with its npm script and the env variables table reference; the statement that none of them import database code.

- [ ] **Step 5: HANDOFF §5.1 and PLAN §10**: the owner steps from `backup.md` (3)–(7) as a numbered checklist with status cells.

- [ ] **Step 6: Format; commit**

```bash
git add docs/RUNBOOKS jobs/README.md docs/HANDOFF.md docs/PLAN.md
git commit -m "Docs: backup setup ceremony, restore procedure and alert response"
```

---

### Task 18: Ship it: PR, owner ceremony, first production run

- [ ] **Step 1: Open the PR** from `ccr-843584e2-mj2gh0` into `main` with the gate green in CI and the Task 16 dispatch URLs in the description. Owner reviews and merges.

- [ ] **Step 2: Owner performs `backup.md` steps (3)–(6)** with the session beside them: B2 bucket and keys, age key pair, migrations 0007/0008 and the password, GitHub Environments and secrets. The session never sees a secret; it reads only run logs.

- [ ] **Step 3: First run (7)**: dispatch Backup, Backup monitor, Backup retention (dry run). Expected log lines: `backup_completed` with `artifactCount ≥ 3` and `referencedObjectCount` = the Task 1 file count; `monitor_status` `ok`; `retention_completed` `dryRun: true`, `candidateDeletionCount: 0`.

- [ ] **Step 4: Wait one scheduled night**: the 06:17 UTC run completes on its own and the 07:08 UTC monitor stays green. Record both run URLs and timings in `docs/RUNBOOKS/backup.md` under `## First production runs`.

---

### Task 19: Restore drill on a scratch target

- [ ] **Step 1: Target**: the owner creates a second Free Supabase project `gtsales-crm-restore-drill` in the same organisation (the Free plan allows two) with a private `documents` bucket and S3 keys, or runs `supabase start` locally with Docker. The drill never touches production.

- [ ] **Step 2: Verify-only** on the owner's computer: `RESTORE_RUN_ID=<last night's run> RECOVERY_PRIVATE_KEY_PATH=… B2_ARCHIVE_READER_* … pnpm --filter @gt-sales/jobs run restore` → report `verified: true`, `restored: false`.

- [ ] **Step 3: Full restore** with `TARGET_DATABASE_URL` (the drill project's `postgres` role, session pooler) and `TARGET_STORAGE_*` → `restored: true`, `rowCountMismatches: []`, `restoreDurationMs` recorded.

- [ ] **Step 4: Checks on the target** (SQL editor): `select count(*) from app.leads` equals the manifest; `select count(*) from storage.objects` equals `referencedObjectCount`; a `set_config('app.workspace_id', …)` probe as `app_runtime` after setting its password; `select count(*) from auth.users` equals the manifest when auth was included.

- [ ] **Step 5: Evidence and clean-up**: `docs/RUNBOOKS/restore.md` gets a `## Drill 2026-xx-xx` section with the run id, durations, counts and anything that surprised; the owner pauses or deletes the drill project (it holds real customer data: delete, do not leave it). Phase 1 is done when this section exists (spec §12).

---

## Self-review notes

- Spec §10 coverage: jobs imported (Tasks 2–14), S3 source adapted (8), Sanity off (not ported), dump includes `public` legacy tables (7), protected environments and write-without-delete (16, 17), nightly archive + practised restore (18, 19). The lease parts of the source were deliberately not ported, and the reason (nothing physically deletes a referenced document in this repository) is stated in Task 8's module comment and `backup.md` (8).
- Names used across tasks: `StorageSourceReader`/`S3StorageSourceReader`/`FakeStorageSourceReader` (8, 9, 15); `SourceCompletenessGuard`/`PsqlSourceCompletenessGuard` (8, 9, 15); `countCopyRows` (8, 9, 15); `RestoreTarget`/`PsqlAndS3RestoreTarget` (13, 14, 15); `DatabaseDumpArtifacts` (7, 13, 14); `backupReadPolicy` and `<table>_backup_reader_read` (6, 7 comment, 8 guard query); `deployment` on manifest and heartbeat (5, 9, 11).
- Review Focus 1–5 each have a test named in a task.
