import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { codePropertyCatalog } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseDocumentStore } from '../src/documents/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';

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

// A distinct id range from the other integration suites sharing this database.
const WORKSPACE = '11000000-0000-4000-8000-0000000000f1';
const WORKSPACE_B = '11000000-0000-4000-8000-0000000000f2';
const ACTOR = '21000000-0000-4000-8000-0000000000f1';
const ACTOR_B = '21000000-0000-4000-8000-0000000000f2';
const REQUEST = '31000000-0000-4000-8000-0000000000f1';
let leadId = randomUUID();
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('DatabaseDocumentStore (T17)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseDocumentStore;
  let work: DatabaseLeadWorkStore;

  const intent = (recordId = leadId, stagingKey = `staging/${WORKSPACE}/${randomUUID()}`) => ({
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    requestId: REQUEST,
    recordType: 'lead' as const,
    recordId,
    documentType: 'passport',
    bucket: 'test-bucket',
    stagingKey,
    declaredContentType: 'application/pdf' as const,
    declaredSizeBytes: 100,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    for (const [id, slug] of [
      [WORKSPACE, 'docs-f1'],
      [WORKSPACE_B, 'docs-f2'],
    ] as const) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${id}, ${slug}, ${slug})
        on conflict (id) do nothing
      `;
    }
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    store = new DatabaseDocumentStore({ withTenantTx: database.withTenantTx.bind(database) });
    work = new DatabaseLeadWorkStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    // Isolate fixtures by parent ID; raw file deletion correctly requires a
    // customer-deletion acknowledgement now. The disposable DB owns teardown.
    leadId = randomUUID();
  });

  test('claim → attach makes exactly one available object and records a revision', async () => {
    const file = await store.createIntent(intent());
    expect(file.status).toBe('uploading');

    const claim = await store.claimForVerification({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId: file.id,
      candidateKey: `candidate/${WORKSPACE}/${file.id}/c1`,
      now: new Date(),
    });
    expect(claim.status).toBe('claimed');

    const attach = await store.attachVerified({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId: file.id,
      candidateKey: `candidate/${WORKSPACE}/${file.id}/c1`,
      objectKey: `candidate/${WORKSPACE}/${file.id}/c1`,
      detectedMime: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'a'.repeat(64),
    });
    expect(attach.status).toBe('attached');

    const revisions = await admin`
      select revision, checksum_sha256 from app.file_revisions where file_id = ${file.id}
    `;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.['checksum_sha256']).toBe('a'.repeat(64));
  });

  test('a second claim after attach observes already_available (idempotent finalize)', async () => {
    const file = await store.createIntent(intent());
    await store.claimForVerification({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId: file.id,
      candidateKey: `candidate/${WORKSPACE}/${file.id}/c1`,
      now: new Date(),
    });
    await store.attachVerified({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId: file.id,
      candidateKey: `candidate/${WORKSPACE}/${file.id}/c1`,
      objectKey: `candidate/${WORKSPACE}/${file.id}/c1`,
      detectedMime: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'a'.repeat(64),
    });
    const second = await store.claimForVerification({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId: file.id,
      candidateKey: `candidate/${WORKSPACE}/${file.id}/c2`,
      now: new Date(),
    });
    expect(second.status).toBe('already_available');
  });

  test('only one of two concurrent claims wins; the other sees in_progress', async () => {
    const file = await store.createIntent(intent());
    const [a, b] = await Promise.all([
      store.claimForVerification({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        fileId: file.id,
        candidateKey: `candidate/${WORKSPACE}/${file.id}/a`,
        now: new Date(),
      }),
      store.claimForVerification({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        fileId: file.id,
        candidateKey: `candidate/${WORKSPACE}/${file.id}/b`,
        now: new Date(),
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['claimed', 'in_progress']);
  });

  test('a foreign workspace cannot read another workspace’s file (RLS)', async () => {
    const file = await store.createIntent(intent());
    const foreign = await store.getFile({
      workspaceId: WORKSPACE_B,
      actorId: ACTOR_B,
      fileId: file.id,
    });
    expect(foreign).toBeUndefined();
  });

  test('review is recorded and surfaced as the latest decision', async () => {
    const file = await store.createIntent(intent());
    const reviewed = await store.recordReview({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId: file.id,
      decision: 'rejected',
      note: 'blurry scan',
    });
    expect(reviewed.status).toBe('recorded');
    const listed = await store.listFilesForRecord({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      recordType: 'lead',
      recordId: leadId,
    });
    expect(listed[0]?.latestReview?.decision).toBe('rejected');
  });

  /** A submitted order on the site, as the Get Canada Sim import leaves one. */
  const order = async (restricted = false) => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, consent_version, customer_data_restricted_at)
      values (${WORKSPACE}, 'sim_order', 'submitted', 'ci', ${restricted ? new Date() : null})
      returning id
    `;
    if (!row) throw new Error('lead insert returned nothing');
    return row.id;
  };

  const imported = (lead: string, overrides: { fileId?: string; checksum?: string } = {}) => {
    const fileId = overrides.fileId ?? randomUUID();
    return {
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      leadId: lead,
      documentType: 'passport',
      bucket: 'documents',
      objectKey: `candidate/${WORKSPACE}/legacy-${fileId}`,
      detectedMime: 'application/pdf' as const,
      sizeBytes: 2048,
      checksumSha256: overrides.checksum ?? 'b'.repeat(64),
      uploadedBy: '00000000-0000-4000-8000-00000000a001',
      uploadedAt: new Date('2026-09-01T10:00:00.000Z'),
    };
  };

  test('an imported document is available on its lead, once, and audited', async () => {
    const lead = await order();
    const input = imported(lead);
    const first = await store.insertImportedFile(input);
    expect(first).toMatchObject({
      status: 'imported',
      file: {
        id: input.fileId,
        status: 'available',
        objectKey: input.objectKey,
        detectedMime: 'application/pdf',
        revision: 1,
        createdAt: input.uploadedAt,
      },
    });
    expect(await store.insertImportedFile(input)).toMatchObject({
      status: 'exists',
      file: { id: input.fileId },
    });
    const [revision] = await admin`
      select revision, created_by from app.file_revisions where file_id = ${input.fileId}
    `;
    expect(revision).toMatchObject({ revision: 1, created_by: input.uploadedBy });
    const audits = await admin`
      select action, actor_id, after from app.audit_events where entity_id = ${input.fileId}
    `;
    expect(audits).toEqual([
      {
        action: 'file.imported',
        actor_id: ACTOR,
        after: { documentType: 'passport', revision: 1, checksumSha256: input.checksumSha256 },
      },
    ]);
  });

  test('a restricted or unknown lead takes no imported document', async () => {
    expect(await store.insertImportedFile(imported(await order(true)))).toEqual({
      status: 'lead_not_found',
    });
    expect(await store.insertImportedFile(imported(randomUUID()))).toEqual({
      status: 'lead_not_found',
    });
  });

  test('each review of a lead’s document writes one document entry on its timeline', async () => {
    const lead = await order();
    const input = imported(lead);
    await store.insertImportedFile(input);
    await store.recordReview({
      workspaceId: WORKSPACE,
      actorId: ACTOR_B,
      requestId: REQUEST,
      fileId: input.fileId,
      decision: 'approved',
    });
    await store.recordReview({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId: input.fileId,
      decision: 'rejected',
      note: 'expired passport',
    });
    const entries = await admin`
      select actor_id, kind, body, data from app.lead_activities
      where lead_id = ${lead}
      order by created_at, id
    `;
    expect(entries).toEqual([
      {
        actor_id: ACTOR_B,
        kind: 'document',
        body: null,
        data: { fileId: input.fileId, documentType: 'passport', decision: 'approved' },
      },
      {
        actor_id: ACTOR,
        kind: 'document',
        body: null,
        data: { fileId: input.fileId, documentType: 'passport', decision: 'rejected' },
      },
    ]);

    // The lead page shows the latest review on the document.
    const page = await work.getLead({
      workspaceId: WORKSPACE,
      catalog: codePropertyCatalog,
      actorId: ACTOR,
      leadId: lead,
      includeWork: true,
    });
    expect(page?.documents).toEqual([
      expect.objectContaining({
        id: input.fileId,
        review: { decision: 'rejected', at: expect.any(String) },
      }),
    ]);
    expect(page?.activities.filter((activity) => activity.kind === 'document')).toHaveLength(2);
  });

  test('a review of a file on another kind of record writes no lead timeline entry', async () => {
    // Even an order record that shares the id of a lead is not that lead.
    const recordId = await order();
    const file = await store.createIntent({ ...intent(), recordType: 'order', recordId });
    expect(
      await store.recordReview({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        requestId: REQUEST,
        fileId: file.id,
        decision: 'approved',
      }),
    ).toMatchObject({ status: 'recorded' });
    const entries = await admin`
      select 1 from app.lead_activities where lead_id = ${recordId}
    `;
    expect(entries).toHaveLength(0);
  });

  test('the lead page lists the current document of each type, not the ID check photo', async () => {
    const lead = await order();
    const older = imported(lead, { checksum: 'c'.repeat(64) });
    await store.insertImportedFile(older);
    const newer = imported(lead);
    await store.insertImportedFile(newer);
    await store.insertImportedFile({ ...imported(lead), documentType: 'sim_photo' });
    // A licence photo the customer gave for the credit check belongs to the ID check card.
    const licence = { ...imported(lead), documentType: 'drivers_licence' };
    await store.insertImportedFile(licence);
    await admin`
      insert into app.lead_identities (
        workspace_id, lead_id, id_type, file_id, credit_check_consent_at, created_by
      ) values (${WORKSPACE}, ${lead}, 'drivers_licence', ${licence.fileId}, now(), ${ACTOR})
    `;

    const page = await work.getLead({
      workspaceId: WORKSPACE,
      catalog: codePropertyCatalog,
      actorId: ACTOR,
      leadId: lead,
      includeWork: true,
    });
    const documents = [...(page?.documents ?? [])].sort((a, b) =>
      a.documentType.localeCompare(b.documentType),
    );
    expect(documents.map((document) => [document.documentType, document.revision])).toEqual([
      ['passport', 2],
      ['sim_photo', 1],
    ]);
    expect(documents[0]).toMatchObject({
      id: newer.fileId,
      review: null,
      contentType: 'application/pdf',
      sizeBytes: 2048,
      createdAt: '2026-09-01T10:00:00.000Z',
    });
  });
});
