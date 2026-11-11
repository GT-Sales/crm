import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseDraftGrantVerifier } from '../src/documents/grant.js';
import { hashDraftGrantToken } from '../src/leads/token.js';

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

const WORKSPACE = '11000000-0000-4000-8000-000000000f51';
const ACTOR = '21000000-0000-4000-8000-000000000f51';
const LEAD = '41000000-0000-4000-8000-000000000f51';
const TOKEN = 'gtdg_ci-draft-grant-documents-token';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// Audit L-1: a draft grant uploads and downloads only while its lead is a
// draft; submitting or archiving the lead ends it.
databaseTest('draft grant document rights (verifyLead)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let verifier: DatabaseDraftGrantVerifier;
  const verify = () =>
    verifier.verifyLead({ workspaceId: WORKSPACE, actorId: ACTOR, grantToken: TOKEN, now: NOW });

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-draft-grant-documents', 'CI Draft Grant Documents')
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version)
      values (${LEAD}, ${WORKSPACE}, 'sim_order', 'incomplete', 'incomplete', 'ci')
    `;
    await admin`
      insert into app.draft_grants (workspace_id, lead_id, token_hash, expires_at)
      values (${WORKSPACE}, ${LEAD}, ${hashDraftGrantToken(TOKEN)}, ${new Date(NOW.getTime() + 86_400_000)})
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    verifier = new DatabaseDraftGrantVerifier(database);
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await database?.close();
    await admin?.end();
  });

  test('works on a draft, not once it is archived or submitted', async () => {
    expect(await verify()).toBe(LEAD);

    await admin`update app.leads set deleted_at = ${NOW} where id = ${LEAD}`;
    expect(await verify()).toBeUndefined();

    await admin`update app.leads set deleted_at = null, status = 'submitted', stage = 'pending' where id = ${LEAD}`;
    expect(await verify()).toBeUndefined();
  });
});
