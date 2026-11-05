import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseAiTurnStore } from '../src/ai/turn-store.js';

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

const SITE = '11000000-0000-4000-8000-000000000e61';
const OTHER_SITE = '11000000-0000-4000-8000-000000000e62';
const ACTOR = '21000000-0000-4000-8000-000000000e61';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// CHAT-6: each Ask AI turn leaves one row of counts, visible to its own site
// only, which the runtime can add but never change or delete.
databaseTest('Ask AI turn records (app.ai_turns)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'ci-ai-turns', 'CI AI turns'), (${OTHER_SITE}, 'ci-ai-turns-b', 'CI AI turns B')
      on conflict (id) do nothing
    `;
    await admin`delete from app.ai_turns where workspace_id in (${SITE}, ${OTHER_SITE})`;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  test('records a turn as counts, readable by its own site only', async () => {
    const store = new DatabaseAiTurnStore(database);
    await store.record({
      requestId: '51000000-0000-4000-8000-000000000e61',
      workspaceId: SITE,
      actorId: ACTOR,
      engine: 'gateway',
      modelId: 'example/model',
      promptVersion: 9,
      outcome: 'failed',
      durationMs: 1234.6,
      outputTokens: 321,
      failureCode: 'provider_unavailable',
      toolCalls: 2,
      records: 7,
      dataBytes: 2048,
    });

    const [row] = await admin<
      {
        engine: string;
        model: string;
        outcome: string;
        failure_code: string;
        duration_ms: number;
        output_tokens: number;
        tool_calls: number;
        records: number;
        data_bytes: number;
        recovered_draft: boolean;
      }[]
    >`
      select engine, model, outcome, failure_code, duration_ms, output_tokens, tool_calls,
        records, data_bytes, recovered_draft
      from app.ai_turns where workspace_id = ${SITE}
    `;
    expect(row).toEqual({
      engine: 'gateway',
      model: 'example/model',
      outcome: 'failed',
      failure_code: 'provider_unavailable',
      duration_ms: 1235,
      output_tokens: 321,
      tool_calls: 2,
      records: 7,
      data_bytes: 2048,
      recovered_draft: false,
    });

    const visible = (workspaceId: string) =>
      database.withTenantTx({ workspaceId, actorId: ACTOR }, (tx) =>
        tx.execute<{ count: number }>(sql`select count(*)::int as count from app.ai_turns`),
      );
    expect((await visible(SITE))[0]?.count).toBe(1);
    expect((await visible(OTHER_SITE))[0]?.count).toBe(0);
  });

  test('cannot be changed or deleted by the runtime, and forces RLS', async () => {
    const [grants] = await admin<{ update: boolean; delete: boolean; forced: boolean }[]>`
      select
        has_table_privilege('app_runtime', 'app.ai_turns', 'update') as update,
        has_table_privilege('app_runtime', 'app.ai_turns', 'delete') as delete,
        (select relforcerowsecurity from pg_class where oid = 'app.ai_turns'::regclass) as forced
    `;
    expect(grants).toEqual({ update: false, delete: false, forced: true });
  });
});
