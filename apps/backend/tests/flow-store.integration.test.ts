import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILT_IN_AUTOMATION_KEYS,
  CUSTOM_FLOW_KEY_PATTERN,
  builtInFlowDefinition,
  builtInFlowName,
  flowCatalogResponseSchema,
  type FlowDefinition,
  type FlowDraft,
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
const DRAFT_SITE = site(7);
const ACTIVATE_SITE = site(8);
const TIMER_SITE = site(9);
const CATALOG_SITE = site(10);
const RESET_SITE = site(11);
const DETAIL_SITE = site(12);
const TIMER_LEAD = '38000000-0000-4000-8000-000000008709';
const TIMER_LEADS = [1, 2, 3].map((n) => `38000000-0000-4000-8000-00000000879${n}`);
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

  // -------------------------------------------------------------------------
  // Drafts, activation, reset, versions and the catalogue (Task 10)

  const withSteps = (steps: unknown[], trigger?: unknown): FlowDraft =>
    // Parsed by the store, as the route's request schema would hand it over.
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        trigger: trigger ?? {
          kind: 'stage_entered',
          leadType: 'sim_order',
          stage: 'verified',
          when: null,
        },
        steps,
      }),
    );

  it('the first draft save copies from nothing and bumps the revision', async () => {
    await resetSite(DRAFT_SITE);
    // A built-in has no draft: the first save makes version 2 from what it is sent.
    const seeded = await store.get(write(DRAFT_SITE), 'sim_order_dispatched');
    expect(seeded).toMatchObject({ revision: 0, draft: null, activeVersion: { version: 1 } });
    const edited = {
      ...builtInFlowDefinition('sim_order_dispatched'),
      steps: [
        ...builtInFlowDefinition('sim_order_dispatched').steps,
        { id: 's_note', kind: 'send_email', template: 'activated' },
      ],
    };
    const saved = ok(
      await store.saveDraft(write(DRAFT_SITE), 'sim_order_dispatched', {
        expectedRevision: 0,
        definition: withSteps(edited.steps, edited.trigger),
      }),
    );
    expect(saved.issues).toEqual([]);
    expect(saved.flow).toMatchObject({
      revision: 1,
      activeVersion: { version: 1 },
      draft: { version: 2, definition: edited },
    });
    // A custom flow's empty draft (version 1) is rewritten in place.
    const flow = await customFlow(DRAFT_SITE, 'Draft');
    const rewritten = ok(
      await store.saveDraft(write(DRAFT_SITE), flow.key, {
        expectedRevision: 0,
        definition: withSteps([{ id: 's_mail', kind: 'send_email', template: null }]),
      }),
    );
    expect(rewritten.flow).toMatchObject({ revision: 1, draft: { version: 1 } });
    expect(await audits(DRAFT_SITE, 'automation.draft_saved')).toEqual([]);
  });

  it('a stale revision is refused and changes nothing', async () => {
    await resetSite(DRAFT_SITE);
    const flow = await customFlow(DRAFT_SITE, 'Stale');
    expect(
      await store.saveDraft(write(DRAFT_SITE), flow.key, {
        expectedRevision: 4,
        definition: withSteps([{ id: 's_mail', kind: 'send_email', template: 'activated' }]),
      }),
    ).toEqual({ status: 'revision_conflict' });
    expect(
      await store.activate(write(DRAFT_SITE), flow.key, {
        expectedRevision: 4,
        mayChangeLeads: true,
      }),
    ).toEqual({
      status: 'revision_conflict',
    });
    const after = await store.get(write(DRAFT_SITE), flow.key);
    expect(after).toMatchObject({
      revision: 0,
      draft: { version: 1, definition: { schemaVersion: 1, trigger: null, steps: [] } },
    });
  });

  it('a draft keeps site issues as warnings', async () => {
    await resetSite(DRAFT_SITE);
    const flow = await customFlow(DRAFT_SITE, 'Warnings');
    const saved = ok(
      await store.saveDraft(write(DRAFT_SITE), flow.key, {
        expectedRevision: 0,
        definition: withSteps([
          { id: 's_mail', kind: 'send_email', template: 'tpl_nosuchtemplate01' },
          {
            id: 's_assign',
            kind: 'assign_lead',
            actorId: '28000000-0000-4000-8000-000000008799',
            reassign: false,
          },
        ]),
      }),
    );
    expect(saved.issues).toEqual([
      { path: 'steps.0.template', code: 'template_unavailable', ref: 'tpl_nosuchtemplate01' },
      {
        path: 'steps.1.actorId',
        code: 'member_unavailable',
        ref: '28000000-0000-4000-8000-000000008799',
      },
    ]);
    expect(saved.flow.draft?.definition).toMatchObject({
      steps: [{ id: 's_mail' }, { id: 's_assign' }],
    });
  });

  it('a structure error is refused with its message, and a custom flow never stores main', async () => {
    await resetSite(DRAFT_SITE);
    const flow = await customFlow(DRAFT_SITE, 'Structure');
    const afterBranch = await store.saveDraft(write(DRAFT_SITE), flow.key, {
      expectedRevision: 0,
      definition: withSteps([
        {
          id: 's_if',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'lead_type', in: ['sim_order'] }] },
          then: [],
          else: [],
        },
        { id: 's_mail', kind: 'send_email', template: 'activated' },
      ]),
    });
    expect(afterBranch.status).toBe('invalid');
    if (afterBranch.status !== 'invalid') throw new Error('not refused');
    expect(afterBranch.issues.length).toBeGreaterThan(0);
    expect(afterBranch.issues.every((issue) => typeof issue === 'string')).toBe(true);

    // The request schema takes `main` (for a built-in's draft); a custom flow is refused it.
    const main = await store.saveDraft(write(DRAFT_SITE), flow.key, {
      expectedRevision: 0,
      definition: withSteps([{ id: 'main', kind: 'send_email', template: 'activated' }]),
    });
    expect(main.status).toBe('invalid');
    const [stored] = await admin<{ definition: unknown; revision: number }[]>`
      select v.definition, a.revision from app.automation_versions v
      join app.automations a on a.id = v.automation_id
      where a.workspace_id = ${DRAFT_SITE} and a.key = ${flow.key} and v.status = 'draft'
    `;
    expect(stored).toEqual({
      definition: { schemaVersion: 1, trigger: null, steps: [] },
      revision: 0,
    });
    // A built-in may keep its own `main`.
    const builtIn = ok(
      await store.saveDraft(write(DRAFT_SITE), 'sim_order_activated', {
        expectedRevision: 0,
        definition: withSteps(
          builtInFlowDefinition('sim_order_activated').steps,
          builtInFlowDefinition('sim_order_activated').trigger,
        ),
      }),
    );
    expect(builtIn.flow.draft?.version).toBe(2);
  });

  it('activation refuses a draft with any site issue', async () => {
    await resetSite(ACTIVATE_SITE);
    await admin`delete from app.email_templates where workspace_id = ${ACTIVATE_SITE}`;
    await admin`delete from app.properties where workspace_id = ${ACTIVATE_SITE}`;
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by, archived_at)
      values (${ACTIVATE_SITE}, 'tpl_archivedtemplat1', 'Gone', 'Hello', 'Hello', 1, ${ACTOR}, now())
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position, sensitive)
      values (${ACTIVATE_SITE}, 'lead', 'custom_secret', 'custom', 'Secret', 'text', 1, true)
    `;
    const cases: [unknown[], unknown, string, string][] = [
      [
        [{ id: 's_mail', kind: 'send_email', template: 'tpl_archivedtemplat1' }],
        undefined,
        'template_unavailable',
        'tpl_archivedtemplat1',
      ],
      [
        [{ id: 's_mail', kind: 'send_email', template: 'activated' }],
        { kind: 'stage_entered', leadType: 'sim_order', stage: 'paid', when: null },
        'stage_unavailable',
        'paid',
      ],
      [
        [{ id: 's_mail', kind: 'send_email', template: 'activated' }],
        {
          kind: 'stage_entered',
          leadType: 'sim_order',
          stage: 'verified',
          when: {
            match: 'all',
            items: [{ kind: 'property', filter: { key: 'custom_secret', op: 'eq', value: 'x' } }],
          },
        },
        'property_unavailable',
        'custom_secret',
      ],
    ];
    for (const [steps, trigger, code, ref] of cases) {
      const flow = await customFlow(ACTIVATE_SITE, code);
      ok(
        await store.saveDraft(write(ACTIVATE_SITE), flow.key, {
          expectedRevision: 0,
          definition: withSteps(steps, trigger),
        }),
      );
      const refused = await store.activate(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 1,
        mayChangeLeads: true,
      });
      expect(refused).toEqual({
        status: 'invalid',
        issues: [expect.objectContaining({ code, ref })],
      });
      const after = await store.get(write(ACTIVATE_SITE), flow.key);
      expect(after?.activeVersion).toBeNull();
    }
    // A draft that is not finished is refused by its structure.
    const unfinished = await customFlow(ACTIVATE_SITE, 'Unfinished');
    const empty = await store.activate(write(ACTIVATE_SITE), unfinished.key, {
      expectedRevision: 0,
      mayChangeLeads: true,
    });
    expect(empty.status).toBe('invalid');
  });

  it('activation does not wait on a run being recorded for the flow (no key lock)', async () => {
    await resetSite(ACTIVATE_SITE);
    const lead = '38000000-0000-4000-8000-000000008781';
    await admin`delete from app.leads where id = ${lead}`;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version)
      values (${lead}, ${ACTIVATE_SITE}, 'sim_order', 'submitted', 'pending', 'ci')
    `;
    const flow = await customFlow(ACTIVATE_SITE, 'Racing');
    const mail = (template: string) => withSteps([{ id: 's_mail', kind: 'send_email', template }]);
    ok(
      await store.saveDraft(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 0,
        definition: mail('activated'),
      }),
    );
    const first = ok(
      await store.activate(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 1,
        mayChangeLeads: false,
      }),
    );
    ok(
      await store.saveDraft(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 2,
        definition: mail('cancelled'),
      }),
    );

    // A firing in flight: its run insert holds key-share locks on the flow and
    // its version (the FKs) until it commits.
    const holder = postgres(migrationUrl ?? '', {
      max: 1,
      prepare: false,
      ssl: false,
      onnotice: () => {},
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => {};
    const isInserted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const firing = holder
      .begin(async (tx) => {
        await tx`
          insert into app.automation_runs
            (workspace_id, automation_key, automation_id, version_id, lead_id, status, occurrence)
          values (${ACTIVATE_SITE}, ${flow.key}, ${flow.id}, ${first.activeVersion?.id ?? null},
            ${lead}, 'completed', 'in-flight')
        `;
        inserted();
        await released;
        throw new Error('roll back');
      })
      .catch(() => undefined);
    await isInserted;
    try {
      const activation = store.activate(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 3,
        mayChangeLeads: false,
      });
      const waited = await Promise.race([
        activation.then(() => 'activated'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 5000)),
      ]);
      expect(waited).toBe('activated');
      expect(ok(await activation)).toMatchObject({ activeVersion: { version: 2 }, revision: 4 });
    } finally {
      release();
      await firing;
      await holder.end();
    }
  });

  it('activation of a lead-changing draft needs lead.manage', async () => {
    await resetSite(ACTIVATE_SITE);
    const flow = await customFlow(ACTIVATE_SITE, 'Tasks');
    ok(
      await store.saveDraft(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 0,
        definition: withSteps([
          {
            id: 's_task',
            kind: 'create_task',
            title: 'Call {first name}',
            dueInDays: 1,
            assignee: { kind: 'lead_assignee' },
          },
        ]),
      }),
    );
    expect(
      await store.activate(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 1,
        mayChangeLeads: false,
      }),
    ).toEqual({
      status: 'needs_lead_manage',
    });
    const activated = ok(
      await store.activate(write(ACTIVATE_SITE), flow.key, {
        expectedRevision: 1,
        mayChangeLeads: true,
      }),
    );
    expect(activated).toMatchObject({
      revision: 2,
      draft: null,
      activeVersion: { version: 1, activatedBy: ACTOR },
    });
    // An email-only flow needs no lead.manage.
    const mail = await customFlow(ACTIVATE_SITE, 'Mail');
    ok(
      await store.saveDraft(write(ACTIVATE_SITE), mail.key, {
        expectedRevision: 0,
        definition: withSteps([{ id: 's_mail', kind: 'send_email', template: 'activated' }]),
      }),
    );
    expect(
      (
        await store.activate(write(ACTIVATE_SITE), mail.key, {
          expectedRevision: 1,
          mayChangeLeads: false,
        })
      ).status,
    ).toBe('ok');
    expect(await audits(ACTIVATE_SITE, 'automation.activated')).toEqual([
      { before: null, after: { key: flow.key, version: 1 } },
      { before: null, after: { key: mail.key, version: 1 } },
    ]);
  });

  it('activation retires the old version, keeps the flow switch, recomputes and voids pending timers', async () => {
    await resetSite(TIMER_SITE);
    await admin`delete from app.leads where workspace_id = ${TIMER_SITE}`;
    for (const id of [TIMER_LEAD, ...TIMER_LEADS]) {
      await admin`
        insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version)
        values (${id}, ${TIMER_SITE}, 'sim_order', 'submitted', 'pending', 'ci')
      `;
    }
    const inPending = (days: number) => ({
      kind: 'time_in_stage',
      leadType: 'sim_order',
      stage: 'pending',
      after: { amount: days, unit: 'days' },
      when: null,
    });
    const mail = [{ id: 's_mail', kind: 'send_email', template: 'activated' }];
    const flow = await customFlow(TIMER_SITE, 'Timers');
    ok(
      await store.saveDraft(write(TIMER_SITE), flow.key, {
        expectedRevision: 0,
        definition: withSteps(mail, inPending(3)),
      }),
    );
    ok(
      await store.activate(write(TIMER_SITE), flow.key, {
        expectedRevision: 1,
        mayChangeLeads: false,
      }),
    );
    ok(await store.setEnabled(write(TIMER_SITE), flow.key, true));
    const eventAt = '2026-11-02T15:00:00.000Z';
    const timer = async (leadId: string, stage: string) => {
      const [row] = await admin<{ id: string }[]>`
        insert into app.automation_timers
          (workspace_id, automation_id, lead_id, trigger_kind, occurrence, stage, event_at, due_at)
        values (${TIMER_SITE}, ${flow.id}, ${leadId}, 'time_in_stage', ${`stay:${leadId}`}, ${stage},
          ${eventAt}, '2026-11-05T15:00:00Z')
        returning id
      `;
      if (!row) throw new Error('no timer');
      return row.id;
    };
    const stays = await timer(TIMER_LEADS[0] ?? '', 'pending');
    const elsewhere = await timer(TIMER_LEADS[1] ?? '', 'verified');
    const held = await timer(TIMER_LEADS[2] ?? '', 'pending');

    // Version 2 waits five days.
    ok(
      await store.saveDraft(write(TIMER_SITE), flow.key, {
        expectedRevision: 2,
        definition: withSteps(mail, inPending(5)),
      }),
    );
    const holder = postgres(migrationUrl ?? '', {
      max: 1,
      prepare: false,
      ssl: false,
      onnotice: () => {},
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = holder.begin(async (tx) => {
      await tx`select id from app.automation_timers where id = ${held} for update`;
      locked();
      await released;
    });
    await isLocked;
    try {
      const activated = ok(
        await store.activate(write(TIMER_SITE), flow.key, {
          expectedRevision: 3,
          mayChangeLeads: false,
        }),
      );
      expect(activated).toMatchObject({
        enabled: true,
        activeVersion: { version: 2 },
        draft: null,
        revision: 4,
      });
    } finally {
      release();
      await holding;
      await holder.end();
    }
    const timers = await admin<{ id: string; status: string; due: Date }[]>`
      select id, status, due_at as due from app.automation_timers where workspace_id = ${TIMER_SITE}
    `;
    const byId = new Map(timers.map((row) => [row.id, row]));
    expect(byId.get(stays)?.status).toBe('pending');
    expect(byId.get(stays)?.due.toISOString()).toBe('2026-11-07T15:00:00.000Z');
    expect(byId.get(elsewhere)?.status).toBe('void');
    expect(byId.get(held)).toMatchObject({ status: 'pending' });
    expect(byId.get(held)?.due.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    const versions = await admin<{ version: number; status: string; retired: boolean }[]>`
      select v.version, v.status, v.retired_at is not null as retired from app.automation_versions v
      where v.automation_id = ${flow.id} order by v.version
    `;
    expect(versions).toEqual([
      { version: 1, status: 'retired', retired: true },
      { version: 2, status: 'active', retired: false },
    ]);

    // A trigger of another kind voids the rest.
    ok(
      await store.saveDraft(write(TIMER_SITE), flow.key, {
        expectedRevision: 4,
        definition: withSteps(mail, {
          kind: 'after_submitted',
          leadTypes: ['sim_order'],
          after: { amount: 1, unit: 'days' },
          when: null,
        }),
      }),
    );
    ok(
      await store.activate(write(TIMER_SITE), flow.key, {
        expectedRevision: 5,
        mayChangeLeads: false,
      }),
    );
    const [after] = await admin<
      { status: string }[]
    >`select status from app.automation_timers where id = ${stays}`;
    expect(after?.status).toBe('void');
  });

  it("an activated version's definition never changes", async () => {
    await resetSite(DRAFT_SITE);
    const flow = await customFlow(DRAFT_SITE, 'Versions');
    const first = withSteps([{ id: 's_mail', kind: 'send_email', template: 'activated' }]);
    ok(
      await store.saveDraft(write(DRAFT_SITE), flow.key, {
        expectedRevision: 0,
        definition: first,
      }),
    );
    ok(
      await store.activate(write(DRAFT_SITE), flow.key, {
        expectedRevision: 1,
        mayChangeLeads: false,
      }),
    );
    const second = withSteps([{ id: 's_mail', kind: 'send_email', template: 'cancelled' }]);
    const saved = ok(
      await store.saveDraft(write(DRAFT_SITE), flow.key, {
        expectedRevision: 2,
        definition: second,
      }),
    );
    expect(saved.flow).toMatchObject({
      activeVersion: { version: 1, definition: first },
      draft: { version: 2, definition: second },
    });
  });

  it('discard then save makes a new draft number', async () => {
    await resetSite(DRAFT_SITE);
    const flow = await customFlow(DRAFT_SITE, 'Discard');
    const discarded = ok(await store.discardDraft(write(DRAFT_SITE), flow.key));
    expect(discarded).toMatchObject({ draft: null, revision: 1 });
    expect(await audits(DRAFT_SITE, 'automation.draft_discarded')).toEqual([
      { before: null, after: { key: flow.key, version: 1 } },
    ]);
    // Nothing to discard: no change.
    expect(ok(await store.discardDraft(write(DRAFT_SITE), flow.key)).revision).toBe(1);
    const saved = ok(
      await store.saveDraft(write(DRAFT_SITE), flow.key, {
        expectedRevision: 1,
        definition: withSteps([{ id: 's_mail', kind: 'send_email', template: 'activated' }]),
      }),
    );
    expect(saved.flow.draft?.version).toBe(2);
  });

  it('reset puts the built-in default back as a draft, built-ins only', async () => {
    await resetSite(RESET_SITE);
    const flow = await customFlow(RESET_SITE, 'Custom');
    expect(await store.reset(write(RESET_SITE), flow.key)).toEqual({ status: 'not_builtin' });
    ok(
      await store.updateDetails(write(RESET_SITE), 'order_received', {
        expectedRevision: 0,
        name: 'Renamed',
      }),
    );
    ok(
      await store.saveDraft(write(RESET_SITE), 'order_received', {
        expectedRevision: 1,
        definition: withSteps(
          [{ id: 'main', kind: 'send_email', template: 'cancelled' }],
          builtInFlowDefinition('order_received').trigger,
        ),
      }),
    );
    const reset = ok(await store.reset(write(RESET_SITE), 'order_received'));
    expect(reset).toMatchObject({
      name: builtInFlowName('order_received'),
      revision: 3,
      draft: { version: 2, definition: builtInFlowDefinition('order_received') },
    });
    expect(await audits(RESET_SITE, 'automation.reset')).toEqual([
      { before: null, after: { key: 'order_received' } },
    ]);
    const activated = ok(
      await store.activate(write(RESET_SITE), 'order_received', {
        expectedRevision: 3,
        mayChangeLeads: false,
      }),
    );
    expect(activated.activeVersion).toMatchObject({
      version: 2,
      definition: builtInFlowDefinition('order_received'),
    });
  });

  it('versions list and one version read', async () => {
    await resetSite(RESET_SITE);
    ok(
      await store.saveDraft(write(RESET_SITE), 'sim_order_cancelled', {
        expectedRevision: 0,
        definition: withSteps(
          builtInFlowDefinition('sim_order_cancelled').steps,
          builtInFlowDefinition('sim_order_cancelled').trigger,
        ),
      }),
    );
    ok(
      await store.activate(write(RESET_SITE), 'sim_order_cancelled', {
        expectedRevision: 1,
        mayChangeLeads: false,
      }),
    );
    const versions = await store.versions(write(RESET_SITE), 'sim_order_cancelled');
    expect(versions.map((entry) => [entry.version, entry.status, entry.activatedBy])).toEqual([
      [2, 'active', ACTOR],
      [1, 'retired', null],
    ]);
    const one = await store.getVersion(write(RESET_SITE), 'sim_order_cancelled', 1);
    expect(one).toMatchObject({
      version: 1,
      status: 'retired',
      definition: builtInFlowDefinition('sim_order_cancelled'),
    });
    expect(await store.getVersion(write(RESET_SITE), 'sim_order_cancelled', 9)).toBeUndefined();
    expect(
      await store.getVersion({ workspaceId: OTHER_SITE, actorId: ACTOR }, 'sim_order_cancelled', 2),
    ).toBeUndefined();
  });

  it('the detail serves an active definition that no longer parses, as needing attention', async () => {
    await resetSite(DETAIL_SITE);
    const flow = await customFlow(DETAIL_SITE, 'Rotten', {
      schemaVersion: 1,
      trigger: { kind: 'gone' },
      steps: [],
    });
    await admin`
      update app.automation_versions set definition = '{"schemaVersion": 1, "nonsense": true}'::jsonb
      where automation_id = ${flow.id} and status = 'draft'
    `;
    const detail = await store.detail(write(DETAIL_SITE), flow.key);
    expect(detail).toMatchObject({
      needsAttention: { code: 'definition_invalid' },
      active: { version: 2, definition: null },
      draft: { version: 1, definition: null, issues: [{ code: 'definition_invalid' }] },
    });
    expect(detail?.versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(await store.detail(write(DETAIL_SITE), 'flow_aaaaaaaaaaaaaaaa')).toBeUndefined();
    const builtIn = await store.detail(write(DETAIL_SITE), 'mobility_activated');
    expect(builtIn).toMatchObject({
      needsAttention: null,
      draft: null,
      active: { version: 1, definition: builtInFlowDefinition('mobility_activated') },
    });
  });

  it('the catalogue leaves out sensitive and hidden properties and tracking_code, and names what each property may be used for', async () => {
    await resetSite(CATALOG_SITE);
    await admin`delete from app.email_templates where workspace_id = ${CATALOG_SITE}`;
    await admin`delete from app.properties where workspace_id = ${CATALOG_SITE}`;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position, sensitive, hidden, staff_only)
      values
        (${CATALOG_SITE}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1, false, false, false),
        (${CATALOG_SITE}, 'lead', 'custom_secret', 'custom', 'Secret', 'text', 2, true, false, false),
        (${CATALOG_SITE}, 'lead', 'custom_hidden', 'custom', 'Hidden', 'text', 3, false, true, false),
        (${CATALOG_SITE}, 'lead', 'custom_internal', 'custom', 'Internal', 'text', 4, false, false, true)
    `;
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by)
      values (${CATALOG_SITE}, 'tpl_catalogtemplate1', 'Size note', 'About {prop:custom_size}', 'Hi {first name}', 1, ${ACTOR})
    `;
    // More archived templates than any response carries: none is listed.
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by, archived_at)
      select ${CATALOG_SITE}, 'tpl_archived' || lpad(n::text, 8, '0'), 'Old ' || n, 'Old', 'Old', 1, ${ACTOR}, now()
      from generate_series(1, 210) n
    `;
    await admin`
      insert into app.plans (workspace_id, lead_type, name, active, position)
      values (${CATALOG_SITE}, 'sim_order', 'Student', true, 0), (${CATALOG_SITE}, 'sim_order', 'Old', false, 1)
    `;
    const catalog = await store.catalog(write(CATALOG_SITE));
    expect(() => flowCatalogResponseSchema.parse({ ...catalog, requestId: REQUEST })).not.toThrow();
    const keys = catalog.properties.map((property) => property.key);
    expect(keys).toContain('custom_size');
    expect(keys).toContain('custom_internal');
    expect(keys).not.toContain('custom_secret');
    expect(keys).not.toContain('custom_hidden');
    expect(catalog.properties.find((property) => property.key === 'custom_size')).toMatchObject({
      condition: true,
      update: true,
      taskVariable: true,
      emailVariable: true,
    });
    expect(catalog.properties.find((property) => property.key === 'custom_internal')).toMatchObject(
      {
        emailVariable: false,
      },
    );
    const templates = catalog.templates.map((template) => template.key);
    expect(templates).not.toContain('tracking_code');
    expect(templates).toHaveLength(9);
    expect(catalog.templates.at(-1)).toMatchObject({
      key: 'tpl_catalogtemplate1',
      name: 'Size note',
      builtIn: false,
      archived: false,
    });
    expect(catalog.templates.at(-1)?.fillIns).toContain('prop:custom_size');
    expect(catalog.templates.at(-1)?.fillIns).not.toContain('code');
    expect(catalog.plans.map((plan) => [plan.name, plan.active])).toEqual([
      ['Student', true],
      ['Old', false],
    ]);
    expect(catalog.members.map((member) => member.actorId).sort()).toEqual([ACTOR, MEMBER].sort());
    expect(
      catalog.leadTypes.find((type) => type.key === 'sim_order')?.stages.map((stage) => stage.key),
    ).toContain('verified');
    expect(catalog.taskVariables).toContain('order number');
  });
});
