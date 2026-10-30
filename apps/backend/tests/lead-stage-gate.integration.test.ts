import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEAD_ORDER,
  codePropertyCatalog,
  freezePlan,
  type CreatePlanRequest,
  type LeadOrder,
  type Plan,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseDocumentStore } from '../src/documents/store.js';
import { todayInToronto } from '../src/leads/stage-move.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';

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

// Distinct id range for the stage gate tests.
const SITE = '18000000-0000-4000-8000-000000000801';
const ACTOR = '28000000-0000-4000-8000-000000000801';
const REQUEST = '38000000-0000-4000-8000-000000000801';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ctx = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };

const planInput = (overrides: Partial<CreatePlanRequest>): CreatePlanRequest => ({
  leadType: 'sim_order',
  name: 'Gated plan',
  priceMinor: 4000,
  billingPeriod: 'month',
  paymentRequired: false,
  requiredDocuments: ['passport', 'visa'],
  active: true,
  customValues: {},
  ...overrides,
});

databaseTest('stage moves, their gates and the documents override', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let documents: DatabaseDocumentStore;
  let gatedPlan: Plan;
  let licencePlan: Plan;
  let freePlan: Plan;
  let passportPlan: Plan;

  const orderOf = (plan: Plan | null): LeadOrder => ({
    ...DEFAULT_LEAD_ORDER,
    planId: plan?.id ?? null,
    plan: plan ? freezePlan(plan, [], new Date()) : null,
  });

  /** A submitted SIM order at `stage`, with its order details stored as given. */
  const insertLead = async (stage: string, orderDetails: object): Promise<string> => {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        order_details
      ) values (
        ${id}, ${SITE}, 'sim_order', 'submitted', ${stage}, 'ci', '{}'::jsonb,
        ${admin.json({ schemaVersion: 1, payload: {} })}, ${admin.json(JSON.parse(JSON.stringify(orderDetails)))}
      )
    `;
    return id;
  };

  /** A verified file of `documentType` on the lead, as the import attaches one. */
  const upload = async (leadId: string, documentType: string): Promise<string> => {
    const fileId = randomUUID();
    const outcome = await documents.insertImportedFile({
      ...ctx,
      fileId,
      leadId,
      documentType,
      bucket: 'documents',
      objectKey: `candidate/${SITE}/gate-${fileId}`,
      detectedMime: 'application/pdf',
      sizeBytes: 1024,
      checksumSha256: 'd'.repeat(64),
      uploadedBy: ACTOR,
      uploadedAt: new Date(),
    });
    if (outcome.status !== 'imported') throw new Error(`file not imported: ${outcome.status}`);
    return fileId;
  };

  const review = async (fileId: string, decision: 'approved' | 'rejected') => {
    const outcome = await documents.recordReview({ ...ctx, fileId, decision });
    if (outcome.status !== 'recorded') throw new Error('review not recorded');
  };

  const approved = async (leadId: string, documentType: string) => {
    const fileId = await upload(leadId, documentType);
    await review(fileId, 'approved');
    return fileId;
  };

  const move = (
    leadId: string,
    stage: string,
    extra: { order?: Record<string, string | null>; documentsOverrideReason?: string } = {},
  ) => work.updateLead({ ...ctx, leadId, stage, catalog: codePropertyCatalog, ...extra });

  const storedOrder = async (leadId: string): Promise<Record<string, unknown>> => {
    const [row] = await admin<{ orderDetails: Record<string, unknown> }[]>`
      select order_details as "orderDetails" from app.leads where id = ${leadId}
    `;
    return row?.orderDetails ?? {};
  };

  const stageOf = async (leadId: string) => {
    const [row] = await admin<{ stage: string }[]>`
      select stage from app.leads where id = ${leadId}
    `;
    return row?.stage;
  };

  const timeline = async (leadId: string) =>
    admin<{ kind: string; data: Record<string, unknown> }[]>`
      select kind, data from app.lead_activities
      where lead_id = ${leadId} and kind <> 'document'
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
    // Deleting the site removes its leads, plans, files, timeline and audit rows.
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`
      insert into app.workspaces (id, slug, name) values (${SITE}, 'stage-gate-801', 'Stage Gate')
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    work = new DatabaseLeadWorkStore(database);
    documents = new DatabaseDocumentStore({ withTenantTx: database.withTenantTx.bind(database) });
    const planStore = new DatabasePlanStore(database);
    const created = await planStore.create(ctx, planInput({}));
    const licence = await planStore.create(
      ctx,
      planInput({ name: 'Licence plan', requiredDocuments: ['drivers_licence'] }),
    );
    const free = await planStore.create(
      ctx,
      planInput({ name: 'Free plan', requiredDocuments: [] }),
    );
    const passport = await planStore.create(
      ctx,
      planInput({ name: 'Passport plan', requiredDocuments: ['passport'] }),
    );
    if (
      created.kind !== 'created' ||
      licence.kind !== 'created' ||
      free.kind !== 'created' ||
      passport.kind !== 'created'
    ) {
      throw new Error('plans');
    }
    gatedPlan = created.plan;
    licencePlan = licence.plan;
    freePlan = free.plan;
    passportPlan = passport.plan;
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('dispatches only once the plan’s documents are approved, then refuses activation when one is replaced or rejected', async () => {
    const leadId = await insertLead('verified', orderOf(gatedPlan));
    const courier = { order: { courier: 'Canada Post' } };

    expect(await move(leadId, 'delivered', courier)).toEqual({
      status: 'documents_incomplete',
      missing: ['passport', 'visa'],
    });
    await approved(leadId, 'passport');
    expect(await move(leadId, 'delivered', courier)).toEqual({
      status: 'documents_incomplete',
      missing: ['visa'],
    });
    expect(await stageOf(leadId)).toBe('verified');
    expect(await timeline(leadId)).toEqual([]);

    await approved(leadId, 'visa');
    const outcome = await move(leadId, 'delivered', courier);
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    expect(outcome.lead.stage).toBe('delivered');
    expect(outcome.lead.order).toMatchObject({
      courier: 'Canada Post',
      dispatchedAt: todayInToronto(new Date()),
      documentsOverride: null,
    });
    expect(await storedOrder(leadId)).toMatchObject({
      courier: 'Canada Post',
      dispatchedAt: todayInToronto(new Date()),
    });
    const entries = await timeline(leadId);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['edit', 'status_change']);
    expect(entries.find((entry) => entry.kind === 'status_change')?.data).toEqual({
      from: 'verified',
      to: 'delivered',
    });
    expect(entries.find((entry) => entry.kind === 'edit')?.data).toEqual({
      fields: ['courier', 'dispatchedAt'],
    });

    // A new upload replaces the approved passport, and is not reviewed yet.
    await upload(leadId, 'passport');
    expect(await move(leadId, 'activated')).toEqual({
      status: 'documents_incomplete',
      missing: ['passport'],
    });
    expect(await stageOf(leadId)).toBe('delivered');
  });

  it('checks the documents of the plan a move’s own edit gives the order', async () => {
    const leadId = await insertLead('verified', orderOf(freePlan));
    const before = await storedOrder(leadId);
    expect(
      await move(leadId, 'delivered', {
        order: { planId: passportPlan.id, courier: 'Canada Post' },
      }),
    ).toEqual({ status: 'documents_incomplete', missing: ['passport'] });
    expect(await stageOf(leadId)).toBe('verified');
    expect(await storedOrder(leadId)).toEqual(before);
    expect(await timeline(leadId)).toEqual([]);

    // The other way: leaving a plan that needs documents for one that needs none.
    const gated = await insertLead('verified', orderOf(gatedPlan));
    expect(
      await move(gated, 'delivered', { order: { planId: freePlan.id, courier: 'Canada Post' } }),
    ).toMatchObject({ status: 'updated', lead: { stage: 'delivered' } });
    expect(await storedOrder(gated)).toMatchObject({ planId: freePlan.id, courier: 'Canada Post' });
  });

  it('counts only a document’s latest review', async () => {
    const leadId = await insertLead('delivered', {
      ...orderOf(gatedPlan),
      courier: 'Canada Post',
    });
    await approved(leadId, 'passport');
    const visa = await approved(leadId, 'visa');
    await review(visa, 'rejected');
    expect(await move(leadId, 'activated')).toEqual({
      status: 'documents_incomplete',
      missing: ['visa'],
    });
    await review(visa, 'approved');
    expect(await move(leadId, 'activated')).toMatchObject({
      status: 'updated',
      lead: { stage: 'activated', order: { activatedAt: todayInToronto(new Date()) } },
    });
  });

  it('does not count a licence photo given for the credit check', async () => {
    const leadId = await insertLead('verified', orderOf(licencePlan));
    const licence = await approved(leadId, 'drivers_licence');
    await admin`
      insert into app.lead_identities (
        workspace_id, lead_id, id_type, file_id, credit_check_consent_at, created_by
      ) values (${SITE}, ${leadId}, 'drivers_licence', ${licence}, now(), ${ACTOR})
    `;
    expect(await move(leadId, 'delivered', { order: { courier: 'Canada Post' } })).toEqual({
      status: 'documents_incomplete',
      missing: ['drivers_licence'],
    });
  });

  it('an override moves on without the documents, with its reason recorded', async () => {
    const leadId = await insertLead('delivered', {
      ...orderOf(gatedPlan),
      courier: 'Canada Post',
    });
    await approved(leadId, 'visa');

    expect(await move(leadId, 'activated', { documentsOverrideReason: '   ' })).toEqual({
      status: 'document_override_reason_required',
    });

    const reason = 'Passport checked in person at the counter';
    const outcome = await move(leadId, 'activated', { documentsOverrideReason: `  ${reason} ` });
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    expect(outcome.lead.stage).toBe('activated');
    expect(outcome.lead.order?.documentsOverride).toEqual({
      reason,
      missing: ['passport'],
      at: expect.any(String),
    });
    expect(await storedOrder(leadId)).toMatchObject({
      activatedAt: todayInToronto(new Date()),
      documentsOverride: { reason, missing: ['passport'] },
    });
    expect(outcome.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'status_change', from: 'delivered', to: 'activated' }),
        expect.objectContaining({ kind: 'edit', fields: ['activatedAt'] }),
        expect.objectContaining({
          kind: 'system',
          event: 'documents_override',
          missing: ['passport'],
          reason,
        }),
      ]),
    );
    expect(outcome.activities).toHaveLength(3);
    const audits = await admin<{ action: string; after: unknown }[]>`
      select action, after from app.audit_events
      where entity_id = ${leadId} and action like 'lead.%'
      order by action
    `;
    expect(audits).toEqual([
      {
        action: 'lead.documents_overridden',
        after: { from: 'delivered', to: 'activated', missing: ['passport'], reason },
      },
      expect.objectContaining({ action: 'lead.updated' }),
    ]);
  });

  it('ignores a reason when nothing is missing', async () => {
    const leadId = await insertLead('delivered', {
      ...orderOf(gatedPlan),
      courier: 'Canada Post',
    });
    await approved(leadId, 'passport');
    await approved(leadId, 'visa');
    const outcome = await move(leadId, 'activated', { documentsOverrideReason: 'Just in case' });
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    expect(outcome.lead.order?.documentsOverride).toBeNull();
    expect(outcome.activities.map((activity) => activity.kind).sort()).toEqual([
      'edit',
      'status_change',
    ]);
    expect((await storedOrder(leadId))['documentsOverride']).toBeNull();
  });

  it('refuses the dispatch and activation details a move needs', async () => {
    const leadId = await insertLead('verified', orderOf(null));
    expect(await move(leadId, 'delivered')).toEqual({ status: 'dispatch_details_required' });
    expect(await move(leadId, 'delivered', { order: { courier: null } })).toEqual({
      status: 'dispatch_details_required',
    });
    const delivered = await insertLead('delivered', { ...orderOf(null), courier: 'Purolator' });
    expect(await move(delivered, 'activated', { order: { activatedAt: null } })).toEqual({
      status: 'activation_details_required',
    });
  });

  it('a legacy SIM order with empty order details needs only the courier', async () => {
    const leadId = await insertLead('verified', {});
    const outcome = await move(leadId, 'delivered', { order: { courier: 'Canada Post' } });
    expect(outcome).toMatchObject({
      status: 'updated',
      lead: { stage: 'delivered', order: { courier: 'Canada Post' } },
    });
  });

  it('allows only the type’s moves', async () => {
    const completed = await insertLead('completed', orderOf(null));
    expect(await move(completed, 'cancelled')).toEqual({
      status: 'illegal_stage_move',
      from: 'completed',
      to: 'cancelled',
      allowed: [],
    });
    expect(await move(completed, 'not_a_stage')).toEqual({ status: 'invalid_stage' });

    const cancelled = await insertLead('cancelled', orderOf(gatedPlan));
    expect(await move(cancelled, 'pending')).toMatchObject({
      status: 'updated',
      lead: { stage: 'pending' },
    });
    // A row still on a retired stage may move to any listed one.
    const legacy = await insertLead('paid', {});
    expect(await move(legacy, 'pending')).toMatchObject({
      status: 'updated',
      lead: { stage: 'pending' },
    });
  });

  it('dispatch and activation details without a stage change are plain order edits', async () => {
    const leadId = await insertLead('pending', orderOf(gatedPlan));
    const outcome = await work.updateLead({
      ...ctx,
      leadId,
      catalog: codePropertyCatalog,
      order: {
        courier: 'Canada Post',
        trackingNumber: 'LX123456789CA',
        dispatchedAt: '2026-10-29',
        activatedAt: '2026-10-30',
        activationNumber: '6475550123',
        activationAccount: 'Rogers 1001',
      },
    });
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    expect(outcome.lead.stage).toBe('pending');
    expect(await storedOrder(leadId)).toMatchObject({
      courier: 'Canada Post',
      trackingNumber: 'LX123456789CA',
      dispatchedAt: '2026-10-29',
      activatedAt: '2026-10-30',
      activationNumber: '6475550123',
      activationAccount: 'Rogers 1001',
    });
    expect(outcome.activities).toEqual([
      expect.objectContaining({
        kind: 'edit',
        fields: [
          'courier',
          'trackingNumber',
          'dispatchedAt',
          'activatedAt',
          'activationNumber',
          'activationAccount',
        ],
      }),
    ]);
    // The audit names the changed details and keeps none of their values.
    const [audit] = await admin<{ after: { changedFields: string[]; order: object } }[]>`
      select after from app.audit_events
      where entity_id = ${leadId} and action = 'lead.updated'
    `;
    expect(audit?.after.changedFields).toEqual([
      'courier',
      'trackingNumber',
      'dispatchedAt',
      'activatedAt',
      'activationNumber',
      'activationAccount',
    ]);
    expect(audit?.after.order).toMatchObject({ planId: gatedPlan.id, quantity: 1 });
    for (const field of ['courier', 'trackingNumber', 'activationNumber', 'activationAccount']) {
      expect(audit?.after.order).not.toHaveProperty(field);
    }
    for (const value of ['Canada Post', 'LX123456789CA', '6475550123', 'Rogers 1001']) {
      expect(JSON.stringify(audit)).not.toContain(value);
    }

    // Null clears one detail; the others stay.
    const cleared = await work.updateLead({
      ...ctx,
      leadId,
      catalog: codePropertyCatalog,
      order: { trackingNumber: null },
    });
    expect(cleared).toMatchObject({
      status: 'updated',
      lead: { order: { courier: 'Canada Post', trackingNumber: null } },
      activities: [expect.objectContaining({ kind: 'edit', fields: ['trackingNumber'] })],
    });
  });
});
