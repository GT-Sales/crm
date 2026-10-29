import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../src/migrations.js';
import { setTestBackupReaderPassword, TEST_BACKUP_READER_PASSWORD } from '../src/test-helpers.js';

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

  return migrationUrl;
}

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WORKSPACE_A = '12000000-0000-4000-8000-000000000701';
const WORKSPACE_B = '12000000-0000-4000-8000-000000000702';
const LEAD_A = '13000000-0000-4000-8000-000000000701';
const LEAD_B = '13000000-0000-4000-8000-000000000702';
const REFUSED_LEAD = '13000000-0000-4000-8000-000000000703';

databaseTest('backup_reader role, grants and read policies', () => {
  let admin: ReturnType<typeof postgres>;
  let readerSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await setTestBackupReaderPassword(admin);

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_A}, 'ci-backup-reader-a', 'CI Backup Reader A'),
        (${WORKSPACE_B}, 'ci-backup-reader-b', 'CI Backup Reader B')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version)
      values
        (${LEAD_A}, ${WORKSPACE_A}, 'contact_message', 'submitted', 'ci-v1'),
        (${LEAD_B}, ${WORKSPACE_B}, 'contact_message', 'submitted', 'ci-v1')
      on conflict (id) do nothing
    `;

    const readerUrl = new URL(migrationUrl);
    readerUrl.username = 'backup_reader';
    readerUrl.password = TEST_BACKUP_READER_PASSWORD;
    readerSql = postgres(readerUrl.toString(), { max: 1, prepare: false, ssl: false });
  });

  afterAll(async () => {
    await readerSql?.end();
    if (admin) {
      await admin`delete from app.leads where id in (${LEAD_A}, ${LEAD_B}, ${REFUSED_LEAD})`;
      await admin`delete from app.workspaces where id in (${WORKSPACE_A}, ${WORKSPACE_B})`;
      await admin.end();
    }
  });

  it('creates backup_reader as a login role without superuser or bypassrls', async () => {
    const rows = await admin<
      { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }[]
    >`
      select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole
      from pg_roles
      where rolname = 'backup_reader'
    `;

    expect(rows).toEqual([
      { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false },
    ]);
  });

  it('every RLS table in app has a SELECT policy for backup_reader', async () => {
    const rlsTables = await admin<{ tablename: string }[]>`
      select tablename from pg_tables
      where schemaname = 'app' and rowsecurity
      order by tablename
    `;
    const policies = await admin<
      { tablename: string; policyname: string; permissive: string; qual: string }[]
    >`
      select tablename, policyname, permissive, qual
      from pg_policies
      where schemaname = 'app'
        and cmd = 'SELECT'
        and 'backup_reader' = any(roles)
      order by tablename
    `;

    expect(rlsTables.length).toBeGreaterThan(0);
    expect(policies).toEqual(
      rlsTables.map(({ tablename }) => ({
        tablename,
        policyname: `${tablename}_backup_reader_read`,
        permissive: 'PERMISSIVE',
        qual: 'true',
      })),
    );
  });

  it('backup_reader can SELECT every app table and cannot INSERT, UPDATE or DELETE', async () => {
    const privileges = await admin<
      {
        tablename: string;
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
      }[]
    >`
      select
        tablename,
        has_table_privilege('backup_reader', format('app.%I', tablename), 'SELECT') as "canSelect",
        has_table_privilege('backup_reader', format('app.%I', tablename), 'INSERT') as "canInsert",
        has_table_privilege('backup_reader', format('app.%I', tablename), 'UPDATE') as "canUpdate",
        has_table_privilege('backup_reader', format('app.%I', tablename), 'DELETE') as "canDelete"
      from pg_tables
      where schemaname = 'app'
      order by tablename
    `;

    expect(privileges.length).toBeGreaterThan(0);
    for (const row of privileges) {
      expect(row).toEqual({
        tablename: row.tablename,
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
      });
    }
  });

  it('backup_reader sees every workspace without tenant context', async () => {
    const [identity] = await readerSql<{ user: string; workspaceId: string | null }[]>`
      select current_user as "user", nullif(current_setting('app.workspace_id', true), '') as "workspaceId"
    `;
    expect(identity).toEqual({ user: 'backup_reader', workspaceId: null });

    const [row] = await readerSql<{ count: number }[]>`
      select count(*)::int as count from app.leads where id in (${LEAD_A}, ${LEAD_B})
    `;
    expect(row?.count).toBe(2);
  });

  it('an insert as backup_reader is refused with permission denied', async () => {
    await expect(
      readerSql`
        insert into app.leads (id, workspace_id, lead_type, status, consent_version)
        values (${REFUSED_LEAD}, ${WORKSPACE_A}, 'contact_message', 'submitted', 'ci-v1')
      `,
    ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied/) });
  });
});
