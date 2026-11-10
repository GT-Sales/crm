import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

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
const WORKSPACE = '11000000-0000-4000-8000-000000000f61';
const ACTOR = '21000000-0000-4000-8000-000000000f61';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// Audits L-7 and L-8: the readiness ping and the tenant transactions' limits.
databaseTest('runtime limits', () => {
  let database: DatabaseClient;
  let broken: DatabaseClient;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    const admin = postgres(migrationUrl, {
      max: 1,
      prepare: false,
      ssl: false,
      onnotice: () => {},
    });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin.end();
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    runtimeUrl.password = 'not-the-password';
    broken = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    await database?.close();
    await broken?.close();
  });

  test('the readiness ping answers with a working URL and throws with a wrong one', async () => {
    await expect(database.ping(3_000)).resolves.toBeUndefined();
    await expect(broken.ping(3_000)).rejects.toThrow();
  });

  test('every tenant transaction carries a statement and idle timeout, which a read may raise', async () => {
    const settings = await database.withTenantTx(
      { workspaceId: WORKSPACE, actorId: ACTOR },
      async (tx) => {
        const [before] = await tx.execute<{ statement: string; idle: string }>(
          sql`select current_setting('statement_timeout') as statement,
          current_setting('idle_in_transaction_session_timeout') as idle`,
        );
        await tx.execute(sql`select set_config('statement_timeout', '60000', true)`);
        const [after] = await tx.execute<{ statement: string }>(
          sql`select current_setting('statement_timeout') as statement`,
        );
        return { before, after };
      },
    );
    expect(settings).toEqual({
      before: { statement: '15s', idle: '30s' },
      after: { statement: '1min' },
    });

    const refused = await database
      .withTenantTx({ workspaceId: WORKSPACE, actorId: ACTOR }, async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '100', true)`);
        await tx.execute(sql`select pg_sleep(1)`);
        return 'ran';
      })
      .catch((error: unknown) =>
        error instanceof Error && error.cause instanceof Error ? error.cause.message : 'other',
      );
    expect(refused).toMatch(/statement timeout/);
  });
});
