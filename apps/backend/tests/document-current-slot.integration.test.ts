import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseDocumentStore } from '../src/documents/store.js';
import { findMissingDocuments } from '../src/leads/documents-check.js';
import { DatabaseTrackingStore } from '../src/tracking/store.js';
import { getDisposableTestDatabaseUrl, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

/**
 * Issue #81: one current file per lead and document type. Overlapping
 * attaches of one slot leave exactly one current file, the database refuses a
 * second, and the documents check and tracking read that same file.
 */

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Ids and slugs of this file only.
const SITE = '00000000-0000-4000-8000-00000000c801';
const STAFF = '00000000-0000-4000-8000-00000000c811';
const CREDENTIAL = '00000000-0000-4000-8000-00000000c812';
const EMAIL = 'slots.c801@example.com';
const UNIQUE_VIOLATION = '23505';

databaseTest('one current document per lead and type (#81)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let documents: DatabaseDocumentStore;
  const scope = { workspaceId: SITE, actorId: STAFF };

  const insertLead = async () => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, full_name, email,
        external_ref, order_details, consent_version)
      values (${SITE}, 'sim_order', 'submitted', 'pending', 'Cora Slots', ${EMAIL},
        ${`MS-${Math.floor(Math.random() * 1e9)}`}, ${admin.json({ quantity: 1 })}, 'ci')
      returning id
    `;
    if (!row) throw new Error('no lead');
    return row.id;
  };

  /** An upload claimed for verification, ready for its attach. */
  const verifying = async (leadId: string) => {
    const file = await documents.createIntent({
      ...scope,
      requestId: randomUUID(),
      recordType: 'lead',
      recordId: leadId,
      documentType: 'passport',
      bucket: 'documents',
      stagingKey: `staging/${SITE}/${randomUUID()}`,
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 100,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const candidateKey = `candidate/${SITE}/${randomUUID()}`;
    await documents.claimForVerification({
      ...scope,
      fileId: file.id,
      candidateKey,
      now: new Date(),
    });
    return { fileId: file.id, candidateKey };
  };
  const attach = (file: { fileId: string; candidateKey: string }) =>
    documents.attachVerified({
      ...scope,
      requestId: randomUUID(),
      fileId: file.fileId,
      candidateKey: file.candidateKey,
      objectKey: file.candidateKey,
      detectedMime: 'application/pdf',
      sizeBytes: 100,
      checksumSha256: 'c'.repeat(64),
    });

  const current = (leadId: string) =>
    admin<{ id: string }[]>`
      select id from app.files
      where workspace_id = ${SITE} and record_id = ${leadId} and document_type = 'passport'
        and status = 'available' and superseded_by_file_id is null
        and not held_for_change_request
    `;

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
      maxConnections: 8,
    });
    documents = new DatabaseDocumentStore(database);
  });

  beforeEach(async () => {
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`
      insert into app.workspaces (id, slug, name) values (${SITE}, 'current-slot-c801', 'Slot Site')
    `;
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('two overlapping attaches of one slot leave exactly one current file', async () => {
    for (let round = 0; round < 5; round += 1) {
      const leadId = await insertLead();
      const files = await Promise.all([verifying(leadId), verifying(leadId), verifying(leadId)]);
      const outcomes = await Promise.all(files.map(attach));
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'attached',
        'attached',
        'attached',
      ]);
      const rows = await current(leadId);
      expect(rows).toHaveLength(1);
      // Every other one is superseded (each by the attach that came after it).
      const superseded = await admin<{ by: string | null }[]>`
        select superseded_by_file_id as by from app.files
        where workspace_id = ${SITE} and record_id = ${leadId} and id <> ${rows[0]?.id ?? ''}
      `;
      expect(superseded).toHaveLength(2);
      expect(superseded.every((row) => row.by !== null)).toBe(true);
    }
  });

  it('the database refuses a second current file of a slot', async () => {
    const leadId = await insertLead();
    await attach(await verifying(leadId));
    const error = await admin`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, candidate_key, object_key, declared_content_type, detected_mime,
        declared_size_bytes, size_bytes, checksum_sha256, status, uploaded_by, expires_at)
      values (${SITE}, 'lead', ${leadId}, 'passport', 'documents', ${`staging/${randomUUID()}`},
        ${`candidate/${randomUUID()}`}, ${`candidate/${randomUUID()}`}, 'application/pdf',
        'application/pdf', 10, 10, ${'d'.repeat(64)}, 'available', ${STAFF}, now())
    `.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('the documents check and tracking read the same current file: the newest, unreviewed', async () => {
    const leadId = await insertLead();
    const older = await verifying(leadId);
    await attach(older);
    await documents.recordReview({
      ...scope,
      requestId: randomUUID(),
      fileId: older.fileId,
      decision: 'approved',
    });
    const missing = () =>
      database.withTenantTx(scope, (tx) =>
        findMissingDocuments(tx, { workspaceId: SITE, leadId, required: ['passport'] }),
      );
    const tracked = async () => {
      const orders = await new DatabaseTrackingStore(database).listOrders({
        workspaceId: SITE,
        actorId: CREDENTIAL,
        normalizedEmail: EMAIL,
      });
      return orders[0]?.documents.find((document) => document.documentType === 'passport')?.state;
    };
    expect(await missing()).toEqual([]);
    expect(await tracked()).toBe('approved');

    // A newer upload replaces it: the old approval is not carried over.
    await attach(await verifying(leadId));
    expect(await missing()).toEqual(['passport']);
    expect(await tracked()).toBe('received');
  });

  it('an import made current over an existing file supersedes it first', async () => {
    const leadId = await insertLead();
    const uploaded = await verifying(leadId);
    await attach(uploaded);
    const fileId = randomUUID();
    const imported = await documents.insertImportedFile({
      ...scope,
      requestId: randomUUID(),
      fileId,
      leadId,
      documentType: 'passport',
      bucket: 'documents',
      objectKey: `candidate/${SITE}/legacy-${fileId}`,
      detectedMime: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'e'.repeat(64),
      uploadedBy: STAFF,
      uploadedAt: new Date(),
    });
    expect(imported.status).toBe('imported');
    expect(await current(leadId)).toEqual([{ id: fileId }]);
  });
});
