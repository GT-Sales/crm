import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { codePropertyCatalog } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseDocumentStore } from '../src/documents/store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { findMissingDocuments } from '../src/leads/documents-check.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import {
  ChangeRequestService,
  DatabaseChangeRequestStore,
  toStaffChangeRequest,
  toTrackingPendingChange,
} from '../src/tracking/change-requests.js';
import { DatabaseTrackingStore } from '../src/tracking/store.js';
import { getDisposableTestDatabaseUrl, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '00000000-0000-4000-8000-000000006701';
const CREDENTIAL = '00000000-0000-4000-8000-000000006711';
const LEGACY_ACTOR = '00000000-0000-4000-8000-00000000a001';
const ACTIVE_PLAN = '00000000-0000-4000-8000-000000006721';
const INACTIVE_PLAN = '00000000-0000-4000-8000-000000006722';
const OLD_PLAN = '00000000-0000-4000-8000-000000006723';
const NADIA = 'nadia.change@example.com';
const PHONE = '+1 647 555 0177';
const scope = { workspaceId: SITE, actorId: CREDENTIAL };

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

databaseTest('customer change requests and held documents', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseChangeRequestStore;
  let documents: DatabaseDocumentStore;

  const insertLead = async (values: {
    stage: string;
    leadType?: string;
    form?: Record<string, postgres.JSONValue>;
  }): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, full_name, email, phone,
        payload, order_details, consent_version)
      values (${SITE}, ${values.leadType ?? 'sim_order'}, 'submitted', ${values.stage},
        'Nadia Khan', ${NADIA}, '+1 647 555 0100',
        ${admin.json({ schemaVersion: 1, payload: values.form ?? { delivery: 'esim' } })},
        ${admin.json({ planId: OLD_PLAN, plan: frozenPlan, quantity: 1 })}, 'ci')
      returning id
    `;
    if (!row) throw new Error('the lead was not inserted');
    return row.id;
  };

  const requestChange = (
    leadId: string,
    fields: Parameters<typeof store.requestChange>[0]['fields'],
  ) =>
    store.requestChange({
      ...scope,
      normalizedEmail: NADIA,
      requestId: crypto.randomUUID(),
      leadId,
      fields,
      now: new Date(),
    });

  const timeline = (leadId: string) =>
    admin<{ data: Record<string, unknown> }[]>`
      select data from app.lead_activities
      where workspace_id = ${SITE} and lead_id = ${leadId} and kind = 'system'
        and data ->> 'event' = 'change_requested'
      order by created_at, id
    `;

  const audits = (leadId: string) =>
    admin<{ actorLabel: string; after: unknown }[]>`
      select actor_label as "actorLabel", after from app.audit_events
      where workspace_id = ${SITE} and entity_id = ${leadId} and action = 'lead.change_requested'
      order by created_at, id
    `;

  /** A customer's passport or visa, uploaded and finalized as held. */
  const heldFile = async (leadId: string, documentType: 'passport' | 'visa' = 'passport') => {
    const file = await documents.createIntent({
      ...scope,
      requestId: crypto.randomUUID(),
      recordType: 'lead',
      recordId: leadId,
      documentType,
      bucket: 'documents',
      stagingKey: `staging/${SITE}/${crypto.randomUUID()}`,
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 100,
      expiresAt: new Date(Date.now() + 60_000),
      held: true,
    });
    const candidateKey = `candidate/${SITE}/${file.id}`;
    await documents.claimForVerification({
      ...scope,
      fileId: file.id,
      candidateKey,
      now: new Date(),
    });
    const attached = await documents.attachVerified({
      ...scope,
      requestId: crypto.randomUUID(),
      fileId: file.id,
      candidateKey,
      objectKey: candidateKey,
      detectedMime: 'application/pdf',
      sizeBytes: 100,
      checksumSha256: 'e'.repeat(64),
    });
    expect(attached.status).toBe('attached');
    return { fileId: file.id, objectKey: candidateKey };
  };

  /** A staff-side current passport, approved. */
  const currentPassport = async (leadId: string) => {
    const key = `candidate/${SITE}/${crypto.randomUUID()}`;
    const [row] = await admin<{ id: string }[]>`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, candidate_key, object_key, declared_content_type, detected_mime,
        declared_size_bytes, size_bytes, checksum_sha256, status, revision, uploaded_by,
        expires_at, finalized_at)
      values (${SITE}, 'lead', ${leadId}, 'passport', 'documents', ${key}, ${key}, ${key},
        'application/pdf', 'application/pdf', 10, 10, ${'f'.repeat(64)}, 'available', 100,
        ${LEGACY_ACTOR}, now(), now())
      returning id
    `;
    if (!row) throw new Error('no file');
    await admin`
      insert into app.file_review_events (workspace_id, file_id, decision, actor_id)
      values (${SITE}, ${row.id}, 'approved', ${LEGACY_ACTOR})
    `;
    return row.id;
  };

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
    store = new DatabaseChangeRequestStore(database);
    documents = new DatabaseDocumentStore(database);
  });

  beforeEach(async () => {
    // Deleting the site removes its leads, files, requests, timeline and counters.
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'change-requests-671', 'Change Site')`;
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, active, position)
      values (${ACTIVE_PLAN}, ${SITE}, 'sim_order', 'Unlimited', true, 0),
             (${INACTIVE_PLAN}, ${SITE}, 'sim_order', 'Retired', false, 1),
             (${OLD_PLAN}, ${SITE}, 'sim_order', 'Old plan', true, 2)
    `;
    // The import wrote the old admin's requests up to #69 on the site's timeline.
    const imported = await insertLead({ stage: 'activated' });
    await admin`
      insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, data)
      values (${SITE}, ${imported}, ${LEGACY_ACTOR}, 'system',
              ${admin.json({ event: 'change_requested', requestNo: 69 })}),
             (${SITE}, ${imported}, ${LEGACY_ACTOR}, 'system',
              ${admin.json({ event: 'change_requested', requestNo: 12 })})
    `;
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('numbers a first request after the imported ones, records keys only, and replaces it in place', async () => {
    const lead = await insertLead({ stage: 'pending' });
    const first = await requestChange(lead, { phone: PHONE, arrivalDate: '2026-12-01' });
    if (first.status !== 'saved') throw new Error(`not saved: ${first.status}`);
    expect(first.changeRequest).toMatchObject({
      leadId: lead,
      requestNo: 70,
      status: 'pending',
      version: 1,
      requested: { phone: PHONE, arrivalDate: '2026-12-01' },
      stagedFiles: [],
    });
    expect(first.removedObjectKeys).toEqual([]);
    expect((await timeline(lead)).map((row) => row.data)).toEqual([
      {
        event: 'change_requested',
        requestNo: 70,
        changeRequestId: first.changeRequest.id,
        fields: ['phone', 'arrivalDate'],
        documents: [],
      },
    ]);
    const [audit] = await audits(lead);
    expect(audit).toMatchObject({
      actorLabel: 'website credential',
      after: {
        changeRequestId: first.changeRequest.id,
        requestNo: 70,
        fields: ['phone', 'arrivalDate'],
        documents: [],
      },
    });
    expect(JSON.stringify(await audits(lead))).not.toContain('555 0177');
    expect(JSON.stringify(await timeline(lead))).not.toContain('555 0177');
    // The lead itself is unchanged until staff approve.
    const [row] = await admin<{ phone: string }[]>`select phone from app.leads where id = ${lead}`;
    expect(row?.phone).toBe('+1 647 555 0100');

    const second = await requestChange(lead, { fullName: 'Nadia K. Khan' });
    if (second.status !== 'saved') throw new Error('not saved');
    expect(second.changeRequest).toMatchObject({
      id: first.changeRequest.id,
      requestNo: 70,
      version: 2,
      requested: { fullName: 'Nadia K. Khan' },
    });
    expect(second.changeRequest.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first.changeRequest.updatedAt.getTime(),
    );
  });

  it('serializes two requests at once into one pending row with one number', async () => {
    const lead = await insertLead({ stage: 'verified' });
    const [a, b] = await Promise.all([
      requestChange(lead, { phone: PHONE }),
      requestChange(lead, { fullName: 'Nadia Two' }),
    ]);
    expect([a.status, b.status]).toEqual(['saved', 'saved']);
    const rows = await admin<{ requestNo: number; version: number; status: string }[]>`
      select request_no as "requestNo", version, status from app.change_requests
      where workspace_id = ${SITE} and lead_id = ${lead}
    `;
    expect(rows).toEqual([{ requestNo: 70, version: 2, status: 'pending' }]);
    expect((await timeline(lead)).map((row) => row.data['requestNo'])).toEqual([70, 70]);
  });

  it('refuses an order that can no longer change, or is not a SIM order', async () => {
    const delivered = await insertLead({ stage: 'delivered' });
    expect(await requestChange(delivered, { phone: PHONE })).toEqual({ status: 'not_allowed' });
    const internet = await insertLead({ stage: 'new', leadType: 'internet' });
    expect(await requestChange(internet, { phone: PHONE })).toEqual({ status: 'not_allowed' });
    const archived = await insertLead({ stage: 'pending' });
    await admin`update app.leads set deleted_at = now() where id = ${archived}`;
    expect(await requestChange(archived, { phone: PHONE })).toEqual({ status: 'not_allowed' });
    expect(await requestChange(crypto.randomUUID(), { phone: PHONE })).toEqual({
      status: 'not_found',
    });
    expect(await admin`select 1 from app.change_requests where workspace_id = ${SITE}`).toEqual([]);
  });

  it('checks the plan and the shipping address a pickup needs', async () => {
    const lead = await insertLead({ stage: 'pending' });
    expect(await requestChange(lead, { planId: INACTIVE_PLAN })).toEqual({
      status: 'invalid_field',
      field: 'planId',
    });
    expect(await requestChange(lead, { planId: crypto.randomUUID() })).toEqual({
      status: 'invalid_field',
      field: 'planId',
    });
    expect(await requestChange(lead, { delivery: 'pickup' })).toEqual({
      status: 'invalid_field',
      field: 'shippingAddress',
    });
    expect(
      (await requestChange(lead, { delivery: 'pickup', shippingAddress: '1 Front St W, Toronto' }))
        .status,
    ).toBe('saved');
    expect((await requestChange(lead, { planId: ACTIVE_PLAN })).status).toBe('saved');
    // A stored address is enough for a pickup.
    const withAddress = await insertLead({
      stage: 'pending',
      form: { delivery: 'esim', shippingAddress: '9 King St, Toronto' },
    });
    expect((await requestChange(withAddress, { delivery: 'pickup' })).status).toBe('saved');
  });

  it('holds a customer’s passport back until approval, and joins it to the pending request', async () => {
    const lead = await insertLead({ stage: 'pending' });
    const current = await currentPassport(lead);
    const first = await heldFile(lead);
    const work = new DatabaseLeadWorkStore(database);
    const page = await work.getLead({
      ...scope,
      catalog: codePropertyCatalog,
      leadId: lead,
      includeWork: true,
    });
    // The current passport stays current; the held one is not on the Documents card.
    expect(page?.documents.map((document) => document.id)).toEqual([current]);
    expect(
      await database.withTenantTx(scope, (tx) =>
        findMissingDocuments(tx, { workspaceId: SITE, leadId: lead, required: ['passport'] }),
      ),
    ).toEqual([]);

    const requested = await requestChange(lead, { phone: PHONE });
    if (requested.status !== 'saved') throw new Error('not saved');
    const attached = await store.attachDocument({
      ...scope,
      normalizedEmail: NADIA,
      requestId: crypto.randomUUID(),
      leadId: lead,
      fileId: first.fileId,
      now: new Date(),
    });
    if (attached.status !== 'saved') throw new Error(`not saved: ${attached.status}`);
    expect(attached.changeRequest).toMatchObject({
      requestNo: 70,
      version: 2,
      requested: { phone: PHONE },
      stagedFiles: [{ fileId: first.fileId, documentType: 'passport' }],
    });
    expect((await timeline(lead)).at(-1)?.data).toMatchObject({
      requestNo: 70,
      fields: [],
      documents: ['passport'],
    });

    // A second held passport replaces the first: tombstoned, its object to delete.
    const second = await heldFile(lead);
    const replaced = await store.attachDocument({
      ...scope,
      normalizedEmail: NADIA,
      requestId: crypto.randomUUID(),
      leadId: lead,
      fileId: second.fileId,
      now: new Date(),
    });
    if (replaced.status !== 'saved') throw new Error('not saved');
    expect(replaced.removedObjectKeys).toEqual([first.objectKey]);
    expect(replaced.changeRequest.stagedFiles).toEqual([
      { fileId: second.fileId, documentType: 'passport' },
    ]);
    expect(replaced.changeRequest.version).toBe(3);
    const [tombstoned] = await admin<{ status: string }[]>`
      select status from app.files where id = ${first.fileId}
    `;
    expect(tombstoned?.status).toBe('deleted');

    // Visible to staff and to the customer, values and documents both.
    const pending = await database.withTenantTx(scope, (tx) =>
      store.pendingForLead(tx, SITE, lead),
    );
    if (!pending) throw new Error('no pending request');
    expect(toStaffChangeRequest(pending)).toMatchObject({
      requestNo: 70,
      status: 'pending',
      fields: { phone: PHONE },
      documents: [{ fileId: second.fileId, documentType: 'passport' }],
      version: 3,
    });
    expect(toTrackingPendingChange(pending)).toMatchObject({
      requestNo: 70,
      fields: { phone: PHONE },
      documents: ['passport'],
    });
    const listed = await new DatabaseTrackingStore(database).listOrders({
      ...scope,
      normalizedEmail: NADIA,
    });
    const order = listed.find((entry) => entry.reference === lead);
    expect(order?.pendingChange).toMatchObject({
      requestNo: 70,
      fields: { phone: PHONE },
      documents: ['passport'],
    });
    const others = listed.filter((entry) => entry.reference !== lead);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((entry) => entry.pendingChange === null)).toBe(true);
  });

  it('opens a request with no fields for a document sent on its own, numbered next', async () => {
    const lead = await insertLead({ stage: 'on_hold' });
    await requestChange(await insertLead({ stage: 'pending' }), { phone: PHONE });
    const { fileId } = await heldFile(lead, 'visa');
    const outcome = await store.attachDocument({
      ...scope,
      normalizedEmail: NADIA,
      requestId: crypto.randomUUID(),
      leadId: lead,
      fileId,
      now: new Date(),
    });
    if (outcome.status !== 'saved') throw new Error(`not saved: ${outcome.status}`);
    expect(outcome.changeRequest).toMatchObject({
      requestNo: 71,
      version: 1,
      requested: {},
      stagedFiles: [{ fileId, documentType: 'visa' }],
    });
    // A file that is not this lead's held upload joins nothing.
    const other = await insertLead({ stage: 'pending' });
    expect(
      await store.attachDocument({
        ...scope,
        normalizedEmail: NADIA,
        requestId: crypto.randomUUID(),
        leadId: other,
        fileId,
        now: new Date(),
      }),
    ).toEqual({ status: 'not_found' });
  });

  it('adds a document straight to an order that has none of that type, without a staff decision', async () => {
    const lead = await insertLead({ stage: 'pending' });
    const { fileId } = await heldFile(lead, 'passport');
    const requestId = crypto.randomUUID();
    const outcome = await store.attachDocument({
      ...scope,
      normalizedEmail: NADIA,
      requestId,
      leadId: lead,
      fileId,
      now: new Date(),
    });
    // The website's answer keeps its shape: the request it made.
    if (outcome.status !== 'saved') throw new Error(`not saved: ${outcome.status}`);
    expect(outcome.changeRequest.stagedFiles).toEqual([{ fileId, documentType: 'passport' }]);

    // The file is the order's current passport, on the Documents card.
    const page = await new DatabaseLeadWorkStore(database).getLead({
      ...scope,
      catalog: codePropertyCatalog,
      leadId: lead,
      includeWork: true,
    });
    expect(page?.documents.map((document) => document.id)).toEqual([fileId]);
    expect(page?.changeRequest ?? null).toBeNull();
    const [request] = await admin<{ status: string; resolved_by: string | null }[]>`
      select status, resolved_by from app.change_requests where lead_id = ${lead}
    `;
    expect(request).toEqual({ status: 'approved', resolved_by: scope.actorId });
    const [approval] = await admin<{ data: Record<string, unknown> }[]>`
      select data from app.lead_activities
      where lead_id = ${lead} and data ->> 'event' = 'change_approved'
    `;
    expect(approval?.data).toMatchObject({
      event: 'change_approved',
      fields: [],
      documents: ['passport'],
      automatic: true,
    });
    expect(
      await admin`
        select action from app.audit_events
        where request_id = ${requestId} order by created_at, action
      `,
    ).toEqual(
      expect.arrayContaining([
        { action: 'file.released' },
        { action: 'lead.change_request_approved' },
      ]),
    );
    // Nothing is left pending for the customer either.
    const listed = await new DatabaseTrackingStore(database).listOrders({
      ...scope,
      normalizedEmail: NADIA,
    });
    expect(listed.find((entry) => entry.reference === lead)?.pendingChange).toBeNull();

    // A second passport now replaces one, so it waits for staff.
    const second = await heldFile(lead, 'passport');
    const replacing = await store.attachDocument({
      ...scope,
      normalizedEmail: NADIA,
      requestId: crypto.randomUUID(),
      leadId: lead,
      fileId: second.fileId,
      now: new Date(),
    });
    if (replacing.status !== 'saved') throw new Error('not saved');
    const pending = await database.withTenantTx(scope, (tx) =>
      store.pendingForLead(tx, SITE, lead),
    );
    expect(pending?.stagedFiles).toEqual([{ fileId: second.fileId, documentType: 'passport' }]);
  });

  it('keeps a document waiting for staff when the same request changes a detail', async () => {
    const lead = await insertLead({ stage: 'pending' });
    expect((await requestChange(lead, { phone: PHONE })).status).toBe('saved');
    const { fileId } = await heldFile(lead, 'visa');
    const outcome = await store.attachDocument({
      ...scope,
      normalizedEmail: NADIA,
      requestId: crypto.randomUUID(),
      leadId: lead,
      fileId,
      now: new Date(),
    });
    if (outcome.status !== 'saved') throw new Error('not saved');
    const pending = await database.withTenantTx(scope, (tx) =>
      store.pendingForLead(tx, SITE, lead),
    );
    expect(pending).toMatchObject({
      requested: { phone: PHONE },
      stagedFiles: [{ fileId, documentType: 'visa' }],
    });
    const [file] = await admin<{ held: boolean }[]>`
      select held_for_change_request as held from app.files where id = ${fileId}
    `;
    expect(file?.held).toBe(true);
  });

  it('audits a replaced held file only when it was still there to tombstone', async () => {
    const lead = await insertLead({ stage: 'pending' });
    // The order has a passport already, so each new one waits for staff.
    await currentPassport(lead);
    const first = await heldFile(lead);
    const join = (fileId: string) =>
      store.attachDocument({
        ...scope,
        normalizedEmail: NADIA,
        requestId: crypto.randomUUID(),
        leadId: lead,
        fileId,
        now: new Date(),
      });
    expect((await join(first.fileId)).status).toBe('saved');
    // Gone already (staff removed it): replacing it deletes and audits nothing.
    await admin`update app.files set status = 'deleted', deleted_at = now() where id = ${first.fileId}`;
    const second = await heldFile(lead);
    const replaced = await join(second.fileId);
    if (replaced.status !== 'saved') throw new Error('not saved');
    expect(replaced.removedObjectKeys).toEqual([]);
    expect(
      await admin`select 1 from app.audit_events where entity_id = ${first.fileId} and action = 'file.deleted'`,
    ).toEqual([]);
    // A held file still there is tombstoned and audited.
    const third = await heldFile(lead);
    expect((await join(third.fileId)).status).toBe('saved');
    expect(
      await admin`select 1 from app.audit_events where entity_id = ${second.fileId} and action = 'file.deleted'`,
    ).toHaveLength(1);
  });

  it('discards a finalized held file that can join no request, but never one a pending request holds', async () => {
    const deleteObject = vi.fn(async () => undefined);
    const service = new ChangeRequestService({
      store,
      context: {
        emailEnvironment: customerEmailEnvironmentFromEnv({
          EMAIL_CONTACT_HASH_SECRET: 'change-requests-contact-secret-01',
        }),
      },
      objects: { deleteObject },
      bucket: 'documents',
      database,
    });
    const attach = (leadId: string, fileId: string) =>
      service.attachDocument({
        ...scope,
        normalizedEmail: NADIA,
        requestId: crypto.randomUUID(),
        leadId,
        fileId,
        now: new Date(),
      });
    const fileState = async (fileId: string) =>
      (
        await admin<{ status: string; held: boolean }[]>`
          select status, held_for_change_request as held from app.files where id = ${fileId}
        `
      )[0];

    // The order left the changeable stages between the finalize and the join.
    const lead = await insertLead({ stage: 'pending' });
    const orphan = await heldFile(lead);
    await admin`update app.leads set stage = 'delivered' where id = ${lead}`;
    expect(await attach(lead, orphan.fileId)).toEqual({ status: 'not_allowed' });
    expect(await fileState(orphan.fileId)).toEqual({ status: 'deleted', held: true });
    expect(deleteObject).toHaveBeenCalledWith({
      workspaceId: SITE,
      bucket: 'documents',
      objectKey: orphan.objectKey,
    });
    expect(
      await admin`
        select after from app.audit_events
        where entity_id = ${orphan.fileId} and action = 'file.deleted'
      `,
    ).toEqual([{ after: { status: 'deleted', reason: 'change_request_not_allowed' } }]);

    // A file already joined to a pending request stays for staff to decide.
    deleteObject.mockClear();
    const kept = await insertLead({ stage: 'pending' });
    await currentPassport(kept);
    const joined = await heldFile(kept);
    expect((await attach(kept, joined.fileId)).status).toBe('saved');
    await admin`update app.leads set stage = 'delivered' where id = ${kept}`;
    expect(await attach(kept, joined.fileId)).toEqual({ status: 'not_allowed' });
    expect(await fileState(joined.fileId)).toEqual({ status: 'available', held: true });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('refuses a customer whose email is no longer the order’s, writing nothing', async () => {
    const lead = await insertLead({ stage: 'pending' });
    const held = await heldFile(lead);
    // Staff moved the order to another customer after the order was found by the grant's email.
    await admin`update app.leads set email = 'someone.else@example.com' where id = ${lead}`;

    expect(await requestChange(lead, { phone: PHONE })).toEqual({ status: 'not_found' });
    expect(
      await store.attachDocument({
        ...scope,
        normalizedEmail: NADIA,
        requestId: crypto.randomUUID(),
        leadId: lead,
        fileId: held.fileId,
        now: new Date(),
      }),
    ).toEqual({ status: 'not_found' });
    expect(
      await store.isHeldUpload({
        ...scope,
        normalizedEmail: NADIA,
        leadId: lead,
        fileId: held.fileId,
      }),
    ).toBe(false);
    expect(await timeline(lead)).toEqual([]);
    const [requests] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.change_requests where lead_id = ${lead}
    `;
    expect(requests?.count).toBe(0);

    // The new owner's own email is accepted, and a different case or padding of it too.
    expect(
      (
        await store.requestChange({
          ...scope,
          normalizedEmail: 'someone.else@example.com',
          requestId: crypto.randomUUID(),
          leadId: lead,
          fields: { phone: PHONE },
          now: new Date(),
        })
      ).status,
    ).toBe('saved');
    await admin`update app.leads set email = '  Nadia.Change@Example.com ' where id = ${lead}`;
    expect((await requestChange(lead, { fullName: 'Nadia K.' })).status).toBe('saved');
  });

  it('knows a held upload of the lead from any other file', async () => {
    const lead = await insertLead({ stage: 'pending' });
    const other = await insertLead({ stage: 'pending' });
    const held = await heldFile(lead);
    const plain = await currentPassport(lead);
    const isHeld = (leadId: string, fileId: string) =>
      store.isHeldUpload({ ...scope, normalizedEmail: NADIA, leadId, fileId });
    expect(await isHeld(lead, held.fileId)).toBe(true);
    expect(await isHeld(lead, plain)).toBe(false);
    expect(await isHeld(other, held.fileId)).toBe(false);
    expect(await isHeld(lead, crypto.randomUUID())).toBe(false);
    // An intent not yet finalized is a held upload too.
    const intent = await documents.createIntent({
      ...scope,
      requestId: crypto.randomUUID(),
      recordType: 'lead',
      recordId: lead,
      documentType: 'visa',
      bucket: 'documents',
      stagingKey: `staging/${SITE}/${crypto.randomUUID()}`,
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 100,
      expiresAt: new Date(Date.now() + 60_000),
      held: true,
    });
    expect(await isHeld(lead, intent.id)).toBe(true);
    await admin`update app.files set status = 'deleted' where id = ${held.fileId}`;
    expect(await isHeld(lead, held.fileId)).toBe(false);
  });
});
