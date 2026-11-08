import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseAnalyticsStore, comparisonRange } from '../src/analytics/store.js';

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

// A distinct id range from every other integration test file sharing this database.
const SITE = '16000000-0000-4000-8000-000000000b01';
const OTHER_SITE = '16000000-0000-4000-8000-000000000b02';
const ACTOR = '26000000-0000-4000-8000-000000000b01';
const TEAMMATE = '26000000-0000-4000-8000-000000000b02';
const PLAN_PERCENT = '76000000-0000-4000-8000-000000000b01';
const PLAN_FIXED = '76000000-0000-4000-8000-000000000b02';
const PLAN_NONE = '76000000-0000-4000-8000-000000000b03';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
/** The ten days ending today; the previous range is the ten before. */
const FROM = day(-9);
const TO = day(0);

databaseTest('the analytics dashboard (analytics store)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseAnalyticsStore;

  const snapshot = (planId: string, commission?: unknown) => ({
    planId,
    name: 'Unlimited 50',
    priceMinor: 5000,
    currency: 'CAD',
    billingPeriod: 'month',
    paymentRequired: true,
    requiredDocuments: [],
    properties: {},
    ...(commission === undefined ? {} : { commission }),
    frozenAt: '2026-10-01T00:00:00.000Z',
  });

  /** A lead `daysAgo` days old (noon UTC); returns its id. */
  const lead = async (options: {
    daysAgo: number;
    leadType?: string;
    stage?: string;
    order?: unknown;
    form?: Record<string, unknown>;
    custom?: Record<string, unknown>;
    attribution?: Record<string, unknown>;
    assignee?: string;
    trashed?: boolean;
    workspaceId?: string;
  }): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (
        workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        custom_values, order_details, assigned_actor_id, deleted_at, created_at, updated_at
      ) values (
        ${options.workspaceId ?? SITE}, ${options.leadType ?? 'sim_order'}, 'submitted',
        ${options.stage ?? 'pending'}, 'ci', ${JSON.stringify(options.attribution ?? {})}::text::jsonb,
        ${JSON.stringify({ schemaVersion: 1, payload: options.form ?? {} })}::text::jsonb,
        ${JSON.stringify(options.custom ?? {})}::text::jsonb,
        ${JSON.stringify(options.order ?? {})}::text::jsonb,
        ${options.assignee ?? null}, ${options.trashed ? new Date() : null},
        date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
          - make_interval(days => ${options.daysAgo}) + interval '12 hours',
        now()
      ) returning id
    `;
    if (!row) throw new Error('lead not inserted');
    return row.id;
  };

  const movedTo = async (leadId: string, to: string, daysAgo: number) => {
    await admin`
      insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, data, created_at)
      values (${SITE}, ${leadId}, ${ACTOR}, 'status_change', ${admin.json({ from: 'pending', to })},
        date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
          - make_interval(days => ${daysAgo}) + interval '13 hours')
    `;
  };

  const analytics = (overrides: Record<string, unknown> = {}) =>
    store.analytics({
      workspaceId: SITE,
      actorId: ACTOR,
      from: FROM,
      to: TO,
      compare: 'previous',
      group: 'day',
      today: TO,
      ...overrides,
    });

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting the sites removes every row of theirs, so a rerun starts clean.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    for (const [id, slug] of [
      [SITE, 'analytics-b01'],
      [OTHER_SITE, 'analytics-b02'],
    ] as const) {
      await admin`insert into app.workspaces (id, slug, name) values (${id}, ${slug}, ${slug})`;
    }
    await admin`
      insert into app.plans (
        id, workspace_id, lead_type, name, price_minor, billing_period, payment_required,
        custom_values, commission_type, commission_rate_bps, commission_minor
      ) values
        (${PLAN_PERCENT}, ${SITE}, 'sim_order', 'Unlimited 50', 5000, 'month', true,
          '{}'::jsonb, 'percent', 1000, null),
        (${PLAN_FIXED}, ${SITE}, 'internet', 'Fibre 500', 7000, 'month', false,
          ${admin.json({ custom_website_slug: 'fibre-500' })}, 'fixed', null, 2500),
        (${PLAN_NONE}, ${SITE}, 'sim_order', 'Tourist', 3000, 'one_time', true,
          '{}'::jsonb, 'none', null, null)
    `;

    // Current range.
    // L1: frozen with 10 %, two of them, paid, activated yesterday: 1000 earned.
    const l1 = await lead({
      daysAgo: 2,
      stage: 'completed',
      order: {
        planId: PLAN_PERCENT,
        plan: snapshot(PLAN_PERCENT, { type: 'percent', rateBps: 1000 }),
        quantity: 2,
        paymentStatus: 'paid',
        carrierCommission: 'received',
      },
      form: { delivery: 'esim' },
      attribution: { utmSource: 'google', partnerCode: 'PT-7' },
      assignee: TEAMMATE,
    });
    await movedTo(l1, 'activated', 1);
    await movedTo(l1, 'completed', 0);
    // L3: an internet lead matched by its website slug, won: fixed 2500.
    await lead({
      daysAgo: 3,
      leadType: 'internet',
      stage: 'won',
      form: { planId: 'fibre-500' },
      custom: { custom_payment_status: 'Paid', custom_commission: 'Received' },
      attribution: { utmSource: 'facebook' },
    });
    // L4: open, linked to the 10 % plan without a frozen copy: 500 expected.
    const l4 = await lead({
      daysAgo: 1,
      order: { planId: PLAN_PERCENT, quantity: 1, paymentStatus: 'pending' },
      form: { delivery: 'pickup' },
      attribution: { utmSource: 'google' },
      assignee: TEAMMATE,
    });
    // L5: cancelled: not new, lost.
    await lead({ daysAgo: 1, stage: 'cancelled', form: { delivery: 'esim' } });
    // L7: internet won, its slug matches no plan: won without a commission.
    await lead({ daysAgo: 4, leadType: 'internet', stage: 'won', form: { planId: 'gone-slug' } });

    // Previous range.
    // L2: created in the previous range, frozen before plans had commissions
    // (no `commission` on the copy): the plan's current 10 %, won 3 days ago.
    const l2 = await lead({
      daysAgo: 15,
      stage: 'activated',
      order: { planId: PLAN_PERCENT, plan: snapshot(PLAN_PERCENT), quantity: 1 },
      form: { delivery: 'esim' },
    });
    await movedTo(l2, 'activated', 3);
    // L6: won in the previous range, a plan with no commission (no activity: created date).
    await lead({
      daysAgo: 12,
      stage: 'completed',
      order: { planId: PLAN_NONE, plan: snapshot(PLAN_NONE, { type: 'none' }), quantity: 1 },
    });

    // Never counted: archived, another site.
    await lead({ daysAgo: 1, trashed: true, stage: 'completed' });
    await lead({ daysAgo: 1, workspaceId: OTHER_SITE });

    // Follow-ups: one overdue (TEAMMATE), one due today (nobody).
    await admin`
      insert into app.lead_tasks (workspace_id, lead_id, title, due_at, assigned_actor_id, created_by)
      values
        (${SITE}, ${l4}, 'Call back', now() - interval '2 days', ${TEAMMATE}, ${ACTOR}),
        (${SITE}, ${l4}, 'Check visa', ${`${TO}T12:00:00.000Z`}, null, ${ACTOR})
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    store = new DatabaseAnalyticsStore(database);
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await database?.close();
    await admin?.end();
  });

  test('counts new, won and paid against the previous range', async () => {
    const figures = await analytics();
    expect(figures.range).toEqual({ from: FROM, to: TO, days: 10 });
    expect(figures.comparison).toEqual({ from: day(-19), to: day(-10) });
    expect(figures.kpis.newLeads).toEqual({ current: 4, previous: 2 });
    // Won by won date: L1, L2 (created earlier, activated 3 days ago), L3, L7; before: L6.
    expect(figures.kpis.won).toEqual({ current: 4, previous: 1 });
    // L1's paid, and L3's custom `Paid` read case-insensitively.
    expect(figures.kpis.paid).toEqual({ current: 2, previous: 0 });
    expect(figures.kpis.followUps).toEqual({ due: 2, overdue: 1 });
    expect(figures.trend).toHaveLength(10);
    expect(figures.trend.reduce((sum, entry) => sum + entry.current, 0)).toBe(4);
    expect(figures.trend.reduce((sum, entry) => sum + (entry.previous ?? 0), 0)).toBe(2);
  });

  test('earns commission by percent of the frozen price and by fixed amount, by won date', async () => {
    const figures = await analytics();
    // L1: 5000 × 10 % × 2 = 1000; L2: the plan's current 10 % of 5000 = 500; L3: fixed 2500.
    expect(figures.commission).toMatchObject({
      earnedMinor: { current: 4000, previous: 0 },
      expectedMinor: 500,
      wonWithoutCommission: 1,
      anyPlanHasCommission: true,
      wonDateBasis: 'status_change_else_created',
    });
    expect(figures.commissionTrend?.reduce((sum, entry) => sum + entry.earnedMinor, 0)).toBe(4000);
    // L1's earning lands on the day it was first activated (yesterday), not its creation.
    expect(figures.commissionTrend?.find((entry) => entry.bucket === day(-1))?.earnedMinor).toBe(
      1000,
    );
  });

  test('resolves plans by frozen copy, link and website slug; unmatched slugs count apart', async () => {
    const figures = await analytics();
    expect(figures.mix.plans).toEqual(
      expect.arrayContaining([
        { planId: PLAN_PERCENT, name: 'Unlimited 50', total: 2 },
        { planId: PLAN_FIXED, name: 'Fibre 500', total: 1 },
        { planId: null, name: 'No plan matched', total: 1 },
      ]),
    );
    const fixed = await analytics({ planId: PLAN_FIXED });
    expect(fixed.kpis.newLeads.current).toBe(1);
    expect(fixed.commission?.earnedMinor.current).toBe(2500);
  });

  test('applies the type, source, partner, assignee, payment and delivery filters', async () => {
    const internet = await analytics({ leadType: 'internet' });
    expect(internet.kpis.newLeads.current).toBe(2);
    expect(internet.kpis.won.current).toBe(2);
    expect(internet.commission?.earnedMinor.current).toBe(2500);
    expect(internet.statuses.payment).toEqual(expect.arrayContaining([{ key: 'paid', total: 1 }]));
    expect(internet.statuses.commission).toEqual(
      expect.arrayContaining([{ key: 'received', total: 1 }]),
    );

    expect((await analytics({ source: 'google' })).kpis.newLeads.current).toBe(2);
    expect((await analytics({ partner: 'PT-7' })).kpis.newLeads.current).toBe(1);
    const mine = await analytics({ assignee: TEAMMATE });
    expect(mine.kpis.newLeads.current).toBe(2);
    expect(mine.kpis.followUps).toEqual({ due: 2, overdue: 1 });
    expect((await analytics({ assignee: 'none' })).kpis.newLeads.current).toBe(2);
    expect((await analytics({ paymentStatus: 'paid' })).kpis.newLeads.current).toBe(2);
    const pickup = await analytics({ leadType: 'sim_order', delivery: 'pickup' });
    expect(pickup.kpis.newLeads.current).toBe(1);

    const sim = await analytics({ leadType: 'sim_order' });
    expect(sim.mix.delivery).toEqual(
      expect.arrayContaining([
        { key: 'esim', total: 1 },
        { key: 'pickup', total: 1 },
      ]),
    );
    expect(sim.stages).toEqual(
      expect.arrayContaining([
        { leadType: 'sim_order', stage: 'cancelled', total: 1 },
        { leadType: 'sim_order', stage: 'completed', total: 1 },
        { leadType: 'sim_order', stage: 'pending', total: 1 },
      ]),
    );
    expect(sim.sources).toEqual([{ key: 'google', total: 2 }]);
    expect(sim.partners).toEqual([{ code: 'PT-7', name: null, total: 1 }]);
  });

  test('reports the team, the comparison modes and a type with no plan commission', async () => {
    const figures = await analytics();
    expect(figures.team).toEqual(
      expect.arrayContaining([
        { actorId: TEAMMATE, assigned: 2, won: 1, overdue: 1 },
        // L3, L5 (cancelled) and L7.
        { actorId: null, assigned: 3, won: 2, overdue: 0 },
      ]),
    );
    const none = await analytics({ compare: 'none' });
    expect(none.comparison).toBeNull();
    expect(none.kpis.newLeads.previous).toBeNull();
    expect(none.trend.every((entry) => entry.previous === null)).toBe(true);
    const lastYear = await analytics({ compare: 'last_year', group: 'month' });
    expect(lastYear.kpis.newLeads.previous).toBe(0);
    expect(lastYear.trend.length).toBeGreaterThanOrEqual(1);
    const mobility = await analytics({ leadType: 'mobility' });
    expect(mobility.commission?.anyPlanHasCommission).toBe(false);
    expect(mobility.kpis.newLeads.current).toBe(0);
  });

  test('works out the comparison ranges', () => {
    expect(comparisonRange('2026-11-01', '2026-11-07', 'previous')).toEqual({
      from: '2026-10-25',
      to: '2026-10-31',
    });
    expect(comparisonRange('2026-01-01', '2026-03-31', 'last_year')).toEqual({
      from: '2025-01-01',
      to: '2025-03-31',
    });
    expect(comparisonRange('2026-01-01', '2026-01-31', 'none')).toBeNull();
  });
});
