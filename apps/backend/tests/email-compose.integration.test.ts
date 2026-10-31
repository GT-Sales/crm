import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_EMAIL_JOB_TYPE,
  DEFAULT_LEAD_ORDER,
  customerEmailJobPayloadSchema,
  type CustomerEmailJobPayload,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { composeCustomerEmail, type ComposeRecipient } from '../src/email/compose.js';
import { hashContact } from '../src/email/hash.js';
import { queueComposedEmail } from '../src/email/queue.js';
import {
  customerEmailEnvironmentFromEnv,
  customerEmailFromEnv,
  resolveSiteSender,
} from '../src/email/senders.js';
import { DatabaseEmailSettingsStore } from '../src/email/settings-store.js';

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

// Distinct id range for the composer and queue tests.
const SITE = '1d000000-0000-4000-8000-000000000711'; // saved settings
// Listed in EMAIL_SENDERS_JSON, which is ignored now: no saved settings, so no sender.
const FALLBACK_SITE = '1d000000-0000-4000-8000-000000000712';
const NO_SENDER_SITE = '1d000000-0000-4000-8000-000000000713'; // neither
const ACTOR = '2d000000-0000-4000-8000-000000000711';
const REQUEST = '3d000000-0000-4000-8000-000000000711';
const LEAD = '9d000000-0000-4000-8000-000000000711';
const OTHER_LEAD = '9d000000-0000-4000-8000-000000000712';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SECRET = 'ci-email-contact-hash-secret-0123456789';

const CUSTOMER = 'nadia.customer@example.test';
const STAFF = 'staff.member@example.test';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: SECRET,
  // The removed fallback: set on purpose, it must change nothing.
  EMAIL_SENDERS_JSON: JSON.stringify([
    {
      workspaceId: FALLBACK_SITE,
      fromAddress: 'order@fallback.example',
      fromName: 'Fallback Sim',
      replyToAddress: 'help@fallback.example',
      siteUrl: 'https://fallback.example/',
    },
    { workspaceId: SITE, fromAddress: 'env@site.example', fromName: 'Env Name' },
  ]),
};

const scope = { workspaceId: SITE, actorId: ACTOR };
const write = { ...scope, requestId: REQUEST };

const simLead = (
  overrides: Partial<Extract<ComposeRecipient, { kind: 'lead' }>['lead']> = {},
): ComposeRecipient => ({
  kind: 'lead',
  lead: {
    id: LEAD,
    leadType: 'sim_order',
    fullName: 'Nadia Khan',
    email: ` ${CUSTOMER} `,
    externalRef: null,
    form: { simNumber: '+1 647 555 0199' },
    customValues: {},
    order: null,
    ...overrides,
  },
});

databaseTest('customer email composer and queue', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let settings: DatabaseEmailSettingsStore;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const sites = [SITE, FALLBACK_SITE, NO_SENDER_SITE];

  const reset = async () => {
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(sites)}`;
    await admin`delete from app.lead_activities where workspace_id in ${admin(sites)}`;
    await admin`delete from app.audit_events where workspace_id in ${admin(sites)}`;
    await admin`delete from app.email_template_versions where workspace_id in ${admin(sites)}`;
    await admin`delete from app.email_templates where workspace_id in ${admin(sites)}`;
  };

  const compose = (
    workspaceId: string,
    template: Parameters<typeof composeCustomerEmail>[2]['template'],
    recipient: ComposeRecipient,
    env = environment,
  ) =>
    database.withTenantTx({ workspaceId, actorId: ACTOR }, (tx) =>
      composeCustomerEmail(tx, env, { workspaceId, template, recipient }),
    );

  const ready = async (...args: Parameters<typeof compose>): Promise<CustomerEmailJobPayload> => {
    const outcome = await compose(...args);
    if (outcome.kind !== 'ready') throw new Error(`not ready: ${JSON.stringify(outcome)}`);
    return outcome.payload;
  };

  const queue = (
    input: Omit<
      Parameters<typeof queueComposedEmail>[1],
      'workspaceId' | 'actorId' | 'requestId'
    > & { workspaceId?: string },
  ) =>
    database.withTenantTx({ workspaceId: input.workspaceId ?? SITE, actorId: ACTOR }, (tx) =>
      queueComposedEmail(tx, {
        workspaceId: SITE,
        actorId: ACTOR,
        requestId: REQUEST,
        ...input,
      }),
    );

  const jobs = (workspaceId = SITE) =>
    admin<{ id: string; jobType: string; dedupeKey: string; payload: unknown }[]>`
      select id, job_type as "jobType", dedupe_key as "dedupeKey", payload from app.outbox_jobs
      where workspace_id = ${workspaceId}
      order by created_at, id
    `;

  const timeline = (leadId: string) =>
    admin<{ kind: string; body: string | null; data: unknown }[]>`
      select kind, body, data from app.lead_activities
      where workspace_id = ${SITE} and lead_id = ${leadId}
      order by created_at, id
    `;

  const audits = () =>
    admin<{ action: string; entity: string; entityId: string; before: unknown; after: unknown }[]>`
      select action, entity, entity_id as "entityId", before, after from app.audit_events
      where workspace_id = ${SITE}
      order by created_at, id
    `;

  const leadUpdatedAt = async (leadId: string) => {
    const [row] = await admin<{ updatedAt: Date }[]>`
      select updated_at as "updatedAt" from app.leads where id = ${leadId}
    `;
    return row?.updatedAt;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id in ${admin(sites)}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'email-compose-711', 'Compose Site'),
        (${FALLBACK_SITE}, 'email-compose-712', 'Compose Fallback'),
        (${NO_SENDER_SITE}, 'email-compose-713', 'Compose No Sender')
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version, attribution, payload, full_name, email, updated_at)
      values
        (${LEAD}, ${SITE}, 'sim_order', 'submitted', 'pending', 'ci', '{}'::jsonb,
         ${admin.json({ schemaVersion: 1, payload: {} })}, 'Nadia Khan', ${CUSTOMER}, '2026-01-01T00:00:00Z'),
        (${OTHER_LEAD}, ${SITE}, 'sim_order', 'submitted', 'pending', 'ci', '{}'::jsonb,
         ${admin.json({ schemaVersion: 1, payload: {} })}, 'Other Khan', ${CUSTOMER}, '2026-01-01T00:00:00Z')
    `;
    await admin`
      insert into app.workspace_email_settings (
        workspace_id, from_name, from_address, reply_to, logo_url, brand_color, footer_text, site_url, updated_by
      ) values (
        ${SITE}, 'Compose Sim', 'orders@compose.example', null, 'https://compose.example/logo.png',
        '#123abc', 'Compose Sim, Toronto', 'https://compose.example', ${ACTOR}
      )
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    settings = new DatabaseEmailSettingsStore(database);

    const property = (
      key: string,
      kind: string,
      options: { value: string; label: string; hidden: boolean }[],
      position: number,
    ) => admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, options, position)
      values (${SITE}, 'lead', ${key}, 'custom', ${key}, ${kind}, ${admin.json(options)}, ${position})
    `;
    await property('custom_size', 'choice', [{ value: 'small', label: 'Small', hidden: false }], 1);
    await property('custom_deposit', 'money', [], 2);
    await property('custom_insured', 'yesNo', [], 3);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('resolves the saved settings, else none, whatever EMAIL_SENDERS_JSON lists', async () => {
    const resolve = (workspaceId: string) =>
      database.withTenantTx({ workspaceId, actorId: ACTOR }, (tx) =>
        resolveSiteSender(tx, workspaceId),
      );
    expect(await resolve(SITE)).toEqual({
      sender: { fromName: 'Compose Sim', fromAddress: 'orders@compose.example' },
      branding: {
        siteName: 'Compose Sim',
        logoUrl: 'https://compose.example/logo.png',
        brandColor: '#123abc',
        footerText: 'Compose Sim, Toronto',
      },
      siteUrl: 'https://compose.example',
    });
    expect(await resolve(FALLBACK_SITE)).toBeUndefined();
    expect(await resolve(NO_SENDER_SITE)).toBeUndefined();
  });

  it('can send for a site only with a working provider, the secret and saved settings', async () => {
    const mail = customerEmailFromEnv(ENV, database);
    const can = (workspaceId: string) => mail.available({ workspaceId, actorId: ACTOR });
    expect(await can(SITE)).toBe(true);
    expect(await can(FALLBACK_SITE)).toBe(false);
    expect(await can(NO_SENDER_SITE)).toBe(false);
    const noProvider = customerEmailFromEnv({ ...ENV, EMAIL_PROVIDER: undefined }, database);
    expect(await noProvider.available(scope)).toBe(false);
    const noSecret = customerEmailFromEnv({ ...ENV, EMAIL_CONTACT_HASH_SECRET: '' }, database);
    expect(await noSecret.available(scope)).toBe(false);
  });

  it('composes from the saved sender at the starter version until a template is saved', async () => {
    await reset();
    const payload = await ready(SITE, 'sim_number_ready', simLead());
    expect(customerEmailJobPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      leadId: LEAD,
      template: 'sim_number_ready',
      templateVersion: 0,
      toAddress: CUSTOMER,
      contactHash: hashContact(CUSTOMER, SECRET),
      sender: { fromName: 'Compose Sim', fromAddress: 'orders@compose.example' },
      rendered: { subject: 'Your Canadian mobile number is ready' },
    });
    expect(payload.rendered.text).toContain('+1 647 555 0199');
    expect(payload.rendered.text).toContain('Nadia');
    expect(payload.test).toBeUndefined();
  });

  it('skips with no_sender when the site has no saved settings or the deployment cannot send', async () => {
    for (const site of [FALLBACK_SITE, NO_SENDER_SITE]) {
      expect(await compose(site, 'sim_number_ready', simLead())).toEqual({
        kind: 'skipped',
        reason: 'no_sender',
      });
    }
    const cannotSend = customerEmailEnvironmentFromEnv({ ...ENV, EMAIL_PROVIDER: 'resend' });
    expect(await compose(SITE, 'sim_number_ready', simLead(), cannotSend)).toEqual({
      kind: 'skipped',
      reason: 'no_sender',
    });
  });

  it('skips with no_customer_email when the lead has no valid address', async () => {
    for (const email of [null, '', 'not an address']) {
      expect(await compose(SITE, 'sim_number_ready', simLead({ email }))).toEqual({
        kind: 'skipped',
        reason: 'no_customer_email',
      });
    }
  });

  it('skips with missing_fill_in naming the values the lead lacks', async () => {
    await reset();
    expect(
      await compose(
        SITE,
        'dispatched',
        simLead({ order: { ...DEFAULT_LEAD_ORDER, courier: 'Canada Post' } }),
      ),
    ).toEqual({ kind: 'skipped', reason: 'missing_fill_in', missing: ['tracking number'] });
    expect(await compose(SITE, 'sim_number_ready', simLead({ form: {} }))).toEqual({
      kind: 'skipped',
      reason: 'missing_fill_in',
      missing: ['SIM number'],
    });
    const payload = await ready(
      SITE,
      'dispatched',
      simLead({
        order: { ...DEFAULT_LEAD_ORDER, courier: 'Canada Post', trackingNumber: 'LX1CA' },
      }),
    );
    expect(payload.rendered.text).toContain('LX1CA');
    expect(payload.rendered.text).toContain('https://compose.example/track');
  });

  it('renders the saved version, the site name from the sender', async () => {
    await reset();
    for (const [expectedVersion, subject] of [
      [0, 'One'],
      [1, 'Two'],
      [2, 'Thanks from {site name}'],
    ] as const) {
      const saved = await settings.putTemplate(write, 'order_received', {
        expectedVersion,
        subject,
        body: 'Hi {first name}, thanks for ordering.',
      });
      expect(saved.kind).toBe('saved');
    }
    const payload = await ready(SITE, 'order_received', simLead());
    expect(payload.templateVersion).toBe(3);
    expect(payload.rendered.subject).toBe('Thanks from Compose Sim');
    expect(payload.sender).toEqual({
      fromName: 'Compose Sim',
      fromAddress: 'orders@compose.example',
    });
  });

  it('composes a tracking code to its address with the code and the site name only', async () => {
    await reset();
    const payload = await ready(SITE, 'tracking_code', {
      kind: 'tracking_code',
      toAddress: ` ${CUSTOMER} `,
      code: '042917',
    });
    expect(customerEmailJobPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      template: 'tracking_code',
      templateVersion: 0,
      toAddress: CUSTOMER,
      contactHash: hashContact(CUSTOMER, SECRET),
      sender: { fromName: 'Compose Sim', fromAddress: 'orders@compose.example' },
      rendered: { subject: 'Your Compose Sim tracking code' },
    });
    expect(payload.leadId).toBeUndefined();
    expect(payload.test).toBeUndefined();
    expect(payload.rendered.text).toContain('042917');
    expect(
      await compose(NO_SENDER_SITE, 'tracking_code', {
        kind: 'tracking_code',
        toAddress: CUSTOMER,
        code: '042917',
      }),
    ).toEqual({ kind: 'skipped', reason: 'no_sender' });
  });

  it('composes a staff test with sample values to the staff member', async () => {
    await reset();
    const payload = await ready(SITE, 'dispatched', { kind: 'staff_test', toAddress: STAFF });
    expect(customerEmailJobPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      template: 'dispatched',
      templateVersion: 0,
      toAddress: STAFF,
      contactHash: hashContact(STAFF, SECRET),
      test: true,
    });
    expect(payload.leadId).toBeUndefined();
    expect(payload.rendered.text).toContain('LX123456789CA');
  });

  it('queues one job per dedupe key, with its timeline entry and audit event', async () => {
    await reset();
    const before = await leadUpdatedAt(LEAD);
    const payload = await ready(SITE, 'sim_number_ready', simLead());
    const first = await queue({
      leadId: LEAD,
      dedupeKey: `${LEAD}:${REQUEST}`,
      payload,
      automation: null,
    });
    expect(first).toEqual({
      queued: true,
      jobId: expect.any(String),
      activity: {
        id: expect.any(String),
        actorId: ACTOR,
        kind: 'system',
        event: 'customer_emailed',
        template: 'sim_number_ready',
        templateVersion: 0,
        createdAt: expect.any(String),
      },
    });
    const again = await queue({
      leadId: LEAD,
      dedupeKey: `${LEAD}:${REQUEST}`,
      payload,
      automation: null,
    });
    expect(again).toEqual({ queued: false, jobId: null, activity: null });

    const stored = await jobs();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: first.jobId,
      jobType: CUSTOMER_EMAIL_JOB_TYPE,
      dedupeKey: `${LEAD}:${REQUEST}`,
    });
    expect(customerEmailJobPayloadSchema.parse(stored[0]?.payload)).toEqual(payload);

    expect(await timeline(LEAD)).toEqual([
      {
        kind: 'system',
        body: null,
        data: { event: 'customer_emailed', template: 'sim_number_ready', templateVersion: 0 },
      },
    ]);
    expect(await audits()).toEqual([
      {
        action: 'lead.customer_emailed',
        entity: 'lead',
        entityId: LEAD,
        before: null,
        after: {
          template: 'sim_number_ready',
          templateVersion: 0,
          jobId: first.jobId,
          automation: null,
        },
      },
    ]);
    // A mail staff sent by hand is work on the lead: it moves up the inbox.
    expect((await leadUpdatedAt(LEAD))?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it('names the rule that queued a mail on the timeline and in the audit', async () => {
    await reset();
    const before = await leadUpdatedAt(OTHER_LEAD);
    const payload = await ready(
      SITE,
      'dispatched',
      simLead({
        id: OTHER_LEAD,
        order: { ...DEFAULT_LEAD_ORDER, courier: 'Canada Post', trackingNumber: 'LX2CA' },
      }),
    );
    const queued = await queue({
      leadId: OTHER_LEAD,
      dedupeKey: `${OTHER_LEAD}:sim_order_dispatched:occurrence-1`,
      payload,
      automation: {
        key: 'sim_order_dispatched',
        name: 'Dispatched email',
        version: 1,
        runId: '18000000-0000-4000-8000-0000000083ff',
      },
    });
    expect(queued.queued).toBe(true);
    expect(queued.activity).toMatchObject({
      event: 'customer_emailed',
      template: 'dispatched',
      templateVersion: 0,
      automation: 'sim_order_dispatched',
    });
    expect(await timeline(OTHER_LEAD)).toEqual([
      {
        kind: 'system',
        body: null,
        data: {
          event: 'customer_emailed',
          template: 'dispatched',
          templateVersion: 0,
          automation: 'sim_order_dispatched',
          automationName: 'Dispatched email',
        },
      },
    ]);
    expect((await audits()).map(({ action, after }) => ({ action, after }))).toEqual([
      {
        action: 'lead.customer_emailed',
        after: {
          template: 'dispatched',
          templateVersion: 0,
          jobId: queued.jobId,
          automation: {
            key: 'sim_order_dispatched',
            version: 1,
            runId: '18000000-0000-4000-8000-0000000083ff',
          },
        },
      },
    ]);
    // A rule's mail does not count as staff work on the lead.
    expect((await leadUpdatedAt(OTHER_LEAD))?.getTime()).toBe(before?.getTime());
  });

  it('records a staff test in the audit only', async () => {
    await reset();
    const payload = await ready(SITE, 'cancelled', { kind: 'staff_test', toAddress: STAFF });
    const queued = await queue({
      leadId: null,
      dedupeKey: `test:cancelled:${ACTOR}:202610301200`,
      payload,
      automation: null,
    });
    expect(queued).toEqual({ queued: true, jobId: expect.any(String), activity: null });
    const [activities] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.lead_activities where workspace_id = ${SITE}
    `;
    expect(activities?.total).toBe(0);
    expect(await audits()).toEqual([
      {
        action: 'email.test_sent',
        entity: 'outbox_job',
        entityId: queued.jobId,
        before: null,
        after: { template: 'cancelled', templateVersion: 0, jobId: queued.jobId },
      },
    ]);
  });

  it('keeps addresses and the mail’s words out of the timeline and the audit', async () => {
    await reset();
    const leadPayload = await ready(SITE, 'sim_number_ready', simLead());
    await queue({
      leadId: LEAD,
      dedupeKey: 'privacy-lead',
      payload: leadPayload,
      automation: null,
    });
    const testPayload = await ready(SITE, 'sim_number_ready', {
      kind: 'staff_test',
      toAddress: STAFF,
    });
    await queue({
      leadId: null,
      dedupeKey: 'privacy-test',
      payload: testPayload,
      automation: null,
    });

    const written = JSON.stringify([await timeline(LEAD), await audits()]);
    for (const secret of [
      CUSTOMER,
      STAFF,
      'orders@compose.example',
      leadPayload.contactHash,
      leadPayload.rendered.subject,
      '+1 647 555 0199',
      'Good news',
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(written).not.toContain('@');
  });

  describe('site-made templates and the flow fill-ins', () => {
    const SITE_MADE = 'tpl_composetest00001';
    const siteMade = async (values: { archived?: boolean } = {}) => {
      await admin`
        insert into app.email_templates
          (workspace_id, key, name, subject, body, version, updated_by, archived_at)
        values (${SITE}, ${SITE_MADE}, 'My note', 'Order {order number}',
          ${'Size {prop:custom_size}, deposit {prop:custom_deposit}, insured {prop:custom_insured}.'},
          1, ${ACTOR}, ${values.archived ? new Date() : null})
      `;
    };
    const propertyLead = () =>
      simLead({
        externalRef: 'MS-1042',
        customValues: { custom_size: 'small', custom_deposit: 4000, custom_insured: true },
      });
    const setProperty = (
      key: string,
      values: { sensitive?: boolean; staffOnly?: boolean },
    ) => admin`
      update app.properties
      set sensitive = ${values.sensitive ?? false}, staff_only = ${values.staffOnly ?? false}
      where workspace_id = ${SITE} and key = ${key}
    `;

    it('a tpl_ template renders each property as the record shows it and {order number}', async () => {
      await reset();
      await siteMade();
      const outcome = await compose(SITE, SITE_MADE, propertyLead());
      if (outcome.kind !== 'ready') throw new Error(`not ready: ${JSON.stringify(outcome)}`);
      expect(outcome.templateName).toBe('My note');
      expect(outcome.payload).toMatchObject({ template: SITE_MADE, templateVersion: 1 });
      expect(outcome.payload.rendered.subject).toBe('Order MS-1042');
      expect(outcome.payload.rendered.text).toContain('Size Small, deposit $40.00, insured Yes.');
      expect(customerEmailJobPayloadSchema.parse(outcome.payload)).toEqual(outcome.payload);
    });

    it('a property made sensitive or staff-only after the save is never rendered', async () => {
      await reset();
      await siteMade();
      for (const change of [{ sensitive: true }, { staffOnly: true }]) {
        await setProperty('custom_size', change);
        const outcome = await compose(SITE, SITE_MADE, propertyLead());
        expect(outcome).toEqual({
          kind: 'skipped',
          reason: 'missing_fill_in',
          missing: ['prop:custom_size'],
        });
        await setProperty('custom_size', {});
      }
      expect((await compose(SITE, SITE_MADE, propertyLead())).kind).toBe('ready');
    });

    it('an archived or unknown tpl_ key is template_unavailable', async () => {
      await reset();
      expect(await compose(SITE, 'tpl_nosuchtemplate00', propertyLead())).toEqual({
        kind: 'skipped',
        reason: 'template_unavailable',
      });
      await siteMade({ archived: true });
      expect(await compose(SITE, SITE_MADE, propertyLead())).toEqual({
        kind: 'skipped',
        reason: 'template_unavailable',
      });
    });

    it('a built-in template is named by its label and composes as before', async () => {
      await reset();
      const outcome = await compose(SITE, 'sim_number_ready', simLead({ externalRef: 'MS-7' }));
      if (outcome.kind !== 'ready') throw new Error('not ready');
      expect(outcome.templateName).toBe('SIM number ready');
      expect(outcome.payload.template).toBe('sim_number_ready');
    });
  });
});
