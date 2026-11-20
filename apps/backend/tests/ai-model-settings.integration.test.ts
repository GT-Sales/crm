import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseAiModelSchemaProbe, fixedAiModelSchema } from '../src/ai/model-schema.js';
import { DatabaseAiModelSettingsStore } from '../src/ai/model-settings-store.js';

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

const SITE = '11000000-0000-4000-8000-000000000d91';
const OTHER_SITE = '11000000-0000-4000-8000-000000000d92';
const ACTOR = '21000000-0000-4000-8000-000000000d91';
const REQUEST_ONE = '51000000-0000-4000-8000-000000000d91';
const REQUEST_TWO = '51000000-0000-4000-8000-000000000d92';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// Migration 0040: a site's Ask AI models, one row per site under the tenant
// policy and FORCE RLS, written by an upsert with an ids-only audit event.
databaseTest('Ask AI model settings (app.ai_model_settings)', () => {
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
      values (${SITE}, 'ci-ai-models', 'CI AI models'), (${OTHER_SITE}, 'ci-ai-models-b', 'CI AI models B')
      on conflict (id) do nothing
    `;
    // Re-runnable: clear what this file asserts on.
    await admin`delete from app.ai_model_settings where workspace_id in (${SITE}, ${OTHER_SITE})`;
    await admin`delete from app.audit_events where workspace_id in (${SITE}, ${OTHER_SITE})`;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  test('the catalogue check sees the table and every grant 0040 gives the runtime role', async () => {
    const probe = new DatabaseAiModelSchemaProbe(database);
    expect(await probe.ready({ workspaceId: SITE, actorId: ACTOR })).toBe(true);
    const [flags] = await admin<{ forced: boolean; deletes: boolean }[]>`
      select c.relforcerowsecurity as forced,
        has_table_privilege('app_runtime', 'app.ai_model_settings', 'DELETE') as deletes
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relname = 'ai_model_settings'
    `;
    expect(flags).toEqual({ forced: true, deletes: false });
  });

  test('saves, replaces and reads a site’s list, with ids-only audit events', async () => {
    const store = new DatabaseAiModelSettingsStore(database);
    const scope = { workspaceId: SITE, actorId: ACTOR };
    expect(await store.get(scope)).toBeUndefined();

    const first = await store.save(
      { ...scope, requestId: REQUEST_ONE },
      {
        allowedModels: [
          { id: 'vendor-a/model-one', label: 'Model One' },
          { id: 'vendor-b/model-two', label: 'Model Two' },
        ],
        defaultModel: 'vendor-b/model-two',
      },
    );
    expect(first.status).toBe('saved');
    const second = await store.save(
      { ...scope, requestId: REQUEST_TWO },
      {
        allowedModels: [{ id: 'vendor-c/model-three', label: 'Model Three' }],
        defaultModel: 'vendor-c/model-three',
      },
    );
    expect(second.status).toBe('saved');
    expect(await store.get(scope)).toMatchObject({
      allowedModels: [{ id: 'vendor-c/model-three', label: 'Model Three' }],
      defaultModel: 'vendor-c/model-three',
    });

    const audits = await admin<
      { action: string; entity: string; before: unknown; after: unknown; request_id: string }[]
    >`
      select action, entity, before, after, request_id from app.audit_events
      where workspace_id = ${SITE} and action = 'ai.models_updated'
      order by created_at, request_id
    `;
    expect(audits).toEqual([
      {
        action: 'ai.models_updated',
        entity: 'ai_model_settings',
        before: null,
        after: {
          allowedModels: ['vendor-a/model-one', 'vendor-b/model-two'],
          defaultModel: 'vendor-b/model-two',
        },
        request_id: REQUEST_ONE,
      },
      {
        action: 'ai.models_updated',
        entity: 'ai_model_settings',
        before: {
          allowedModels: ['vendor-a/model-one', 'vendor-b/model-two'],
          defaultModel: 'vendor-b/model-two',
        },
        after: { allowedModels: ['vendor-c/model-three'], defaultModel: 'vendor-c/model-three' },
        request_id: REQUEST_TWO,
      },
    ]);
    // A label is never audited.
    expect(JSON.stringify(audits)).not.toContain('Model Three');
  });

  test('a site sees only its own row, and the runtime role cannot delete one', async () => {
    const store = new DatabaseAiModelSettingsStore(database);
    expect(await store.get({ workspaceId: OTHER_SITE, actorId: ACTOR })).toBeUndefined();
    const visible = (workspaceId: string) =>
      database.withTenantTx({ workspaceId, actorId: ACTOR }, (tx) =>
        tx.execute<{ count: number }>(
          sql`select count(*)::int as count from app.ai_model_settings`,
        ),
      );
    expect((await visible(SITE))[0]?.count).toBe(1);
    expect((await visible(OTHER_SITE))[0]?.count).toBe(0);
    await expect(
      database.withTenantTx({ workspaceId: SITE, actorId: ACTOR }, (tx) =>
        tx.execute(sql`delete from app.ai_model_settings where workspace_id = ${SITE}`),
      ),
    ).rejects.toThrow();
    // Another site's transaction cannot write this site's row.
    await expect(
      database.withTenantTx({ workspaceId: OTHER_SITE, actorId: ACTOR }, (tx) =>
        tx.execute(sql`
          insert into app.ai_model_settings (workspace_id, allowed_models, default_model, updated_by)
          values (${SITE}, '[{"id":"vendor-a/model-one","label":"One"}]'::jsonb, 'vendor-a/model-one', ${ACTOR})
        `),
      ),
    ).rejects.toThrow();
  });

  test('the table refuses a default outside the list and more than eight models', async () => {
    const insert = (models: { id: string; label: string }[], defaultModel: string) => admin`
      insert into app.ai_model_settings (workspace_id, allowed_models, default_model, updated_by)
      values (${OTHER_SITE}, ${admin.json(models)}, ${defaultModel}, ${ACTOR})
    `;
    await expect(
      insert([{ id: 'vendor-a/model-one', label: 'One' }], 'vendor-b/model-two'),
    ).rejects.toMatchObject({ constraint_name: 'ai_model_settings_default_model_check' });
    const nine = Array.from({ length: 9 }, (_, index) => ({
      id: `v/m-${String(index)}`,
      label: 'M',
    }));
    await expect(insert(nine, 'v/m-0')).rejects.toMatchObject({
      constraint_name: 'ai_model_settings_allowed_models_check',
    });
    await expect(insert([], 'v/m-0')).rejects.toThrow();
  });

  test('before 0040 the store reads nothing and saves nothing, touching no table', async () => {
    const store = new DatabaseAiModelSettingsStore(database, fixedAiModelSchema(false));
    const scope = { workspaceId: SITE, actorId: ACTOR };
    expect(await store.available(scope)).toBe(false);
    expect(await store.get(scope)).toBeUndefined();
    expect(
      await store.save(
        { ...scope, requestId: REQUEST_ONE },
        {
          allowedModels: [{ id: 'vendor-a/model-one', label: 'One' }],
          defaultModel: 'vendor-a/model-one',
        },
      ),
    ).toEqual({ status: 'unavailable' });
  });
});
