import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_EMAIL_JOB_TYPE,
  builtInFlowName,
  codePropertyCatalog,
  customerEmailJobPayloadSchema,
  type AutomationKey,
  type BuiltInAutomationKey,
  type CreatePlanRequest,
  type CustomerEmailJobPayload,
  type CustomerEmailTemplate,
  type Plan,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { fireFlows } from '../src/automations/engine.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseEmailSettingsStore } from '../src/email/settings-store.js';
import { idempotencyKeyHash, requestFingerprint } from '../src/leads/idempotency.js';
import { DatabaseLeadStore, type CreateLeadInput } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import { disposableTestDatabaseUrl, seedBuiltInFlow } from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Distinct id range for the automatic email tests.
const SITE = '1a000000-0000-4000-8000-000000001001'; // settings, five rules on
const QUIET_SITE = '1a000000-0000-4000-8000-000000001002'; // settings, every rule off
const NO_SENDER_SITE = '1a000000-0000-4000-8000-000000001003'; // no sender, cancelled on
const BROKEN_SITE = '1a000000-0000-4000-8000-000000001004'; // a stored template that no longer parses
const LONG_SITE = '1a000000-0000-4000-8000-000000001005'; // a subject that can outgrow the job's limit
const STAFF = '2a000000-0000-4000-8000-000000001001';
const CREDENTIAL = '2a000000-0000-4000-8000-000000001002'; // the website's credential
const REQUEST = '3a000000-0000-4000-8000-000000001001';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SECRET = 'ci-email-contact-hash-secret-0123456789';

const SITES = [SITE, QUIET_SITE, NO_SENDER_SITE, BROKEN_SITE, LONG_SITE];
const RULES_ON: readonly BuiltInAutomationKey[] = [
  'order_received',
  'sim_order_information_needed',
  'sim_order_dispatched',
  'sim_order_activated',
  'sim_order_cancelled',
];

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: SECRET,
};

const planInput: CreatePlanRequest = {
  leadType: 'sim_order',
  name: 'Rogers 60GB Visitor',
  priceMinor: 4000,
  billingPeriod: 'month',
  paymentRequired: false,
  requiredDocuments: [],
  active: true,
  customValues: {},
};

databaseTest('the built-in flows send customer emails as the phase 4 rules did', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;
  /** Each site's own SIM plan, by site. */
  const plans = new Map<string, Plan>();
  let plan: Plan;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const staff = (workspaceId = SITE) => ({ workspaceId, actorId: STAFF, requestId: REQUEST });
  const website = (workspaceId = SITE) => ({
    workspaceId,
    actorId: CREDENTIAL,
    requestId: randomUUID(),
  });

  /** A website SIM order submitted in one go, keyed as a retrying website would send it. */
  const submitted = (
    marker: string,
    workspaceId = SITE,
  ): CreateLeadInput & { idempotency: NonNullable<CreateLeadInput['idempotency']> } => {
    const body = { marker, submit: true };
    return {
      ...website(workspaceId),
      leadType: 'sim_order',
      consentVersion: 'ci',
      contact: { fullName: 'Nadia Khan', email: `${marker}@example.test` },
      order: { planId: plans.get(workspaceId)?.id ?? plan.id, quantity: 1 },
      submit: true,
      idempotency: {
        keyHash: idempotencyKeyHash(`key-${marker}`),
        fingerprint: requestFingerprint(body),
      },
    };
  };

  /** An order already being worked (submitted unless said otherwise), stored as given. */
  const insertLead = async (input: {
    workspaceId?: string;
    leadType?: string;
    status?: 'incomplete' | 'submitted';
    stage: string;
    fullName?: string;
    email?: string | null;
    form?: Record<string, unknown>;
    order?: Record<string, unknown>;
  }): Promise<string> => {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        full_name, email, order_details
      ) values (
        ${id}, ${input.workspaceId ?? SITE}, ${input.leadType ?? 'sim_order'},
        ${input.status ?? 'submitted'},
        ${input.stage}, 'ci', '{}'::jsonb,
        ${admin.json(JSON.parse(JSON.stringify({ schemaVersion: 1, payload: input.form ?? {} })))},
        ${input.fullName ?? 'Nadia Khan'},
        ${input.email === undefined ? `${id}@example.test` : input.email},
        ${admin.json(JSON.parse(JSON.stringify(input.order ?? {})))}
      )
    `;
    return id;
  };

  const move = (
    leadId: string,
    stage: string,
    extra: { workspaceId?: string; order?: Record<string, string | null> } = {},
  ) =>
    work.updateLead({
      ...staff(extra.workspaceId),
      leadId,
      stage,
      catalog: codePropertyCatalog,
      ...(extra.order ? { order: extra.order } : {}),
    });

  const jobs = (leadId: string) =>
    admin<{ id: string; jobType: string; dedupeKey: string; payload: CustomerEmailJobPayload }[]>`
      select id, job_type as "jobType", dedupe_key as "dedupeKey", payload
      from app.outbox_jobs
      where payload ->> 'leadId' = ${leadId}
      order by created_at, id
    `;

  /** Each run of the lead with its one step (`main`): the built-ins send one mail each. */
  const runs = (leadId: string) =>
    admin<
      {
        automationKey: string;
        status: string;
        stepId: string | null;
        outcome: string | null;
        reason: string | null;
        detail: string | null;
        jobId: string | null;
      }[]
    >`
      select r.automation_key as "automationKey", r.status, s.step_id as "stepId",
        s.outcome, s.reason, s.detail, s.job_id as "jobId"
      from app.automation_runs r
      left join app.automation_step_runs s on s.workspace_id = r.workspace_id and s.run_id = r.id
      where r.lead_id = ${leadId}
      order by r.created_at, r.id, s.created_at, s.id
    `;

  const emailed = (leadId: string) =>
    admin<{ actorId: string; data: Record<string, unknown> }[]>`
      select actor_id as "actorId", data from app.lead_activities
      where lead_id = ${leadId} and kind = 'system' and data ->> 'event' = 'customer_emailed'
      order by created_at, id
    `;

  const runCount = async (key: AutomationKey, workspaceId = SITE) => {
    const [row] = await admin<{ runCount: number }[]>`
      select run_count as "runCount" from app.automations
      where workspace_id = ${workspaceId} and key = ${key}
    `;
    return row?.runCount ?? 0;
  };

  const saveTemplate = async (
    workspaceId: string,
    key: CustomerEmailTemplate,
    subject: string,
    body: string,
  ) => {
    const settings = new DatabaseEmailSettingsStore(database);
    const current = (await settings.listTemplates({ workspaceId, actorId: STAFF })).find(
      (template) => template.key === key,
    );
    const outcome = await settings.putTemplate(staff(workspaceId), key, {
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
    // Deleting the sites removes their leads, plans, jobs, rules, runs, templates and audit rows.
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(SITES)}`;
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'automatic-emails-1001', 'Automatic Emails'),
        (${QUIET_SITE}, 'automatic-emails-1002', 'Automatic Emails Quiet'),
        (${NO_SENDER_SITE}, 'automatic-emails-1003', 'Automatic Emails No Sender'),
        (${BROKEN_SITE}, 'automatic-emails-1004', 'Automatic Emails Broken'),
        (${LONG_SITE}, 'automatic-emails-1005', 'Automatic Emails Long')
    `;
    for (const workspaceId of [SITE, QUIET_SITE, BROKEN_SITE, LONG_SITE]) {
      await admin`
        insert into app.workspace_email_settings (
          workspace_id, from_name, from_address, reply_to, logo_url, brand_color, footer_text,
          site_url, updated_by
        ) values (
          ${workspaceId}, 'Rule Sim', 'orders@rules.example', null, null, '#123abc', '',
          'https://rules.example', ${STAFF}
        )
      `;
    }

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    leadStore = new DatabaseLeadStore(database, environment);
    work = new DatabaseLeadWorkStore(database, environment);

    // Seeded as `ensureBuiltInFlows` seeds them: every built-in has its row and version 1.
    const seed = (workspaceId: string, key: BuiltInAutomationKey, enabled: boolean) =>
      seedBuiltInFlow(admin, { workspaceId, key, enabled, actorId: STAFF });
    for (const key of RULES_ON) await seed(SITE, key, true);
    await seed(SITE, 'mobility_activated', false);
    await seed(QUIET_SITE, 'order_received', false);
    for (const workspaceId of [NO_SENDER_SITE, BROKEN_SITE, LONG_SITE]) {
      await seed(workspaceId, 'sim_order_cancelled', true);
    }

    await saveTemplate(
      SITE,
      'order_received',
      'We have your order',
      'Hi {first name},\n\nYour {plan} order ({price}) is in.',
    );
    await saveTemplate(
      SITE,
      'dispatched',
      'Your order is on its way',
      'Hi {first name},\n\nIt is with {courier}, tracking number {tracking number}.',
    );
    // A version saved before a parser change: it no longer parses.
    await admin`
      insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
      values (${BROKEN_SITE}, 'cancelled', 'Cancelled', 'Hi {tracking nmber}', 1, ${STAFF})
    `;

    for (const workspaceId of [SITE, QUIET_SITE]) {
      const created = await new DatabasePlanStore(database).create(staff(workspaceId), planInput);
      if (created.kind !== 'created') throw new Error(`plan not created: ${created.kind}`);
      plans.set(workspaceId, created.plan);
      if (workspaceId === SITE) plan = created.plan;
    }
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('sends the order received mail once at website submit, naming the frozen plan, and never again on a retry', async () => {
    const input = submitted('submit-once');
    const first = await leadStore.createLead(input);
    const leadId = first.lead.id;

    const queued = await jobs(leadId);
    expect(queued).toHaveLength(1);
    const [job] = queued;
    expect(job).toMatchObject({
      jobType: CUSTOMER_EMAIL_JOB_TYPE,
      dedupeKey: `${leadId}:order_received:submitted`,
    });
    const payload = customerEmailJobPayloadSchema.parse(job?.payload);
    expect(payload).toMatchObject({
      leadId,
      template: 'order_received',
      templateVersion: 1,
      toAddress: 'submit-once@example.test',
    });
    expect(payload.rendered.text).toContain('Your Rogers 60GB Visitor order ($40.00/month) is in.');
    expect(await runs(leadId)).toEqual([
      {
        automationKey: 'order_received',
        status: 'completed',
        stepId: 'main',
        outcome: 'done',
        reason: null,
        detail: null,
        jobId: job?.id,
      },
    ]);
    expect(await runCount('order_received')).toBe(1);
    // Queued by the website's credential, as the flow's mail.
    expect(await emailed(leadId)).toEqual([
      {
        actorId: CREDENTIAL,
        data: {
          event: 'customer_emailed',
          template: 'order_received',
          templateVersion: 1,
          automation: 'order_received',
          automationName: builtInFlowName('order_received'),
        },
      },
    ]);

    const replayed = await leadStore.createLead({ ...input, requestId: randomUUID() });
    expect(replayed).toMatchObject({ replayed: true, lead: { id: leadId } });
    expect(await jobs(leadId)).toHaveLength(1);
    expect(await runs(leadId)).toHaveLength(1);
    expect(await runCount('order_received')).toBe(1);
  });

  it('sends it when a draft is submitted, and not for a replay of that submit', async () => {
    const draft = await leadStore.createLead({
      ...website(),
      leadType: 'sim_order',
      consentVersion: 'ci',
      contact: { fullName: 'Draft Person', email: 'draft-submit@example.test' },
      form: { schemaVersion: 1, payload: { delivery: 'esim' } },
      order: { planId: plan.id, quantity: 1 },
    });
    const leadId = draft.lead.id;
    const grantToken = draft.grant?.token;
    if (!grantToken) throw new Error('expected a draft grant');
    expect(await jobs(leadId)).toEqual([]);
    const before = await runCount('order_received');

    const idempotency = {
      keyHash: idempotencyKeyHash('key-draft-submit'),
      fingerprint: requestFingerprint({ submit: true }),
    };
    const submit = () =>
      leadStore.updateLead({ ...website(), leadId, grantToken, submit: true, idempotency });
    expect(await submit()).toMatchObject({ status: 'updated', lead: { status: 'submitted' } });
    const queued = await jobs(leadId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ template: 'order_received', templateVersion: 1 });
    expect(queued[0]?.payload.rendered.text).toContain('Draft');
    expect(await runs(leadId)).toMatchObject([
      { automationKey: 'order_received', status: 'completed', outcome: 'done' },
    ]);

    expect(await submit()).toMatchObject({ status: 'updated', replayed: true });
    expect(await jobs(leadId)).toHaveLength(1);
    expect(await runs(leadId)).toHaveLength(1);
    expect(await runCount('order_received')).toBe(before + 1);
  });

  it('queues nothing and records no run while the flow is off', async () => {
    const created = await leadStore.createLead(submitted('rule-off', QUIET_SITE));
    expect(await jobs(created.lead.id)).toEqual([]);
    expect(await runs(created.lead.id)).toEqual([]);
    expect(await runCount('order_received', QUIET_SITE)).toBe(0);
  });

  it('sends the dispatched mail when an order moves to Delivered, and again on a later move back', async () => {
    const leadId = await insertLead({ stage: 'verified' });
    const before = await runCount('sim_order_dispatched');

    const outcome = await move(leadId, 'delivered', {
      order: { courier: 'Canada Post', trackingNumber: 'LX123456789CA' },
    });
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    expect(outcome).not.toHaveProperty('emailSkipped');
    const first = await jobs(leadId);
    expect(first).toHaveLength(1);
    expect(first[0]?.payload).toMatchObject({ template: 'dispatched', templateVersion: 1 });
    expect(first[0]?.payload.rendered.text).toContain('LX123456789CA');
    const statusChange = outcome.activities.find((entry) => entry.kind === 'status_change');
    expect(first[0]?.dedupeKey).toBe(`${leadId}:sim_order_dispatched:${statusChange?.id}`);
    expect(await emailed(leadId)).toEqual([
      {
        actorId: STAFF,
        data: {
          event: 'customer_emailed',
          template: 'dispatched',
          templateVersion: 1,
          automation: 'sim_order_dispatched',
          automationName: builtInFlowName('sim_order_dispatched'),
        },
      },
    ]);
    // The move answers with every entry it wrote, the rule's mail among them,
    // so the lead page shows it without a reload.
    expect(outcome.activities).toContainEqual(
      expect.objectContaining({
        kind: 'system',
        event: 'customer_emailed',
        template: 'dispatched',
        templateVersion: 1,
        automation: 'sim_order_dispatched',
      }),
    );
    expect(await runs(leadId)).toEqual([
      {
        automationKey: 'sim_order_dispatched',
        status: 'completed',
        stepId: 'main',
        outcome: 'done',
        reason: null,
        detail: null,
        jobId: first[0]?.id,
      },
    ]);
    expect(await runCount('sim_order_dispatched')).toBe(before + 1);

    // Back and forth is a new move each time, and a new mail.
    expect(await move(leadId, 'on_hold')).toMatchObject({ status: 'updated' });
    expect(await move(leadId, 'verified')).toMatchObject({ status: 'updated' });
    expect(await move(leadId, 'delivered')).toMatchObject({ status: 'updated' });
    const all = await jobs(leadId);
    expect(all.map((job) => job.payload.template)).toEqual([
      'dispatched',
      'information_needed',
      'dispatched',
    ]);
    expect(await runCount('sim_order_dispatched')).toBe(before + 2);
  });

  it('moves on without the mail when the order lacks a fill-in, and says which', async () => {
    const leadId = await insertLead({ stage: 'verified' });
    const outcome = await move(leadId, 'delivered', { order: { courier: 'Canada Post' } });
    expect(outcome).toMatchObject({ status: 'updated', lead: { stage: 'delivered' } });
    if (outcome.status !== 'updated') throw new Error('not updated');
    expect(outcome.emailSkipped).toEqual([
      {
        automation: 'sim_order_dispatched',
        flowName: builtInFlowName('sim_order_dispatched'),
        template: 'dispatched',
        templateName: 'Dispatched',
        reason: 'missing_fill_in',
        missing: ['tracking number'],
      },
    ]);
    expect(await jobs(leadId)).toEqual([]);
    // The run went on and ended; its one step was skipped, naming the fill-ins.
    expect(await runs(leadId)).toEqual([
      {
        automationKey: 'sim_order_dispatched',
        status: 'completed',
        stepId: 'main',
        outcome: 'skipped',
        reason: 'missing_fill_in',
        detail: 'tracking number',
        jobId: null,
      },
    ]);
  });

  it('records a skip for an order with no customer email', async () => {
    const leadId = await insertLead({ stage: 'verified', email: null });
    const outcome = await move(leadId, 'cancelled');
    expect(outcome).toMatchObject({
      status: 'updated',
      emailSkipped: [
        { automation: 'sim_order_cancelled', template: 'cancelled', reason: 'no_customer_email' },
      ],
    });
    expect(await jobs(leadId)).toEqual([]);
    expect(await runs(leadId)).toMatchObject([
      { status: 'completed', outcome: 'skipped', reason: 'no_customer_email' },
    ]);
  });

  it('records a skip for a site with no sender', async () => {
    const leadId = await insertLead({ workspaceId: NO_SENDER_SITE, stage: 'pending' });
    const outcome = await move(leadId, 'cancelled', { workspaceId: NO_SENDER_SITE });
    expect(outcome).toMatchObject({
      status: 'updated',
      emailSkipped: [
        {
          automation: 'sim_order_cancelled',
          flowName: builtInFlowName('sim_order_cancelled'),
          template: 'cancelled',
          templateName: 'Cancelled',
          reason: 'no_sender',
        },
      ],
    });
    expect(await jobs(leadId)).toEqual([]);
    expect(await runs(leadId)).toEqual([
      {
        automationKey: 'sim_order_cancelled',
        status: 'completed',
        stepId: 'main',
        outcome: 'skipped',
        reason: 'no_sender',
        detail: null,
        jobId: null,
      },
    ]);
  });

  it('mails nothing when a checkout the customer never submitted is cancelled', async () => {
    const before = await runCount('sim_order_cancelled');
    const abandoned = await insertLead({ status: 'incomplete', stage: 'incomplete' });
    const outcome = await move(abandoned, 'cancelled');
    expect(outcome).toMatchObject({ status: 'updated', lead: { stage: 'cancelled' } });
    expect(outcome).not.toHaveProperty('emailSkipped');
    expect(await jobs(abandoned)).toEqual([]);
    expect(await runs(abandoned)).toEqual([]);
    // Not even the skip a missing address would otherwise record.
    const noAddress = await insertLead({ status: 'incomplete', stage: 'incomplete', email: null });
    const quiet = await move(noAddress, 'cancelled');
    expect(quiet).toMatchObject({ status: 'updated', lead: { stage: 'cancelled' } });
    expect(quiet).not.toHaveProperty('emailSkipped');
    expect(await runs(noAddress)).toEqual([]);
    expect(await runCount('sim_order_cancelled')).toBe(before);

    // The same move of an order that was placed mails the customer.
    const placed = await insertLead({ stage: 'pending' });
    expect(await move(placed, 'cancelled')).toMatchObject({ status: 'updated' });
    const queued = await jobs(placed);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ template: 'cancelled' });
    expect(await runs(placed)).toEqual([
      {
        automationKey: 'sim_order_cancelled',
        status: 'completed',
        stepId: 'main',
        outcome: 'done',
        reason: null,
        detail: null,
        jobId: queued[0]?.id,
      },
    ]);
    expect(await runCount('sim_order_cancelled')).toBe(before + 1);
  });

  it('fires nothing for a flow that is off or a type with no flows', async () => {
    const mobility = await insertLead({ leadType: 'mobility', stage: 'qualified' });
    const activated = await move(mobility, 'activated');
    expect(activated).toMatchObject({ status: 'updated', lead: { stage: 'activated' } });
    expect(activated).not.toHaveProperty('emailSkipped');
    expect(await jobs(mobility)).toEqual([]);
    expect(await runs(mobility)).toEqual([]);

    const message = await insertLead({ leadType: 'contact_message', stage: 'new' });
    const closed = await move(message, 'closed');
    expect(closed).toMatchObject({ status: 'updated', lead: { stage: 'closed' } });
    expect(closed).not.toHaveProperty('emailSkipped');
    expect(await jobs(message)).toEqual([]);
    expect(await runs(message)).toEqual([]);
  });

  it('never fails the move over a stored template that no longer parses, and logs no customer detail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const leadId = await insertLead({
        workspaceId: BROKEN_SITE,
        stage: 'pending',
        email: 'broken.customer@example.test',
      });
      const outcome = await move(leadId, 'cancelled', { workspaceId: BROKEN_SITE });
      expect(outcome).toMatchObject({
        status: 'updated',
        lead: { stage: 'cancelled' },
        emailSkipped: [
          { automation: 'sim_order_cancelled', template: 'cancelled', reason: 'compose_failed' },
        ],
      });
      expect(await jobs(leadId)).toEqual([]);
      // The failure is no longer invisible: the step and its run say so.
      expect(await runs(leadId)).toEqual([
        {
          automationKey: 'sim_order_cancelled',
          status: 'failed',
          stepId: 'main',
          outcome: 'failed',
          reason: 'compose_failed',
          detail: null,
          jobId: null,
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(JSON.parse(logged)).toMatchObject({
        event: 'automation_compose_failed',
        workspaceId: BROKEN_SITE,
        automation: 'sim_order_cancelled',
        template: 'cancelled',
      });
      expect(logged).not.toContain('broken.customer');
      expect(logged).not.toContain('Nadia');
    } finally {
      warn.mockRestore();
    }
  });

  it('queues nothing for a mail that would not fit its job, and logs only the flow', async () => {
    // A subject at its 150-character limit, filled with a long name, passes the job's 300.
    const subject = 'Cancelled: {first name} {last name}, yes {first name} {last name} '.padEnd(
      150,
      'x',
    );
    expect(subject).toHaveLength(150);
    await saveTemplate(LONG_SITE, 'cancelled', subject, 'Your order is cancelled.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const leadId = await insertLead({
        workspaceId: LONG_SITE,
        stage: 'pending',
        fullName: `${'Annabelle'.repeat(9)} ${'Lee'.repeat(25)}`,
        email: 'long.customer@example.test',
      });
      const outcome = await move(leadId, 'cancelled', { workspaceId: LONG_SITE });
      expect(outcome).toMatchObject({
        status: 'updated',
        lead: { stage: 'cancelled' },
        emailSkipped: [{ automation: 'sim_order_cancelled', reason: 'compose_failed' }],
      });
      expect(await jobs(leadId)).toEqual([]);
      expect(await runs(leadId)).toMatchObject([
        { status: 'failed', outcome: 'failed', reason: 'compose_failed' },
      ]);
      expect(await emailed(leadId)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(Object.keys(JSON.parse(logged)).sort()).toEqual([
        'automation',
        'event',
        'requestId',
        'template',
        'workspaceId',
      ]);
      expect(JSON.parse(logged)).toMatchObject({
        event: 'automation_compose_failed',
        workspaceId: LONG_SITE,
        automation: 'sim_order_cancelled',
        template: 'cancelled',
      });
      expect(logged).not.toContain('long.customer');
      expect(logged).not.toContain('Annabelle');
      expect(logged).not.toContain('Cancelled:');
    } finally {
      warn.mockRestore();
    }
  });

  it('queues one mail per occurrence: the same occurrence again records nothing', async () => {
    const leadId = await insertLead({ stage: 'cancelled' });
    const fire = () =>
      database.withTenantTx({ workspaceId: SITE, actorId: STAFF }, (tx) =>
        fireFlows(tx, { ...staff(), environment }, [
          {
            kind: 'stage_entered',
            leadId,
            leadType: 'sim_order',
            stage: 'cancelled',
            occurrence: 'occurrence-1',
            depth: 0,
            chain: [],
            parentRunId: null,
            at: new Date(),
          },
        ]),
      );
    const first = await fire();
    expect(first).toEqual({
      skipped: [],
      activities: [
        expect.objectContaining({
          kind: 'system',
          event: 'customer_emailed',
          automation: 'sim_order_cancelled',
        }),
      ],
    });
    // The run is unique per occurrence: the second firing writes nothing.
    expect(await fire()).toEqual({ skipped: [], activities: [] });
    expect(await jobs(leadId)).toHaveLength(1);
    expect(await runs(leadId)).toHaveLength(1);
    expect((await jobs(leadId))[0]?.dedupeKey).toBe(`${leadId}:sim_order_cancelled:occurrence-1`);
  });

  it('fireFlows on a lead that is still incomplete records nothing', async () => {
    const leadId = await insertLead({ status: 'incomplete', stage: 'incomplete' });
    const event = {
      leadId,
      leadType: 'sim_order',
      depth: 0,
      chain: [],
      parentRunId: null,
      at: new Date(),
    };
    const fired = await database.withTenantTx({ workspaceId: SITE, actorId: STAFF }, (tx) =>
      fireFlows(tx, { ...staff(), environment }, [
        { ...event, kind: 'lead_submitted', stage: 'incomplete', occurrence: 'submitted' },
        { ...event, kind: 'stage_entered', stage: 'cancelled', occurrence: 'occurrence-2' },
      ]),
    );
    expect(fired).toEqual({ skipped: [], activities: [] });
    expect(await jobs(leadId)).toEqual([]);
    expect(await runs(leadId)).toEqual([]);
  });

  describe('the SIM number mail staff send by hand', () => {
    const send = (leadId: string, workspaceId = SITE, store = work) =>
      store.queueCustomerEmail({
        ...staff(workspaceId),
        requestId: randomUUID(),
        leadId,
        template: 'sim_number_ready',
      });

    it('names what the order lacks', async () => {
      const noNumber = await insertLead({ stage: 'delivered' });
      expect(await send(noNumber)).toEqual({ status: 'missing', missing: ['SIM number'] });
      const noEmail = await insertLead({
        stage: 'delivered',
        email: null,
        form: { simNumber: '+1 647 555 0123' },
      });
      expect(await send(noEmail)).toEqual({ status: 'missing', missing: ['customer email'] });
      const noSender = await insertLead({
        workspaceId: NO_SENDER_SITE,
        stage: 'delivered',
        form: { simNumber: '+1 647 555 0123' },
      });
      expect(await send(noSender, NO_SENDER_SITE)).toEqual({ status: 'no_sender' });
      expect(await jobs(noNumber)).toEqual([]);
      expect(await jobs(noEmail)).toEqual([]);
      expect(await jobs(noSender)).toEqual([]);
    });

    it('queues the site’s saved version, as staff’s mail and not a rule’s', async () => {
      await saveTemplate(
        SITE,
        'sim_number_ready',
        'Your number',
        'Hi {first name}, it is {SIM number}.',
      );
      const version = await saveTemplate(
        SITE,
        'sim_number_ready',
        'Your number is ready',
        'Hi {first name}, your number is **{SIM number}**.',
      );
      expect(version).toBe(2);
      const leadId = await insertLead({
        stage: 'delivered',
        form: { simNumber: '+1 647 555 0123' },
      });

      const requestId = randomUUID();
      const outcome = await work.queueCustomerEmail({
        ...staff(),
        requestId,
        leadId,
        template: 'sim_number_ready',
      });
      expect(outcome).toMatchObject({
        status: 'queued',
        activity: {
          kind: 'system',
          event: 'customer_emailed',
          template: 'sim_number_ready',
          templateVersion: 2,
        },
      });
      const queued = await jobs(leadId);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        jobType: CUSTOMER_EMAIL_JOB_TYPE,
        dedupeKey: `${leadId}:${requestId}`,
        payload: { template: 'sim_number_ready', templateVersion: 2 },
      });
      expect(queued[0]?.payload.rendered.text).toContain('+1 647 555 0123');
      expect(await emailed(leadId)).toEqual([
        {
          actorId: STAFF,
          data: { event: 'customer_emailed', template: 'sim_number_ready', templateVersion: 2 },
        },
      ]);
      expect(await runs(leadId)).toEqual([]);
    });
  });
});
