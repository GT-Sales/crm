import type { Server } from 'node:http';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeAnalyticsSink,
  FakeEmailAdapter,
  InMemoryR2DocumentStore,
  sha256Hex,
} from '@gt-sales/adapters';
import {
  CUSTOMER_EMAIL_JOB_TYPE,
  TRACKING_CODE_JOB_TYPE,
  TRACKING_GRANT_HEADER,
  createLeadResponseSchema,
  getWorkspaceLeadResponseSchema,
  resolveChangeRequestResponseSchema,
  trackedChangeResponseSchema,
  trackingCodeResponseSchema,
  trackingOrdersResponseSchema,
  trackingVerifyResponseSchema,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { OutboxRunner, createJobHandlerRegistry, type EmailDeliveryRecorder } from '@gt-sales/jobs';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import { DatabaseAutomationStore } from '../src/automations/store.js';
import { DatabaseDocumentContextResolver } from '../src/documents/resolver.js';
import { DocumentService } from '../src/documents/service.js';
import { DatabaseDocumentStore } from '../src/documents/store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseEmailSettingsStore } from '../src/email/settings-store.js';
import { DatabaseEmailStore } from '../src/email/store.js';
import { DatabaseOutboxStore } from '../src/jobs/store.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import { DatabasePropertyStore } from '../src/properties/store.js';
import { DatabaseStaffStore } from '../src/staff/store.js';
import {
  ChangeRequestService,
  DatabaseChangeRequestStore,
} from '../src/tracking/change-requests.js';
import { createTrackingCodeHandler } from '../src/tracking/delivery.js';
import { loadTrackingSecret } from '../src/tracking/secrets.js';
import { TrackingService } from '../src/tracking/service.js';
import { DatabaseTrackingStore } from '../src/tracking/store.js';
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

// Distinct id range for the tracking flow (…72xx).
const SITE = '00000000-0000-4000-8000-000000007201';
/** Holds the Leads role: decides change requests (`lead.manage`). */
const LEADS_MEMBER = '00000000-0000-4000-8000-000000007211';
/** Holds the Orders role only: reviews documents (`order.manage`), cannot decide requests. */
const ORDERS_MEMBER = '00000000-0000-4000-8000-000000007212';
const CREDENTIAL = '00000000-0000-4000-8000-000000007221';
/** The scheduler's identity for the outbox runs. */
const OUTBOX_ACTOR = '00000000-0000-4000-8000-000000007231';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const CONTACT_SECRET = 'tracking-flow-contact-hash-secret-0123';
const TRACKING_SECRET = 'tracking-flow-tracking-hash-secret-0123456789';
const NADIA = 'nadia@example.com';
const OLD_PHONE = '+1 647 555 0204';
const NEW_PHONE = '+1 437 555 0177';
const NEW_ARRIVAL = '2026-12-04';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2]);

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: CONTACT_SECRET,
  TRACKING_HASH_SECRET: TRACKING_SECRET,
};

/** One bearer token per seeded member; anything else is signed out. */
const TOKENS: Readonly<Record<string, string>> = {
  'tracking-flow-leads': LEADS_MEMBER,
  'tracking-flow-orders': ORDERS_MEMBER,
};

class StubStaffVerifier implements StaffSessionVerifier {
  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    const actorId = TOKENS[accessToken];
    return actorId ? { actorId, verifiedEmail: `${accessToken}@example.test` } : undefined;
  }
}

const jobRowSchema = z.object({ jobType: z.string(), status: z.string(), payload: z.unknown() });

databaseTest('a customer change request, from the tracking code to approval on the lead', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let server: Server;
  let baseUrl: string;
  let planId: string;
  let email: FakeEmailAdapter;
  let runOutbox: () => ReturnType<OutboxRunner['run']>;
  const objects = new InMemoryR2DocumentStore();
  const website = generateServiceSecret();
  const setup = { workspaceId: SITE, actorId: LEADS_MEMBER, requestId: crypto.randomUUID() };

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
  const leadPath = (leadId: string) => `/api/v1/staff/workspaces/${SITE}/leads/${leadId}`;

  const jobs = async (jobType: string) =>
    z.array(jobRowSchema).parse(
      await admin`
        select job_type as "jobType", status, payload from app.outbox_jobs
        where workspace_id = ${SITE} and job_type = ${jobType}
        order by created_at, id
      `,
    );

  /** The code request queues its mail after the neutral answer: wait for the job. */
  const codeJobQueued = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await jobs(TRACKING_CODE_JOB_TYPE)).length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no tracking code job was queued');
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting the site removes its leads, files, plans, challenges, change requests, jobs,
    // templates, settings, counters, members, credential and audit rows from the last run.
    await admin`delete from app.email_messages where workspace_id = ${SITE}`;
    await admin`delete from app.outbox_jobs where workspace_id = ${SITE}`;
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'tracking-flow-7201', 'Tracking Flow Sim')`;
    await admin`insert into app.roles (workspace_id, name) values (${SITE}, 'leads'), (${SITE}, 'orders')`;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at)
      values
        (${SITE}, ${LEADS_MEMBER}, 'staff', 'active', now()),
        (${SITE}, ${ORDERS_MEMBER}, 'staff', 'active', now())
    `;
    await admin`
      insert into app.membership_roles (workspace_id, membership_id, role_id)
      select m.workspace_id, m.id, r.id
      from app.memberships m
      join app.roles r on r.workspace_id = m.workspace_id
      where m.workspace_id = ${SITE}
        and ((m.user_id = ${LEADS_MEMBER} and r.name = 'leads')
          or (m.user_id = ${ORDERS_MEMBER} and r.name = 'orders'))
    `;
    await admin`
      insert into app.service_credentials (id, workspace_id, secret_hash, scopes)
      values (${CREDENTIAL}, ${SITE}, ${website.secretHash}, array['leads:write', 'tracking'])
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
    const secret = loadTrackingSecret(ENV);
    const automations = new DatabaseAutomationStore(database);
    const leadStore = new DatabaseLeadStore(database, environment, automations);
    const planStore = new DatabasePlanStore(database);
    const emailSettings = new DatabaseEmailSettingsStore(database);
    const documentService = new DocumentService(
      new DatabaseDocumentStore(database),
      objects,
      new DatabaseDocumentContextResolver(database),
    );
    const changeRequests = new ChangeRequestService({
      store: new DatabaseChangeRequestStore(database),
      context: { emailEnvironment: environment, automations },
      objects,
      database,
    });

    // The site's sender (no template saved: the starters are sent) and its plan that needs a passport.
    await emailSettings.putSettings(setup, {
      fromName: 'Tracking Flow Sim',
      fromAddress: 'orders@tracking-flow.example',
      replyTo: null,
      logoUrl: null,
      brandColor: '#123abc',
      footerText: '',
      siteUrl: 'https://tracking-flow.example',
    });
    const plan = await planStore.create(setup, {
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

    // The outbox as the deployment builds it, with a fake adapter the test can read.
    email = new FakeEmailAdapter();
    const emailStore = new DatabaseEmailStore(database);
    const delivery: EmailDeliveryRecorder = {
      prepare: (input) =>
        emailStore.prepareDelivery({ ...input, provider: 'fake', providerAccount: 'fake' }),
      recordResult: (input) => emailStore.recordDeliveryResult(input),
    };
    const handlers = new Map(
      createJobHandlerRegistry({
        email,
        analytics: new FakeAnalyticsSink(),
        eligibility: emailStore,
        delivery,
      }),
    );
    handlers.set(
      TRACKING_CODE_JOB_TYPE,
      createTrackingCodeHandler({
        email,
        eligibility: emailStore,
        delivery,
        environment,
        secret,
        database,
      }),
    );
    const runner = new OutboxRunner({ store: new DatabaseOutboxStore(database), handlers });
    runOutbox = () => runner.run({ authorizedWorkspaceIds: [SITE], actorId: OUTBOX_ACTOR });

    const auth = {
      resolveCredential: database.resolveWebsiteCredential,
      // The limiter is not under test; its windows would outlive a run.
      rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      botCheck: () => true,
    };
    server = createApp({
      staff: {
        sessionVerifier: new StubStaffVerifier(),
        store: new DatabaseStaffStore(database),
        credentialStore: new DatabaseWebsiteCredentialStore(database),
        leadStore,
        leadWorkStore: new DatabaseLeadWorkStore(database, environment, automations),
        documentService,
        planStore,
        propertyStore: new DatabasePropertyStore(database),
        automationStore: automations,
        emailSettingsStore: emailSettings,
        changeRequests,
      },
      website: { auth, leads: { store: leadStore }, plans: { store: planStore } },
      tracking: {
        auth,
        secret,
        tracking: new TrackingService({
          store: new DatabaseTrackingStore(database),
          secret,
          contactHash: (address) => environment.contactHash(address),
        }),
        changeRequests,
        documents: { service: documentService },
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

  it('codes, lists, asks, uploads, approves, emails and reviews, keeping values out of the trail', async () => {
    // The website submits Nadia Khan's order: it takes the next MS- number.
    const created = await call('POST', '/api/v1/website/leads', website.secret, {
      leadType: 'sim_order',
      contact: { fullName: 'Nadia Khan', email: NADIA, phone: OLD_PHONE },
      form: {
        schemaVersion: 1,
        payload: {
          delivery: 'esim',
          arrivalDate: '2026-11-20',
          permitType: 'worker',
          flightBooked: true,
        },
      },
      consentVersion: 'ci',
      submit: true,
      order: { planId, quantity: 1 },
    });
    expect(created.status).toBe(201);
    const { lead } = createLeadResponseSchema.parse(created.body);
    const leadId = lead.id;
    const reference = lead.externalRef ?? '';
    expect(reference).toMatch(/^MS-\d+$/);
    // A submitted order waits at Incomplete until staff take it in; a change needs Pending or later.
    const takenIn = await call('PATCH', leadPath(leadId), 'tracking-flow-leads', {
      stage: 'pending',
    });
    expect(takenIn.status).toBe(200);

    // A tracking code for her email; one outbox run sends it.
    const code = await call('POST', '/api/v1/website/tracking/code', website.secret, {
      email: ` ${NADIA.toUpperCase()} `,
    });
    expect(code.status).toBe(200);
    expect(trackingCodeResponseSchema.parse(code.body).status).toBe('code_sent');
    await codeJobQueued();
    expect(await runOutbox()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(email.deliveries).toHaveLength(1);
    const [codeMail] = email.deliveries;
    expect(codeMail).toMatchObject({ template: 'tracking_code', toAddress: NADIA });
    const sentCode = /tracking code is \*?\*?(\d{6})/.exec(codeMail?.rendered?.text ?? '')?.[1];
    if (!sentCode) throw new Error('the mail carries no code');

    // The code verifies to a grant.
    const verified = await call('POST', '/api/v1/website/tracking/verify', website.secret, {
      email: NADIA,
      code: sentCode,
    });
    expect(verified.status).toBe(200);
    const grant = trackingVerifyResponseSchema.parse(verified.body).grant.token;
    const customer = { [TRACKING_GRANT_HEADER]: grant };
    const listOrders = async () => {
      const listed = await call(
        'GET',
        '/api/v1/website/tracking/orders',
        website.secret,
        undefined,
        customer,
      );
      expect(listed.status).toBe(200);
      return trackingOrdersResponseSchema.parse(listed.body).orders;
    };

    // Her order, received, on its plan, open to change, the passport still missing.
    const [listed, ...others] = await listOrders();
    expect(others).toEqual([]);
    expect(listed).toMatchObject({
      reference,
      stage: 'pending',
      stageLabel: 'Received',
      plan: { id: planId, name: 'Rogers 60GB' },
      canRequestChange: true,
      pendingChange: null,
      details: { phone: OLD_PHONE, arrivalDate: '2026-11-20' },
      documents: [{ documentType: 'passport', state: 'missing' }],
    });

    // She asks for a new phone and arrival date: request #1.
    const orderPath = `/api/v1/website/tracking/orders/${encodeURIComponent(reference)}`;
    const asked = await call(
      'POST',
      `${orderPath}/changes`,
      website.secret,
      { fields: { phone: NEW_PHONE, arrivalDate: NEW_ARRIVAL } },
      customer,
    );
    expect(asked.status).toBe(201);
    expect(trackedChangeResponseSchema.parse(asked.body).changeRequest).toMatchObject({
      requestNo: 1,
      fields: { phone: NEW_PHONE, arrivalDate: NEW_ARRIVAL },
      documents: [],
    });

    // And sends a passport with it: intent, the browser's PUT, finalize.
    const intent = await call(
      'POST',
      `${orderPath}/uploads/intents`,
      website.secret,
      { documentType: 'passport', contentType: 'application/pdf', sizeBytes: PDF.byteLength },
      customer,
    );
    expect(intent.status).toBe(201);
    const upload = z.object({ uploadId: z.uuid(), url: z.string() }).parse(intent.body);
    const stagingKey = upload.url.replace(`memory://${SITE}/`, '');
    objects.putStagingObject(stagingKey, PDF);
    const finalized = await call(
      'POST',
      `${orderPath}/uploads/${upload.uploadId}/finalize`,
      website.secret,
      { checksumSha256: sha256Hex(PDF) },
      customer,
    );
    expect(finalized.status).toBe(200);
    expect(trackedChangeResponseSchema.parse(finalized.body).changeRequest).toMatchObject({
      requestNo: 1,
      documents: ['passport'],
    });

    // Staff see the request on the lead; the held passport is not on its Documents card.
    const before = await call('GET', leadPath(leadId), 'tracking-flow-leads');
    expect(before.status).toBe(200);
    const detail = getWorkspaceLeadResponseSchema.parse(before.body);
    expect(detail.access.decideChanges).toBe(true);
    expect(detail.changeRequest).toMatchObject({
      requestNo: 1,
      status: 'pending',
      version: 2,
      fields: { phone: NEW_PHONE, arrivalDate: NEW_ARRIVAL },
      documents: [{ fileId: upload.uploadId, documentType: 'passport' }],
    });
    expect(detail.documents).toEqual([]);
    expect(detail.lead.contact.phone).toBe(OLD_PHONE);
    const changeRequestId = detail.changeRequest?.id ?? '';

    // The Orders member may review documents but not decide the request.
    const decidePath = `${leadPath(leadId)}/change-requests/${changeRequestId}`;
    const refused = await call('POST', `${decidePath}/approve`, 'tracking-flow-orders', {
      expectedVersion: 2,
    });
    expect(refused.status).toBe(403);

    // The Leads member approves the version they saw.
    const approved = await call('POST', `${decidePath}/approve`, 'tracking-flow-leads', {
      expectedVersion: 2,
    });
    expect(approved.status).toBe(200);
    const decision = resolveChangeRequestResponseSchema.parse(approved.body);
    expect(decision.emailSkipped).toBeUndefined();
    expect(decision.lead.contact.phone).toBe(NEW_PHONE);
    expect(decision.lead.form?.payload['arrivalDate']).toBe(NEW_ARRIVAL);

    const after = getWorkspaceLeadResponseSchema.parse(
      (await call('GET', leadPath(leadId), 'tracking-flow-leads')).body,
    );
    expect(after.changeRequest).toBeNull();
    expect(after.lead.contact.phone).toBe(NEW_PHONE);
    expect(after.lead.form?.payload['arrivalDate']).toBe(NEW_ARRIVAL);
    // The approved passport is the lead's own now, waiting for a review.
    expect(after.documents).toEqual([
      expect.objectContaining({ id: upload.uploadId, documentType: 'passport' }),
    ]);

    // The timeline, oldest first: asked twice by the website, the edit, the decision, its mail.
    const entries = [...after.activities].reverse();
    const requested = entries.filter(
      (entry) => entry.kind === 'system' && entry.event === 'change_requested',
    );
    expect(requested).toHaveLength(2);
    for (const entry of requested) {
      expect(entry).toMatchObject({ actorId: CREDENTIAL, requestNo: 1, changeRequestId });
    }
    const edit = entries.find((entry) => entry.kind === 'edit');
    expect(edit).toMatchObject({ actorId: LEADS_MEMBER });
    expect(edit && 'fields' in edit ? [...edit.fields].sort() : []).toEqual(
      ['arrivalDate', 'phone'].sort(),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'system',
        event: 'change_approved',
        actorId: LEADS_MEMBER,
        requestNo: 1,
        changeRequestId,
        documents: ['passport'],
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'system',
        event: 'customer_emailed',
        template: 'change_approved',
      }),
    );
    const order = entries
      .filter(
        (entry) =>
          entry.kind === 'edit' ||
          (entry.kind === 'system' &&
            ['change_requested', 'change_approved', 'customer_emailed'].includes(entry.event)),
      )
      .map((entry) => (entry.kind === 'system' ? entry.event : entry.kind));
    expect(order.slice(0, 2)).toEqual(['change_requested', 'change_requested']);
    expect(order.slice(2).sort()).toEqual(['change_approved', 'customer_emailed', 'edit'].sort());

    // One outbox run sends the Change approved mail.
    const approvalJobs = await jobs(CUSTOMER_EMAIL_JOB_TYPE);
    expect(approvalJobs).toHaveLength(1);
    expect(approvalJobs[0]?.payload).toMatchObject({ template: 'change_approved' });
    expect(await runOutbox()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(email.deliveries).toHaveLength(2);
    expect(email.deliveries[1]).toMatchObject({
      template: 'change_approved',
      toAddress: NADIA,
      leadId,
    });
    expect(email.deliveries[1]?.rendered?.text).toContain('Hi Nadia');

    // The customer's list: nothing pending, the passport received.
    expect(await listOrders()).toEqual([
      expect.objectContaining({
        reference,
        pendingChange: null,
        details: expect.objectContaining({ phone: NEW_PHONE, arrivalDate: NEW_ARRIVAL }),
        documents: [{ documentType: 'passport', state: 'received' }],
      }),
    ]);

    // The Orders member approves the passport; the customer sees it approved.
    const reviewed = await call(
      'POST',
      `/api/v1/staff/workspaces/${SITE}/files/${upload.uploadId}/review`,
      'tracking-flow-orders',
      { decision: 'approved' },
    );
    expect(reviewed.status).toBe(200);
    expect(await listOrders()).toEqual([
      expect.objectContaining({ documents: [{ documentType: 'passport', state: 'approved' }] }),
    ]);

    // The code job kept only the challenge id once it ended.
    const codeJobs = await jobs(TRACKING_CODE_JOB_TYPE);
    expect(codeJobs).toHaveLength(1);
    expect(codeJobs[0]?.status).toBe('completed');
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(codeJobs[0]?.payload))).toEqual([
      'challengeId',
    ]);

    // No audit or timeline row holds the new phone (in any common spelling) or the new date.
    const spellings = [NEW_PHONE, '437 555 0177', '437-555-0177', '4375550177', NEW_ARRIVAL];
    const trail = await admin<{ text: string }[]>`
      select coalesce(before::text, '') || ' ' || coalesce(after::text, '') as text
      from app.audit_events where workspace_id = ${SITE}
      union all
      select data::text from app.lead_activities where workspace_id = ${SITE}
    `;
    expect(trail.length).toBeGreaterThan(0);
    for (const row of trail) {
      for (const spelling of spellings) expect(row.text).not.toContain(spelling);
    }
  });
});
