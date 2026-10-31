import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { codePropertyCatalog, type CustomerEmailJobPayload } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { fireFlows, type FlowEvent } from '../src/automations/engine.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore, applyLeadUpdate } from '../src/leads/work-store.js';
import {
  addActiveVersion,
  disposableTestDatabaseUrl,
  flowKey,
  insertActiveFlow,
  seedBuiltInFlow,
} from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008301'; // a built-in and custom flows
const GONE_SITE = '18000000-0000-4000-8000-000000008302'; // flows naming what is gone
const BROKEN_SITE = '18000000-0000-4000-8000-000000008303'; // a template that will not render
const RACE_SITE = '18000000-0000-4000-8000-000000008304'; // activation and switching mid-move
const SUBMIT_SITE = '18000000-0000-4000-8000-000000008305'; // submissions and the conversion
const SITES = [SITE, GONE_SITE, BROKEN_SITE, RACE_SITE, SUBMIT_SITE];
const STAFF = '28000000-0000-4000-8000-000000008301';
const CREDENTIAL = '28000000-0000-4000-8000-000000008302';
const PLAN = '48000000-0000-4000-8000-000000008305';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const ARCHIVED_TEMPLATE = 'tpl_engine8302000001';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789',
};

/** A definition from its trigger and steps, stored as given (it may be one that no longer parses). */
const flow = (trigger: unknown, steps: readonly unknown[]) => ({
  schemaVersion: 1,
  trigger,
  steps,
});
const entered = (stage: string, leadType = 'sim_order') =>
  ({ kind: 'stage_entered', leadType, stage, when: null }) as const;
const send = (id: string, template: string) => ({ id, kind: 'send_email', template });

databaseTest('the flow engine', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let leadStore: DatabaseLeadStore;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const staff = (workspaceId: string) => ({ workspaceId, actorId: STAFF, requestId: randomUUID() });

  const insertLead = async (input: {
    workspaceId: string;
    leadType?: string;
    stage: string;
    assignedActorId?: string | null;
    email?: string | null;
    order?: Record<string, unknown>;
  }): Promise<string> => {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        full_name, email, assigned_actor_id, order_details
      ) values (
        ${id}, ${input.workspaceId}, ${input.leadType ?? 'sim_order'}, 'submitted', ${input.stage},
        'ci', '{}'::jsonb, '{"schemaVersion":1,"payload":{}}'::jsonb, 'Nadia Khan',
        ${input.email === undefined ? `${id}@example.test` : input.email},
        ${input.assignedActorId ?? null},
        ${admin.json(JSON.parse(JSON.stringify(input.order ?? {})))}
      )
    `;
    return id;
  };

  const move = (workspaceId: string, leadId: string, stage: string) =>
    work.updateLead({
      ...staff(workspaceId),
      leadId,
      stage,
      catalog: codePropertyCatalog,
      ...(stage === 'delivered'
        ? { order: { courier: 'Canada Post', trackingNumber: 'LX1CA' } }
        : {}),
    });

  const jobs = (leadId: string) =>
    admin<{ id: string; dedupeKey: string; payload: CustomerEmailJobPayload }[]>`
      select id, dedupe_key as "dedupeKey", payload from app.outbox_jobs
      where payload ->> 'leadId' = ${leadId}
      order by created_at, id
    `;

  const runs = (leadId: string) =>
    admin<
      {
        id: string;
        automationKey: string;
        status: string;
        reason: string | null;
        detail: string | null;
        occurrence: string | null;
        versionId: string | null;
        finished: boolean;
      }[]
    >`
      select id, automation_key as "automationKey", status, reason, detail, occurrence,
        version_id as "versionId", finished_at is not null as finished
      from app.automation_runs where lead_id = ${leadId}
      order by created_at, id
    `;

  const steps = (runId: string) =>
    admin<
      {
        stepId: string;
        stepKind: string;
        outcome: string;
        branch: string | null;
        reason: string | null;
        jobId: string | null;
      }[]
    >`
      select step_id as "stepId", step_kind as "stepKind", outcome, branch, reason,
        job_id as "jobId"
      from app.automation_step_runs where run_id = ${runId}
      order by created_at, id
    `;

  const stageEvent = (leadId: string, stage: string, occurrence: string): FlowEvent => ({
    kind: 'stage_entered',
    leadId,
    leadType: 'sim_order',
    stage,
    occurrence,
    depth: 0,
    chain: [],
    parentRunId: null,
    at: new Date(),
  });

  const fire = (workspaceId: string, events: FlowEvent[]) =>
    database.withTenantTx({ workspaceId, actorId: STAFF }, (tx) =>
      fireFlows(tx, { ...staff(workspaceId), environment }, events),
    );

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 2, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(SITES)}`;
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
    for (const [index, id] of SITES.entries()) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${id}, ${`automation-engine-830${index + 1}`}, ${`Engine Site ${index + 1}`})
      `;
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status)
        values (${id}, ${STAFF}, 'staff', 'active')
      `;
      await admin`
        insert into app.workspace_email_settings (
          workspace_id, from_name, from_address, reply_to, logo_url, brand_color, footer_text,
          site_url, updated_by
        ) values (
          ${id}, 'Engine Sim', 'orders@engine.example', null, null, '#123abc', '',
          'https://engine.example', ${STAFF}
        )
      `;
    }
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, price_minor, billing_period, active, position)
      values (${PLAN}, ${SUBMIT_SITE}, 'sim_order', 'Engine plan', 1000, 'month', true, 0)
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    work = new DatabaseLeadWorkStore(database, environment);
    leadStore = new DatabaseLeadStore(database, environment);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('a built-in and a custom flow on one move send two mails, once', async () => {
    await seedBuiltInFlow(admin, {
      workspaceId: SITE,
      key: 'sim_order_dispatched',
      enabled: true,
      actorId: STAFF,
    });
    const custom = flowKey('8301', 1);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: custom,
      name: 'My dispatch note',
      enabled: true,
      definition: flow(entered('delivered'), [send('s_mail0001', 'order_received')]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: SITE, stage: 'verified' });
    const outcome = await move(SITE, leadId, 'delivered');
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    const occurrence = outcome.activities.find((entry) => entry.kind === 'status_change')?.id;
    // One transaction's jobs share their creation time: compared as a set.
    expect((await jobs(leadId)).map((job) => job.dedupeKey).sort()).toEqual(
      [
        `${leadId}:sim_order_dispatched:${occurrence}`,
        `${leadId}:${custom}:${occurrence}:s_mail0001`,
      ].sort(),
    );
    expect((await runs(leadId)).map((run) => [run.automationKey, run.status])).toEqual([
      ['sim_order_dispatched', 'completed'],
      [custom, 'completed'],
    ]);

    // The same occurrence fired again: no third mail, no new run.
    if (!occurrence) throw new Error('no status change');
    expect(await fire(SITE, [stageEvent(leadId, 'delivered', occurrence)])).toEqual({
      skipped: [],
      activities: [],
    });
    expect(await jobs(leadId)).toHaveLength(2);
    expect(await runs(leadId)).toHaveLength(2);
  });

  it('a flow whose when does not hold records nothing', async () => {
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8301', 2),
      name: 'Only when owned',
      enabled: true,
      definition: flow(
        { ...entered('on_hold'), when: { match: 'all', items: [{ kind: 'assignee', op: 'any' }] } },
        [send('s_mail0002', 'information_needed')],
      ),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: SITE, stage: 'pending' });
    expect(await move(SITE, leadId, 'on_hold')).toMatchObject({ status: 'updated' });
    expect(await runs(leadId)).toEqual([]);
    expect(await jobs(leadId)).toEqual([]);
  });

  it('nested branches take the branch the condition picks and record it', async () => {
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8301', 3),
      name: 'Branches',
      enabled: true,
      definition: flow(entered('cancelled'), [
        {
          id: 's_outer',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'assignee', op: 'none' }] },
          then: [
            {
              id: 's_inner',
              kind: 'if_else',
              condition: {
                match: 'any',
                items: [{ kind: 'stage', op: 'in', stages: ['pending'] }],
              },
              then: [send('s_yes_yes', 'information_needed')],
              else: [send('s_yes_no', 'cancelled')],
            },
          ],
          else: [send('s_no', 'activated')],
        },
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: SITE, stage: 'pending' });
    expect(await move(SITE, leadId, 'cancelled')).toMatchObject({ status: 'updated' });
    const [run] = await runs(leadId);
    expect(run).toMatchObject({ status: 'completed', finished: true });
    expect(await steps(run?.id ?? '')).toEqual([
      expect.objectContaining({ stepId: 's_outer', outcome: 'done', branch: 'yes' }),
      expect.objectContaining({ stepId: 's_inner', outcome: 'done', branch: 'no' }),
      expect.objectContaining({ stepId: 's_yes_no', stepKind: 'send_email', outcome: 'done' }),
    ]);
    expect((await jobs(leadId)).map((job) => job.payload.template)).toEqual(['cancelled']);
  });

  it('a wait stores its resume time and leaves the run waiting', async () => {
    const created = await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8301', 4),
      name: 'Wait then send',
      enabled: true,
      definition: flow(entered('verified'), [
        { id: 's_wait', kind: 'wait', for: { amount: 2, unit: 'days' } },
        send('s_after', 'information_needed'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: SITE, stage: 'pending' });
    const before = Date.now();
    expect(await move(SITE, leadId, 'verified')).toMatchObject({ status: 'updated' });
    const [run] = await runs(leadId);
    expect(run).toMatchObject({ status: 'waiting', finished: false });
    expect(await steps(run?.id ?? '')).toEqual([
      expect.objectContaining({ stepId: 's_wait', stepKind: 'wait', outcome: 'waiting' }),
    ]);
    const [wait] = await admin<{ status: string; resumeAt: Date; automationId: string }[]>`
      select status, resume_at as "resumeAt", automation_id as "automationId"
      from app.automation_waits where run_id = ${run?.id ?? ''}
    `;
    expect(wait).toMatchObject({ status: 'pending', automationId: created.id });
    const expected = before + 2 * 24 * 3_600_000;
    expect(Math.abs((wait?.resumeAt.getTime() ?? 0) - expected)).toBeLessThan(5_000);
    expect(await jobs(leadId)).toEqual([]);
  });

  it('a flow naming a stage or template that is gone is skipped whole, with the key', async () => {
    await admin`
      insert into app.email_templates
        (workspace_id, key, name, subject, body, version, updated_by, archived_at)
      values (${GONE_SITE}, ${ARCHIVED_TEMPLATE}, 'Old note', 'Old', 'Nothing.', 1, ${STAFF}, now())
    `;
    const stageFlow = flowKey('8302', 1);
    const templateFlow = flowKey('8302', 2);
    // Written as stored before the catalogue dropped `paid`, and before the template's archive.
    await insertActiveFlow(admin, {
      workspaceId: GONE_SITE,
      key: stageFlow,
      name: 'Paid branch',
      enabled: true,
      definition: flow(entered('cancelled'), [
        {
          id: 's_paid',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'stage', op: 'in', stages: ['paid'] }] },
          then: [send('s_paid_mail', 'cancelled')],
          else: [],
        },
      ]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: GONE_SITE,
      key: templateFlow,
      name: 'Old note flow',
      enabled: true,
      definition: flow(entered('cancelled'), [send('s_old', ARCHIVED_TEMPLATE)]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: GONE_SITE, stage: 'pending' });
    expect(await move(GONE_SITE, leadId, 'cancelled')).toMatchObject({
      status: 'updated',
      lead: { stage: 'cancelled' },
    });
    const recorded = await runs(leadId);
    expect(
      recorded.map(({ automationKey, status, reason, detail, finished }) => ({
        automationKey,
        status,
        reason,
        detail,
        finished,
      })),
    ).toEqual([
      {
        automationKey: stageFlow,
        status: 'skipped',
        reason: 'stage_unavailable',
        detail: 'paid',
        finished: true,
      },
      {
        automationKey: templateFlow,
        status: 'skipped',
        reason: 'template_unavailable',
        detail: ARCHIVED_TEMPLATE,
        finished: true,
      },
    ]);
    for (const run of recorded) expect(await steps(run.id)).toEqual([]);
    expect(await jobs(leadId)).toEqual([]);
  });

  it('a definition that no longer parses is skipped definition_invalid', async () => {
    const key = flowKey('8302', 3);
    await insertActiveFlow(admin, {
      workspaceId: GONE_SITE,
      key,
      name: 'From the future',
      enabled: true,
      definition: flow(entered('on_hold'), [{ id: 's_x', kind: 'teleport' }]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: GONE_SITE, stage: 'pending' });
    expect(await move(GONE_SITE, leadId, 'on_hold')).toMatchObject({ status: 'updated' });
    expect(await runs(leadId)).toMatchObject([
      { automationKey: key, status: 'skipped', reason: 'definition_invalid', detail: null },
    ]);
  });

  it('a step that throws fails the run and leaves the move committed', async () => {
    // A version saved before a parser change: it no longer parses.
    await admin`
      insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
      values (${BROKEN_SITE}, 'cancelled', 'Cancelled', 'Hi {tracking nmber}', 1, ${STAFF})
    `;
    const key = flowKey('8303', 1);
    await insertActiveFlow(admin, {
      workspaceId: BROKEN_SITE,
      key,
      name: 'Broken mail',
      enabled: true,
      definition: flow(entered('cancelled'), [
        send('s_broken', 'cancelled'),
        send('s_never', 'information_needed'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: BROKEN_SITE, stage: 'pending' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await move(BROKEN_SITE, leadId, 'cancelled');
      expect(outcome).toMatchObject({
        status: 'updated',
        lead: { stage: 'cancelled' },
        emailSkipped: [
          {
            automation: key,
            flowName: 'Broken mail',
            template: 'cancelled',
            templateName: 'Cancelled',
            reason: 'compose_failed',
          },
        ],
      });
    } finally {
      warn.mockRestore();
    }
    const [run] = await runs(leadId);
    expect(run).toMatchObject({ status: 'failed', reason: 'step_failed', finished: true });
    expect(await steps(run?.id ?? '')).toEqual([
      expect.objectContaining({ stepId: 's_broken', outcome: 'failed', reason: 'compose_failed' }),
    ]);
    const [lead] = await admin<
      { stage: string }[]
    >`select stage from app.leads where id = ${leadId}`;
    expect(lead?.stage).toBe('cancelled');
    expect(await jobs(leadId)).toEqual([]);
  });

  it('a version activated while a move is in flight: that move runs the old version, the next the new', async () => {
    const key = flowKey('8304', 1);
    const v1 = await insertActiveFlow(admin, {
      workspaceId: RACE_SITE,
      key,
      name: 'Versioned',
      enabled: true,
      definition: flow(entered('on_hold'), [send('s_mail', 'information_needed')]),
      actorId: STAFF,
    });
    let v2 = '';
    const leadId = await insertLead({ workspaceId: RACE_SITE, stage: 'pending' });
    const outcome = await database.withTenantTx({ workspaceId: RACE_SITE, actorId: STAFF }, (tx) =>
      applyLeadUpdate(
        tx,
        {
          emailEnvironment: environment,
          afterFlowsRead: async () => {
            v2 = await admin.begin((other) =>
              addActiveVersion(other, {
                workspaceId: RACE_SITE,
                automationId: v1.id,
                version: 2,
                definition: flow(entered('on_hold'), [send('s_mail', 'cancelled')]),
                actorId: STAFF,
                activatedBy: STAFF,
              }),
            );
          },
        },
        { ...staff(RACE_SITE), leadId, stage: 'on_hold', catalog: codePropertyCatalog },
      ),
    );
    expect(outcome).toMatchObject({ status: 'updated' });
    expect(await runs(leadId)).toMatchObject([{ versionId: v1.versionId, status: 'completed' }]);
    expect((await jobs(leadId)).map((job) => job.payload.template)).toEqual(['information_needed']);

    // The next move reads the new version.
    expect(await move(RACE_SITE, leadId, 'pending')).toMatchObject({ status: 'updated' });
    expect(await move(RACE_SITE, leadId, 'on_hold')).toMatchObject({ status: 'updated' });
    expect((await runs(leadId)).map((run) => run.versionId)).toEqual([v1.versionId, v2]);
    expect((await jobs(leadId)).map((job) => job.payload.template)).toEqual([
      'information_needed',
      'cancelled',
    ]);
  });

  it('a flow switched off mid-move still runs for that move only', async () => {
    const key = flowKey('8304', 2);
    const created = await insertActiveFlow(admin, {
      workspaceId: RACE_SITE,
      key,
      name: 'Switched',
      enabled: true,
      definition: flow(entered('verified'), [send('s_mail', 'information_needed')]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: RACE_SITE, stage: 'pending' });
    const outcome = await database.withTenantTx({ workspaceId: RACE_SITE, actorId: STAFF }, (tx) =>
      applyLeadUpdate(
        tx,
        {
          emailEnvironment: environment,
          afterFlowsRead: async () => {
            await admin`update app.automations set enabled = false where id = ${created.id}`;
          },
        },
        { ...staff(RACE_SITE), leadId, stage: 'verified', catalog: codePropertyCatalog },
      ),
    );
    expect(outcome).toMatchObject({ status: 'updated' });
    expect(await runs(leadId)).toMatchObject([{ automationKey: key, status: 'completed' }]);
    expect(await move(RACE_SITE, leadId, 'on_hold')).toMatchObject({ status: 'updated' });
    expect(await move(RACE_SITE, leadId, 'verified')).toMatchObject({ status: 'updated' });
    expect((await runs(leadId)).filter((run) => run.automationKey === key)).toHaveLength(1);
  });

  it('submission flows run before the stage flows of the same submit', async () => {
    const submittedFlow = flowKey('8305', 1);
    const pendingFlow = flowKey('8305', 2);
    // The stage flow is created first: order of firing is submission flows first, not creation.
    await insertActiveFlow(admin, {
      workspaceId: SUBMIT_SITE,
      key: pendingFlow,
      name: 'Pending flow',
      enabled: true,
      definition: flow(entered('pending'), [send('s_pending', 'information_needed')]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: SUBMIT_SITE,
      key: submittedFlow,
      name: 'Submitted flow',
      enabled: true,
      definition: flow({ kind: 'lead_submitted', leadTypes: ['sim_order'], when: null }, [
        send('s_submitted', 'order_received'),
      ]),
      actorId: STAFF,
    });
    const created = await leadStore.createLead({
      workspaceId: SUBMIT_SITE,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'sim_order',
      consentVersion: 'ci',
      contact: { fullName: 'Ravi Patel', email: 'engine-submit@example.test' },
      form: { schemaVersion: 1, payload: { delivery: 'esim' } },
      order: { planId: PLAN, quantity: 1 },
      submit: true,
    });
    const leadId = created.lead.id;
    const [entry] = await admin<{ id: string }[]>`
      select id from app.lead_activities
      where lead_id = ${leadId} and kind = 'system' and data ->> 'event' = 'submitted'
    `;
    expect((await runs(leadId)).map((run) => [run.automationKey, run.occurrence])).toEqual([
      [submittedFlow, 'submitted'],
      [pendingFlow, entry?.id],
    ]);
    const emailed = await admin<{ actorId: string }[]>`
      select actor_id as "actorId" from app.lead_activities
      where lead_id = ${leadId} and data ->> 'event' = 'customer_emailed'
    `;
    expect(emailed.map((row) => row.actorId)).toEqual([CREDENTIAL, CREDENTIAL]);
  });

  it('a type that does not move on submit enters its first stage as submitted:stage', async () => {
    const key = flowKey('8305', 3);
    await insertActiveFlow(admin, {
      workspaceId: SUBMIT_SITE,
      key,
      name: 'New internet lead',
      enabled: true,
      definition: flow(entered('new', 'internet'), [send('s_new', 'order_received')]),
      actorId: STAFF,
    });
    const created = await leadStore.createLead({
      workspaceId: SUBMIT_SITE,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'internet',
      consentVersion: 'ci',
      contact: { fullName: 'Ada Lin', email: 'engine-internet@example.test' },
      submit: true,
    });
    expect(await runs(created.lead.id)).toMatchObject([
      { automationKey: key, occurrence: 'submitted:stage', status: 'completed' },
    ]);
  });

  it('after the conversion, replaying an occurrence the old code mailed queues nothing', async () => {
    const seeded = await seedBuiltInFlow(admin, {
      workspaceId: SUBMIT_SITE,
      key: 'sim_order_dispatched',
      enabled: true,
      actorId: STAFF,
    });
    const leadId = await insertLead({
      workspaceId: SUBMIT_SITE,
      stage: 'delivered',
      order: { courier: 'Canada Post', trackingNumber: 'LX9CA' },
    });
    // What phase 4 left and 0020 converted: a queued run with its job and occurrence X.
    const mailed = randomUUID();
    const [job] = await admin<{ id: string }[]>`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload)
      values (${SUBMIT_SITE}, 'lead_customer_email', ${`${leadId}:sim_order_dispatched:${mailed}`},
        ${admin.json({ leadId })})
      returning id
    `;
    await admin`
      insert into app.automation_runs
        (workspace_id, automation_key, automation_id, version_id, lead_id, outcome, job_id,
         status, occurrence, finished_at)
      values (${SUBMIT_SITE}, 'sim_order_dispatched', ${seeded.id}, ${seeded.versionId}, ${leadId},
        'queued', ${job?.id ?? null}, 'completed', ${mailed}, now())
    `;
    expect(await fire(SUBMIT_SITE, [stageEvent(leadId, 'delivered', mailed)])).toEqual({
      skipped: [],
      activities: [],
    });
    expect(await runs(leadId)).toHaveLength(1);
    expect(await jobs(leadId)).toHaveLength(1);

    // Only the job is left (its run pruned): the run records the mail as already sent.
    const onlyJob = randomUUID();
    await admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload)
      values (${SUBMIT_SITE}, 'lead_customer_email', ${`${leadId}:sim_order_dispatched:${onlyJob}`},
        ${admin.json({ leadId })})
    `;
    await fire(SUBMIT_SITE, [stageEvent(leadId, 'delivered', onlyJob)]);
    const all = await runs(leadId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ occurrence: onlyJob, status: 'completed' });
    expect(await steps(all[1]?.id ?? '')).toEqual([
      expect.objectContaining({ stepId: 'main', outcome: 'skipped', reason: 'already_sent' }),
    ]);
    expect(await jobs(leadId)).toHaveLength(2);
  });

  it("a move's response carries what its flows wrote", async () => {
    const key = flowKey('8301', 5);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key,
      name: 'Two mails',
      enabled: true,
      definition: flow(entered('on_hold'), [
        send('s_one', 'information_needed'),
        send('s_two', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead({ workspaceId: SITE, stage: 'pending' });
    const outcome = await move(SITE, leadId, 'on_hold');
    if (outcome.status !== 'updated') throw new Error('not updated');
    const mails = outcome.activities.filter(
      (entry) => entry.kind === 'system' && entry.event === 'customer_emailed',
    );
    expect(mails).toHaveLength(2);
    expect(mails[0]).toMatchObject({ automation: key, automationName: 'Two mails' });
    expect(outcome).not.toHaveProperty('emailSkipped');

    const noAddress = await insertLead({ workspaceId: SITE, stage: 'pending', email: null });
    const skipped = await move(SITE, noAddress, 'on_hold');
    expect(skipped).toMatchObject({
      status: 'updated',
      emailSkipped: [
        { automation: key, template: 'information_needed', reason: 'no_customer_email' },
        { automation: key, template: 'cancelled', reason: 'no_customer_email' },
      ],
    });
  });
});
