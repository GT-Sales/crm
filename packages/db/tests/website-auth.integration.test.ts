import { createHash } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/index.js';
import { applyMigrations } from '../src/migrations.js';
import { seedDatabase } from '../src/seed.js';

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

const WORKSPACE = '11000000-0000-4000-8000-000000000601';
const ACTIVE_SECRET = 'gtsk_integration_active_secret_value';
const REVOKED_SECRET = 'gtsk_integration_revoked_secret_value';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

databaseTest('website credential and rate-limit bootstrap', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;
  let tenantDatabase: DatabaseClient;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    await seedDatabase({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });

    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-website', 'CI Website Workspace')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.service_credentials (workspace_id, secret_hash, scopes)
      values
        (${WORKSPACE}, ${sha256(ACTIVE_SECRET)}, ARRAY['leads:write', 'uploads:customer']),
        (${WORKSPACE}, ${sha256(REVOKED_SECRET)}, ARRAY['leads:write'])
      on conflict (secret_hash) do nothing
    `;
    await admin`
      update app.service_credentials
      set revoked_at = now()
      where secret_hash = ${sha256(REVOKED_SECRET)}
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
    tenantDatabase = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
  });

  afterAll(async () => {
    await tenantDatabase.close();
    await runtimeSql.end();
    await admin.end();
  });

  test('resolves an active credential to its own workspace and scopes without tenant context', async () => {
    const resolution = await tenantDatabase.resolveWebsiteCredential(sha256(ACTIVE_SECRET));
    expect(resolution).toEqual({
      credentialId: expect.any(String),
      workspaceId: WORKSPACE,
      scopes: ['leads:write', 'uploads:customer'],
      revoked: false,
    });
  });

  test('credential resolution remains executable only by the runtime role', async () => {
    const [privileges] = await admin<{ public_execute: boolean; runtime_execute: boolean }[]>`
      select
        has_function_privilege('public', 'app.resolve_website_credential(text)', 'execute') as public_execute,
        has_function_privilege('app_runtime', 'app.resolve_website_credential(text)', 'execute') as runtime_execute
    `;
    expect(privileges).toEqual({ public_execute: false, runtime_execute: true });
  });

  test('reports a revoked credential as revoked', async () => {
    const resolution = await tenantDatabase.resolveWebsiteCredential(sha256(REVOKED_SECRET));
    expect(resolution?.revoked).toBe(true);
  });

  test('returns nothing for an unknown secret hash', async () => {
    expect(
      await tenantDatabase.resolveWebsiteCredential(sha256('gtsk_never_issued')),
    ).toBeUndefined();
  });

  test('runtime role cannot read credentials directly without tenant context', async () => {
    const rows = await runtimeSql`select id from app.service_credentials`;
    expect(rows).toHaveLength(0);
  });

  test('runtime role cannot touch the rate-limit table directly', async () => {
    await expect(runtimeSql`select bucket_key from app.rate_limit_buckets`).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('rate limiter allows up to the maximum then denies with a retry hint', async () => {
    const key = `ci:rl:${Date.now()}`;
    const first = await tenantDatabase.rateLimitHit({
      bucketKey: key,
      windowSeconds: 60,
      maxCount: 2,
    });
    const second = await tenantDatabase.rateLimitHit({
      bucketKey: key,
      windowSeconds: 60,
      maxCount: 2,
    });
    const third = await tenantDatabase.rateLimitHit({
      bucketKey: key,
      windowSeconds: 60,
      maxCount: 2,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('rate-limit buckets are independent per key (no global counter)', async () => {
    const keyA = `ci:rl:a:${Date.now()}`;
    const keyB = `ci:rl:b:${Date.now()}`;
    await tenantDatabase.rateLimitHit({ bucketKey: keyA, windowSeconds: 60, maxCount: 1 });
    const overA = await tenantDatabase.rateLimitHit({
      bucketKey: keyA,
      windowSeconds: 60,
      maxCount: 1,
    });
    const freshB = await tenantDatabase.rateLimitHit({
      bucketKey: keyB,
      windowSeconds: 60,
      maxCount: 1,
    });

    expect(overA.allowed).toBe(false);
    expect(freshB.allowed).toBe(true);
  });

  test('a key outside the literal character set is bound, and counts as its own key', async () => {
    const key = `ci:rl:o'brien%${Date.now()}`;
    const first = await tenantDatabase.rateLimitHit({
      bucketKey: key,
      windowSeconds: 60,
      maxCount: 1,
    });
    const second = await tenantDatabase.rateLimitHit({
      bucketKey: key,
      windowSeconds: 60,
      maxCount: 1,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });
});
