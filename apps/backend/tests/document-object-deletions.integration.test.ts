import { createHash, randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryR2DocumentStore } from '@gt-sales/adapters';
import { codePropertyCatalog } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  DatabaseObjectDeletionQueue,
  enqueueObjectDeletions,
  objectDeletionBackoffMs,
  STAGING_DELETE_MARGIN_MS,
} from '../src/documents/object-deletions.js';
import { DocumentService, type DocumentContextResolver } from '../src/documents/service.js';
import { DatabaseDocumentStore } from '../src/documents/store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseAbandonedLeadPruner } from '../src/retention/abandoned-leads.js';
import {
  ChangeRequestService,
  DatabaseChangeRequestStore,
} from '../src/tracking/change-requests.js';

/**
 * Issues #82 and #108: every copy of a document's upload is recorded for
 * deletion in the transaction that makes it disposable, and the cleanup
 * sweep removes it, retrying until storage confirms, never touching an
 * object a live file still points at. Storage is the in-memory fixture with
 * a switch that makes its deletes fail.
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
  return migrationUrl;
}

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Ids and slugs of this file only.
const SITE = '00000000-0000-4000-8000-00000000d801';
const STAFF = '00000000-0000-4000-8000-00000000d811';
const CREDENTIAL = '00000000-0000-4000-8000-00000000d812';
const SCHEDULER = '00000000-0000-4000-8000-00000000d813';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const EMAIL = 'objects.d801@example.com';
const PDF = new TextEncoder().encode('%PDF-1.4 synthetic test document d801');
const PDF_SHA256 = createHash('sha256').update(PDF).digest('hex');

/** The in-memory fixture, whose deletes fail while `failing` is above zero. */
class FlakyStorage extends InMemoryR2DocumentStore {
  failing = 0;
  deletes: string[] = [];
  override async deleteObject(input: {
    workspaceId: string;
    bucket: string;
    objectKey: string;
  }): Promise<void> {
    this.deletes.push(input.objectKey);
    if (this.failing > 0) {
      this.failing -= 1;
      throw new Error('r2_cleanup_failed');
    }
    await super.deleteObject(input);
  }
}

const resolver: DocumentContextResolver = {
  resolveChecklist: async () => ({ found: true, allowed: ['passport', 'visa'] }),
  resolveOrderLeadId: async () => undefined,
};

databaseTest('document object deletions (#82, #108)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let storage: FlakyStorage;
  let clock: Date;
  let documents: DocumentService;

  const scope = { workspaceId: SITE, actorId: STAFF };
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const queue = () => new DatabaseObjectDeletionQueue(database);
  const serviceWith = () =>
    new DocumentService(new DatabaseDocumentStore(database), storage, resolver, {
      bucket: 'documents',
      now: () => clock,
      objectDeletions: queue(),
    });
  const sweep = (service = documents) =>
    service.sweepExpired({ workspaceId: SITE, actorId: SCHEDULER });

  const insertLead = async (overrides: { status?: string; updatedAt?: Date } = {}) => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, full_name, email,
        payload, order_details, consent_version, updated_at)
      values (${SITE}, 'sim_order', ${overrides.status ?? 'submitted'},
        ${overrides.status === 'incomplete' ? 'incomplete' : 'pending'}, 'Dana Objects', ${EMAIL},
        ${admin.json({ schemaVersion: 1, payload: { delivery: 'esim' } })}, ${admin.json({ quantity: 1 })},
        'ci', ${overrides.updatedAt ?? new Date()})
      returning id
    `;
    if (!row) throw new Error('the lead was not inserted');
    return row.id;
  };

  /** A real upload through the service: intent, the customer's PUT, finalize. */
  const upload = async (
    leadId: string,
    options: { held?: true; actorId?: string; documentType?: string } = {},
  ) => {
    const actorId = options.actorId ?? STAFF;
    const created = await documents.createIntent({
      workspaceId: SITE,
      actorId,
      requestId: randomUUID(),
      recordType: 'lead',
      recordId: leadId,
      documentType: options.documentType ?? 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: PDF.byteLength,
      ...(options.held ? { held: true as const } : {}),
    });
    if (created.status !== 'created') throw new Error(`no intent: ${created.status}`);
    const [row] = await admin<{ stagingKey: string }[]>`
      select staging_key as "stagingKey" from app.files where id = ${created.uploadId}
    `;
    if (!row) throw new Error('no file row');
    storage.putStagingObject(row.stagingKey, PDF);
    const finalized = await documents.finalize({
      workspaceId: SITE,
      actorId,
      requestId: randomUUID(),
      fileId: created.uploadId,
      checksumSha256: PDF_SHA256,
    });
    if (finalized.status !== 'available') throw new Error(`not available: ${finalized.status}`);
    return {
      fileId: created.uploadId,
      stagingKey: row.stagingKey,
      objectKey: finalized.file.objectKey ?? '',
    };
  };

  const entries = () =>
    admin<
      {
        objectKey: string;
        reason: string;
        notBefore: Date;
        attempts: number;
        lastError: string | null;
        outcome: string | null;
      }[]
    >`
      select object_key as "objectKey", reason, not_before as "notBefore", attempts,
        last_error as "lastError", outcome
      from app.file_object_deletions where workspace_id = ${SITE} order by created_at, object_key
    `;
  const entry = async (objectKey: string) =>
    (await entries()).find((row) => row.objectKey === objectKey);

  const opens = async (fileId: string) =>
    (await documents.issueDownload({ ...scope, requestId: randomUUID(), fileId })).status;

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
      maxConnections: 4,
    });
  });

  beforeEach(async () => {
    clock = new Date();
    storage = new FlakyStorage();
    documents = serviceWith();
    // Deleting the site removes its leads, files, requests and deletion entries.
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'object-deletions-d801', 'Object Deletions Site')
    `;
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('deletes a finalized upload’s staging copy once its link has expired, and the document still opens', async () => {
    const leadId = await insertLead();
    const file = await upload(leadId);
    expect(file.objectKey).not.toBe(file.stagingKey);
    expect(storage.has(file.stagingKey)).toBe(true);
    const staged = await entry(file.stagingKey);
    expect(staged).toMatchObject({ reason: 'staging_after_attach', attempts: 0, outcome: null });
    const [row] = await admin<{ expiresAt: Date }[]>`
      select expires_at as "expiresAt" from app.files where id = ${file.fileId}
    `;
    expect(staged?.notBefore.getTime()).toBe(
      (row?.expiresAt.getTime() ?? 0) + STAGING_DELETE_MARGIN_MS,
    );

    // While the upload link could still write it, it stays.
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 0 });
    expect(storage.has(file.stagingKey)).toBe(true);

    later(10 * 60 * 1000 + STAGING_DELETE_MARGIN_MS);
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 1, failed: 0 });
    expect(storage.has(file.stagingKey)).toBe(false);
    expect(storage.has(file.objectKey)).toBe(true);
    expect(await entry(file.stagingKey)).toMatchObject({ outcome: 'deleted' });
    expect(await entry(file.objectKey)).toBeUndefined();
    expect(await opens(file.fileId)).toBe('issued');
  });

  it('keeps a deletion through a temporary storage failure and retries it after the backoff', async () => {
    const leadId = await insertLead();
    const file = await upload(leadId);
    later(10 * 60 * 1000 + STAGING_DELETE_MARGIN_MS);
    await sweep(); // the staging copy goes first
    expect(
      await documents.remove({ ...scope, requestId: randomUUID(), fileId: file.fileId }),
    ).toMatchObject({ status: 'tombstoned' });
    expect(await entry(file.objectKey)).toMatchObject({ reason: 'file_deleted', outcome: null });

    storage.failing = 1;
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 0, failed: 1 });
    expect(storage.has(file.objectKey)).toBe(true);
    expect(await entry(file.objectKey)).toMatchObject({
      attempts: 1,
      lastError: 'r2_cleanup_failed',
      outcome: null,
    });

    // Not before its backoff: the next hourly pass would wait.
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 0, failed: 0 });
    later(objectDeletionBackoffMs(1));
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 1, failed: 0 });
    expect(storage.has(file.objectKey)).toBe(false);
    expect(await entry(file.objectKey)).toMatchObject({
      attempts: 2,
      lastError: null,
      outcome: 'deleted',
    });
  });

  it('survives a restart between the commit and the delete, and between the claim and the delete', async () => {
    const leadId = await insertLead();
    const file = await upload(leadId);
    // The tombstone commits; the process dies before any storage call.
    await documents.remove({ ...scope, requestId: randomUUID(), fileId: file.fileId });
    expect(storage.has(file.objectKey)).toBe(true);

    // A sweep claims the entries and dies before deleting.
    later(10 * 60 * 1000 + STAGING_DELETE_MARGIN_MS);
    const claimed = await queue().claimDue({ ...scope, now: clock, limit: 10 });
    expect(claimed.claimed.map((row) => row.objectKey).sort()).toEqual(
      [file.stagingKey, file.objectKey].sort(),
    );

    // A new process, after the claim's backoff, finishes the work.
    later(objectDeletionBackoffMs(1));
    documents = serviceWith();
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 2 });
    expect(storage.has(file.objectKey)).toBe(false);
    expect(storage.has(file.stagingKey)).toBe(false);
  });

  it('retries a deletion that already happened safely, and never deletes a key a live file uses', async () => {
    const leadId = await insertLead();
    const gone = await upload(leadId, { documentType: 'visa' });
    const kept = await upload(leadId);
    later(10 * 60 * 1000 + STAGING_DELETE_MARGIN_MS);
    await sweep(); // both staging copies
    await documents.remove({ ...scope, requestId: randomUUID(), fileId: gone.fileId });
    // Something deleted the object already (the after-commit delete of a
    // decision, a run that died before recording it): the sweep's delete
    // finds it absent, which counts, and the entry completes.
    await storage.deleteObject({
      workspaceId: SITE,
      bucket: 'documents',
      objectKey: gone.objectKey,
    });
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 1, failed: 0 });
    expect(await entry(gone.objectKey)).toMatchObject({ outcome: 'deleted' });

    // The same object enqueued again (a repeated tombstone): it stays done.
    // The served object of a live file, enqueued by mistake: kept.
    await database.withTenantTx(scope, async (tx) => {
      await enqueueObjectDeletions(
        tx,
        SITE,
        [
          { bucket: 'documents', objectKey: gone.objectKey, reason: 'file_deleted' },
          { bucket: 'documents', objectKey: kept.objectKey, reason: 'file_deleted' },
        ],
        clock,
      );
    });
    expect(await entry(gone.objectKey)).toMatchObject({ outcome: 'deleted' });
    const result = (await sweep()).pendingDeletions;
    expect(result).toMatchObject({ deleted: 0, failed: 0, keptReferenced: 1 });
    expect(await entry(kept.objectKey)).toMatchObject({ outcome: 'kept_referenced' });
    expect(storage.has(kept.objectKey)).toBe(true);
    expect(await opens(kept.fileId)).toBe('issued');

    // Once that file is deleted after all, its kept entry is reopened and goes.
    await documents.remove({ ...scope, requestId: randomUUID(), fileId: kept.fileId });
    expect(await entry(kept.objectKey)).toMatchObject({ outcome: null, attempts: 0 });
    expect((await sweep()).pendingDeletions).toMatchObject({ deleted: 1 });
    expect(storage.has(kept.objectKey)).toBe(false);
  });

  it('removes every copy of a rejected and of a replaced change-request document; the approved one still opens', async () => {
    const leadId = await insertLead();
    // The passport staff approved earlier.
    const approved = await upload(leadId);
    await documents.review({
      ...scope,
      requestId: randomUUID(),
      fileId: approved.fileId,
      decision: 'approved',
    });
    const context = {
      emailEnvironment: customerEmailEnvironmentFromEnv({
        EMAIL_PROVIDER: 'fake',
        NODE_ENV: 'test',
        EMAIL_CONTACT_HASH_SECRET: 'object-deletions-contact-secret-0123',
      }),
    };
    const changes = new ChangeRequestService({
      store: new DatabaseChangeRequestStore(database),
      context,
      database,
      bucket: 'documents',
      objects: storage,
    });
    const website = { workspaceId: SITE, actorId: CREDENTIAL, requestId: randomUUID() };
    const first = await upload(leadId, { held: true, actorId: CREDENTIAL });
    const attached = await changes.attachDocument({
      ...website,
      leadId,
      normalizedEmail: EMAIL,
      fileId: first.fileId,
      now: clock,
    });
    if (attached.status !== 'saved') throw new Error(`not attached: ${attached.status}`);
    // The customer sends another passport: the first is replaced.
    const second = await upload(leadId, { held: true, actorId: CREDENTIAL });
    const replaced = await changes.attachDocument({
      ...website,
      leadId,
      normalizedEmail: EMAIL,
      fileId: second.fileId,
      now: clock,
    });
    if (replaced.status !== 'saved') throw new Error(`not replaced: ${replaced.status}`);
    const rejected = await changes.reject({
      workspaceId: SITE,
      actorId: STAFF,
      requestId: randomUUID(),
      catalog: codePropertyCatalog,
      leadId,
      changeRequestId: replaced.changeRequest.id,
      expectedVersion: replaced.changeRequest.version,
    });
    expect(rejected.status).toBe('rejected');

    later(10 * 60 * 1000 + STAGING_DELETE_MARGIN_MS);
    await sweep();
    for (const copy of [first.stagingKey, first.objectKey, second.stagingKey, second.objectKey]) {
      expect(storage.has(copy)).toBe(false);
      expect(await entry(copy)).toMatchObject({ outcome: 'deleted' });
    }
    expect(storage.has(approved.objectKey)).toBe(true);
    expect(storage.has(approved.stagingKey)).toBe(false);
    expect(await opens(approved.fileId)).toBe('issued');
  });

  it('keeps an abandoned draft’s erasure recorded when storage fails, and the sweep finishes it', async () => {
    const leadId = await insertLead({
      status: 'incomplete',
      updatedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
    });
    const file = await upload(leadId);
    await admin`
      update app.leads set updated_at = now() - interval '120 days' where id = ${leadId}
    `;
    storage.failing = 10;
    const pruner = new DatabaseAbandonedLeadPruner(database, { objects: storage });
    const run = await pruner.restrictAbandoned({ ...scope, actorId: SCHEDULER, now: new Date() });
    expect(run.restrictedLeads).toBe(1);
    expect(run.failedDeletes).toBeGreaterThan(0);
    expect(storage.has(file.objectKey)).toBe(true);
    expect(await entry(file.objectKey)).toMatchObject({ reason: 'file_deleted', outcome: null });

    storage.failing = 0;
    later(10 * 60 * 1000 + STAGING_DELETE_MARGIN_MS);
    await sweep();
    expect(storage.has(file.objectKey)).toBe(false);
    expect(storage.has(file.stagingKey)).toBe(false);
  });

  it('backfills earlier leftovers in bounded batches, once, and leaves every live object', async () => {
    const leadId = await insertLead();
    const key = (stage: string) => `${stage}/${SITE}/${randomUUID()}`;
    const legacy = {
      deletedStaging: key('staging'),
      deletedObject: key('candidate'),
      liveStaging: key('staging'),
      liveObject: key('candidate'),
    };
    // Files from before the deletion record: a deleted one still in storage,
    // and an available one whose staging copy was never removed.
    await admin`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, candidate_key, object_key, declared_content_type, detected_mime,
        declared_size_bytes, size_bytes, checksum_sha256, status, revision, uploaded_by,
        expires_at, finalized_at, deleted_at, created_at)
      values
        (${SITE}, 'lead', ${leadId}, 'visa', 'documents', ${legacy.deletedStaging},
          ${legacy.deletedObject}, ${legacy.deletedObject}, 'application/pdf', 'application/pdf',
          10, 10, ${PDF_SHA256}, 'deleted', 1, ${STAFF}, now() - interval '30 days',
          now() - interval '30 days', now() - interval '20 days', now() - interval '30 days'),
        (${SITE}, 'lead', ${leadId}, 'passport', 'documents', ${legacy.liveStaging},
          ${legacy.liveObject}, ${legacy.liveObject}, 'application/pdf', 'application/pdf',
          10, 10, ${PDF_SHA256}, 'available', 1, ${STAFF}, now() - interval '30 days',
          now() - interval '30 days', null, now() - interval '29 days')
    `;
    for (const objectKey of Object.values(legacy)) storage.putObject(objectKey, PDF);

    const first = await new DocumentService(
      new DatabaseDocumentStore(database),
      storage,
      resolver,
      {
        bucket: 'documents',
        now: () => clock,
        objectDeletions: queue(),
        deletionBackfillBatch: 2,
      },
    ).sweepExpired({ workspaceId: SITE, actorId: SCHEDULER });
    expect(first.pendingDeletions).toMatchObject({ backfilled: 2 });
    const second = await sweep();
    expect(second.pendingDeletions).toMatchObject({ backfilled: 1 });
    expect((await sweep()).pendingDeletions).toMatchObject({ backfilled: 0, deleted: 0 });

    expect(storage.has(legacy.deletedStaging)).toBe(false);
    expect(storage.has(legacy.deletedObject)).toBe(false);
    expect(storage.has(legacy.liveStaging)).toBe(false);
    expect(storage.has(legacy.liveObject)).toBe(true);
    expect((await entries()).every((row) => row.reason === 'backfill')).toBe(true);
  });
});
