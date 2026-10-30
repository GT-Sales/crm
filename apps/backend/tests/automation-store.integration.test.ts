import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILT_IN_AUTOMATION_KEYS } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  DatabaseAutomationStore,
  enabledAutomationKeys,
  type RecordAutomationRunInput,
} from '../src/automations/store.js';

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

// Distinct id range for the automation store tests.
const SITE = '1d000000-0000-4000-8000-000000000501';
const OTHER_SITE = '1d000000-0000-4000-8000-000000000502';
const ACTOR = '2d000000-0000-4000-8000-000000000501';
const REQUEST = '3d000000-0000-4000-8000-000000000501';
const LEAD = '9d000000-0000-4000-8000-000000000501';
const OTHER_LEAD = '9d000000-0000-4000-8000-000000000502';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const scope = { workspaceId: SITE, actorId: ACTOR };
const write = { ...scope, requestId: REQUEST };
const otherScope = { workspaceId: OTHER_SITE, actorId: ACTOR };
const otherWrite = { ...otherScope, requestId: REQUEST };

databaseTest('automation store', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseAutomationStore;

  const reset = async () => {
    await admin`delete from app.automation_runs where workspace_id in (${SITE}, ${OTHER_SITE})`;
    await admin`delete from app.automations where workspace_id in (${SITE}, ${OTHER_SITE})`;
    await admin`delete from app.audit_events where workspace_id in (${SITE}, ${OTHER_SITE})`;
  };

  const record = (
    workspaceId: string,
    input: Partial<RecordAutomationRunInput> & Pick<RecordAutomationRunInput, 'key' | 'leadId'>,
  ) =>
    database.withTenantTx({ workspaceId, actorId: ACTOR }, (tx) =>
      store.recordRun(tx, {
        workspaceId,
        outcome: 'queued',
        // A queued run names the job it queued (a database check).
        jobId: input.outcome === 'skipped' ? undefined : crypto.randomUUID(),
        ...input,
      }),
    );

  const toggleAudits = async (workspaceId: string) =>
    admin<{ action: string; entity: string; before: unknown; after: unknown }[]>`
      select action, entity, before, after from app.audit_events
      where workspace_id = ${workspaceId} and action = 'automation.toggled'
      order by created_at
    `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its leads, automations and runs.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'automation-501', 'Automation Site'),
        (${OTHER_SITE}, 'automation-502', 'Automation Other')
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version, attribution, payload, full_name)
      values
        (${LEAD}, ${SITE}, 'sim_order', 'submitted', 'pending', 'ci', '{}'::jsonb,
         ${admin.json({ schemaVersion: 1, payload: {} })}, 'Named Customer'),
        (${OTHER_LEAD}, ${OTHER_SITE}, 'sim_order', 'submitted', 'pending', 'ci', '{}'::jsonb,
         ${admin.json({ schemaVersion: 1, payload: {} })}, 'Other Customer')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabaseAutomationStore(database);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('lists the six built-ins off and never run for a site with no rows', async () => {
    await reset();
    const list = await store.list(scope);
    expect(list.map((entry) => entry.key)).toEqual([...BUILT_IN_AUTOMATION_KEYS]);
    expect(list).toHaveLength(6);
    for (const entry of list) {
      expect(entry).toEqual({ key: entry.key, enabled: false, lastRunAt: null, runCount: 0 });
    }
  });

  it('switches a rule on with one audit event, and again with none', async () => {
    await reset();
    const first = await store.setEnabled(write, 'sim_order_dispatched', true);
    expect(first).toEqual({
      key: 'sim_order_dispatched',
      enabled: true,
      lastRunAt: null,
      runCount: 0,
    });
    expect(await toggleAudits(SITE)).toEqual([
      {
        action: 'automation.toggled',
        entity: 'automation',
        before: { key: 'sim_order_dispatched', enabled: false },
        after: { key: 'sim_order_dispatched', enabled: true },
      },
    ]);

    const again = await store.setEnabled(write, 'sim_order_dispatched', true);
    expect(again.enabled).toBe(true);
    expect(await toggleAudits(SITE)).toHaveLength(1);

    const list = await store.list(scope);
    expect(list.find((entry) => entry.key === 'sim_order_dispatched')?.enabled).toBe(true);
    expect(list.filter((entry) => entry.enabled)).toHaveLength(1);

    const off = await store.setEnabled(write, 'sim_order_dispatched', false);
    expect(off.enabled).toBe(false);
    const audits = await toggleAudits(SITE);
    expect(audits).toHaveLength(2);
    expect(audits[1]?.after).toEqual({ key: 'sim_order_dispatched', enabled: false });
    const [rows] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.automations where workspace_id = ${SITE}
    `;
    expect(rows?.total).toBe(1);
  });

  it('switching an untouched rule off writes a row but no audit event', async () => {
    await reset();
    const off = await store.setEnabled(write, 'order_received', false);
    expect(off.enabled).toBe(false);
    expect(await toggleAudits(SITE)).toHaveLength(0);
  });

  it('reports only the enabled keys among those asked', async () => {
    await reset();
    await store.setEnabled(write, 'order_received', true);
    await store.setEnabled(write, 'sim_order_cancelled', true);
    await store.setEnabled(write, 'sim_order_activated', false);
    const enabled = await database.withTenantTx(scope, (tx) =>
      enabledAutomationKeys(tx, SITE, [
        'order_received',
        'sim_order_activated',
        'sim_order_dispatched',
      ]),
    );
    expect([...enabled]).toEqual(['order_received']);
    const none = await database.withTenantTx(scope, (tx) => enabledAutomationKeys(tx, SITE, []));
    expect(none.size).toBe(0);
  });

  it('counts a queued run and leaves a skipped run uncounted', async () => {
    await reset();
    await store.setEnabled(write, 'sim_order_dispatched', true);

    await record(SITE, { key: 'sim_order_dispatched', leadId: LEAD });
    let entry = (await store.list(scope)).find((item) => item.key === 'sim_order_dispatched');
    expect(entry?.runCount).toBe(1);
    expect(entry?.lastRunAt).toBeInstanceOf(Date);
    const queuedAt = entry?.lastRunAt;

    await record(SITE, {
      key: 'sim_order_dispatched',
      leadId: LEAD,
      outcome: 'skipped',
      reason: 'no_customer_email',
    });
    entry = (await store.list(scope)).find((item) => item.key === 'sim_order_dispatched');
    expect(entry?.runCount).toBe(1);
    expect(entry?.lastRunAt).toEqual(queuedAt);

    const runs = await store.listRuns(scope, 'sim_order_dispatched', { includeLeadNames: false });
    expect(runs.map((run) => [run.outcome, run.reason])).toEqual([
      ['skipped', 'no_customer_email'],
      ['queued', null],
    ]);
  });

  it('lists runs newest first, capped at 50, with lead names only when asked', async () => {
    await reset();
    await store.setEnabled(write, 'order_received', true);
    await admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason, created_at)
      select ${SITE}, 'order_received', ${LEAD}, 'skipped', 'no_sender',
             now() - make_interval(mins => n)
      from generate_series(1, 55) as n
    `;
    // A run of another rule is not listed under this one.
    await admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason)
      values (${SITE}, 'sim_order_cancelled', ${LEAD}, 'skipped', 'no_sender')
    `;

    const runs = await store.listRuns(scope, 'order_received', { includeLeadNames: false });
    expect(runs).toHaveLength(50);
    const times = runs.map((run) => run.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(runs.every((run) => run.leadName === null && run.leadId === LEAD)).toBe(true);

    const few = await store.listRuns(scope, 'order_received', {
      limit: 3,
      includeLeadNames: true,
    });
    expect(few).toHaveLength(3);
    expect(few.every((run) => run.leadName === 'Named Customer')).toBe(true);
    expect(few[0]).toEqual(
      expect.objectContaining({ outcome: 'skipped', reason: 'no_sender', id: expect.any(String) }),
    );

    const capped = await store.listRuns(scope, 'order_received', {
      limit: 500,
      includeLeadNames: false,
    });
    expect(capped).toHaveLength(50);
  });

  it('keeps two sites independent', async () => {
    await reset();
    await store.setEnabled(write, 'order_received', true);
    await store.setEnabled(otherWrite, 'sim_order_cancelled', true);
    await record(SITE, { key: 'order_received', leadId: LEAD });

    const mine = await store.list(scope);
    const theirs = await store.list(otherScope);
    expect(mine.filter((entry) => entry.enabled).map((entry) => entry.key)).toEqual([
      'order_received',
    ]);
    expect(theirs.filter((entry) => entry.enabled).map((entry) => entry.key)).toEqual([
      'sim_order_cancelled',
    ]);
    expect(mine.find((entry) => entry.key === 'order_received')?.runCount).toBe(1);
    expect(theirs.every((entry) => entry.runCount === 0)).toBe(true);

    expect(await store.listRuns(otherScope, 'order_received', { includeLeadNames: true })).toEqual(
      [],
    );
    const enabledElsewhere = await database.withTenantTx(otherScope, (tx) =>
      enabledAutomationKeys(tx, OTHER_SITE, ['order_received']),
    );
    expect(enabledElsewhere.size).toBe(0);
  });
});
