import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILT_IN_AUTOMATION_KEYS,
  CUSTOM_FLOW_KEY_PATTERN,
  builtInFlowDefinition,
  builtInFlowName,
  type FlowDefinition,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseFlowStore, type StoredFlow } from '../src/automations/flow-store.js';

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

const site = (n: number) => `18000000-0000-4000-8000-0000000087${String(n).padStart(2, '0')}`;
const SEED_SITE = site(1);
const LIMIT_SITE = site(2);
const RACE_SITE = site(3);
const SWITCH_SITE = site(4);
const ATTENTION_SITE = site(5);
const OTHER_SITE = site(6);
const SITES = Array.from({ length: 12 }, (_, index) => site(index + 1));
const ACTOR = '28000000-0000-4000-8000-000000008701';
const MEMBER = '28000000-0000-4000-8000-000000008702';
const REQUEST = '58000000-0000-4000-8000-000000008701';
const LEAD = '38000000-0000-4000-8000-000000008701';
const OTHER_LEAD = '38000000-0000-4000-8000-000000008702';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SITE_TEMPLATE = 'tpl_flowstoretest001';

const write = (workspaceId: string) => ({ workspaceId, actorId: ACTOR, requestId: REQUEST });

/** A custom flow that mails `template` when a SIM order moves to `stage`. */
const mailOnStage = (
  stage: string,
  template: string,
  extra: Partial<FlowDefinition> = {},
): FlowDefinition => ({
  schemaVersion: 1,
  trigger: { kind: 'stage_entered', leadType: 'sim_order', stage, when: null },
  steps: [{ id: 's_mail', kind: 'send_email', template }],
  ...extra,
});

databaseTest('the flow store', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseFlowStore;

  const ok = <T>(outcome: { status: string; value?: T }): T => {
    expect(outcome.status).toBe('ok');
    if (outcome.value === undefined) throw new Error('no value');
    return outcome.value;
  };

  /** Gives a flow an active version as the database would after an activation. */
  const activateAs = async (workspaceId: string, flowId: string, definition: unknown) => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.automation_versions
        (workspace_id, automation_id, version, status, definition, created_by, activated_by, activated_at)
      values (${workspaceId}, ${flowId},
        (select coalesce(max(version), 0) + 1 from app.automation_versions where automation_id = ${flowId}),
        'active', ${admin.json(JSON.parse(JSON.stringify(definition)))}, ${ACTOR}, ${ACTOR}, now())
      returning id
    `;
    if (!row) throw new Error('no version');
    await admin`update app.automations set active_version_id = ${row.id} where id = ${flowId}`;
  };

  const customFlow = async (workspaceId: string, name: string, definition?: unknown) => {
    const flow = ok(await store.create(write(workspaceId), { name }));
    if (definition !== undefined) await activateAs(workspaceId, flow.id, definition);
    return flow;
  };

  const audits = (workspaceId: string, action: string) =>
    admin<{ before: unknown; after: unknown }[]>`
      select before, after from app.audit_events
      where workspace_id = ${workspaceId} and action = ${action} order by created_at, id
    `;

  const resetSite = async (workspaceId: string) => {
    await admin`delete from app.automations where workspace_id = ${workspaceId}`;
    await admin`delete from app.audit_events where workspace_id = ${workspaceId}`;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 2, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
    for (const [index, id] of SITES.entries()) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${id}, ${`flow-store-87${String(index + 1).padStart(2, '0')}`}, ${`Flow site ${index + 1}`})
      `;
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status)
        values (${id}, ${ACTOR}, 'staff', 'active'), (${id}, ${MEMBER}, 'staff', 'active')
      `;
    }
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version, full_name)
      values (${LEAD}, ${SWITCH_SITE}, 'sim_order', 'submitted', 'pending', 'ci', 'Named Customer'),
             (${OTHER_LEAD}, ${OTHER_SITE}, 'sim_order', 'submitted', 'pending', 'ci', 'Other Customer')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 12,
    });
    store = new DatabaseFlowStore(database);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('the list seeds the six built-ins, off, with version 1 active, once', async () => {
    await resetSite(SEED_SITE);
    const [first, second] = await Promise.all([
      store.list(write(SEED_SITE), { archived: false }),
      store.list(write(SEED_SITE), { archived: false }),
    ]);
    for (const result of [first, second]) {
      expect(result.flows.map((flow) => flow.key)).toEqual([...BUILT_IN_AUTOMATION_KEYS]);
      for (const flow of result.flows) {
        expect(flow.origin).toBe('builtin');
        expect(flow.enabled).toBe(false);
        expect(flow.activeVersion?.version).toBe(1);
        expect(flow.activeVersion?.activatedBy).toBeNull();
        expect(flow.draft).toBeNull();
      }
      expect(result.needsAttention.size).toBe(0);
      expect(result.warnings).toEqual([]);
    }
    const rows = await admin<{ key: string; name: string; definition: unknown }[]>`
      select a.key, a.name, v.definition from app.automations a
      join app.automation_versions v on v.id = a.active_version_id
      where a.workspace_id = ${SEED_SITE} order by a.key
    `;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const key = BUILT_IN_AUTOMATION_KEYS.find((entry) => entry === row.key);
      if (!key) throw new Error(`unexpected ${row.key}`);
      expect(row.name).toBe(builtInFlowName(key));
      expect(row.definition).toEqual(builtInFlowDefinition(key));
    }
    const [versions] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.automation_versions where workspace_id = ${SEED_SITE}
    `;
    expect(versions?.count).toBe(6);
    // A third list changes nothing.
    await store.list(write(SEED_SITE), { archived: false });
    const [again] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.automation_versions where workspace_id = ${SEED_SITE}
    `;
    expect(again?.count).toBe(6);
  });

  it('a site that never opened the page fires nothing', async () => {
    await resetSite(OTHER_SITE);
    // The engine reads only rows that exist, are on and have an active version.
    const live = await admin`
      select a.key from app.automations a
      join app.automation_versions v on v.id = a.active_version_id
      where a.workspace_id = ${OTHER_SITE} and a.enabled and a.archived_at is null
    `;
    expect(live).toHaveLength(0);
    const [rows] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.automations where workspace_id = ${OTHER_SITE}
    `;
    expect(rows?.count).toBe(0);
  });

  it('a built-in row the old backend made without a version is repaired with its name', async () => {
    await resetSite(SEED_SITE);
    await admin`
      insert into app.automations (workspace_id, key, enabled, updated_by)
      values (${SEED_SITE}, 'sim_order_dispatched', true, ${ACTOR})
    `;
    const flow = await store.get(write(SEED_SITE), 'sim_order_dispatched');
    expect(flow?.name).toBe(builtInFlowName('sim_order_dispatched'));
    expect(flow?.enabled).toBe(true);
    expect(flow?.activeVersion?.definition).toEqual(builtInFlowDefinition('sim_order_dispatched'));
  });

  it('create makes a custom flow with an empty draft and stops at 50', async () => {
    await resetSite(LIMIT_SITE);
    const first = ok(
      await store.create(write(LIMIT_SITE), { name: 'Follow up', description: 'Calls' }),
    );
    expect(first.key).toMatch(CUSTOM_FLOW_KEY_PATTERN);
    expect(first).toMatchObject({
      origin: 'custom',
      name: 'Follow up',
      description: 'Calls',
      enabled: false,
      archived: false,
      revision: 0,
      activeVersion: null,
      draft: { version: 1, definition: { schemaVersion: 1, trigger: null, steps: [] } },
    });
    expect(await audits(LIMIT_SITE, 'automation.created')).toEqual([
      { before: null, after: { key: first.key, origin: 'custom', version: 1 } },
    ]);
    for (let index = 1; index < 44; index += 1) {
      expect((await store.create(write(LIMIT_SITE), { name: `Flow ${index}` })).status).toBe('ok');
    }
    expect(await store.create(write(LIMIT_SITE), { name: 'One too many' })).toEqual({
      status: 'limit_reached',
    });

    // Concurrently: a site with 46 flows takes exactly 4 more.
    await resetSite(RACE_SITE);
    for (let index = 0; index < 40; index += 1) {
      await store.create(write(RACE_SITE), { name: `Flow ${index}` });
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.create(write(RACE_SITE), { name: `Race ${index}` }),
      ),
    );
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(4);
    expect(results.filter((result) => result.status === 'limit_reached')).toHaveLength(6);
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.automations
      where workspace_id = ${RACE_SITE} and archived_at is null
    `;
    expect(count?.count).toBe(50);
  });

  it('rename needs the current revision', async () => {
    await resetSite(SWITCH_SITE);
    const flow = await customFlow(SWITCH_SITE, 'Before');
    expect(
      await store.updateDetails(write(SWITCH_SITE), flow.key, {
        expectedRevision: 3,
        name: 'After',
      }),
    ).toEqual({ status: 'revision_conflict' });
    const renamed = ok(
      await store.updateDetails(write(SWITCH_SITE), flow.key, {
        expectedRevision: 0,
        name: 'After',
        description: 'Now described',
      }),
    );
    expect(renamed).toMatchObject({ name: 'After', description: 'Now described', revision: 1 });
    expect(await audits(SWITCH_SITE, 'automation.renamed')).toEqual([
      { before: null, after: { key: flow.key, fields: ['name', 'description'] } },
    ]);
    // Nothing changed: no new revision and no audit.
    const same = ok(
      await store.updateDetails(write(SWITCH_SITE), flow.key, {
        expectedRevision: 1,
        name: 'After',
      }),
    );
    expect(same.revision).toBe(1);
    const cleared = ok(
      await store.updateDetails(write(SWITCH_SITE), flow.key, {
        expectedRevision: 1,
        description: null,
      }),
    );
    expect(cleared).toMatchObject({ description: null, revision: 2 });
    expect(
      await store.updateDetails(write(SWITCH_SITE), 'flow_aaaaaaaaaaaaaaaa', {
        expectedRevision: 0,
        name: 'x',
      }),
    ).toEqual({ status: 'not_found' });
  });

  it('switching on needs an active version', async () => {
    await resetSite(SWITCH_SITE);
    const flow = await customFlow(SWITCH_SITE, 'Draft only');
    expect(await store.setEnabled(write(SWITCH_SITE), flow.key, true)).toEqual({
      status: 'no_active_version',
    });
    await activateAs(SWITCH_SITE, flow.id, mailOnStage('verified', 'activated'));
    const on = ok(await store.setEnabled(write(SWITCH_SITE), flow.key, true));
    expect(on.enabled).toBe(true);
    // A built-in has its version from the seeding.
    expect(
      ok(await store.setEnabled(write(SWITCH_SITE), 'sim_order_dispatched', true)).enabled,
    ).toBe(true);
    expect(await store.setEnabled(write(SWITCH_SITE), 'flow_aaaaaaaaaaaaaaaa', true)).toEqual({
      status: 'not_found',
    });
  });

  it('two concurrent first toggles write one audit row', async () => {
    await resetSite(SWITCH_SITE);
    const results = await Promise.all([
      store.setEnabled(write(SWITCH_SITE), 'sim_order_activated', true),
      store.setEnabled(write(SWITCH_SITE), 'sim_order_activated', true),
    ]);
    for (const result of results) expect(ok(result).enabled).toBe(true);
    expect(await audits(SWITCH_SITE, 'automation.toggled')).toEqual([
      {
        before: { key: 'sim_order_activated', enabled: false },
        after: { key: 'sim_order_activated', enabled: true },
      },
    ]);
    // Off with no change writes nothing either.
    ok(await store.setEnabled(write(SWITCH_SITE), 'order_received', false));
    expect(await audits(SWITCH_SITE, 'automation.toggled')).toHaveLength(1);
  });

  it('switching off cancels waiting runs and voids pending timers at once', async () => {
    await resetSite(SWITCH_SITE);
    const flow = await customFlow(SWITCH_SITE, 'Waits', mailOnStage('verified', 'activated'));
    const other = await customFlow(SWITCH_SITE, 'Other', mailOnStage('verified', 'activated'));
    ok(await store.setEnabled(write(SWITCH_SITE), flow.key, true));
    ok(await store.setEnabled(write(SWITCH_SITE), other.key, true));
    const waiting = async (automationId: string, key: string, occurrence: string) => {
      const [run] = await admin<{ id: string }[]>`
        insert into app.automation_runs
          (workspace_id, automation_key, automation_id, lead_id, status, occurrence)
        values (${SWITCH_SITE}, ${key}, ${automationId}, ${LEAD}, 'waiting', ${occurrence})
        returning id
      `;
      if (!run) throw new Error('no run');
      await admin`
        insert into app.automation_waits (workspace_id, run_id, automation_id, lead_id, step_id, resume_at)
        values (${SWITCH_SITE}, ${run.id}, ${automationId}, ${LEAD}, 's_wait', now() + interval '1 day')
      `;
      await admin`
        insert into app.automation_timers
          (workspace_id, automation_id, lead_id, trigger_kind, occurrence, event_at, due_at)
        values (${SWITCH_SITE}, ${automationId}, ${LEAD}, 'after_submitted', ${occurrence}, now(),
          now() + interval '1 day')
      `;
      return run.id;
    };
    const run = await waiting(flow.id, flow.key, 'occ-1');
    const otherRun = await waiting(other.id, other.key, 'occ-2');

    ok(await store.setEnabled(write(SWITCH_SITE), flow.key, false));
    const [state] = await admin<{ status: string; reason: string; wait: string }[]>`
      select r.status, r.reason, w.status as wait from app.automation_runs r
      join app.automation_waits w on w.run_id = r.id where r.id = ${run}
    `;
    expect(state).toEqual({ status: 'cancelled', reason: 'flow_switched_off', wait: 'cancelled' });
    const timers = await admin<{ automationId: string; status: string }[]>`
      select automation_id as "automationId", status from app.automation_timers
      where workspace_id = ${SWITCH_SITE} order by automation_id
    `;
    expect(timers.find((timer) => timer.automationId === flow.id)?.status).toBe('void');
    expect(timers.find((timer) => timer.automationId === other.id)?.status).toBe('pending');
    const [untouched] = await admin<{ status: string }[]>`
      select status from app.automation_runs where id = ${otherRun}
    `;
    expect(untouched?.status).toBe('waiting');
  });

  it('archive is custom only, switches off first, and restore counts against the limit', async () => {
    await resetSite(LIMIT_SITE);
    expect(await store.archive(write(LIMIT_SITE), 'order_received')).toEqual({
      status: 'builtin',
    });
    const flow = await customFlow(LIMIT_SITE, 'Archived', mailOnStage('verified', 'activated'));
    ok(await store.setEnabled(write(LIMIT_SITE), flow.key, true));
    const archived = ok(await store.archive(write(LIMIT_SITE), flow.key));
    expect(archived).toMatchObject({ enabled: false, archived: true });
    expect(await store.setEnabled(write(LIMIT_SITE), flow.key, true)).toEqual({
      status: 'archived',
    });
    expect(await audits(LIMIT_SITE, 'automation.archived')).toEqual([
      {
        before: { key: flow.key, enabled: true, archived: false },
        after: { key: flow.key, enabled: false, archived: true },
      },
    ]);
    const live = await store.list(write(LIMIT_SITE), { archived: false });
    expect(live.flows.map((entry) => entry.key)).not.toContain(flow.key);
    const archivedList = await store.list(write(LIMIT_SITE), { archived: true });
    expect(archivedList.flows.map((entry) => entry.key)).toEqual([flow.key]);
    expect(archivedList.nextBefore).toBeNull();

    // Fill the site to 50, then the restore is refused.
    for (let index = 0; index < 44; index += 1) {
      ok(await store.create(write(LIMIT_SITE), { name: `Flow ${index}` }));
    }
    expect(await store.restore(write(LIMIT_SITE), flow.key)).toEqual({ status: 'limit_reached' });
    const someone = (await store.list(write(LIMIT_SITE), { archived: false })).flows.at(-1);
    if (!someone) throw new Error('no flow');
    ok(await store.archive(write(LIMIT_SITE), someone.key));
    const restored = ok(await store.restore(write(LIMIT_SITE), flow.key));
    expect(restored).toMatchObject({ archived: false, enabled: false });
    expect(await audits(LIMIT_SITE, 'automation.restored')).toHaveLength(1);
    expect(await store.restore(write(LIMIT_SITE), 'order_received')).toEqual({ status: 'builtin' });
  });

  it('the archived list is paged, however many flows were archived', async () => {
    await resetSite(LIMIT_SITE);
    // More archived flows than any one response carries.
    for (let index = 0; index < 120; index += 1) {
      const flow = ok(await store.create(write(LIMIT_SITE), { name: `Old ${index}` }));
      ok(await store.archive(write(LIMIT_SITE), flow.key));
    }
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await store.list(write(LIMIT_SITE), {
        archived: true,
        ...(before ? { before } : {}),
      });
      expect(result.flows.length).toBeLessThanOrEqual(50);
      seen.push(...result.flows.map((flow) => flow.key));
      if (!result.nextBefore) break;
      before = result.nextBefore;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    // The live list still holds only the six.
    expect((await store.list(write(LIMIT_SITE), { archived: false })).flows).toHaveLength(6);
  });

  it('runs page by 50 with before, legacy runs read as one send step, names only with contact access', async () => {
    await resetSite(SWITCH_SITE);
    await admin`delete from app.automation_runs where workspace_id = ${SWITCH_SITE}`;
    const flow = await customFlow(SWITCH_SITE, 'Runs', mailOnStage('verified', 'activated'));
    const [version] = await admin<{ id: string }[]>`
      select active_version_id as id from app.automations where id = ${flow.id}
    `;
    // 55 completed runs, one second apart, and one waiting run, newest.
    for (let index = 0; index < 55; index += 1) {
      await admin`
        insert into app.automation_runs
          (workspace_id, automation_key, automation_id, version_id, lead_id, status, occurrence,
           trigger_kind, created_at, finished_at)
        values (${SWITCH_SITE}, ${flow.key}, ${flow.id}, ${version?.id ?? null}, ${LEAD}, 'completed',
          ${`occ-${index}`}, 'stage_entered', now() - make_interval(secs => ${100 - index}),
          now() - make_interval(secs => ${100 - index}))
      `;
    }
    const [waiting] = await admin<{ id: string }[]>`
      insert into app.automation_runs
        (workspace_id, automation_key, automation_id, version_id, lead_id, status, occurrence, trigger_kind)
      values (${SWITCH_SITE}, ${flow.key}, ${flow.id}, ${version?.id ?? null}, ${LEAD}, 'waiting',
        'occ-wait', 'stage_entered')
      returning id
    `;
    if (!waiting) throw new Error('no run');
    await admin`
      insert into app.automation_step_runs (workspace_id, run_id, step_id, step_kind, outcome, branch)
      values (${SWITCH_SITE}, ${waiting.id}, 's_if', 'if_else', 'done', 'yes')
    `;
    await admin`
      insert into app.automation_step_runs (workspace_id, run_id, step_id, step_kind, outcome)
      values (${SWITCH_SITE}, ${waiting.id}, 's_wait', 'wait', 'waiting')
    `;
    await admin`
      insert into app.automation_waits (workspace_id, run_id, automation_id, lead_id, step_id, resume_at)
      values (${SWITCH_SITE}, ${waiting.id}, ${flow.id}, ${LEAD}, 's_wait', '2026-11-03T14:00:00Z')
    `;

    const first = await store.listRuns(write(SWITCH_SITE), flow.key, { includeLeadNames: false });
    if (!first) throw new Error('no runs');
    expect(first.runs).toHaveLength(50);
    expect(first.runs[0]).toMatchObject({
      id: waiting.id,
      status: 'waiting',
      leadName: null,
      // Version 1 is the empty draft the flow was made with.
      version: 2,
      triggerKind: 'stage_entered',
      resumeAt: '2026-11-03T14:00:00.000Z',
      legacy: false,
      steps: [
        { stepId: 's_if', stepKind: 'if_else', outcome: 'done', branch: 'yes' },
        { stepId: 's_wait', stepKind: 'wait', outcome: 'waiting', branch: null },
      ],
    });
    expect(first.nextBefore).toBe(first.runs[49]?.id);
    const second = await store.listRuns(write(SWITCH_SITE), flow.key, {
      before: first.nextBefore ?? undefined,
      includeLeadNames: true,
    });
    expect(second?.runs).toHaveLength(6);
    expect(second?.nextBefore).toBeNull();
    expect(second?.runs[0]?.leadName).toBe('Named Customer');
    const ids = new Set([...first.runs, ...(second?.runs ?? [])].map((run) => run.id));
    expect(ids.size).toBe(56);

    // Phase 4 runs: no automation_id, an outcome; the queued one's status defaulted.
    const [job] = await admin<{ id: string }[]>`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload)
      values (${SWITCH_SITE}, 'lead_customer_email', ${`legacy-${crypto.randomUUID()}`}, '{}'::jsonb)
      returning id
    `;
    await admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, job_id, created_at)
      values (${SWITCH_SITE}, 'sim_order_dispatched', ${LEAD}, 'queued', ${job?.id ?? null}, now() - interval '1 hour')
    `;
    await admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason)
      values (${SWITCH_SITE}, 'sim_order_dispatched', ${LEAD}, 'skipped', 'no_sender')
    `;
    const legacy = await store.listRuns(write(SWITCH_SITE), 'sim_order_dispatched', {
      includeLeadNames: false,
    });
    expect(legacy?.runs.map((run) => [run.status, run.legacy, run.reason, run.steps])).toEqual([
      [
        'skipped',
        true,
        'no_sender',
        [
          expect.objectContaining({
            stepId: 'main',
            stepKind: 'send_email',
            outcome: 'skipped',
            reason: 'no_sender',
          }),
        ],
      ],
      [
        'completed',
        true,
        null,
        [expect.objectContaining({ stepId: 'main', stepKind: 'send_email', outcome: 'done' })],
      ],
    ]);
    const one = await store.getRun(write(SWITCH_SITE), flow.key, waiting.id, {
      includeLeadNames: true,
    });
    expect(one?.leadName).toBe('Named Customer');
    expect(
      await store.getRun(write(SWITCH_SITE), 'sim_order_dispatched', waiting.id, {
        includeLeadNames: true,
      }),
    ).toBeUndefined();
    expect(
      await store.listRuns(write(SWITCH_SITE), 'flow_aaaaaaaaaaaaaaaa', {
        includeLeadNames: false,
      }),
    ).toBeUndefined();
  });

  it('the list warns when two flows on email on the same event', async () => {
    await resetSite(SWITCH_SITE);
    ok(await store.setEnabled(write(SWITCH_SITE), 'sim_order_dispatched', true));
    const note = await customFlow(
      SWITCH_SITE,
      'My dispatch note',
      mailOnStage('delivered', 'dispatched'),
    );
    expect((await store.list(write(SWITCH_SITE), { archived: false })).warnings).toEqual([]);
    ok(await store.setEnabled(write(SWITCH_SITE), note.key, true));
    const { warnings } = await store.list(write(SWITCH_SITE), { archived: false });
    expect(warnings).toEqual([
      {
        event: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered' },
        flows: [
          { key: 'sim_order_dispatched', name: builtInFlowName('sim_order_dispatched') },
          { key: note.key, name: 'My dispatch note' },
        ],
        message: `Customers get 2 emails when a SIM order moves to Delivered: ${builtInFlowName('sim_order_dispatched')}, My dispatch note.`,
      },
    ]);
  });

  it('an unusable active version marks the flow needs attention', async () => {
    await resetSite(ATTENTION_SITE);
    await admin`delete from app.email_templates where workspace_id = ${ATTENTION_SITE}`;
    await admin`delete from app.properties where workspace_id = ${ATTENTION_SITE}`;
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by)
      values (${ATTENTION_SITE}, ${SITE_TEMPLATE}, 'Site note', 'Hello', 'Hello {first name}', 1, ${ACTOR})
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position)
      values (${ATTENTION_SITE}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1)
    `;
    const template = await customFlow(
      ATTENTION_SITE,
      'Template',
      mailOnStage('verified', SITE_TEMPLATE),
    );
    const stage = await customFlow(ATTENTION_SITE, 'Stage', mailOnStage('paid', 'activated'));
    const property = await customFlow(
      ATTENTION_SITE,
      'Property',
      mailOnStage('verified', 'activated', {
        trigger: {
          kind: 'stage_entered',
          leadType: 'sim_order',
          stage: 'verified',
          when: {
            match: 'all',
            items: [{ kind: 'property', filter: { key: 'custom_size', op: 'eq', value: 'Large' } }],
          },
        },
      }),
    );
    const broken = await customFlow(ATTENTION_SITE, 'Broken', { schemaVersion: 1, nonsense: 1 });
    const clean = await customFlow(ATTENTION_SITE, 'Clean', mailOnStage('verified', 'activated'));

    let result = await store.list(write(ATTENTION_SITE), { archived: false });
    expect(result.needsAttention.get(template.key)).toBeUndefined();
    expect(result.needsAttention.get(property.key)).toBeUndefined();
    expect(result.needsAttention.get(stage.key)).toEqual({
      path: 'trigger.stage',
      code: 'stage_unavailable',
      ref: 'paid',
    });
    expect(result.needsAttention.get(broken.key)).toEqual({
      path: 'definition',
      code: 'definition_invalid',
      ref: 'definition',
    });

    await admin`
      update app.email_templates set archived_at = now()
      where workspace_id = ${ATTENTION_SITE} and key = ${SITE_TEMPLATE}
    `;
    await admin`
      update app.properties set sensitive = true
      where workspace_id = ${ATTENTION_SITE} and key = 'custom_size'
    `;
    result = await store.list(write(ATTENTION_SITE), { archived: false });
    expect(result.needsAttention.get(template.key)).toEqual({
      path: 'steps.0.template',
      code: 'template_unavailable',
      ref: SITE_TEMPLATE,
    });
    expect(result.needsAttention.get(property.key)).toMatchObject({
      code: 'property_unavailable',
      ref: 'custom_size',
    });
    expect(result.needsAttention.get(clean.key)).toBeUndefined();
    // A flow with only a draft has nothing active to be wrong.
    const draftOnly = await customFlow(ATTENTION_SITE, 'Draft');
    result = await store.list(write(ATTENTION_SITE), { archived: false });
    expect(result.needsAttention.get(draftOnly.key)).toBeUndefined();
  });

  it("another site's flows and runs are invisible", async () => {
    await resetSite(SWITCH_SITE);
    await resetSite(OTHER_SITE);
    const mine = await customFlow(SWITCH_SITE, 'Mine', mailOnStage('verified', 'activated'));
    await admin`
      insert into app.automation_runs (workspace_id, automation_key, automation_id, lead_id, status, occurrence)
      values (${SWITCH_SITE}, ${mine.key}, ${mine.id}, ${LEAD}, 'completed', 'occ-x')
    `;
    const other = { workspaceId: OTHER_SITE, actorId: ACTOR, requestId: REQUEST };
    expect(await store.get(other, mine.key)).toBeUndefined();
    expect(await store.listRuns(other, mine.key, { includeLeadNames: true })).toBeUndefined();
    expect(await store.setEnabled(other, mine.key, true)).toEqual({ status: 'not_found' });
    expect(await store.archive(other, mine.key)).toEqual({ status: 'not_found' });
    const theirs = await store.list(other, { archived: false });
    expect(theirs.flows.map((flow: StoredFlow) => flow.key)).not.toContain(mine.key);
    const builtInRuns = await store.listRuns(other, 'sim_order_dispatched', {
      includeLeadNames: false,
    });
    expect(builtInRuns?.runs).toEqual([]);
  });
});
