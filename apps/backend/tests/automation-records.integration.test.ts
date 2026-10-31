import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOMER_EMAIL_TEMPLATES } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  StepRunShapeError,
  cancelFlowWork,
  cancelWaitingRun,
  detailOf,
  finishRun,
  insertStepRun,
} from '../src/automations/records.js';
import { loadFlowSite } from '../src/automations/site.js';

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

const SITE = '18000000-0000-4000-8000-000000008291';
const OTHER_SITE = '18000000-0000-4000-8000-000000008292';
const ACTOR = '28000000-0000-4000-8000-000000008291';
const MEMBER = '28000000-0000-4000-8000-000000008292';
const LEFT_MEMBER = '28000000-0000-4000-8000-000000008293';
const OTHER_SITE_MEMBER = '28000000-0000-4000-8000-000000008294';
const LEAD = '38000000-0000-4000-8000-000000008291';
const PLAN = '48000000-0000-4000-8000-000000008291';
const MOBILITY_PLAN = '48000000-0000-4000-8000-000000008292';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SITE_MADE = 'tpl_recordstest00001';
const ARCHIVED = 'tpl_recordstest00002';

databaseTest('automation run records and the flow site snapshot', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  const scope = { workspaceId: SITE, actorId: ACTOR };

  const flow = async (key: string) => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.automations (workspace_id, key, origin, name, updated_by)
      values (${SITE}, ${key}, 'custom', ${key}, ${ACTOR})
      returning id
    `;
    if (!row) throw new Error('the flow was not inserted');
    return row.id;
  };

  const waitingRun = async (automationId: string, key: string, occurrence: string) => {
    const [run] = await admin<{ id: string }[]>`
      insert into app.automation_runs
        (workspace_id, automation_key, automation_id, lead_id, status, occurrence)
      values (${SITE}, ${key}, ${automationId}, ${LEAD}, 'waiting', ${occurrence})
      returning id
    `;
    if (!run) throw new Error('the run was not inserted');
    await admin`
      insert into app.automation_waits (workspace_id, run_id, automation_id, lead_id, step_id, resume_at)
      values (${SITE}, ${run.id}, ${automationId}, ${LEAD}, 's_wait0001', now() + interval '1 day')
    `;
    return run.id;
  };

  const timer = (automationId: string, occurrence: string, status = 'pending') => admin`
    insert into app.automation_timers
      (workspace_id, automation_id, lead_id, trigger_kind, occurrence, event_at, due_at, status)
    values (${SITE}, ${automationId}, ${LEAD}, 'after_submitted', ${occurrence}, now(),
      now() + interval '1 day', ${status})
  `;

  const runState = (runId: string) =>
    admin<{ status: string; reason: string | null; finished: boolean; wait: string }[]>`
      select r.status, r.reason, r.finished_at is not null as finished, w.status as wait
      from app.automation_runs r join app.automation_waits w on w.run_id = r.id
      where r.id = ${runId}
    `;

  const stepRows = (runId: string) =>
    admin<{ stepId: string; stepKind: string; outcome: string; reason: string | null }[]>`
      select step_id as "stepId", step_kind as "stepKind", outcome, reason
      from app.automation_step_runs where run_id = ${runId} order by created_at, id
    `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'automation-records-8291', 'Records Site'),
             (${OTHER_SITE}, 'automation-records-8292', 'Records Other Site')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values (${SITE}, ${ACTOR}, 'staff', 'active'),
             (${SITE}, ${MEMBER}, 'staff', 'active'),
             (${SITE}, ${LEFT_MEMBER}, 'staff', 'revoked'),
             (${OTHER_SITE}, ${OTHER_SITE_MEMBER}, 'staff', 'active')
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version)
      values (${LEAD}, ${SITE}, 'sim_order', 'submitted', 'pending', 'ci')
    `;
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, active, position)
      values (${PLAN}, ${SITE}, 'sim_order', 'Basic', true, 0),
             (${MOBILITY_PLAN}, ${SITE}, 'mobility', 'Old plan', false, 1)
    `;
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by, archived_at)
      values
        (${SITE}, ${SITE_MADE}, 'Size note', 'About {prop:custom_size}',
         'Size {prop:custom_size}, colour {prop:custom_colour}, again {prop:custom_size}.', 1, ${ACTOR}, null),
        (${SITE}, ${ARCHIVED}, 'Old note', 'Old', 'Nothing to fill.', 1, ${ACTOR}, now()),
        (${SITE}, 'dispatched', null, 'Saved dispatched', 'Hi {first name}', 2, ${ACTOR}, null)
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position)
      values (${SITE}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1)
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
  });

  afterAll(async () => {
    await database?.close();
    if (admin) {
      await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
      await admin.end();
    }
  });

  it('detailOf joins keys with commas and cuts them to 200 characters', () => {
    expect(detailOf(['first name', 'prop:custom_size'])).toBe('first name,prop:custom_size');
    expect(detailOf(['x'.repeat(150), 'y'.repeat(150)])).toHaveLength(200);
    expect(detailOf([])).toBe('');
  });

  it('insertStepRun refuses a done send without a job and a 201-character detail before any SQL', async () => {
    const flowId = await flow('flow_recordsshape0001');
    const runId = await waitingRun(flowId, 'flow_recordsshape0001', 'shape');
    await database.withTenantTx(scope, async (tx) => {
      const refused = [
        { runId, stepId: 's_mail', stepKind: 'send_email' as const, outcome: 'done' as const },
        { runId, stepId: 's_task', stepKind: 'create_task' as const, outcome: 'done' as const },
        {
          runId,
          stepId: 's_mail',
          stepKind: 'send_email' as const,
          outcome: 'skipped' as const,
          reason: 'no_sender' as const,
          branch: 'yes' as const,
        },
        {
          runId,
          stepId: 's_mail',
          stepKind: 'send_email' as const,
          outcome: 'skipped' as const,
          reason: 'missing_fill_in' as const,
          detail: 'x'.repeat(201),
        },
      ];
      for (const record of refused) {
        await expect(insertStepRun(tx, SITE, record)).rejects.toBeInstanceOf(StepRunShapeError);
      }
      // No statement failed inside the transaction: it is still usable.
      await insertStepRun(tx, SITE, {
        runId,
        stepId: 's_branch',
        stepKind: 'if_else',
        outcome: 'done',
        branch: 'no',
      });
      await insertStepRun(tx, SITE, {
        runId,
        stepId: 's_mail',
        stepKind: 'send_email',
        outcome: 'done',
        jobId: crypto.randomUUID(),
      });
    });
    expect(await stepRows(runId)).toEqual([
      { stepId: 's_branch', stepKind: 'if_else', outcome: 'done', reason: null },
      { stepId: 's_mail', stepKind: 'send_email', outcome: 'done', reason: null },
    ]);
  });

  it('finishRun ends a run, and cancelWaitingRun cancels a pending wait once', async () => {
    const flowId = await flow('flow_recordsfinish001');
    const finished = await waitingRun(flowId, 'flow_recordsfinish001', 'finish');
    await database.withTenantTx(scope, (tx) =>
      finishRun(tx, SITE, finished, { status: 'failed', reason: 'step_failed', detail: 's_x' }),
    );
    const [row] = await admin<{ status: string; reason: string; detail: string; done: boolean }[]>`
      select status, reason, detail, finished_at is not null and updated_at >= created_at as done
      from app.automation_runs where id = ${finished}
    `;
    expect(row).toEqual({ status: 'failed', reason: 'step_failed', detail: 's_x', done: true });

    const waiting = await waitingRun(flowId, 'flow_recordsfinish001', 'cancel');
    const cancel = () =>
      database.withTenantTx(scope, (tx) =>
        cancelWaitingRun(tx, SITE, { runId: waiting, reason: 'lead_archived' }),
      );
    expect(await cancel()).toBe(true);
    expect(await cancel()).toBe(false);
    expect(await runState(waiting)).toEqual([
      { status: 'cancelled', reason: 'lead_archived', finished: true, wait: 'cancelled' },
    ]);
    expect(await stepRows(waiting)).toEqual([
      { stepId: 's_wait0001', stepKind: 'wait', outcome: 'cancelled', reason: 'lead_archived' },
    ]);
  });

  it('cancelFlowWork cancels the flow’s pending waits and voids its timers, skipping a locked wait and other flows', async () => {
    const mine = await flow('flow_recordscancel001');
    const other = await flow('flow_recordscancel002');
    const free = await waitingRun(mine, 'flow_recordscancel001', 'free');
    const held = await waitingRun(mine, 'flow_recordscancel001', 'held');
    const untouched = await waitingRun(other, 'flow_recordscancel002', 'other');
    await timer(mine, 'mine-1');
    await timer(mine, 'mine-2');
    await timer(mine, 'mine-fired', 'fired');
    await timer(other, 'other-1');

    // Another connection holds one wait, as a tick resuming it would.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = postgres(migrationUrl ?? '', { max: 1, prepare: false, ssl: false });
    const holding = holder.begin(async (tx) => {
      await tx`select id from app.automation_waits where run_id = ${held} for update`;
      locked();
      await released;
    });
    await isLocked;

    const result = await database.withTenantTx(scope, (tx) =>
      cancelFlowWork(tx, SITE, mine, 'flow_switched_off'),
    );
    release();
    await holding;
    await holder.end();

    expect(result).toEqual({ cancelledRuns: 1, voidedTimers: 2 });
    expect(await runState(free)).toEqual([
      { status: 'cancelled', reason: 'flow_switched_off', finished: true, wait: 'cancelled' },
    ]);
    expect(await stepRows(free)).toEqual([
      { stepId: 's_wait0001', stepKind: 'wait', outcome: 'cancelled', reason: 'flow_switched_off' },
    ]);
    expect(await runState(held)).toEqual([
      { status: 'waiting', reason: null, finished: false, wait: 'pending' },
    ]);
    expect(await stepRows(held)).toEqual([]);
    expect(await runState(untouched)).toEqual([
      { status: 'waiting', reason: null, finished: false, wait: 'pending' },
    ]);
    const timers = await admin<{ occurrence: string; status: string }[]>`
      select occurrence, status from app.automation_timers
      where workspace_id = ${SITE} order by occurrence
    `;
    expect(timers).toEqual([
      { occurrence: 'mine-1', status: 'void' },
      { occurrence: 'mine-2', status: 'void' },
      { occurrence: 'mine-fired', status: 'fired' },
      { occurrence: 'other-1', status: 'pending' },
    ]);
  });

  it('loadFlowSite lists the nine built-ins, the site’s own templates, active members only and every plan', async () => {
    const site = await database.withTenantTx(scope, (tx) => loadFlowSite(tx, SITE));
    for (const key of CUSTOMER_EMAIL_TEMPLATES) {
      expect(site.templates.get(key), key).toEqual({ archived: false, propertyKeys: [] });
    }
    expect(site.templates.get(SITE_MADE)).toEqual({
      archived: false,
      propertyKeys: ['custom_colour', 'custom_size'],
    });
    expect(site.templates.get(ARCHIVED)).toEqual({ archived: true, propertyKeys: [] });
    expect(site.templates.size).toBe(CUSTOMER_EMAIL_TEMPLATES.length + 2);
    expect([...site.memberIds].sort()).toEqual([ACTOR, MEMBER].sort());
    expect(site.plans).toEqual(
      new Map([
        [PLAN, { leadType: 'sim_order' }],
        [MOBILITY_PLAN, { leadType: 'mobility' }],
      ]),
    );
    expect(site.catalog.get('custom_size')?.label).toBe('Size');
  });
});
