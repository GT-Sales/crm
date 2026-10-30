import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CUSTOMER_EMAIL_JOB_TYPE, codePropertyCatalog } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { z } from 'zod';

import { DatabaseAutomationStore } from '../src/automations/store.js';
import { DatabaseDocumentStore } from '../src/documents/store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadWorkStore, type LeadUpdateContext } from '../src/leads/work-store.js';
import {
  ChangeRequestService,
  DatabaseChangeRequestStore,
  type DecideInput,
} from '../src/tracking/change-requests.js';

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

const SITE = '00000000-0000-4000-8000-000000006801';
const BARE_SITE = '00000000-0000-4000-8000-000000006802'; // no email settings
const CREDENTIAL = '00000000-0000-4000-8000-000000006811';
const STAFF = '00000000-0000-4000-8000-000000006812';
const COLLEAGUE = '00000000-0000-4000-8000-000000006813';
const OLD_PLAN = '00000000-0000-4000-8000-000000006821';
const OTHER_PLAN = '00000000-0000-4000-8000-000000006822';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const NEW_PHONE = '+1 437 555 0188';
const STAFF_PHONE = '+1 416 555 0000';
const REQUESTED = {
  fullName: 'Nadia Q. Khan',
  phone: NEW_PHONE,
  delivery: 'pickup' as const,
  shippingAddress: '100 Queen St W, Toronto ON',
  arrivalDate: '2026-12-15',
  planId: OTHER_PLAN,
};

const sortedKeys = (value: unknown) => z.array(z.string()).parse(value).sort();

const frozenPlan = {
  planId: OLD_PLAN,
  name: 'Old plan',
  priceMinor: 3000,
  currency: 'CAD',
  billingPeriod: '30_days',
  paymentRequired: false,
  requiredDocuments: ['passport'],
  properties: {},
  frozenAt: '2026-10-01T10:00:00.000Z',
};

databaseTest('approving and rejecting change requests', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseChangeRequestStore;
  let documents: DatabaseDocumentStore;
  let context: LeadUpdateContext;
  let service: ChangeRequestService;
  let work: DatabaseLeadWorkStore;
  let deleted: string[];

  const staff = (actorId = STAFF) => ({ actorId, requestId: crypto.randomUUID() });

  const insertLead = async (site = SITE, email: string | null = 'nadia.decide@example.com') => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, full_name, email, phone,
        payload, order_details, consent_version)
      values (${site}, 'sim_order', 'submitted', 'pending', 'Nadia Khan', ${email},
        '+1 647 555 0100', ${admin.json({ schemaVersion: 1, payload: { delivery: 'esim' } })},
        ${admin.json({ planId: OLD_PLAN, plan: frozenPlan, quantity: 1 })}, 'ci')
      returning id
    `;
    if (!row) throw new Error('the lead was not inserted');
    return row.id;
  };

  const currentPassport = async (site: string, leadId: string) => {
    const key = `candidate/${site}/${crypto.randomUUID()}`;
    const [row] = await admin<{ id: string }[]>`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, candidate_key, object_key, declared_content_type, detected_mime,
        declared_size_bytes, size_bytes, checksum_sha256, status, revision, uploaded_by,
        expires_at, finalized_at)
      values (${site}, 'lead', ${leadId}, 'passport', 'documents', ${key}, ${key}, ${key},
        'application/pdf', 'application/pdf', 10, 10, ${'f'.repeat(64)}, 'available', 50,
        ${STAFF}, now(), now())
      returning id
    `;
    if (!row) throw new Error('no file');
    return row.id;
  };

  const heldPassport = async (site: string, leadId: string) => {
    const scope = { workspaceId: site, actorId: CREDENTIAL };
    const file = await documents.createIntent({
      ...scope,
      requestId: crypto.randomUUID(),
      recordType: 'lead',
      recordId: leadId,
      documentType: 'passport',
      bucket: 'documents',
      stagingKey: `staging/${site}/${crypto.randomUUID()}`,
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 100,
      expiresAt: new Date(Date.now() + 60_000),
      held: true,
    });
    const candidateKey = `candidate/${site}/${file.id}`;
    await documents.claimForVerification({
      ...scope,
      fileId: file.id,
      candidateKey,
      now: new Date(),
    });
    await documents.attachVerified({
      ...scope,
      requestId: crypto.randomUUID(),
      fileId: file.id,
      candidateKey,
      objectKey: candidateKey,
      detectedMime: 'application/pdf',
      sizeBytes: 100,
      checksumSha256: 'e'.repeat(64),
    });
    return { fileId: file.id, objectKey: candidateKey };
  };

  /** A pending SIM order with the customer's request and a held passport: version 2. */
  const pendingRequest = async (
    site = SITE,
    email?: string | null,
    fields: Parameters<DatabaseChangeRequestStore['requestChange']>[0]['fields'] = REQUESTED,
  ) => {
    const leadId = await insertLead(site, email);
    const oldPassport = await currentPassport(site, leadId);
    const scope = { workspaceId: site, actorId: CREDENTIAL, requestId: crypto.randomUUID() };
    const saved = await store.requestChange({ ...scope, leadId, fields, now: new Date() });
    if (saved.status !== 'saved') throw new Error(`not saved: ${saved.status}`);
    const passport = await heldPassport(site, leadId);
    const attached = await store.attachDocument({
      ...scope,
      leadId,
      fileId: passport.fileId,
      now: new Date(),
    });
    if (attached.status !== 'saved') throw new Error(`not attached: ${attached.status}`);
    expect(attached.changeRequest.version).toBe(2);
    return { leadId, oldPassport, passport, request: attached.changeRequest };
  };

  const decide = (
    input: { leadId: string; changeRequestId: string; expectedVersion: number },
    site = SITE,
    actorId = STAFF,
  ): DecideInput => ({
    workspaceId: site,
    ...staff(actorId),
    catalog: codePropertyCatalog,
    ...input,
  });

  const timeline = (leadId: string) =>
    admin<{ kind: string; data: Record<string, unknown> }[]>`
      select kind, data from app.lead_activities where lead_id = ${leadId}
      order by created_at, id
    `;

  const fileRow = async (fileId: string) => {
    const [row] = await admin<{ held: boolean; status: string; supersededBy: string | null }[]>`
      select held_for_change_request as held, status, superseded_by_file_id as "supersededBy"
      from app.files where id = ${fileId}
    `;
    return row;
  };

  const requestRow = async (id: string) => {
    const [row] = await admin<
      { status: string; resolvedBy: string | null; resolvedAt: Date | null; version: number }[]
    >`
      select status, resolved_by as "resolvedBy", resolved_at as "resolvedAt", version
      from app.change_requests where id = ${id}
    `;
    return row;
  };

  const decisionJobs = (leadId: string) =>
    admin<{ dedupeKey: string; template: string }[]>`
      select dedupe_key as "dedupeKey", payload ->> 'template' as template from app.outbox_jobs
      where job_type = ${CUSTOMER_EMAIL_JOB_TYPE} and payload ->> 'leadId' = ${leadId}
      order by created_at, id
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
      maxConnections: 6,
    });
    store = new DatabaseChangeRequestStore(database);
    documents = new DatabaseDocumentStore(database);
    context = {
      emailEnvironment: customerEmailEnvironmentFromEnv({
        EMAIL_PROVIDER: 'fake',
        NODE_ENV: 'test',
        EMAIL_CONTACT_HASH_SECRET: 'change-decisions-contact-secret-0123',
      }),
      automations: new DatabaseAutomationStore(database),
    };
    work = new DatabaseLeadWorkStore(database, context.emailEnvironment, context.automations);
  });

  beforeEach(async () => {
    deleted = [];
    service = new ChangeRequestService({
      store,
      context,
      database,
      bucket: 'documents',
      objects: {
        deleteObject: async (input) => {
          deleted.push(input.objectKey);
        },
      },
    });
    // Deleting a site removes its leads, files, requests, jobs, plans and settings.
    await admin`delete from app.email_messages where workspace_id in (${SITE}, ${BARE_SITE})`;
    await admin`delete from app.workspaces where id in (${SITE}, ${BARE_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'change-decisions-681', 'Decisions Site'),
             (${BARE_SITE}, 'change-decisions-682', 'Decisions Bare Site')
    `;
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, price_minor, active, position)
      values (${OLD_PLAN}, ${SITE}, 'sim_order', 'Old plan', 3000, true, 0),
             (${OTHER_PLAN}, ${SITE}, 'sim_order', 'Unlimited 75', 4500, true, 1)
    `;
    await admin`
      insert into app.workspace_email_settings (workspace_id, from_name, from_address, updated_by)
      values (${SITE}, 'Decide Sim', 'orders@decide.example', ${STAFF})
    `;
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('approves through the lead update: values, plan, documents, entries and the mail', async () => {
    const { leadId, oldPassport, passport, request } = await pendingRequest();
    const outcome = await service.approve(
      decide({ leadId, changeRequestId: request.id, expectedVersion: 2 }),
    );
    if (outcome.status !== 'approved') throw new Error(`not approved: ${outcome.status}`);
    expect(outcome.emailSkipped).toBeUndefined();
    expect(outcome.lead).toMatchObject({
      contact: { fullName: REQUESTED.fullName, phone: NEW_PHONE },
      form: {
        payload: {
          delivery: 'pickup',
          shippingAddress: REQUESTED.shippingAddress,
          arrivalDate: REQUESTED.arrivalDate,
        },
      },
      order: { planId: OTHER_PLAN, plan: { planId: OTHER_PLAN, name: 'Unlimited 75' } },
    });

    const entries = await timeline(leadId);
    const edits = entries.filter((entry) => entry.kind === 'edit');
    expect(edits).toHaveLength(1);
    expect(sortedKeys(edits[0]?.data['fields'])).toEqual(
      ['arrivalDate', 'delivery', 'fullName', 'phone', 'plan', 'shippingAddress'].sort(),
    );
    const approved = entries.find((entry) => entry.data['event'] === 'change_approved');
    expect(approved?.data).toMatchObject({
      requestNo: request.requestNo,
      changeRequestId: request.id,
      documents: ['passport'],
    });
    expect(sortedKeys(approved?.data['fields'])).toEqual(
      ['arrivalDate', 'delivery', 'fullName', 'phone', 'planId', 'shippingAddress'].sort(),
    );
    expect(outcome.activities.map((activity) => activity.kind)).toContain('edit');

    // The customer's passport is current now, waiting for review; the old one replaced.
    expect(await fileRow(passport.fileId)).toEqual({
      held: false,
      status: 'available',
      supersededBy: null,
    });
    expect((await fileRow(oldPassport))?.supersededBy).toBe(passport.fileId);
    const page = await work.getLead({
      workspaceId: SITE,
      actorId: STAFF,
      catalog: codePropertyCatalog,
      leadId,
      includeWork: true,
    });
    expect(page?.documents).toEqual([
      expect.objectContaining({ id: passport.fileId, documentType: 'passport', review: null }),
    ]);
    expect(page?.changeRequest).toBeNull();

    expect(await requestRow(request.id)).toMatchObject({ status: 'approved', resolvedBy: STAFF });
    expect((await requestRow(request.id))?.resolvedAt).toBeInstanceOf(Date);
    expect(await decisionJobs(leadId)).toEqual([
      { dedupeKey: `${leadId}:change_approved:${request.id}`, template: 'change_approved' },
    ]);

    // Values only in the request row and the mail's job: never the timeline or the audit.
    const audit =
      await admin`select action, before, after from app.audit_events where entity_id = ${leadId}`;
    expect(audit.map((row) => row['action'])).toEqual(
      expect.arrayContaining(['lead.updated', 'lead.change_request_approved']),
    );
    // Every audit row of the lead, the approval's lead.updated among them.
    const trail = JSON.stringify([
      entries,
      await admin`select action, before, after from app.audit_events where entity_id = ${leadId}`,
    ]);
    expect(trail).not.toContain('555 0188');

    // Decided once.
    expect(
      await service.approve(decide({ leadId, changeRequestId: request.id, expectedVersion: 2 })),
    ).toEqual({ status: 'resolved' });
    expect(
      await service.reject(decide({ leadId, changeRequestId: request.id, expectedVersion: 2 })),
    ).toEqual({ status: 'resolved' });
  });

  it('refuses the version from before the customer replaced the request, writing nothing', async () => {
    const leadId = await insertLead();
    const scope = { workspaceId: SITE, actorId: CREDENTIAL, requestId: crypto.randomUUID() };
    const first = await store.requestChange({
      ...scope,
      leadId,
      fields: { phone: NEW_PHONE },
      now: new Date(),
    });
    if (first.status !== 'saved') throw new Error('not saved');
    await store.requestChange({ ...scope, leadId, fields: { fullName: 'Other' }, now: new Date() });
    const before = await timeline(leadId);
    expect(
      await service.approve(
        decide({ leadId, changeRequestId: first.changeRequest.id, expectedVersion: 1 }),
      ),
    ).toEqual({ status: 'version_conflict' });
    expect(await timeline(leadId)).toEqual(before);
    expect(await requestRow(first.changeRequest.id)).toMatchObject({
      status: 'pending',
      version: 2,
    });
    expect(
      await service.approve(
        decide({ leadId, changeRequestId: crypto.randomUUID(), expectedVersion: 2 }),
      ),
    ).toEqual({ status: 'not_found' });
    await admin`update app.leads set deleted_at = now() where id = ${leadId}`;
    expect(
      await service.approve(
        decide({ leadId, changeRequestId: first.changeRequest.id, expectedVersion: 2 }),
      ),
    ).toEqual({ status: 'trashed' });
  });

  it('serializes an approval with a staff edit of the same phone: both land, the later wins', async () => {
    const { leadId, request } = await pendingRequest();
    const started = Date.now();
    const [approved, edited] = await Promise.all([
      service.approve(decide({ leadId, changeRequestId: request.id, expectedVersion: 2 })),
      work.updateLead({
        workspaceId: SITE,
        ...staff(COLLEAGUE),
        catalog: codePropertyCatalog,
        leadId,
        contact: { phone: STAFF_PHONE },
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(approved.status).toBe('approved');
    expect(edited.status).toBe('updated');
    expect((await requestRow(request.id))?.status).toBe('approved');
    const edits = (await timeline(leadId)).filter((entry) => entry.kind === 'edit');
    expect(edits).toHaveLength(2);
    const [row] = await admin<
      { phone: string }[]
    >`select phone from app.leads where id = ${leadId}`;
    expect([NEW_PHONE, STAFF_PHONE]).toContain(row?.phone);
  });

  it('keeps whichever write committed last: a staff edit before the approval, or after it', async () => {
    const phoneOf = async (leadId: string) =>
      (await admin<{ phone: string }[]>`select phone from app.leads where id = ${leadId}`)[0]
        ?.phone;
    const editPhone = (leadId: string) =>
      work.updateLead({
        workspaceId: SITE,
        ...staff(COLLEAGUE),
        catalog: codePropertyCatalog,
        leadId,
        contact: { phone: STAFF_PHONE },
      });

    const first = await pendingRequest();
    await editPhone(first.leadId);
    await service.approve(
      decide({ leadId: first.leadId, changeRequestId: first.request.id, expectedVersion: 2 }),
    );
    expect(await phoneOf(first.leadId)).toBe(NEW_PHONE);

    const second = await pendingRequest();
    await service.approve(
      decide({ leadId: second.leadId, changeRequestId: second.request.id, expectedVersion: 2 }),
    );
    await editPhone(second.leadId);
    expect(await phoneOf(second.leadId)).toBe(STAFF_PHONE);
  });

  it('rolls back an approval whose plan is no longer sold: the request stays pending', async () => {
    const { leadId, passport, request } = await pendingRequest();
    await admin`update app.plans set active = false where id = ${OTHER_PLAN}`;
    expect(
      await service.approve(decide({ leadId, changeRequestId: request.id, expectedVersion: 2 })),
    ).toEqual({ status: 'invalid_field', field: 'plan' });
    expect((await requestRow(request.id))?.status).toBe('pending');
    expect((await fileRow(passport.fileId))?.held).toBe(true);
    const [row] = await admin<{ fullName: string; phone: string }[]>`
      select full_name as "fullName", phone from app.leads where id = ${leadId}
    `;
    expect(row).toEqual({ fullName: 'Nadia Khan', phone: '+1 647 555 0100' });
    expect((await timeline(leadId)).some((entry) => entry.kind === 'edit')).toBe(false);
  });

  it('rejects: the held files tombstoned and their objects deleted, the lead unchanged, the mail queued', async () => {
    const { leadId, oldPassport, passport, request } = await pendingRequest();
    const outcome = await service.reject(
      decide({ leadId, changeRequestId: request.id, expectedVersion: 2 }),
    );
    if (outcome.status !== 'rejected') throw new Error(`not rejected: ${outcome.status}`);
    expect(outcome.lead.contact.phone).toBe('+1 647 555 0100');
    expect((await fileRow(passport.fileId))?.status).toBe('deleted');
    expect((await fileRow(oldPassport))?.supersededBy).toBeNull();
    expect(deleted).toEqual([passport.objectKey]);
    expect(await requestRow(request.id)).toMatchObject({ status: 'rejected', resolvedBy: STAFF });
    expect((await requestRow(request.id))?.resolvedAt).toBeInstanceOf(Date);
    const rejected = (await timeline(leadId)).find(
      (entry) => entry.data['event'] === 'change_rejected',
    )?.data;
    expect(rejected).toMatchObject({
      event: 'change_rejected',
      requestNo: request.requestNo,
      changeRequestId: request.id,
      documents: ['passport'],
    });
    // Keys and document types only, as the request and the approval carry them.
    expect(sortedKeys(rejected?.['fields'])).toEqual(
      ['arrivalDate', 'delivery', 'fullName', 'phone', 'planId', 'shippingAddress'].sort(),
    );
    expect(JSON.stringify(rejected)).not.toContain('555 0188');
    expect(await decisionJobs(leadId)).toEqual([
      { dedupeKey: `${leadId}:change_rejected:${request.id}`, template: 'change_rejected' },
    ]);
  });

  it('decides anyway, and says why no mail went: no sender, or no customer address', async () => {
    const bare = await pendingRequest(BARE_SITE, undefined, { phone: NEW_PHONE });
    const noSender = await service.approve(
      decide(
        { leadId: bare.leadId, changeRequestId: bare.request.id, expectedVersion: 2 },
        BARE_SITE,
      ),
    );
    expect(noSender).toMatchObject({
      status: 'approved',
      emailSkipped: { template: 'change_approved', reason: 'no_sender' },
    });

    const noEmail = await pendingRequest(SITE, null);
    const outcome = await service.reject(
      decide({ leadId: noEmail.leadId, changeRequestId: noEmail.request.id, expectedVersion: 2 }),
    );
    expect(outcome).toMatchObject({
      status: 'rejected',
      emailSkipped: { template: 'change_rejected', reason: 'no_customer_email' },
    });
  });

  it('shows the pending request on the lead page until it is decided', async () => {
    const { leadId, passport, request } = await pendingRequest();
    const page = () =>
      work.getLead({
        workspaceId: SITE,
        actorId: STAFF,
        catalog: codePropertyCatalog,
        leadId,
        includeWork: true,
      });
    expect((await page())?.changeRequest).toMatchObject({
      id: request.id,
      requestNo: request.requestNo,
      status: 'pending',
      version: 2,
      fields: REQUESTED,
      documents: [{ fileId: passport.fileId, documentType: 'passport' }],
    });
    await service.reject(decide({ leadId, changeRequestId: request.id, expectedVersion: 2 }));
    expect((await page())?.changeRequest).toBeNull();
  });
});
