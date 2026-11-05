import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseDocumentReviewQueue } from '../src/documents/review-queue.js';

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

const SITE = '00000000-0000-4000-8000-000000007901';
const OTHER = '00000000-0000-4000-8000-000000007902';
const ACTOR = '00000000-0000-4000-8000-00000000b001';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const frozenPlan = {
  planId: '00000000-0000-4000-8000-000000007911',
  name: 'Rogers 60GB',
  priceMinor: 4000,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: ['passport'],
  properties: {},
  frozenAt: '2026-11-01T12:00:00.000Z',
};

databaseTest('Documents review queue', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let queue: DatabaseDocumentReviewQueue;

  async function insertLead(
    site: string,
    values: { name: string; required?: boolean; archived?: boolean },
  ): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, full_name, email,
        payload, order_details, consent_version, external_ref, deleted_at, customer_data_restricted_at)
      values (${site}, 'sim_order', 'submitted', 'pending', ${values.name},
        ${`${values.name.toLowerCase().replace(/ /g, '.')}@example.test`},
        ${admin.json({ schemaVersion: 1, payload: { delivery: 'esim' } })},
        ${admin.json(values.required ? { planId: frozenPlan.planId, plan: frozenPlan, quantity: 1 } : {})},
        'ci', ${`MS-${values.name.length}${Math.floor(Math.random() * 100000)}`},
        ${values.archived ? new Date() : null}, null)
      returning id
    `;
    if (!row) throw new Error('no lead');
    return row.id;
  }

  async function insertFile(
    site: string,
    leadId: string,
    documentType: string,
    options: { review?: 'approved' | 'rejected'; createdAt?: string; supersededBy?: string } = {},
  ): Promise<string> {
    const key = `candidate/${site}/${crypto.randomUUID()}`;
    const [row] = await admin<{ id: string }[]>`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, candidate_key, object_key, declared_content_type, detected_mime,
        declared_size_bytes, size_bytes, checksum_sha256, status, uploaded_by,
        expires_at, finalized_at, created_at, superseded_by_file_id)
      values (${site}, 'lead', ${leadId}, ${documentType}, 'documents', ${key}, ${key}, ${key},
        'application/pdf', 'application/pdf', 10, 10, ${'f'.repeat(64)}, 'available', ${ACTOR},
        now(), now(), ${options.createdAt ?? '2026-11-03T12:00:00Z'}, ${options.supersededBy ?? null})
      returning id
    `;
    if (!row) throw new Error('no file');
    if (options.review) {
      await admin`
        insert into app.file_review_events (workspace_id, file_id, decision, actor_id)
        values (${site}, ${row.id}, ${options.review}, ${ACTOR})
      `;
    }
    return row.id;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 2,
    });
    queue = new DatabaseDocumentReviewQueue(database);
  });

  beforeEach(async () => {
    // Deleting the sites removes their leads and files.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'review-queue-791', 'Queue Site'), (${OTHER}, 'review-queue-792', 'Other Site')
    `;
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id in (${SITE}, ${OTHER})`;
    await admin?.end();
    await database?.close();
  });

  const scope = { workspaceId: SITE, actorId: ACTOR };

  it('lists unreviewed current documents, required ones first then oldest, with both totals', async () => {
    const nadia = await insertLead(SITE, { name: 'Nadia Khan', required: true });
    const omar = await insertLead(SITE, { name: 'Omar Haddad' });
    const older = await insertFile(SITE, omar, 'visa', { createdAt: '2026-11-01T12:00:00Z' });
    const passport = await insertFile(SITE, nadia, 'passport', {
      createdAt: '2026-11-04T12:00:00Z',
    });
    const rejected = await insertFile(SITE, omar, 'work_permit', { review: 'rejected' });
    await insertFile(SITE, nadia, 'visa', { review: 'approved' });

    const page = await queue.list(scope, { status: 'to_review', page: 1 });
    expect(page.counts).toEqual({ toReview: 2, rejected: 1 });
    expect(page.total).toBe(2);
    expect(page.items.map((item) => [item.document.id, item.required])).toEqual([
      [passport, true],
      [older, false],
    ]);
    expect(page.items[0]?.lead).toMatchObject({
      id: nadia,
      leadType: 'sim_order',
      stage: 'pending',
      name: 'Nadia Khan',
    });
    expect(page.items[0]?.document).toMatchObject({
      documentType: 'passport',
      contentType: 'application/pdf',
      review: null,
    });

    const rejectedPage = await queue.list(scope, { status: 'rejected', page: 1 });
    expect(rejectedPage.items.map((item) => item.document.id)).toEqual([rejected]);
    expect(rejectedPage.items[0]?.document.review?.decision).toBe('rejected');
  });

  it('leaves out archived and restricted leads, replaced files and other sites', async () => {
    const archived = await insertLead(SITE, { name: 'Archived Lead', archived: true });
    const restricted = await insertLead(SITE, { name: 'Restricted Lead' });
    const active = await insertLead(SITE, { name: 'Active Lead' });
    const elsewhere = await insertLead(OTHER, { name: 'Elsewhere Lead' });
    await insertFile(SITE, archived, 'passport');
    await insertFile(SITE, restricted, 'passport');
    // A restricted lead takes no new files, so it is restricted after its upload.
    await admin`update app.leads set customer_data_restricted_at = now() where id = ${restricted}`;
    const newer = await insertFile(SITE, active, 'passport', { createdAt: '2026-11-04T12:00:00Z' });
    await insertFile(SITE, active, 'passport', {
      createdAt: '2026-11-02T12:00:00Z',
      supersededBy: newer,
    });
    await insertFile(OTHER, elsewhere, 'passport');

    const page = await queue.list(scope, { status: 'to_review', page: 1 });
    expect(page.items.map((item) => item.document.id)).toEqual([newer]);
    expect(page.counts).toEqual({ toReview: 1, rejected: 0 });
  });

  it('reports the total past the last page', async () => {
    const lead = await insertLead(SITE, { name: 'Paged Lead' });
    await insertFile(SITE, lead, 'passport');
    const beyond = await queue.list(scope, { status: 'to_review', page: 3 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(1);
  });
});
