import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { codePropertyCatalog, type CreatePlanRequest } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { fireFlows } from '../src/automations/engine.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import { loadPropertyCatalog } from '../src/properties/catalog.js';
import {
  disposableTestDatabaseUrl,
  flowKey,
  insertActiveFlow,
  seedBuiltInFlow,
} from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008401'; // tasks, assignment, updates
const LOOP_SITE = '18000000-0000-4000-8000-000000008402'; // flows that move each other
const CHAIN_SITE = '18000000-0000-4000-8000-000000008403'; // four chained flows
const SECRET_SITE = '18000000-0000-4000-8000-000000008404'; // a property made sensitive
const ACCESS_SITE = '18000000-0000-4000-8000-000000008405'; // activators who lost access
const SITES = [SITE, LOOP_SITE, CHAIN_SITE, SECRET_SITE, ACCESS_SITE];
const OWNER = '28000000-0000-4000-8000-000000008401'; // owner on every site
const MEMBER = '28000000-0000-4000-8000-000000008402'; // leads role on SITE
const VIEWER = '28000000-0000-4000-8000-000000008403'; // viewer on ACCESS_SITE
const LEFT = '28000000-0000-4000-8000-000000008404'; // revoked on SITE and ACCESS_SITE
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SECRET_VALUE = 'ZX-SECRET-9';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789',
};

const flow = (trigger: unknown, steps: readonly unknown[]) => ({
  schemaVersion: 1,
  trigger,
  steps,
});
const entered = (stage: string, leadType = 'sim_order') => ({
  kind: 'stage_entered',
  leadType,
  stage,
  when: null,
});
const toStage = (id: string, stage: string) => ({
  id,
  kind: 'update_lead',
  change: { kind: 'stage', stage },
});

databaseTest('the lead-changing steps', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const staff = (workspaceId: string, actorId = OWNER) => ({
    workspaceId,
    actorId,
    requestId: randomUUID(),
  });

  const insertLead = async (input: {
    workspaceId: string;
    leadType?: string;
    stage: string;
    assignedActorId?: string | null;
    form?: Record<string, unknown>;
    custom?: Record<string, unknown>;
    order?: Record<string, unknown>;
    externalRef?: string | null;
  }): Promise<string> => {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        full_name, email, assigned_actor_id, custom_values, order_details, external_ref
      ) values (
        ${id}, ${input.workspaceId}, ${input.leadType ?? 'sim_order'}, 'submitted', ${input.stage},
        'ci', '{}'::jsonb,
        ${admin.json(JSON.parse(JSON.stringify({ schemaVersion: 1, payload: input.form ?? {} })))},
        'Nadia Khan', ${`${id}@example.test`}, ${input.assignedActorId ?? null},
        ${admin.json(JSON.parse(JSON.stringify(input.custom ?? {})))},
        ${admin.json(JSON.parse(JSON.stringify(input.order ?? {})))},
        ${input.externalRef ?? null}
      )
    `;
    return id;
  };

  const move = (workspaceId: string, leadId: string, stage: string, order = {}) =>
    database.withTenantTx({ workspaceId, actorId: OWNER }, async (tx) => {
      const catalog = await loadPropertyCatalog(tx);
      return work.updateLead({ ...staff(workspaceId), leadId, stage, catalog, order });
    });

  const runs = (leadId: string) =>
    admin<
      {
        id: string;
        automationKey: string;
        status: string;
        reason: string | null;
        detail: string | null;
        depth: number;
      }[]
    >`
      select id, automation_key as "automationKey", status, reason, detail, depth
      from app.automation_runs where lead_id = ${leadId}
      order by created_at, id
    `;

  /** The run of one flow for the lead (the first, when several). */
  const runOf = async (leadId: string, key: string) =>
    (await runs(leadId)).find((run) => run.automationKey === key);

  const steps = (runId: string) =>
    admin<
      {
        stepId: string;
        outcome: string;
        reason: string | null;
        detail: string | null;
        taskId: string | null;
      }[]
    >`
      select step_id as "stepId", outcome, reason, detail, task_id as "taskId"
      from app.automation_step_runs where run_id = ${runId}
      order by created_at, id
    `;

  const leadRow = async (leadId: string) => {
    const [row] = await admin<
      {
        stage: string;
        assignedActorId: string | null;
        customValues: Record<string, unknown>;
        payload: { payload: Record<string, unknown> };
      }[]
    >`
      select stage, assigned_actor_id as "assignedActorId", custom_values as "customValues", payload
      from app.leads where id = ${leadId}
    `;
    return row;
  };

  const jobs = (leadId: string) =>
    admin<{ dedupeKey: string; template: string }[]>`
      select dedupe_key as "dedupeKey", payload ->> 'template' as template from app.outbox_jobs
      where payload ->> 'leadId' = ${leadId}
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
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(SITES)}`;
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
    for (const [index, id] of SITES.entries()) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${id}, ${`automation-actions-840${index + 1}`}, ${`Actions Site ${index + 1}`})
      `;
      await admin`
        insert into app.roles (workspace_id, name)
        values (${id}, 'owner'), (${id}, 'leads'), (${id}, 'viewer')
      `;
      await admin`
        insert into app.workspace_email_settings (
          workspace_id, from_name, from_address, reply_to, logo_url, brand_color, footer_text,
          site_url, updated_by
        ) values (
          ${id}, 'Actions Sim', 'orders@actions.example', null, null, '#123abc', '',
          'https://actions.example', ${OWNER}
        )
      `;
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at)
        values (${id}, ${OWNER}, 'staff', 'active', now())
      `;
    }
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at)
      values (${SITE}, ${MEMBER}, 'staff', 'active', now()),
             (${SITE}, ${LEFT}, 'staff', 'revoked', now()),
             (${ACCESS_SITE}, ${VIEWER}, 'staff', 'active', now()),
             (${ACCESS_SITE}, ${LEFT}, 'staff', 'revoked', now())
    `;
    await admin`
      insert into app.membership_roles (workspace_id, membership_id, role_id)
      select m.workspace_id, m.id, r.id
      from app.memberships m
      join app.roles r on r.workspace_id = m.workspace_id
      where m.workspace_id in ${admin(SITES)}
        and (
          (m.user_id = ${OWNER} and r.name = 'owner')
          or (m.user_id in (${MEMBER}, ${LEFT}) and r.name = 'leads')
          or (m.user_id = ${VIEWER} and r.name = 'viewer')
        )
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position)
      values (${SITE}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1),
             (${SITE}, 'lead', 'custom_count', 'custom', 'Count', 'number', 2),
             (${SECRET_SITE}, 'lead', 'custom_secret', 'custom', 'Secret', 'text', 1)
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
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('create_task renders variables and dues it in Toronto days', async () => {
    const key = flowKey('8401', 1);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key,
      name: 'Call the customer',
      enabled: true,
      definition: flow(entered('on_hold'), [
        {
          id: 's_task',
          kind: 'create_task',
          title: 'Call {first name} about {order number} ({prop:custom_size})',
          dueInDays: 2,
          assignee: { kind: 'lead_assignee' },
        },
      ]),
      actorId: OWNER,
    });
    const sized = await insertLead({
      workspaceId: SITE,
      stage: 'on_hold',
      assignedActorId: MEMBER,
      custom: { custom_size: 'Large' },
      externalRef: 'MS-1042',
    });
    const unsized = await insertLead({
      workspaceId: SITE,
      stage: 'on_hold',
      externalRef: 'MS-1043',
    });
    // 03:00 UTC on 2 November is still 1 November in Toronto.
    const now = new Date('2026-11-02T03:00:00Z');
    for (const leadId of [sized, unsized]) {
      await database.withTenantTx({ workspaceId: SITE, actorId: OWNER }, (tx) =>
        fireFlows(tx, { ...staff(SITE), environment, now: () => now }, [
          {
            kind: 'stage_entered',
            leadId,
            leadType: 'sim_order',
            stage: 'on_hold',
            occurrence: `task-${leadId}`,
            depth: 0,
            chain: [],
            parentRunId: null,
            at: now,
          },
        ]),
      );
    }
    const tasks = await admin<
      {
        leadId: string;
        id: string;
        title: string;
        dueAt: Date;
        assignedActorId: string | null;
        createdBy: string;
      }[]
    >`
      select lead_id as "leadId", id, title, due_at as "dueAt", assigned_actor_id as "assignedActorId",
        created_by as "createdBy"
      from app.lead_tasks where lead_id in (${sized}, ${unsized})
    `;
    const bySized = tasks.find((task) => task.leadId === sized);
    const byUnsized = tasks.find((task) => task.leadId === unsized);
    expect(bySized).toMatchObject({
      title: 'Call Nadia about MS-1042 (Large)',
      assignedActorId: MEMBER,
      createdBy: OWNER,
    });
    expect(bySized?.dueAt.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(byUnsized).toMatchObject({
      title: 'Call Nadia about MS-1043 ((none))',
      assignedActorId: null,
    });
    const [run] = await runs(sized);
    expect(await steps(run?.id ?? '')).toEqual([
      { stepId: 's_task', outcome: 'done', reason: null, detail: bySized?.id, taskId: bySized?.id },
    ]);
    const [audit] = await admin<
      { actorId: string; actorLabel: string; after: Record<string, unknown> }[]
    >`
      select actor_id as "actorId", actor_label as "actorLabel", after from app.audit_events
      where action = 'lead.task_created' and entity_id = ${bySized?.id ?? ''}
    `;
    expect(audit).toMatchObject({
      actorId: OWNER,
      actorLabel: 'automation',
      after: { leadId: sized, automation: { key, version: 1, runId: run?.id } },
    });
  });

  it('assign_lead respects an owner unless reassign', async () => {
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8401', 2),
      name: 'Give it to the member',
      enabled: true,
      definition: flow(entered('cancelled'), [
        { id: 's_assign', kind: 'assign_lead', actorId: MEMBER, reassign: false },
      ]),
      actorId: OWNER,
    });
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8401', 3),
      name: 'Take it over',
      enabled: true,
      definition: flow(entered('verified'), [
        { id: 's_assign', kind: 'assign_lead', actorId: MEMBER, reassign: true },
      ]),
      actorId: OWNER,
    });
    const unowned = await insertLead({ workspaceId: SITE, stage: 'pending' });
    expect(await move(SITE, unowned, 'cancelled')).toMatchObject({ status: 'updated' });
    expect((await leadRow(unowned))?.assignedActorId).toBe(MEMBER);
    const [assigned] = await admin<{ actorId: string; data: Record<string, unknown> }[]>`
      select actor_id as "actorId", data from app.lead_activities
      where lead_id = ${unowned} and kind = 'assignment'
    `;
    expect(assigned).toMatchObject({
      actorId: OWNER,
      data: {
        from: null,
        to: MEMBER,
        automation: flowKey('8401', 2),
        automationName: 'Give it to the member',
      },
    });

    const owned = await insertLead({ workspaceId: SITE, stage: 'pending', assignedActorId: OWNER });
    expect(await move(SITE, owned, 'cancelled')).toMatchObject({ status: 'updated' });
    expect((await leadRow(owned))?.assignedActorId).toBe(OWNER);
    const kept = await runOf(owned, flowKey('8401', 2));
    expect(await steps(kept?.id ?? '')).toMatchObject([
      { stepId: 's_assign', outcome: 'skipped', reason: 'already_assigned' },
    ]);

    const taken = await insertLead({ workspaceId: SITE, stage: 'pending', assignedActorId: OWNER });
    expect(await move(SITE, taken, 'verified')).toMatchObject({ status: 'updated' });
    expect((await leadRow(taken))?.assignedActorId).toBe(MEMBER);
  });

  it('a chosen member who left skips member_unavailable', async () => {
    const key = flowKey('8401', 4);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key,
      name: 'To someone gone',
      enabled: true,
      definition: flow(entered('contacted', 'internet'), [
        { id: 's_assign', kind: 'assign_lead', actorId: LEFT, reassign: true },
      ]),
      actorId: OWNER,
    });
    const leadId = await insertLead({ workspaceId: SITE, leadType: 'internet', stage: 'new' });
    expect(await move(SITE, leadId, 'contacted')).toMatchObject({ status: 'updated' });
    const recorded = await runs(leadId);
    expect(recorded).toMatchObject([
      { automationKey: key, status: 'skipped', reason: 'member_unavailable', detail: LEFT },
    ]);
    expect((await leadRow(leadId))?.assignedActorId).toBeNull();
  });

  it('update_lead moves through the same gates staff pass', async () => {
    await seedBuiltInFlow(admin, {
      workspaceId: SITE,
      key: 'sim_order_dispatched',
      enabled: true,
      actorId: OWNER,
    });
    const key = flowKey('8401', 5);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key,
      name: 'Ship it',
      enabled: true,
      definition: flow(entered('verified'), [toStage('s_ship', 'delivered')]),
      actorId: OWNER,
    });
    const plans = new DatabasePlanStore(database);
    const planInput: CreatePlanRequest = {
      leadType: 'sim_order',
      name: 'Passport plan',
      priceMinor: 1000,
      billingPeriod: 'month',
      paymentRequired: false,
      requiredDocuments: ['passport'],
      active: true,
      customValues: {},
    };
    const created = await plans.create(staff(SITE), planInput);
    if (created.kind !== 'created') throw new Error('plan not created');

    // No courier: the dispatch gate refuses, as it would refuse staff.
    const noCourier = await insertLead({ workspaceId: SITE, stage: 'pending' });
    expect(await move(SITE, noCourier, 'verified')).toMatchObject({ status: 'updated' });
    const refused = await runOf(noCourier, key);
    expect(await steps(refused?.id ?? '')).toMatchObject([
      { stepId: 's_ship', outcome: 'skipped', reason: 'dispatch_details_required' },
    ]);
    expect((await leadRow(noCourier))?.stage).toBe('verified');

    // A plan needing a passport and none approved: never the override, even for an owner.
    const noDocuments = await insertLead({
      workspaceId: SITE,
      stage: 'pending',
      order: { courier: 'Canada Post', trackingNumber: 'LX7CA' },
    });
    await work.updateLead({
      ...staff(SITE),
      leadId: noDocuments,
      order: { planId: created.plan.id },
      catalog: codePropertyCatalog,
    });
    expect(await move(SITE, noDocuments, 'verified')).toMatchObject({ status: 'updated' });
    const gated = await runOf(noDocuments, key);
    expect(await steps(gated?.id ?? '')).toMatchObject([
      { stepId: 's_ship', outcome: 'skipped', reason: 'documents_incomplete', detail: 'passport' },
    ]);
    expect((await leadRow(noDocuments))?.stage).toBe('verified');

    // A legal move: done, by the automation, and the stage's built-in mail is queued.
    const ready = await insertLead({
      workspaceId: SITE,
      stage: 'pending',
      order: { courier: 'Canada Post', trackingNumber: 'LX8CA' },
    });
    const outcome = await move(SITE, ready, 'verified');
    // The response reads the lead after its flows: the flow moved it on.
    expect(outcome).toMatchObject({ status: 'updated', lead: { stage: 'delivered' } });
    expect((await leadRow(ready))?.stage).toBe('delivered');
    const moved = await runOf(ready, key);
    expect(await steps(moved?.id ?? '')).toMatchObject([{ stepId: 's_ship', outcome: 'done' }]);
    const entries = await admin<{ actorId: string; data: Record<string, unknown> }[]>`
      select actor_id as "actorId", data from app.lead_activities
      where lead_id = ${ready} and kind = 'status_change'
      order by created_at, id
    `;
    // One transaction's entries share their time: compared as a set.
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        { actorId: OWNER, data: { from: 'pending', to: 'verified' } },
        {
          actorId: OWNER,
          data: { from: 'verified', to: 'delivered', automation: key, automationName: 'Ship it' },
        },
      ]),
    );
    expect((await jobs(ready)).map((job) => job.template)).toEqual(['dispatched']);
    // The flow's move and its mail come back with the staff move that set it off (P22).
    if (outcome.status !== 'updated') throw new Error('not updated');
    expect(outcome.activities).toContainEqual(
      expect.objectContaining({ kind: 'status_change', to: 'delivered', automation: key }),
    );
    expect(outcome.activities).toContainEqual(
      expect.objectContaining({ event: 'customer_emailed', automation: 'sim_order_dispatched' }),
    );
    const [audit] = await admin<{ actorLabel: string; after: Record<string, unknown> }[]>`
      select actor_label as "actorLabel", after from app.audit_events
      where entity_id = ${ready} and action = 'lead.updated' and actor_label = 'automation'
        and after -> 'automation' ->> 'key' = ${key}
    `;
    expect(audit).toMatchObject({
      after: { stage: 'delivered', automation: { key, version: 1, runId: moved?.id } },
    });
  });

  it('update_lead sets one custom property or editable form field, never a hidden one', async () => {
    const setSize = flowKey('8401', 6);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: setSize,
      name: 'Set the size',
      enabled: true,
      definition: flow(entered('qualified', 'internet'), [
        {
          id: 's_size',
          kind: 'update_lead',
          change: { kind: 'property', key: 'custom_size', value: 'Small' },
        },
        {
          id: 's_ref',
          kind: 'update_lead',
          change: { kind: 'property', key: 'custom_count', value: 'abc' },
        },
      ]),
      actorId: OWNER,
    });
    const leadId = await insertLead({ workspaceId: SITE, leadType: 'internet', stage: 'new' });
    expect(await move(SITE, leadId, 'qualified')).toMatchObject({ status: 'updated' });
    expect((await leadRow(leadId))?.customValues).toEqual({ custom_size: 'Small' });
    const [run] = await runs(leadId);
    expect(await steps(run?.id ?? '')).toMatchObject([
      { stepId: 's_size', outcome: 'done' },
      { stepId: 's_ref', outcome: 'skipped', reason: 'invalid_field', detail: 'custom_count' },
    ]);

    // A property hidden after the flow was activated: the flow is skipped for it.
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position, hidden)
      values (${SITE}, 'lead', 'custom_hidden', 'custom', 'Hidden', 'text', 3, true)
    `;
    const hidden = flowKey('8401', 7);
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: hidden,
      name: 'Set a hidden one',
      enabled: true,
      definition: flow(entered('existing_shaw', 'internet'), [
        {
          id: 's_hidden',
          kind: 'update_lead',
          change: { kind: 'property', key: 'custom_hidden', value: 'x' },
        },
      ]),
      actorId: OWNER,
    });
    const other = await insertLead({ workspaceId: SITE, leadType: 'internet', stage: 'new' });
    expect(await move(SITE, other, 'existing_shaw')).toMatchObject({ status: 'updated' });
    expect(await runs(other)).toMatchObject([
      {
        automationKey: hidden,
        status: 'skipped',
        reason: 'property_unavailable',
        detail: 'custom_hidden',
      },
    ]);
    expect((await leadRow(other))?.customValues).toEqual({});
  });

  it('an activator who lost lead.manage or left skips activator_not_allowed', async () => {
    for (const [index, activator] of [VIEWER, LEFT, null].entries()) {
      await insertActiveFlow(admin, {
        workspaceId: ACCESS_SITE,
        key: flowKey('8405', index + 1),
        name: `Activated by ${index}`,
        enabled: true,
        definition: flow(entered('contacted', 'internet'), [
          {
            id: 's_task',
            kind: 'create_task',
            title: 'Follow up',
            dueInDays: null,
            assignee: { kind: 'none' },
          },
        ]),
        actorId: OWNER,
        activatedBy: activator,
      });
    }
    const leadId = await insertLead({
      workspaceId: ACCESS_SITE,
      leadType: 'internet',
      stage: 'new',
    });
    expect(await move(ACCESS_SITE, leadId, 'contacted')).toMatchObject({ status: 'updated' });
    const recorded = await runs(leadId);
    expect(recorded).toHaveLength(3);
    for (const run of recorded) {
      expect(run.status).toBe('completed');
      expect(await steps(run.id)).toMatchObject([
        { stepId: 's_task', outcome: 'skipped', reason: 'activator_not_allowed' },
      ]);
    }
    expect(await admin`select id from app.lead_tasks where lead_id = ${leadId}`).toEqual([]);
  });

  it('two flows that move each other stop with loop_prevented and the move commits', async () => {
    const a = flowKey('8402', 1);
    const b = flowKey('8402', 2);
    await insertActiveFlow(admin, {
      workspaceId: LOOP_SITE,
      key: a,
      name: 'A',
      enabled: true,
      definition: flow(entered('contacted', 'internet'), [toStage('s_a', 'qualified')]),
      actorId: OWNER,
    });
    await insertActiveFlow(admin, {
      workspaceId: LOOP_SITE,
      key: b,
      name: 'B',
      enabled: true,
      definition: flow(entered('qualified', 'internet'), [toStage('s_b', 'contacted')]),
      actorId: OWNER,
    });
    const leadId = await insertLead({ workspaceId: LOOP_SITE, leadType: 'internet', stage: 'new' });
    expect(await move(LOOP_SITE, leadId, 'contacted')).toMatchObject({ status: 'updated' });
    expect(
      (await runs(leadId)).map(({ automationKey, status, reason, depth }) => ({
        automationKey,
        status,
        reason,
        depth,
      })),
    ).toEqual([
      { automationKey: a, status: 'completed', reason: null, depth: 0 },
      { automationKey: b, status: 'completed', reason: null, depth: 1 },
      { automationKey: a, status: 'skipped', reason: 'loop_prevented', depth: 2 },
    ]);
    expect((await leadRow(leadId))?.stage).toBe('contacted');
  });

  it("four chained flows: the last move is skipped chain_too_deep and every move's email is queued", async () => {
    for (const key of [
      'sim_order_dispatched',
      'sim_order_activated',
      'sim_order_cancelled',
    ] as const) {
      await seedBuiltInFlow(admin, { workspaceId: CHAIN_SITE, key, enabled: true, actorId: OWNER });
    }
    const chain = [
      ['delivered', 'activated'],
      ['activated', 'cancelled'],
      ['cancelled', 'pending'],
      ['pending', 'on_hold'],
    ];
    const keys = chain.map((_, index) => flowKey('8403', index + 1));
    for (const [index, [from = '', to = '']] of chain.entries()) {
      await insertActiveFlow(admin, {
        workspaceId: CHAIN_SITE,
        key: keys[index] ?? '',
        name: `Chain ${index + 1}`,
        enabled: true,
        definition: flow(entered(from), [toStage(`s_chain${index + 1}`, to)]),
        actorId: OWNER,
      });
    }
    const leadId = await insertLead({ workspaceId: CHAIN_SITE, stage: 'verified' });
    expect(
      await move(CHAIN_SITE, leadId, 'delivered', {
        courier: 'Canada Post',
        trackingNumber: 'LX5CA',
      }),
    ).toMatchObject({ status: 'updated' });
    const recorded = (await runs(leadId)).filter((run) => keys.includes(run.automationKey));
    expect(recorded.map((run) => [run.automationKey, run.status, run.depth])).toEqual([
      [keys[0], 'completed', 0],
      [keys[1], 'completed', 1],
      [keys[2], 'completed', 2],
      [keys[3], 'completed', 3],
    ]);
    expect(await steps(recorded[3]?.id ?? '')).toMatchObject([
      { stepId: 's_chain4', outcome: 'skipped', reason: 'chain_too_deep' },
    ]);
    expect((await leadRow(leadId))?.stage).toBe('pending');
    expect((await jobs(leadId)).map((job) => job.template).sort()).toEqual(
      ['activated', 'cancelled', 'dispatched'].sort(),
    );
  });

  it('a property made sensitive after use skips the run and its value appears nowhere', async () => {
    const key = flowKey('8404', 1);
    await insertActiveFlow(admin, {
      workspaceId: SECRET_SITE,
      key,
      name: 'Secret flow',
      enabled: true,
      definition: flow(entered('contacted', 'internet'), [
        {
          id: 's_if',
          kind: 'if_else',
          condition: {
            match: 'all',
            items: [{ kind: 'property', filter: { key: 'custom_secret', op: 'notEmpty' } }],
          },
          then: [
            {
              id: 's_task',
              kind: 'create_task',
              title: 'Check {prop:custom_secret}',
              dueInDays: 0,
              assignee: { kind: 'none' },
            },
          ],
          else: [],
        },
      ]),
      actorId: OWNER,
    });
    await admin`
      update app.properties set sensitive = true
      where workspace_id = ${SECRET_SITE} and key = 'custom_secret'
    `;
    const leadId = await insertLead({
      workspaceId: SECRET_SITE,
      leadType: 'internet',
      stage: 'new',
      custom: { custom_secret: SECRET_VALUE },
    });
    const logged: string[] = [];
    const capture = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'info').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
    ];
    try {
      expect(await move(SECRET_SITE, leadId, 'contacted')).toMatchObject({ status: 'updated' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await runs(leadId)).toMatchObject([
      {
        automationKey: key,
        status: 'skipped',
        reason: 'property_unavailable',
        detail: 'custom_secret',
      },
    ]);
    const found = await admin<{ place: string }[]>`
      select 'runs' as place from app.automation_runs r where r::text like ${`%${SECRET_VALUE}%`}
      union all select 'steps' from app.automation_step_runs s where s::text like ${`%${SECRET_VALUE}%`}
      union all select 'tasks' from app.lead_tasks t where t::text like ${`%${SECRET_VALUE}%`}
      union all select 'jobs' from app.outbox_jobs j where j.payload::text like ${`%${SECRET_VALUE}%`}
      union all select 'timeline' from app.lead_activities a where a::text like ${`%${SECRET_VALUE}%`}
      union all select 'audit' from app.audit_events e where e::text like ${`%${SECRET_VALUE}%`}
    `;
    expect(found).toEqual([]);
    expect(logged.join('\n')).not.toContain(SECRET_VALUE);
  });
});
