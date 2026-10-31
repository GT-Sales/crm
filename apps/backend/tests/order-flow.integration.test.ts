import type { Server } from 'node:http';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryR2DocumentStore } from '@gt-sales/adapters';
import {
  CUSTOMER_EMAIL_JOB_TYPE,
  apiErrorResponseSchema,
  createLeadResponseSchema,
  getWorkspaceLeadResponseSchema,
  updateWorkspaceLeadResponseSchema,
  type AutomationKey,
  type CustomerEmailJobPayload,
  type CustomerEmailTemplate,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { OutboxRunner } from '@gt-sales/jobs';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import { DatabaseAutomationStore } from '../src/automations/store.js';
import { DatabaseDocumentContextResolver } from '../src/documents/resolver.js';
import { DocumentService } from '../src/documents/service.js';
import { DatabaseDocumentStore } from '../src/documents/store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseEmailSettingsStore } from '../src/email/settings-store.js';
import { DatabaseEmailStore } from '../src/email/store.js';
import { createOutboxJobHandlers } from '../src/jobs/providers.js';
import { DatabaseOutboxStore } from '../src/jobs/store.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import { DatabasePropertyStore } from '../src/properties/store.js';
import { DatabaseStaffStore } from '../src/staff/store.js';
import { generateServiceSecret } from '../src/website/credential.js';
import { DatabaseWebsiteCredentialStore } from '../src/website/store.js';

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

// Distinct id range for the order flow.
const SITE = '70000000-0000-4000-8000-000000001801';
const OWNER = '70000000-0000-4000-8000-000000001811';
const LEADS_MEMBER = '70000000-0000-4000-8000-000000001812';
/** Holds Leads and Orders: the stage move needs `lead.manage`, the override `order.override`. */
const ORDERS_MEMBER = '70000000-0000-4000-8000-000000001813';
const CREDENTIAL = '70000000-0000-4000-8000-000000001821';
const PASSPORT_FILE = '70000000-0000-4000-8000-000000001831';
/** The scheduler's identity for the outbox run. */
const OUTBOX_ACTOR = '70000000-0000-4000-8000-000000001841';
const REQUEST = '70000000-0000-4000-8000-000000001851';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SECRET = 'ci-email-contact-hash-secret-0123456789';
const IDEMPOTENCY_KEY = 'order-flow-1801-submit';
const OVERRIDE_REASON = 'Passport checked in person at the counter.';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: SECRET,
};

const RULES: readonly AutomationKey[] = [
  'order_received',
  'sim_order_dispatched',
  'sim_order_activated',
];

/** One bearer token per seeded member; anything else is signed out. */
const TOKENS: Readonly<Record<string, string>> = {
  'order-flow-owner': OWNER,
  'order-flow-leads': LEADS_MEMBER,
  'order-flow-orders': ORDERS_MEMBER,
};

class StubStaffVerifier implements StaffSessionVerifier {
  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    const actorId = TOKENS[accessToken];
    return actorId ? { actorId, verifiedEmail: `${accessToken}@example.test` } : undefined;
  }
}

databaseTest('a SIM order from the website to activated, by the automations', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let automations: DatabaseAutomationStore;
  let server: Server;
  let baseUrl: string;
  let planId: string;
  const website = generateServiceSecret();
  const owner = { workspaceId: SITE, actorId: OWNER, requestId: REQUEST };

  const call = async (
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json();
    return { status: response.status, body: json };
  };
  const errorOf = (body: unknown) => apiErrorResponseSchema.parse(body).error;

  const leadPath = (leadId: string) => `/api/v1/staff/workspaces/${SITE}/leads/${leadId}`;
  const patch = (leadId: string, body: unknown, token = 'order-flow-owner') =>
    call('PATCH', leadPath(leadId), token, body);
  const review = (decision: 'approved' | 'rejected') =>
    call(
      'POST',
      `/api/v1/staff/workspaces/${SITE}/files/${PASSPORT_FILE}/review`,
      'order-flow-owner',
      { decision },
    );

  const jobs = (leadId: string) =>
    admin<{ id: string; jobType: string; dedupeKey: string; payload: CustomerEmailJobPayload }[]>`
      select id, job_type as "jobType", dedupe_key as "dedupeKey", payload
      from app.outbox_jobs
      where payload ->> 'leadId' = ${leadId}
      order by created_at, id
    `;
  const queuedTemplates = async (leadId: string) =>
    (await jobs(leadId)).map((job) => [job.payload.template, job.payload.templateVersion]);

  const saveTemplate = async (key: CustomerEmailTemplate, subject: string, body: string) => {
    const settings = new DatabaseEmailSettingsStore(database);
    const current = (await settings.listTemplates(owner)).find((entry) => entry.key === key);
    const outcome = await settings.putTemplate(owner, key, {
      expectedVersion: current?.version ?? 0,
      subject,
      body,
    });
    if (outcome.kind !== 'saved') throw new Error(`template not saved: ${outcome.kind}`);
    return outcome.template.version;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting the site removes its leads, files, plans, jobs, mails, rules, runs, templates,
    // members, credential, idempotency keys and audit rows from the last run.
    await admin`delete from app.outbox_jobs where workspace_id = ${SITE}`;
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'order-flow-1801', 'Order Flow')`;
    await admin`
      insert into app.roles (workspace_id, name)
      values (${SITE}, 'owner'), (${SITE}, 'leads'), (${SITE}, 'orders')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at)
      values
        (${SITE}, ${OWNER}, 'staff', 'active', now()),
        (${SITE}, ${LEADS_MEMBER}, 'staff', 'active', now()),
        (${SITE}, ${ORDERS_MEMBER}, 'staff', 'active', now())
    `;
    await admin`
      insert into app.membership_roles (workspace_id, membership_id, role_id)
      select m.workspace_id, m.id, r.id
      from app.memberships m
      join app.roles r on r.workspace_id = m.workspace_id
      where m.workspace_id = ${SITE}
        and (
          (m.user_id = ${OWNER} and r.name = 'owner')
          or (m.user_id in (${LEADS_MEMBER}, ${ORDERS_MEMBER}) and r.name = 'leads')
          or (m.user_id = ${ORDERS_MEMBER} and r.name = 'orders')
        )
    `;
    await admin`
      insert into app.service_credentials (id, workspace_id, secret_hash, scopes)
      values (${CREDENTIAL}, ${SITE}, ${website.secretHash}, array['leads:write'])
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    const environment = customerEmailEnvironmentFromEnv(ENV);
    automations = new DatabaseAutomationStore(database);
    const leadStore = new DatabaseLeadStore(database, environment, automations);
    const emailSettings = new DatabaseEmailSettingsStore(database);
    const planStore = new DatabasePlanStore(database);

    // The site's sender, its plan that needs a passport, its emails and the three rules on.
    await emailSettings.putSettings(owner, {
      fromName: 'Order Flow Sim',
      fromAddress: 'orders@order-flow.example',
      replyTo: null,
      logoUrl: null,
      brandColor: '#123abc',
      footerText: '',
      siteUrl: 'https://order-flow.example',
    });
    const plan = await planStore.create(owner, {
      leadType: 'sim_order',
      name: 'Rogers 60GB',
      priceMinor: 4000,
      billingPeriod: 'month',
      paymentRequired: false,
      requiredDocuments: ['passport'],
      active: true,
      customValues: {},
    });
    if (plan.kind !== 'created') throw new Error(`plan not created: ${plan.kind}`);
    planId = plan.plan.id;
    await saveTemplate('order_received', 'We have your order', 'Hi {first name}, it is in.');
    expect(
      await saveTemplate(
        'order_received',
        'We received your order',
        'Hi {first name},\n\nYour {plan} order ({price}) is in.',
      ),
    ).toBe(2);
    await saveTemplate(
      'dispatched',
      'Your order is on its way',
      'Hi {first name},\n\nIt is with {courier}, tracking number {tracking number}.',
    );
    await saveTemplate('activated', 'Your service is active', 'Hi {first name}, it works now.');
    for (const key of RULES) await automations.setEnabled(owner, key, true);

    server = createApp({
      staff: {
        sessionVerifier: new StubStaffVerifier(),
        store: new DatabaseStaffStore(database),
        credentialStore: new DatabaseWebsiteCredentialStore(database),
        leadStore,
        leadWorkStore: new DatabaseLeadWorkStore(database, environment, automations),
        documentService: new DocumentService(
          new DatabaseDocumentStore(database),
          new InMemoryR2DocumentStore(),
          new DatabaseDocumentContextResolver(database),
        ),
        planStore,
        propertyStore: new DatabasePropertyStore(database),
        automationStore: automations,
        emailSettingsStore: emailSettings,
      },
      website: {
        auth: {
          resolveCredential: database.resolveWebsiteCredential,
          // The limiter is not under test; its windows would outlive a run.
          rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
          botCheck: () => true,
        },
        leads: { store: leadStore },
        plans: { store: planStore },
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database?.close();
    await admin?.end();
  });

  it('emails the customer at submit, dispatch and activation, and checks the passport at each move', async () => {
    // The website submits the order with a key; its retry is the same lead.
    const order = {
      leadType: 'sim_order',
      contact: { fullName: 'Nadia Khan', email: 'order-flow-1801@example.test' },
      form: { schemaVersion: 1, payload: { delivery: 'esim' } },
      consentVersion: 'ci',
      submit: true,
      order: { planId, quantity: 1 },
    };
    const submit = () =>
      call('POST', '/api/v1/website/leads', website.secret, order, {
        'Idempotency-Key': IDEMPOTENCY_KEY,
      });
    const first = await submit();
    expect(first.status).toBe(201);
    const leadId = createLeadResponseSchema.parse(first.body).lead.id;
    const replayed = await submit();
    expect(replayed).toMatchObject({ status: 201, body: { replayed: true, lead: { id: leadId } } });

    const [received, ...others] = await jobs(leadId);
    expect(others).toEqual([]);
    expect(received).toMatchObject({
      jobType: CUSTOMER_EMAIL_JOB_TYPE,
      dedupeKey: `${leadId}:order_received:submitted`,
      payload: { template: 'order_received', templateVersion: 2 },
    });
    expect(received?.payload.rendered.text).toContain(
      'Your Rogers 60GB order ($40.00/month) is in.',
    );

    // The customer's passport, uploaded and attached, not yet reviewed.
    await admin`
      insert into app.files (
        id, workspace_id, record_type, record_id, document_type, bucket, staging_key,
        candidate_key, object_key, declared_content_type, detected_mime, declared_size_bytes,
        size_bytes, checksum_sha256, status, uploaded_by, expires_at, finalized_at
      ) values (
        ${PASSPORT_FILE}, ${SITE}, 'lead', ${leadId}, 'passport', 'documents',
        ${`staging/${SITE}/${PASSPORT_FILE}`}, ${`candidate/${SITE}/${PASSPORT_FILE}`},
        ${`candidate/${SITE}/${PASSPORT_FILE}`}, 'application/pdf', 'application/pdf', 2048, 2048,
        ${'a'.repeat(64)}, 'available', ${CREDENTIAL}, now() + interval '1 hour', now()
      )
    `;

    // The submitted order is Pending at once (an unfinished checkout stays Incomplete).
    const detail = await call('GET', leadPath(leadId), 'order-flow-owner');
    expect(detail.body).toMatchObject({ lead: { stage: 'pending' } });
    expect(getWorkspaceLeadResponseSchema.parse(detail.body).activities).toContainEqual(
      expect.objectContaining({ kind: 'system', event: 'submitted', actorId: CREDENTIAL }),
    );
    expect(await patch(leadId, { stage: 'verified' })).toMatchObject({ status: 200 });

    // Delivered asks for the approved passport first.
    const dispatch = { courier: 'Canada Post', trackingNumber: 'LX123456789CA' };
    const unapproved = await patch(leadId, { stage: 'delivered', order: dispatch });
    expect(unapproved.status).toBe(409);
    expect(errorOf(unapproved.body)).toMatchObject({
      code: 'documents_incomplete',
      details: { missing: ['passport'] },
    });
    expect(await queuedTemplates(leadId)).toEqual([['order_received', 2]]);

    expect(await review('approved')).toMatchObject({ status: 200 });
    const delivered = await patch(leadId, { stage: 'delivered', order: dispatch });
    expect(delivered).toMatchObject({
      status: 200,
      body: { lead: { stage: 'delivered', order: dispatch } },
    });
    expect(delivered.body).not.toHaveProperty('emailSkipped');
    expect(updateWorkspaceLeadResponseSchema.parse(delivered.body).activities).toContainEqual(
      expect.objectContaining({
        event: 'customer_emailed',
        template: 'dispatched',
        templateVersion: 1,
        automation: 'sim_order_dispatched',
      }),
    );
    expect(await queuedTemplates(leadId)).toEqual([
      ['order_received', 2],
      ['dispatched', 1],
    ]);
    expect((await jobs(leadId))[1]?.payload.rendered.text).toContain('LX123456789CA');

    // A later rejection counts: Activated asks again.
    expect(await review('rejected')).toMatchObject({ status: 200 });
    const rejected = await patch(leadId, { stage: 'activated' });
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected.body)).toMatchObject({
      code: 'documents_incomplete',
      details: { missing: ['passport'] },
    });

    // A Leads member may move stages but not past the documents.
    const notAllowed = await patch(
      leadId,
      { stage: 'activated', documentsOverrideReason: OVERRIDE_REASON },
      'order-flow-leads',
    );
    expect(notAllowed.status).toBe(409);
    expect(errorOf(notAllowed.body).code).toBe('documents_override_not_allowed');

    // A member with the Orders role moves it on, with the reason on record.
    const overridden = await patch(
      leadId,
      { stage: 'activated', documentsOverrideReason: OVERRIDE_REASON },
      'order-flow-orders',
    );
    expect(overridden).toMatchObject({ status: 200, body: { lead: { stage: 'activated' } } });
    const activated = await call('GET', leadPath(leadId), 'order-flow-owner');
    expect(activated.body).toMatchObject({
      lead: {
        stage: 'activated',
        order: {
          documentsOverride: {
            reason: OVERRIDE_REASON,
            missing: ['passport'],
            at: expect.any(String),
          },
        },
      },
    });
    expect(getWorkspaceLeadResponseSchema.parse(activated.body).activities).toContainEqual(
      expect.objectContaining({
        kind: 'system',
        event: 'documents_override',
        missing: ['passport'],
        reason: OVERRIDE_REASON,
      }),
    );
    expect(
      await admin`
        select actor_id as "actorId", after from app.audit_events
        where workspace_id = ${SITE} and entity_id = ${leadId}
          and action = 'lead.documents_overridden'
      `,
    ).toEqual([
      {
        actorId: ORDERS_MEMBER,
        after: {
          from: 'delivered',
          to: 'activated',
          missing: ['passport'],
          reason: OVERRIDE_REASON,
        },
      },
    ]);
    expect(await queuedTemplates(leadId)).toEqual([
      ['order_received', 2],
      ['dispatched', 1],
      ['activated', 1],
    ]);

    // One outbox run sends the three, each recording the version it was rendered from.
    const runner = new OutboxRunner({
      store: new DatabaseOutboxStore(database),
      handlers: createOutboxJobHandlers(ENV, new DatabaseEmailStore(database)),
    });
    expect(
      await runner.run({ authorizedWorkspaceIds: [SITE], actorId: OUTBOX_ACTOR }),
    ).toMatchObject({ claimed: 3, completed: 3, failed: 0, retried: 0, uncertain: 0 });
    expect(
      await admin`
        select m.template, m.template_version as "templateVersion", m.status
        from app.email_messages m
        join app.outbox_jobs j on j.workspace_id = m.workspace_id and j.message_id = m.message_id
        where m.workspace_id = ${SITE} and m.lead_id = ${leadId}
        order by j.created_at, j.id
      `,
    ).toEqual([
      { template: 'order_received', templateVersion: 2, status: 'sent' },
      { template: 'dispatched', templateVersion: 1, status: 'sent' },
      { template: 'activated', templateVersion: 1, status: 'sent' },
    ]);

    // Each rule ran once, and queued.
    const rules = await automations.list(owner);
    for (const key of RULES) {
      expect(rules.find((rule) => rule.key === key)).toMatchObject({ enabled: true, runCount: 1 });
      const runs = await automations.listRuns(owner, key, { includeLeadNames: false });
      expect(runs).toEqual([expect.objectContaining({ leadId, outcome: 'queued', reason: null })]);
    }
  });
});
