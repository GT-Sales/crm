import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { codePropertyCatalog } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { cancelFlowWork } from '../src/automations/records.js';
import { runAutomationTick, type AutomationTickResult } from '../src/automations/tick.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import {
  addActiveVersion,
  disposableTestDatabaseUrl,
  flowKey,
  insertActiveFlow,
} from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WAIT_SITE = '18000000-0000-4000-8000-000000008601'; // waits and their resume
const TIME_SITE = '18000000-0000-4000-8000-000000008602'; // the three time triggers
const VOID_SITE = '18000000-0000-4000-8000-000000008603'; // back-fill and voided timers
const DELAY_SITE = '18000000-0000-4000-8000-000000008604'; // a delay re-activated
const RACE_SITE = '18000000-0000-4000-8000-000000008605'; // two ticks at once
const FAIL_SITE = '18000000-0000-4000-8000-000000008606'; // failures and a killed tick
const GUARD_SITE = '18000000-0000-4000-8000-000000008607'; // loops, races, archive, activators
const SITES = [WAIT_SITE, TIME_SITE, VOID_SITE, DELAY_SITE, RACE_SITE, FAIL_SITE, GUARD_SITE];
const LEFT = '28000000-0000-4000-8000-000000008604'; // a member who has since left
const STAFF = '28000000-0000-4000-8000-000000008601';
const CREDENTIAL = '28000000-0000-4000-8000-000000008602';
const RUNNER = '28000000-0000-4000-8000-000000008603'; // the scheduler's identity
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const ARCHIVED_TEMPLATE = 'tpl_tick860100000001';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
const entered = (stage: string) => ({
  kind: 'stage_entered',
  leadType: 'internet',
  stage,
  when: null,
});
const inStage = (stage: string, after: { amount: number; unit: string }) => ({
  kind: 'time_in_stage',
  leadType: 'internet',
  stage,
  after,
  when: null,
});
const send = (id: string, template: string) => ({ id, kind: 'send_email', template });
const toStage = (id: string, stage: string) => ({
  id,
  kind: 'update_lead',
  change: { kind: 'stage', stage },
});
const wait = (id: string, amount: number, unit = 'days') => ({
  id,
  kind: 'wait',
  for: { amount, unit },
});

databaseTest('the automations scheduler task', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let leadStore: DatabaseLeadStore;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const tick = (
    workspaceId: string,
    at: number,
    hooks?: Parameters<typeof runAutomationTick>[0]['hooks'],
  ): Promise<AutomationTickResult> =>
    runAutomationTick(
      { database, environment, now: () => new Date(at), ...(hooks ? { hooks } : {}) },
      { authorizedWorkspaceIds: [workspaceId], actorId: RUNNER },
    );

  const insertLead = async (workspaceId: string, stage = 'new'): Promise<string> => {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        full_name, email
      ) values (
        ${id}, ${workspaceId}, 'internet', 'submitted', ${stage}, 'ci', '{}'::jsonb,
        '{"schemaVersion":1,"payload":{}}'::jsonb, 'Nadia Khan', ${`${id}@example.test`}
      )
    `;
    return id;
  };

  const move = async (workspaceId: string, leadId: string, stage: string) => {
    const outcome = await work.updateLead({
      workspaceId,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      stage,
      catalog: codePropertyCatalog,
    });
    if (outcome.status !== 'updated') throw new Error(`move refused: ${outcome.status}`);
    return outcome;
  };

  const jobs = (leadId: string) =>
    admin<{ dedupeKey: string; template: string }[]>`
      select dedupe_key as "dedupeKey", payload ->> 'template' as template from app.outbox_jobs
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
        occurrence: string | null;
        triggerKind: string | null;
      }[]
    >`
      select id, automation_key as "automationKey", status, reason, occurrence,
        trigger_kind as "triggerKind"
      from app.automation_runs where lead_id = ${leadId}
      order by created_at, id
    `;

  const steps = (runId: string) =>
    admin<{ stepId: string; outcome: string; reason: string | null }[]>`
      select step_id as "stepId", outcome, reason
      from app.automation_step_runs where run_id = ${runId}
      order by created_at, id
    `;

  const timers = (leadId: string) =>
    admin<{ automationId: string; occurrence: string; status: string; dueAt: Date }[]>`
      select automation_id as "automationId", occurrence, status, due_at as "dueAt"
      from app.automation_timers where lead_id = ${leadId}
      order by created_at, id
    `;

  const waitOf = async (runId: string) => {
    const [row] = await admin<{ status: string; attempts: number }[]>`
      select status, attempts from app.automation_waits where run_id = ${runId}
    `;
    return row;
  };

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
        values (${id}, ${`automation-tick-860${index + 1}`}, ${`Tick Site ${index + 1}`})
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
          ${id}, 'Tick Sim', 'orders@tick.example', null, null, '#123abc', '',
          'https://tick.example', ${STAFF}
        )
      `;
    }

    // Lead-changing steps need an activator with Leads rights now (R5).
    await admin`insert into app.roles (workspace_id, name) values (${GUARD_SITE}, 'owner')`;
    await admin`
      insert into app.membership_roles (workspace_id, membership_id, role_id)
      select m.workspace_id, m.id, r.id from app.memberships m
      join app.roles r on r.workspace_id = m.workspace_id and r.name = 'owner'
      where m.workspace_id = ${GUARD_SITE} and m.user_id = ${STAFF}
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, revoked_at)
      values (${GUARD_SITE}, ${LEFT}, 'staff', 'revoked', now())
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 6,
    });
    work = new DatabaseLeadWorkStore(database, environment);
    leadStore = new DatabaseLeadStore(database, environment);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('a wait resumes on its due tick and runs the steps after it', async () => {
    await insertActiveFlow(admin, {
      workspaceId: WAIT_SITE,
      key: flowKey('8601', 1),
      name: 'Wait then ask',
      enabled: true,
      definition: flow(entered('contacted'), [
        wait('s_wait', 2),
        send('s_ask', 'information_needed'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(WAIT_SITE);
    await move(WAIT_SITE, leadId, 'contacted');
    const [run] = await runs(leadId);
    expect(run).toMatchObject({ status: 'waiting' });

    expect(await tick(WAIT_SITE, Date.now() + DAY)).toMatchObject({ resumed: 0 });
    expect(await jobs(leadId)).toEqual([]);

    expect(await tick(WAIT_SITE, Date.now() + 2 * DAY + 60_000)).toMatchObject({ resumed: 1 });
    expect(await steps(run?.id ?? '')).toEqual([
      { stepId: 's_wait', outcome: 'waiting', reason: null },
      { stepId: 's_wait', outcome: 'done', reason: null },
      { stepId: 's_ask', outcome: 'done', reason: null },
    ]);
    expect((await runs(leadId))[0]).toMatchObject({ status: 'completed' });
    expect(await waitOf(run?.id ?? '')).toMatchObject({ status: 'resumed' });
    expect(await jobs(leadId)).toEqual([
      { dedupeKey: expect.stringContaining(':s_ask'), template: 'information_needed' },
    ]);
  });

  it('a run resumes on its own version after a new one is activated', async () => {
    const created = await insertActiveFlow(admin, {
      workspaceId: WAIT_SITE,
      key: flowKey('8601', 2),
      name: 'Versioned wait',
      enabled: true,
      definition: flow(entered('qualified'), [
        wait('s_wait', 1),
        send('s_v1', 'information_needed'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(WAIT_SITE);
    await move(WAIT_SITE, leadId, 'qualified');
    await addActiveVersion(admin, {
      workspaceId: WAIT_SITE,
      automationId: created.id,
      version: 2,
      definition: flow(entered('qualified'), [send('s_v2', 'cancelled')]),
      actorId: STAFF,
      activatedBy: STAFF,
    });
    await tick(WAIT_SITE, Date.now() + DAY + 60_000);
    expect(await jobs(leadId)).toEqual([
      { dedupeKey: expect.stringContaining(':s_v1'), template: 'information_needed' },
    ]);
  });

  it('a resume whose template was archived cancels with template_unavailable', async () => {
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by)
      values (${WAIT_SITE}, ${ARCHIVED_TEMPLATE}, 'A note', 'A note', 'Hello.', 1, ${STAFF})
    `;
    await insertActiveFlow(admin, {
      workspaceId: WAIT_SITE,
      key: flowKey('8601', 3),
      name: 'Wait then note',
      enabled: true,
      definition: flow(entered('existing_shaw'), [
        wait('s_wait', 1),
        send('s_note', ARCHIVED_TEMPLATE),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(WAIT_SITE);
    await move(WAIT_SITE, leadId, 'existing_shaw');
    await admin`
      update app.email_templates set archived_at = now()
      where workspace_id = ${WAIT_SITE} and key = ${ARCHIVED_TEMPLATE}
    `;
    expect(await tick(WAIT_SITE, Date.now() + DAY + 60_000)).toMatchObject({ cancelled: 1 });
    const [run] = await runs(leadId);
    expect(run).toMatchObject({ status: 'cancelled', reason: 'template_unavailable' });
    expect(await jobs(leadId)).toEqual([]);
  });

  it('a resume after the flow went off sends nothing', async () => {
    const off = await insertActiveFlow(admin, {
      workspaceId: WAIT_SITE,
      key: flowKey('8601', 4),
      name: 'Switched off',
      enabled: true,
      definition: flow(entered('old_due'), [wait('s_wait', 1), send('s_after', 'cancelled')]),
      actorId: STAFF,
    });
    const leadId = await insertLead(WAIT_SITE);
    await move(WAIT_SITE, leadId, 'old_due');
    // The store switches it off and cancels its work in one transaction.
    await database.withTenantTx({ workspaceId: WAIT_SITE, actorId: STAFF }, async (tx) => {
      await admin`update app.automations set enabled = false where id = ${off.id}`;
      return cancelFlowWork(tx, WAIT_SITE, off.id, 'flow_switched_off');
    });
    expect((await runs(leadId))[0]).toMatchObject({
      status: 'cancelled',
      reason: 'flow_switched_off',
    });
    await tick(WAIT_SITE, Date.now() + DAY + 60_000);
    expect(await jobs(leadId)).toEqual([]);

    // A wait the switch skipped (a tick held it) is cancelled by the tick's own check.
    const skipped = await insertActiveFlow(admin, {
      workspaceId: WAIT_SITE,
      key: flowKey('8601', 5),
      name: 'Off while held',
      enabled: true,
      definition: flow(entered('installed'), [wait('s_wait', 1), send('s_after', 'cancelled')]),
      actorId: STAFF,
    });
    const held = await insertLead(WAIT_SITE);
    await move(WAIT_SITE, held, 'installed');
    await admin`update app.automations set enabled = false where id = ${skipped.id}`;
    expect(await tick(WAIT_SITE, Date.now() + DAY + 60_000)).toMatchObject({ cancelled: 1 });
    expect((await runs(held))[0]).toMatchObject({
      status: 'cancelled',
      reason: 'flow_switched_off',
    });
    expect(await jobs(held)).toEqual([]);
  });

  it('each time trigger fires once per occurrence', async () => {
    const stay = flowKey('8602', 1);
    const overdue = flowKey('8602', 2);
    const afterSubmit = flowKey('8602', 3);
    await insertActiveFlow(admin, {
      workspaceId: TIME_SITE,
      key: stay,
      name: 'Three days new',
      enabled: true,
      definition: flow(inStage('new', { amount: 3, unit: 'days' }), [
        send('s_stay', 'information_needed'),
      ]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: TIME_SITE,
      key: overdue,
      name: 'Task overdue',
      enabled: true,
      definition: flow(
        { kind: 'task_overdue', leadTypes: [], after: { amount: 1, unit: 'hours' }, when: null },
        [send('s_overdue', 'cancelled')],
      ),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: TIME_SITE,
      key: afterSubmit,
      name: 'A day after',
      enabled: true,
      definition: flow(
        {
          kind: 'after_submitted',
          leadTypes: ['internet'],
          after: { amount: 1, unit: 'days' },
          when: null,
        },
        [send('s_after', 'order_received')],
      ),
      actorId: STAFF,
    });
    const created = await leadStore.createLead({
      workspaceId: TIME_SITE,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'internet',
      consentVersion: 'ci',
      contact: { fullName: 'Ada Lin', email: 'tick-time@example.test' },
      submit: true,
    });
    const leadId = created.lead.id;
    const today = new Date().toISOString().slice(0, 10);
    const task = await work.createTask({
      workspaceId: TIME_SITE,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      title: 'Call back',
      dueAt: `${today}T12:00:00.000Z`,
    });
    if (task.status !== 'saved') throw new Error('task not saved');
    expect((await timers(leadId)).map((timer) => timer.occurrence).sort()).toEqual(
      ['after_submitted', 'stay:submitted:stage', `task:${task.task.id}:${today}`].sort(),
    );

    expect(await tick(TIME_SITE, Date.now() + 4 * DAY)).toMatchObject({ fired: 3 });
    expect(
      (await runs(leadId))
        .map((run) => [run.automationKey, run.triggerKind, run.occurrence])
        .sort(),
    ).toEqual(
      [
        [stay, 'time_in_stage', 'stay:submitted:stage'],
        [overdue, 'task_overdue', `task:${task.task.id}:${today}`],
        [afterSubmit, 'after_submitted', 'after_submitted'],
      ].sort(),
    );
    expect(await jobs(leadId)).toHaveLength(3);
    expect(await tick(TIME_SITE, Date.now() + 5 * DAY)).toMatchObject({ fired: 0 });
    expect(await runs(leadId)).toHaveLength(3);
  });

  it('time triggers never back-fill', async () => {
    const leadId = await insertLead(VOID_SITE);
    await move(VOID_SITE, leadId, 'contacted');
    // Switched on after the lead entered the stage: its stay is not counted.
    await insertActiveFlow(admin, {
      workspaceId: VOID_SITE,
      key: flowKey('8603', 1),
      name: 'Late flow',
      enabled: true,
      definition: flow(inStage('contacted', { amount: 1, unit: 'hours' }), [
        send('s_late', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    expect(await timers(leadId)).toEqual([]);
    await tick(VOID_SITE, Date.now() + DAY);
    expect(await runs(leadId)).toEqual([]);
  });

  it('a timer whose stay ended or whose task closed is voided and records nothing', async () => {
    await insertActiveFlow(admin, {
      workspaceId: VOID_SITE,
      key: flowKey('8603', 2),
      name: 'Stay in qualified',
      enabled: true,
      definition: flow(inStage('qualified', { amount: 1, unit: 'hours' }), [
        send('s_stay', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: VOID_SITE,
      key: flowKey('8603', 3),
      name: 'Overdue task',
      enabled: true,
      definition: flow({ kind: 'task_overdue', leadTypes: ['internet'], after: null, when: null }, [
        send('s_task', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(VOID_SITE);
    await move(VOID_SITE, leadId, 'qualified');
    await move(VOID_SITE, leadId, 'won');
    const today = new Date().toISOString().slice(0, 10);
    const task = await work.createTask({
      workspaceId: VOID_SITE,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      title: 'Follow up',
      dueAt: `${today}T12:00:00.000Z`,
    });
    if (task.status !== 'saved') throw new Error('task not saved');
    await work.updateTask({
      workspaceId: VOID_SITE,
      actorId: STAFF,
      requestId: randomUUID(),
      taskId: task.task.id,
      status: 'done',
    });
    expect(await tick(VOID_SITE, Date.now() + 3 * DAY)).toMatchObject({ voided: 2, fired: 0 });
    expect((await timers(leadId)).map((timer) => timer.status)).toEqual(['void', 'void']);
    expect(await runs(leadId)).toEqual([]);
    expect(await jobs(leadId)).toEqual([]);
  });

  it('a re-activated delay moves a pending timer', async () => {
    const created = await insertActiveFlow(admin, {
      workspaceId: DELAY_SITE,
      key: flowKey('8604', 1),
      name: 'Three then five',
      enabled: true,
      definition: flow(inStage('contacted', { amount: 3, unit: 'days' }), [
        send('s_stay', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(DELAY_SITE);
    const moved = Date.now();
    await move(DELAY_SITE, leadId, 'contacted');
    await addActiveVersion(admin, {
      workspaceId: DELAY_SITE,
      automationId: created.id,
      version: 2,
      definition: flow(inStage('contacted', { amount: 5, unit: 'days' }), [
        send('s_stay', 'cancelled'),
      ]),
      actorId: STAFF,
      activatedBy: STAFF,
    });
    expect(await tick(DELAY_SITE, moved + 4 * DAY)).toMatchObject({ deferred: 1, fired: 0 });
    const [timer] = await timers(leadId);
    expect(timer?.status).toBe('pending');
    expect(Math.abs((timer?.dueAt.getTime() ?? 0) - (moved + 5 * DAY))).toBeLessThan(10_000);
    expect(await tick(DELAY_SITE, moved + 5 * DAY + 60_000)).toMatchObject({ fired: 1 });
    expect(await jobs(leadId)).toHaveLength(1);
  });

  it('two ticks at once run each due wait and timer once', async () => {
    await insertActiveFlow(admin, {
      workspaceId: RACE_SITE,
      key: flowKey('8605', 1),
      name: 'Wait an hour',
      enabled: true,
      definition: flow(entered('contacted'), [
        wait('s_wait', 1, 'hours'),
        send('s_waited', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: RACE_SITE,
      key: flowKey('8605', 2),
      name: 'An hour in contacted',
      enabled: true,
      definition: flow(inStage('contacted', { amount: 1, unit: 'hours' }), [
        send('s_stayed', 'information_needed'),
      ]),
      actorId: STAFF,
    });
    const leads: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const leadId = await insertLead(RACE_SITE);
      await move(RACE_SITE, leadId, 'contacted');
      leads.push(leadId);
    }
    const at = Date.now() + 2 * HOUR;
    const [first, second] = await Promise.all([tick(RACE_SITE, at), tick(RACE_SITE, at)]);
    expect((first?.resumed ?? 0) + (second?.resumed ?? 0)).toBe(20);
    expect((first?.fired ?? 0) + (second?.fired ?? 0)).toBe(20);
    for (const leadId of leads) {
      expect((await jobs(leadId)).map((job) => job.template).sort()).toEqual(
        ['cancelled', 'information_needed'].sort(),
      );
      expect(await runs(leadId)).toHaveLength(2);
    }
  });

  it('a resume that keeps failing gives up after five tries', async () => {
    await insertActiveFlow(admin, {
      workspaceId: FAIL_SITE,
      key: flowKey('8606', 1),
      name: 'Keeps failing',
      enabled: true,
      definition: flow(entered('contacted'), [
        wait('s_wait', 1, 'hours'),
        send('s_after', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(FAIL_SITE);
    await move(FAIL_SITE, leadId, 'contacted');
    const [run] = await runs(leadId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect(
          await tick(FAIL_SITE, Date.now() + 2 * HOUR, {
            insideResume: async () => {
              throw new Error('resume broke');
            },
          }),
        ).toMatchObject({ failed: 1 });
        expect(await waitOf(run?.id ?? '')).toMatchObject({
          attempts: attempt,
          status: attempt < 5 ? 'pending' : 'cancelled',
        });
      }
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
    expect((await runs(leadId))[0]).toMatchObject({ status: 'failed', reason: 'resume_failed' });
    expect((await steps(run?.id ?? '')).at(-1)).toEqual({
      stepId: 's_wait',
      outcome: 'failed',
      reason: 'resume_failed',
    });
    expect(await jobs(leadId)).toEqual([]);
    expect(await tick(FAIL_SITE, Date.now() + 3 * HOUR)).toMatchObject({ resumed: 0, failed: 0 });
  });

  it('a tick killed mid-item leaves it to the next, which completes it once', async () => {
    await insertActiveFlow(admin, {
      workspaceId: FAIL_SITE,
      key: flowKey('8606', 2),
      name: 'Killed tick',
      enabled: true,
      definition: flow(entered('qualified'), [
        wait('s_wait', 1, 'hours'),
        send('s_after', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(FAIL_SITE);
    await move(FAIL_SITE, leadId, 'qualified');
    const [run] = await runs(leadId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        await tick(FAIL_SITE, Date.now() + 2 * HOUR, {
          afterClaim: async () => {
            throw new Error('killed');
          },
        }),
      ).toMatchObject({ failed: 1, resumed: 0 });
    } finally {
      warn.mockRestore();
    }
    expect(await waitOf(run?.id ?? '')).toEqual({ status: 'pending', attempts: 0 });
    expect(await jobs(leadId)).toEqual([]);
    expect(await tick(FAIL_SITE, Date.now() + 2 * HOUR)).toMatchObject({ resumed: 1 });
    expect(await jobs(leadId)).toHaveLength(1);
    expect(await tick(FAIL_SITE, Date.now() + 3 * HOUR)).toMatchObject({ resumed: 0 });
    expect(await jobs(leadId)).toHaveLength(1);
  });

  it('two flows moving a lead back and forth stop at the daily run limit', async () => {
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 1),
      name: 'Back after an hour',
      enabled: true,
      definition: flow(inStage('qualified', { amount: 1, unit: 'hours' }), [
        toStage('s_back', 'contacted'),
      ]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 2),
      name: 'Forward again',
      enabled: true,
      definition: flow(entered('contacted'), [toStage('s_forward', 'qualified')]),
      actorId: STAFF,
    });
    const leadId = await insertLead(GUARD_SITE);
    await move(GUARD_SITE, leadId, 'qualified');
    // Each tick, the timer moves it back and the other flow moves it forward,
    // which starts a new stay: without the limit this never ends.
    for (let hour = 2; hour <= 10; hour += 2) await tick(GUARD_SITE, Date.now() + hour * HOUR);
    const all = await runs(leadId);
    const back = all.filter((run) => run.automationKey === flowKey('8607', 1));
    const forward = all.filter((run) => run.automationKey === flowKey('8607', 2));
    expect(back.map((run) => run.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'skipped',
    ]);
    expect(back[3]?.reason).toBe('run_limit_reached');
    expect(forward.map((run) => run.status)).toEqual(['completed', 'completed', 'completed']);
    const [lead] = await admin<
      { stage: string }[]
    >`select stage from app.leads where id = ${leadId}`;
    expect(lead?.stage).toBe('qualified');
  });

  it('a switch-off in progress when a wait resumes keeps it from running', async () => {
    const racing = await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 3),
      name: 'Off mid-resume',
      enabled: true,
      definition: flow(entered('old_due'), [wait('s_wait', 1), send('s_after', 'cancelled')]),
      actorId: STAFF,
    });
    const leadId = await insertLead(GUARD_SITE);
    await move(GUARD_SITE, leadId, 'old_due');
    // The switch is in progress while the tick claims the wait; it commits a
    // moment later. The tick must wait for it and read the flow off.
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const toggle = admin.begin(async (tx) => {
      // What `setEnabled(false)` takes first (records.ts `takeFlowSwitch`).
      await tx`select pg_advisory_xact_lock(hashtextextended(${`automation-switch:${GUARD_SITE}:${racing.id}`}, 0))`;
      await tx`update app.automations set enabled = false where id = ${racing.id}`;
      locked();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await isLocked;
    expect(await tick(GUARD_SITE, Date.now() + DAY + 60_000)).toMatchObject({ cancelled: 1 });
    await toggle;
    expect((await runs(leadId))[0]).toMatchObject({
      status: 'cancelled',
      reason: 'flow_switched_off',
    });
    expect(await jobs(leadId)).toEqual([]);
  });

  it('archiving a lead ends its waits and timers, and a restore does not revive them', async () => {
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 4),
      name: 'Wait on existing Shaw',
      enabled: true,
      definition: flow(entered('existing_shaw'), [wait('s_wait', 1), send('s_after', 'cancelled')]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 5),
      name: 'Stay on existing Shaw',
      enabled: true,
      definition: flow(inStage('existing_shaw', { amount: 1, unit: 'hours' }), [
        send('s_stay', 'cancelled'),
      ]),
      actorId: STAFF,
    });
    const leadId = await insertLead(GUARD_SITE);
    await move(GUARD_SITE, leadId, 'existing_shaw');
    const archived = await work.setArchived({
      workspaceId: GUARD_SITE,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      archived: true,
    });
    expect(archived.status).toBe('changed');
    expect((await runs(leadId))[0]).toMatchObject({ status: 'cancelled', reason: 'lead_archived' });
    expect((await timers(leadId)).map((timer) => timer.status)).toEqual(['void']);
    await work.setArchived({
      workspaceId: GUARD_SITE,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      archived: false,
    });
    expect(await tick(GUARD_SITE, Date.now() + 2 * DAY)).toMatchObject({ resumed: 0, fired: 0 });
    expect(await jobs(leadId)).toEqual([]);
  });

  it('a stay that a chained move left and re-entered in one write fires once', async () => {
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 6),
      name: 'Won goes to lost',
      enabled: true,
      definition: flow(entered('won'), [toStage('s_lost', 'lost')]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 7),
      name: 'Lost goes to won',
      enabled: true,
      definition: flow(entered('lost'), [toStage('s_won', 'won')]),
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 8),
      name: 'An hour in won',
      enabled: true,
      definition: flow(inStage('won', { amount: 1, unit: 'hours' }), [send('s_won', 'activated')]),
      actorId: STAFF,
    });
    const leadId = await insertLead(GUARD_SITE);
    // One write: won (staff), lost (a flow), won again (a flow; the third hop is the loop guard's).
    await move(GUARD_SITE, leadId, 'won');
    const stays = (await timers(leadId)).filter((timer) => timer.occurrence.startsWith('stay:'));
    expect(stays).toHaveLength(2);
    await tick(GUARD_SITE, Date.now() + 2 * HOUR);
    expect((await timers(leadId)).map((timer) => timer.status).sort()).toEqual(['fired', 'void']);
    expect((await jobs(leadId)).filter((job) => job.template === 'activated')).toHaveLength(1);
  });

  it('a version whose activator has left still runs, never in their name', async () => {
    await insertActiveFlow(admin, {
      workspaceId: GUARD_SITE,
      key: flowKey('8607', 9),
      name: 'Activated by a former member',
      enabled: true,
      definition: flow(entered('contacted'), [
        wait('s_wait', 1),
        send('s_after', 'information_needed'),
      ]),
      actorId: STAFF,
      activatedBy: LEFT,
    });
    const leadId = await insertLead(GUARD_SITE, 'new');
    await move(GUARD_SITE, leadId, 'contacted');
    expect(await tick(GUARD_SITE, Date.now() + DAY + 60_000)).toMatchObject({ resumed: 1 });
    const mailed = await admin<{ actorId: string }[]>`
      select actor_id as "actorId" from app.lead_activities
      where lead_id = ${leadId} and kind = 'system' and data ->> 'event' = 'customer_emailed'
    `;
    expect(mailed).toEqual([{ actorId: RUNNER }]);
  });
});
