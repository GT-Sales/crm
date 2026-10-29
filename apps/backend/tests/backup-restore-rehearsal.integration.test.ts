import { createHash } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { tenantContextStatement } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { seedDatabase } from '@gt-sales/db/seed';
import {
  assertDisposableDatabaseUrl,
  setTestBackupReaderPassword,
  setTestRuntimePassword,
  TEST_BACKUP_READER_PASSWORD,
  TEST_RUNTIME_PASSWORD,
} from '@gt-sales/db/test-helpers';
import {
  generateTestRecipientKeyPair,
  InMemoryArchiveBackend,
  nodeRunCommand,
  TestEnvelopeDecryptor,
  TestEnvelopeEncryptor,
} from '@gt-sales/jobs/archive';
import {
  BackupSourceUnreadableError,
  createBackupRunId,
  FakeStorageSourceReader,
  PgDumpDatabaseExporter,
  PsqlReferencedObjectManifestSource,
  PsqlSourceCompletenessGuard,
  runBackup,
  type BackupRunSummary,
} from '@gt-sales/jobs/backup';
import {
  PsqlAndS3RestoreTarget,
  runRestore,
  type RestoreReport,
  type RestoreTarget,
} from '@gt-sales/jobs/restore';

/**
 * The backup → restore rehearsal (docs/RUNBOOKS/backup.md, restore.md): the
 * real `pg_dumpall`/`pg_dump`/`psql` against two dedicated disposable
 * databases on the test cluster. The source is migrated and seeded, dumped as
 * `backup_reader`, encrypted into an in-memory archive and restored into an
 * empty destination as the cluster's superuser; the destination must then hold
 * exactly the rows the dump held, with its RLS policies and grants intact.
 * Only the archive, the encryption and the document store are test doubles.
 */

function getDisposableTestDatabaseUrl(): string | undefined {
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const destructiveTestsEnabled = process.env.DB_TEST_ALLOW_DESTRUCTIVE === '1';
  if (!migrationUrl && !destructiveTestsEnabled && !process.env.CI) return undefined;
  if (!migrationUrl || !destructiveTestsEnabled) {
    throw new Error(
      'Database integration tests require TEST_MIGRATION_DATABASE_URL and DB_TEST_ALLOW_DESTRUCTIVE=1 together.',
    );
  }
  const databaseName = decodeURIComponent(new URL(migrationUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_MIGRATION_DATABASE_URL must name a disposable database ending in _test.');
  }
  assertDisposableDatabaseUrl(migrationUrl);
  return migrationUrl;
}

/** Every tool reads its connection from PG* variables; the test cluster has no TLS in CI. */
const toolEnv: NodeJS.ProcessEnv = { ...process.env, PGSSLMODE: 'disable' };

/** pg_dump refuses a server newer than itself, so the rehearsal needs a client at least as new. */
async function skipReason(migrationUrl: string | undefined): Promise<string | undefined> {
  if (!migrationUrl) return 'TEST_MIGRATION_DATABASE_URL and DB_TEST_ALLOW_DESTRUCTIVE=1 are unset';
  let clientMajor: number;
  try {
    const result = await nodeRunCommand('pg_dump', ['--version'], { env: toolEnv });
    const match = /\(PostgreSQL\) (\d+)/.exec(new TextDecoder().decode(result.stdout));
    if (result.exitCode !== 0 || !match?.[1]) return 'pg_dump --version did not report a version';
    clientMajor = Number(match[1]);
  } catch {
    return 'pg_dump is not on PATH';
  }
  const admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
  try {
    const [row] = await admin<{ version: string }[]>`
      select current_setting('server_version_num') as version
    `;
    const serverMajor = Math.floor(Number(row?.version) / 10_000);
    if (clientMajor < serverMajor) {
      return `pg_dump ${clientMajor} is older than the server's major version ${serverMajor}`;
    }
    return undefined;
  } finally {
    await admin.end();
  }
}

const migrationUrl = getDisposableTestDatabaseUrl();
const reason = await skipReason(migrationUrl);
// In CI a missing or too-old dump client is a broken pipeline, never a skip;
// only an unconfigured database (which CI rejects above) skips.
if (reason && migrationUrl && process.env.CI) {
  throw new Error(`The backup/restore rehearsal cannot run in CI: ${reason}.`);
}

const SOURCE_DATABASE = 'gt_sales_crm_backup_src_test';
const DESTINATION_DATABASE = 'gt_sales_crm_backup_dst_test';

// A distinct id range from the other integration suites (these databases are
// the rehearsal's own, but the ids stay recognisable in a failure).
const WORKSPACE_A = '15000000-0000-4000-8000-000000000a01';
const WORKSPACE_B = '15000000-0000-4000-8000-000000000b01';
const ACTOR = '25000000-0000-4000-8000-000000000a01';
const LEAD_A = '35000000-0000-4000-8000-000000000a01';
const LEAD_B = '35000000-0000-4000-8000-000000000b01';
const LEAD_AFTER_BACKUP = '35000000-0000-4000-8000-000000000a02';
const FILE_A = '45000000-0000-4000-8000-000000000a01';
const BUCKET = 'documents';
const OBJECT_KEY = 'docs/passport.pdf';
const OBJECT_ARTIFACT = `objects/${WORKSPACE_A}/${OBJECT_KEY}`;
/** 64 synthetic bytes standing in for an uploaded document. */
const FIXTURE = Uint8Array.from({ length: 64 }, (_, index) => index);
const FIXTURE_SHA256 = createHash('sha256').update(FIXTURE).digest('hex');

function databaseUrl(base: string, database: string, user?: { name: string; password: string }) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

describe('backup and restore rehearsal on a disposable Postgres', () => {
  // Unconfigured, every test skips; the placeholder only keeps the URLs parseable.
  const baseUrl = migrationUrl ?? 'postgresql://localhost/unconfigured_test';
  const sourceAdminUrl = databaseUrl(baseUrl, SOURCE_DATABASE);
  const sourceReaderUrl = databaseUrl(baseUrl, SOURCE_DATABASE, {
    name: 'backup_reader',
    password: TEST_BACKUP_READER_PASSWORD,
  });
  const destinationAdminUrl = databaseUrl(baseUrl, DESTINATION_DATABASE);
  const destinationRuntimeUrl = databaseUrl(baseUrl, DESTINATION_DATABASE, {
    name: 'app_runtime',
    password: TEST_RUNTIME_PASSWORD,
  });

  const keys = generateTestRecipientKeyPair();
  const archive = new InMemoryArchiveBackend();
  let cluster: ReturnType<typeof postgres> | undefined;
  let source: ReturnType<typeof postgres> | undefined;
  let destination: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof postgres> | undefined;
  let runId: string | undefined;

  /** DROP/CREATE DATABASE cannot run in a transaction: plain statements on the cluster connection. */
  async function recreateDatabase(name: string): Promise<void> {
    if (!cluster) throw new Error('the cluster connection is not open');
    await cluster.unsafe(`drop database if exists "${name}" with (force)`);
    await cluster.unsafe(`create database "${name}"`);
  }

  async function connectDestination(): Promise<ReturnType<typeof postgres>> {
    await destination?.end();
    destination = postgres(destinationAdminUrl, { max: 1, prepare: false, ssl: false });
    return destination;
  }

  async function count(sql: ReturnType<typeof postgres>, query: string): Promise<number> {
    const [row] = await sql.unsafe<{ count: number }[]>(`select (${query})::int as count`);
    return row?.count ?? -1;
  }

  function restoreTarget(applyObjects: RestoreTarget['applyObjects']): RestoreTarget {
    // Without Storage credentials the real target refuses documents, so the
    // objects stage is a spy; every database stage is the real psql target.
    const target = new PsqlAndS3RestoreTarget({
      databaseUrl: destinationAdminUrl,
      skipRoles: true,
      run: nodeRunCommand,
      baseEnv: toolEnv,
    });
    return {
      preflight: () => target.preflight(),
      applyDatabase: (artifacts) => target.applyDatabase(artifacts),
      applyObjects,
      countRows: (tables) => target.countRows(tables),
    };
  }

  function storageSource(): FakeStorageSourceReader {
    return new FakeStorageSourceReader(
      new Map([[`${BUCKET}/workspaces/${WORKSPACE_A}/${OBJECT_KEY}`, FIXTURE]]),
    );
  }

  /** The backup as the workflow runs it, minus auth and history (absent locally). */
  function backup(id: string): Promise<BackupRunSummary> {
    return runBackup({
      deployment: 'rehearsal',
      runId: id,
      encryptor: new TestEnvelopeEncryptor(keys.publicKeyBase64),
      archiveWriter: archive.asWriter(),
      database: new PgDumpDatabaseExporter(
        sourceReaderUrl,
        nodeRunCommand,
        { authData: 'skip', history: 'skip' },
        toolEnv,
      ),
      referencedObjects: new PsqlReferencedObjectManifestSource(sourceReaderUrl, nodeRunCommand),
      storageSource: storageSource(),
      guard: new PsqlSourceCompletenessGuard(sourceReaderUrl, nodeRunCommand),
      sourceIds: { database: SOURCE_DATABASE },
      toolVersions: { pgDump: 'rehearsal' },
      exclusions: ['auth_data_skipped_by_operator', 'supabase_migrations_skipped_by_operator'],
    });
  }

  beforeAll(async () => {
    if (reason) return;
    // The psql sources (completeness guard, referenced objects) read PGSSLMODE
    // from process.env rather than a base environment.
    vi.stubEnv('PGSSLMODE', 'disable');
    cluster = postgres(baseUrl, { max: 1, prepare: false, ssl: false });
    await recreateDatabase(SOURCE_DATABASE);
    await recreateDatabase(DESTINATION_DATABASE);

    await applyMigrations({ connectionString: sourceAdminUrl, ssl: false });
    await seedDatabase({ connectionString: sourceAdminUrl, ssl: false });
    source = postgres(sourceAdminUrl, { max: 1, prepare: false, ssl: false });
    // Role passwords are cluster-wide, so both logins reach either new database.
    // Set them on the cluster (migration-database) connection: advisory locks
    // are per database, and the sibling suites take these keys there.
    await setTestRuntimePassword(cluster);
    await setTestBackupReaderPassword(cluster);

    await source`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_A}, 'rehearsal-a', 'Rehearsal Site A'),
        (${WORKSPACE_B}, 'rehearsal-b', 'Rehearsal Site B')
    `;
    await source`
      insert into app.leads (id, workspace_id, lead_type, status, full_name, email, consent_version)
      values
        (${LEAD_A}, ${WORKSPACE_A}, 'contact_message', 'submitted', 'Rehearsal Lead A',
          'rehearsal-a@example.invalid', 'rehearsal-v1'),
        (${LEAD_B}, ${WORKSPACE_B}, 'contact_message', 'submitted', 'Rehearsal Lead B',
          'rehearsal-b@example.invalid', 'rehearsal-v1')
    `;
    await source`
      insert into app.files (
        id, workspace_id, record_type, record_id, document_type, bucket, staging_key,
        object_key, declared_content_type, detected_mime, declared_size_bytes, size_bytes,
        checksum_sha256, status, uploaded_by, expires_at, finalized_at
      )
      values (
        ${FILE_A}, ${WORKSPACE_A}, 'lead', ${LEAD_A}, 'passport', ${BUCKET},
        ${`staging/${WORKSPACE_A}/${FILE_A}`}, ${OBJECT_KEY}, 'application/pdf',
        'application/pdf', ${FIXTURE.byteLength}, ${FIXTURE.byteLength}, ${FIXTURE_SHA256},
        'available', ${ACTOR}, now() + interval '1 hour', now()
      )
    `;
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await runtime?.end();
    await destination?.end();
    await source?.end();
    if (cluster) {
      await cluster.unsafe(`drop database if exists "${SOURCE_DATABASE}" with (force)`);
      await cluster.unsafe(`drop database if exists "${DESTINATION_DATABASE}" with (force)`);
      await cluster.end();
    }
  }, 60_000);

  test('the guard stops the backup before anything is exported when backup_reader would miss rows', async ({
    skip,
  }) => {
    if (reason) skip(`rehearsal skipped: ${reason}`);
    if (!source) throw new Error('the source database was not set up');

    // (a) a public table with row security and no reader policy, (b) a
    // restrictive SELECT policy for everyone on an app table, which Postgres
    // ANDs onto the reader's own permissive policy.
    await source.unsafe(`
      create table public.rehearsal_rls_no_policy (id integer primary key);
      alter table public.rehearsal_rls_no_policy enable row level security;
      create policy rehearsal_restrictive_select on app.lead_tasks
        as restrictive for select to public using (false);
    `);
    try {
      const failure = await backup(createBackupRunId(new Date())).catch(
        (caught: unknown) => caught,
      );
      expect(failure).toBeInstanceOf(BackupSourceUnreadableError);
      if (!(failure instanceof BackupSourceUnreadableError)) return;
      expect(failure.tables).toEqual(['app.lead_tasks', 'public.rehearsal_rls_no_policy']);
      expect(await archive.asReader().listObjects('')).toEqual([]);
    } finally {
      await source.unsafe(`
        drop policy if exists rehearsal_restrictive_select on app.lead_tasks;
        drop table if exists public.rehearsal_rls_no_policy;
      `);
    }

    // (c) a schema the reader has no USAGE on: the guard names its table (and
    // its sequence) instead of failing its own query with psql_failed.
    await source.unsafe('revoke usage on schema drizzle from backup_reader');
    try {
      const guard = new PsqlSourceCompletenessGuard(sourceReaderUrl, nodeRunCommand);
      expect(await guard.unreadableTables()).toEqual([
        'drizzle.__drizzle_migrations',
        'drizzle.__drizzle_migrations_id_seq',
      ]);
    } finally {
      await source.unsafe('grant usage on schema drizzle to backup_reader');
    }
    expect(
      await new PsqlSourceCompletenessGuard(sourceReaderUrl, nodeRunCommand).unreadableTables(),
    ).toEqual([]);
    expect(await archive.asReader().listObjects('')).toEqual([]);
  }, 120_000);

  test('a backup taken with the real dump tools restores every row, document, policy and grant', async ({
    skip,
  }) => {
    if (reason) skip(`rehearsal skipped: ${reason}`);
    if (!source) throw new Error('the source database was not set up');
    runId = createBackupRunId(new Date());
    const leadsAtDump = await count(source, 'select count(*) from app.leads');

    const summary = await backup(runId);
    expect(summary).toMatchObject({ runId, referencedObjectCount: 1, artifactCount: 4 });

    // A write after the dump is not in this restore point (Review Focus 2).
    await source`
      insert into app.leads (id, workspace_id, lead_type, status, full_name, consent_version)
      values (${LEAD_AFTER_BACKUP}, ${WORKSPACE_A}, 'contact_message', 'submitted',
        'Rehearsal Lead After Backup', 'rehearsal-v1')
    `;

    const applyObjects = vi.fn<RestoreTarget['applyObjects']>(async () => undefined);
    const report: RestoreReport = await runRestore({
      runId,
      reader: archive.asReader(),
      decryptor: new TestEnvelopeDecryptor(keys.privateKeyBase64),
      target: restoreTarget(applyObjects),
    });

    expect(report.failureReason).toBeUndefined();
    expect(report).toMatchObject({ verified: true, restored: true, rowCountMismatches: [] });
    expect(report.manifest?.exclusions).toEqual(
      expect.arrayContaining([
        'auth_data_skipped_by_operator',
        'supabase_migrations_skipped_by_operator',
      ]),
    );
    expect(report.manifest?.rowCounts['app.leads']).toBe(leadsAtDump);
    expect(report.manifest?.rowCounts['app.files']).toBe(1);

    expect(applyObjects).toHaveBeenCalledTimes(1);
    const objects = applyObjects.mock.calls[0]?.[0];
    expect([...(objects?.keys() ?? [])]).toEqual([OBJECT_ARTIFACT]);
    expect(objects?.get(OBJECT_ARTIFACT)).toEqual(FIXTURE);

    const restored = await connectDestination();
    expect(await count(restored, 'select count(*) from app.leads')).toBe(leadsAtDump);
    expect(
      await count(restored, `select count(*) from app.leads where id = '${LEAD_AFTER_BACKUP}'`),
    ).toBe(0);

    // RLS, policies and grants survived: the runtime role sees its tenant's
    // rows inside a tenant context and nothing without one.
    runtime = postgres(destinationRuntimeUrl, { max: 1, prepare: false, ssl: false });
    const tenantLeads = await runtime.begin(async (tx) => {
      await tx.unsafe(tenantContextStatement({ workspaceId: WORKSPACE_A, actorId: ACTOR }));
      return tx<{ id: string; workspaceId: string }[]>`
        select id, workspace_id as "workspaceId" from app.leads order by id
      `;
    });
    expect(tenantLeads).toEqual([{ id: LEAD_A, workspaceId: WORKSPACE_A }]);
    expect(await count(runtime, 'select count(*) from app.leads')).toBe(0);
  }, 120_000);

  test('one flipped byte in the data artifact stops the restore before the target is touched', async ({
    skip,
  }) => {
    if (reason) skip(`rehearsal skipped: ${reason}`);
    if (!runId) throw new Error('the rehearsal backup did not run');
    const key = `${runId}/data.sql.enc`;
    const stored = await archive.asReader().getObject(key);
    if (!stored) throw new Error(`${key} is not in the archive`);
    const tampered = Uint8Array.from(stored);
    const offset = Math.floor(tampered.byteLength / 2);
    tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
    await archive.asWriter().putObject(key, tampered);

    await runtime?.end();
    runtime = undefined;
    await destination?.end();
    destination = undefined;
    await recreateDatabase(DESTINATION_DATABASE);

    const applyObjects = vi.fn<RestoreTarget['applyObjects']>(async () => undefined);
    const report = await runRestore({
      runId,
      reader: archive.asReader(),
      decryptor: new TestEnvelopeDecryptor(keys.privateKeyBase64),
      target: restoreTarget(applyObjects),
    });

    expect(report).toMatchObject({
      verified: false,
      restored: false,
      failedStage: 'artifact_fetch_and_decrypt',
      mismatchedArtifacts: ['data.sql'],
      missingArtifacts: [],
    });
    expect(applyObjects).not.toHaveBeenCalled();
    const empty = await connectDestination();
    expect(await count(empty, "select count(*) from pg_namespace where nspname = 'app'")).toBe(0);
  }, 120_000);
});
