import { readFileSync } from 'node:fs';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, migrationsFolder } from '../src/migrations.js';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '../src/test-helpers.js';

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

const WORKSPACE_1 = '14000000-0000-4000-8000-000000000b01';
const WORKSPACE_2 = '14000000-0000-4000-8000-000000000b02';
/** Used only when the database has no `getcanadasim` site yet (inside a rolled-back transaction). */
const GETCANADASIM_CANDIDATE = '14000000-0000-4000-8000-000000000b03';
const OTHER_SITE = '14000000-0000-4000-8000-000000000b04';
const ACTOR_A = '15000000-0000-4000-8000-000000000b01';
const LEGACY_IMPORT_ACTOR_ID = '00000000-0000-4000-8000-00000000a001';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const INSUFFICIENT_PRIVILEGE = '42501';

/** The hand-written 0012 migration, statement by statement, as the migrator runs it. */
function runtimeMigrationStatements(): string[] {
  const text = readFileSync(`${migrationsFolder}/0012_plans_runtime.sql`, 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Thrown to roll a transaction back once its assertions have passed. */
class RolledBack extends Error {}

databaseTest('plans, leads.order_details, properties.website_visible and migration 0012', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;

  function asRuntime<T>(
    workspaceId: string,
    actorId: string,
    body: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return runtimeSql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${workspaceId}, true),
               set_config('app.actor_id', ${actorId}, true)
      `;
      return body(tx);
    });
  }

  /**
   * Runs `body` as the migration role and rolls everything back afterwards,
   * so re-running 0012 here (it touches every site's leads) leaves the shared
   * database exactly as it was.
   */
  async function inRolledBackTransaction(
    body: (tx: postgres.TransactionSql) => Promise<void>,
  ): Promise<void> {
    const outcome: unknown = await admin
      .begin(async (tx) => {
        await body(tx);
        throw new RolledBack();
      })
      .catch((error: unknown) => error);
    if (!(outcome instanceof RolledBack)) throw outcome;
  }

  async function runMigration0012(tx: postgres.TransactionSql): Promise<void> {
    for (const statement of runtimeMigrationStatements()) await tx.unsafe(statement);
  }

  async function cleanUp(): Promise<void> {
    await admin`delete from app.workspaces where id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);
    await cleanUp();

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_1}, 'ci-plans-1', 'CI Plans 1'),
        (${WORKSPACE_2}, 'ci-plans-2', 'CI Plans 2')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values
        (${WORKSPACE_1}, ${ACTOR_A}, 'staff', 'active'),
        (${WORKSPACE_2}, ${ACTOR_A}, 'staff', 'active')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
  });

  afterAll(async () => {
    await runtimeSql?.end();
    if (admin) {
      await cleanUp();
      await admin.end();
    }
  });

  it('plans has RLS enabled and forced, its two policies, and no DELETE grant', async () => {
    const [table] = await admin<{ rowSecurity: boolean; forced: boolean; policies: string[] }[]>`
      select c.relrowsecurity as "rowSecurity",
             c.relforcerowsecurity as forced,
             array(
               select p.policyname::text from pg_policies p
               where p.schemaname = 'app' and p.tablename = 'plans'
               order by p.policyname
             ) as policies
      from pg_class c
      where c.relnamespace = 'app'::regnamespace and c.relname = 'plans'
    `;
    expect(table).toEqual({
      rowSecurity: true,
      forced: true,
      policies: ['plans_backup_reader_read', 'plans_tenant_policy'],
    });

    const [privileges] = await admin<
      { select: boolean; insert: boolean; update: boolean; delete: boolean; backup: boolean }[]
    >`
      select
        has_table_privilege('app_runtime', 'app.plans', 'SELECT') as select,
        has_table_privilege('app_runtime', 'app.plans', 'INSERT') as insert,
        has_table_privilege('app_runtime', 'app.plans', 'UPDATE') as update,
        has_table_privilege('app_runtime', 'app.plans', 'DELETE') as delete,
        has_table_privilege('backup_reader', 'app.plans', 'SELECT') as backup
    `;
    expect(privileges).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
      backup: true,
    });

    const [plan] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.plans (workspace_id, lead_type, name, created_by)
        values (${WORKSPACE_1}, 'sim_order', 'Kept forever', ${ACTOR_A})
        returning id
      `;
    });
    if (!plan) throw new Error('the plan was not inserted');
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => tx`delete from app.plans where id = ${plan.id}`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('a plan is visible and writable only inside its own site', async () => {
    const [plan] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.plans (workspace_id, lead_type, name)
        values (${WORKSPACE_1}, 'internet', 'Site one only')
        returning id
      `;
    });
    if (!plan) throw new Error('the plan was not inserted');

    const own = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`select id from app.plans where id = ${plan.id}`;
    });
    expect(own).toHaveLength(1);
    const other = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx`select id from app.plans where id = ${plan.id}`;
    });
    expect(other).toHaveLength(0);
    const changed = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx`update app.plans set name = 'Taken' where id = ${plan.id}`;
    });
    expect(changed.count).toBe(0);
    await expect(
      asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
        return tx`
          insert into app.plans (workspace_id, lead_type, name)
          values (${WORKSPACE_1}, 'internet', 'Planted from site two')
        `;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('a name is unique per site and lead type, ignoring case', async () => {
    await admin`
      insert into app.plans (workspace_id, lead_type, name)
      values (${WORKSPACE_1}, 'mobility', 'Starter')
    `;
    await expect(
      admin`
        insert into app.plans (workspace_id, lead_type, name)
        values (${WORKSPACE_1}, 'mobility', 'STARTER')
      `,
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // Another type of the same site, and the same type of another site, may use it.
    await admin`
      insert into app.plans (workspace_id, lead_type, name)
      values (${WORKSPACE_1}, 'sim_order', 'starter'), (${WORKSPACE_2}, 'mobility', 'Starter')
    `;
  });

  it('a plan takes its defaults and refuses a bad price, currency, period, name, type or values', async () => {
    const [plan] = await admin<
      {
        price_minor: number;
        currency: string;
        billing_period: string;
        payment_required: boolean;
        active: boolean;
        required_documents: string[];
        custom_values: unknown;
        position: number;
        version: number;
      }[]
    >`
      insert into app.plans (workspace_id, lead_type, name)
      values (${WORKSPACE_2}, 'sim_order', 'Defaults')
      returning price_minor::int, currency, billing_period, payment_required, active,
                required_documents, custom_values, position, version
    `;
    expect(plan).toEqual({
      price_minor: 0,
      currency: 'CAD',
      billing_period: 'month',
      payment_required: false,
      active: true,
      required_documents: [],
      custom_values: {},
      position: 0,
      version: 1,
    });

    // Every billing period of the contracts' list is accepted.
    for (const [index, period] of ['one_time', 'month', '30_days', '90_days', 'year'].entries()) {
      await admin`
        insert into app.plans (workspace_id, lead_type, name, billing_period, price_minor)
        values (${WORKSPACE_2}, 'internet', ${`Period ${index}`}, ${period}, 999999999999)
      `;
    }

    const refused = [
      admin`insert into app.plans (workspace_id, lead_type, name, price_minor)
            values (${WORKSPACE_2}, 'sim_order', 'Negative', -1)`,
      admin`insert into app.plans (workspace_id, lead_type, name, currency)
            values (${WORKSPACE_2}, 'sim_order', 'Dollars', 'USD')`,
      admin`insert into app.plans (workspace_id, lead_type, name, billing_period)
            values (${WORKSPACE_2}, 'sim_order', 'Weekly', 'week')`,
      admin`insert into app.plans (workspace_id, lead_type, name)
            values (${WORKSPACE_2}, 'sim_order', '   ')`,
      admin`insert into app.plans (workspace_id, lead_type, name)
            values (${WORKSPACE_2}, 'sim_order', ${'x'.repeat(121)})`,
      admin`insert into app.plans (workspace_id, lead_type, name)
            values (${WORKSPACE_2}, 'Sim Order', 'Bad type')`,
      admin`insert into app.plans (workspace_id, lead_type, name, custom_values)
            values (${WORKSPACE_2}, 'sim_order', 'Array values', '[]'::jsonb)`,
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it('leads.order_details defaults to {} and must be an object; website_visible defaults to false', async () => {
    const [lead] = await admin<{ id: string; order_details: unknown }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, consent_version)
      values (${WORKSPACE_1}, 'sim_order', 'submitted', 'pending', 'ci')
      returning id, order_details
    `;
    if (!lead) throw new Error('the lead was not inserted');
    expect(lead.order_details).toEqual({});
    await expect(
      admin`update app.leads set order_details = '[]'::jsonb where id = ${lead.id}`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      admin`update app.leads set order_details = '"paid"'::jsonb where id = ${lead.id}`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      admin`update app.leads set order_details = null where id = ${lead.id}`,
    ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });

    const [property] = await admin<{ website_visible: boolean }[]>`
      insert into app.properties (workspace_id, object, key, origin, label, kind)
      values (${WORKSPACE_1}, 'plan', 'custom_speed', 'custom', 'Speed', 'text')
      returning website_visible
    `;
    expect(property).toEqual({ website_visible: false });
  });

  it('0012 seeds the six SIM plans for getcanadasim only, once', async () => {
    await inRolledBackTransaction(async (tx) => {
      await tx`
        insert into app.workspaces (id, slug, name)
        values (${GETCANADASIM_CANDIDATE}, 'getcanadasim', 'Get Canada Sim')
        on conflict do nothing
      `;
      const [site] = await tx<{ id: string }[]>`
        select id from app.workspaces where slug = 'getcanadasim'
      `;
      if (!site) throw new Error('expected the getcanadasim workspace');
      // A reused database may already hold them (the migrator ran 0012 after the seed).
      await tx`delete from app.plans where workspace_id = ${site.id}`;
      await tx`
        insert into app.workspaces (id, slug, name)
        values (${OTHER_SITE}, 'ci-plans-not-gcs', 'Not Get Canada Sim')
      `;

      await runMigration0012(tx);
      const seeded = () => tx<
        {
          lead_type: string;
          name: string;
          price_minor: number;
          currency: string;
          billing_period: string;
          payment_required: boolean;
          active: boolean;
          position: number;
        }[]
      >`
        select lead_type, name, price_minor::int, currency, billing_period, payment_required,
               active, position
        from app.plans where workspace_id = ${site.id}
        order by position
      `;
      const expected = [
        ['Unlimited Data · $50, Rogers', 5000],
        ['Unlimited Data · $40, Rogers', 4000],
        ['75GB · $35, Fido', 3500],
        ['90GB · $40, Chatr', 4000],
        ['50GB · $35, Chatr', 3500],
        ['75GB · $75, Chatr', 7500],
      ].map(([name, price], position) => ({
        lead_type: 'sim_order',
        name,
        price_minor: price,
        currency: 'CAD',
        billing_period: 'month',
        payment_required: true,
        active: true,
        position,
      }));
      expect(await seeded()).toEqual(expected);

      // A site with another slug gets none.
      const others = await tx`select id from app.plans where workspace_id = ${OTHER_SITE}`;
      expect(others).toHaveLength(0);

      // A second run, and an owner's renamed-in-case plan, add nothing.
      await tx`
        update app.plans set name = 'unlimited data · $50, rogers'
        where workspace_id = ${site.id} and position = 0
      `;
      await runMigration0012(tx);
      expect(await seeded()).toHaveLength(6);
    });
  });

  it('0012 maps every sim_order lead to its stage, payment status and carrier commission', async () => {
    type Fixture = {
      stage: string;
      status?: string;
      commission?: string;
      deleted?: boolean;
      restricted?: boolean;
      expected: { stage: string; paymentStatus: string; carrierCommission: string };
      activity?: string;
    };
    const PAID_BODY = 'Stage Paid became Pending; payment status set to Paid (phase 3 migration)';
    const INVOICED_BODY =
      'Stage Invoiced became Completed; carrier commission set to Invoiced (phase 3 migration)';
    const fixtures: Fixture[] = [
      {
        stage: 'incomplete',
        status: 'incomplete',
        expected: { stage: 'incomplete', paymentStatus: 'pending', carrierCommission: 'not_yet' },
      },
      {
        stage: 'pending',
        expected: { stage: 'pending', paymentStatus: 'pending', carrierCommission: 'not_yet' },
      },
      {
        stage: 'verified',
        expected: { stage: 'verified', paymentStatus: 'paid', carrierCommission: 'not_yet' },
      },
      {
        stage: 'on_hold',
        expected: { stage: 'on_hold', paymentStatus: 'not_needed', carrierCommission: 'not_yet' },
      },
      {
        stage: 'delivered',
        expected: { stage: 'delivered', paymentStatus: 'paid', carrierCommission: 'not_yet' },
      },
      {
        stage: 'activated',
        commission: 'claw_back',
        expected: { stage: 'activated', paymentStatus: 'paid', carrierCommission: 'clawback' },
      },
      {
        stage: 'completed',
        commission: 'commission_received',
        expected: { stage: 'completed', paymentStatus: 'paid', carrierCommission: 'received' },
      },
      {
        stage: 'cancelled',
        commission: 'invoiced',
        expected: {
          stage: 'cancelled',
          paymentStatus: 'not_needed',
          carrierCommission: 'invoiced',
        },
      },
      {
        stage: 'paid',
        expected: { stage: 'pending', paymentStatus: 'paid', carrierCommission: 'not_yet' },
        activity: PAID_BODY,
      },
      {
        stage: 'invoiced',
        commission: 'claw_back',
        expected: { stage: 'completed', paymentStatus: 'paid', carrierCommission: 'invoiced' },
        activity: INVOICED_BODY,
      },
      {
        stage: 'paid',
        deleted: true,
        expected: { stage: 'pending', paymentStatus: 'paid', carrierCommission: 'not_yet' },
        activity: PAID_BODY,
      },
      {
        stage: 'paid',
        restricted: true,
        expected: { stage: 'pending', paymentStatus: 'paid', carrierCommission: 'not_yet' },
        activity: PAID_BODY,
      },
    ];

    await inRolledBackTransaction(async (tx) => {
      const ids: string[] = [];
      for (const fixture of fixtures) {
        const payload = fixture.restricted
          ? null
          : {
              schemaVersion: 1,
              payload: {
                planId: 'unlimited-data-rogers',
                ...(fixture.commission ? { commissionStatus: fixture.commission } : {}),
              },
            };
        const [row] = await tx<{ id: string }[]>`
          insert into app.leads (workspace_id, lead_type, status, stage, consent_version, payload,
            full_name, deleted_at, customer_data_restricted_at, updated_at)
          values (${WORKSPACE_1}, 'sim_order', ${fixture.status ?? 'submitted'}, ${fixture.stage},
            'ci', ${payload === null ? null : tx.json(payload)},
            ${fixture.restricted ? null : 'Fixture Person'},
            ${fixture.deleted ? new Date('2026-09-01T00:00:00Z') : null},
            ${fixture.restricted ? new Date('2026-09-02T00:00:00Z') : null},
            '2026-08-01T00:00:00Z')
          returning id
        `;
        if (!row) throw new Error('the lead was not inserted');
        ids.push(row.id);
      }
      const [internet] = await tx<{ id: string }[]>`
        insert into app.leads (workspace_id, lead_type, status, stage, consent_version, payload)
        values (${WORKSPACE_1}, 'internet', 'submitted', 'new', 'ci',
          ${tx.json({ schemaVersion: 1, payload: { commissionStatus: 'invoiced' } })})
        returning id
      `;
      if (!internet) throw new Error('the internet lead was not inserted');

      await runMigration0012(tx);

      const rows = await tx<
        { id: string; stage: string; order_details: Record<string, unknown>; updated_at: Date }[]
      >`
        select id, stage, order_details, updated_at from app.leads
        where id in ${tx(ids)}
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      fixtures.forEach((fixture, index) => {
        const row = byId.get(ids[index] ?? '');
        expect(row?.stage, `${fixture.stage} (${String(index)})`).toBe(fixture.expected.stage);
        expect(row?.order_details, `${fixture.stage} (${String(index)})`).toEqual({
          planId: null,
          plan: null,
          quantity: 1,
          paymentStatus: fixture.expected.paymentStatus,
          carrierCommission: fixture.expected.carrierCommission,
        });
        // A data migration is not someone working the lead: its recency is kept.
        expect(row?.updated_at.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      });

      const activities = await tx<
        { lead_id: string; actor_id: string; kind: string; body: string; data: unknown }[]
      >`
        select lead_id, actor_id, kind, body, data from app.lead_activities
        where lead_id in ${tx([internet.id, ...ids])}
      `;
      const expectedActivities = fixtures.flatMap((fixture, index) =>
        fixture.activity
          ? [
              {
                lead_id: ids[index],
                actor_id: LEGACY_IMPORT_ACTOR_ID,
                kind: 'system',
                body: fixture.activity,
                data: { migration: '0012' },
              },
            ]
          : [],
      );
      expect(activities).toHaveLength(4);
      expect(activities).toEqual(expect.arrayContaining(expectedActivities));

      const [other] = await tx<{ stage: string; order_details: unknown }[]>`
        select stage, order_details from app.leads where id = ${internet.id}
      `;
      expect(other).toEqual({ stage: 'new', order_details: {} });

      // A second run finds every sim_order lead already mapped: nothing changes.
      const before = await tx`
        select id, stage, order_details from app.leads where id in ${tx(ids)} order by id
      `;
      await runMigration0012(tx);
      const after = await tx`
        select id, stage, order_details from app.leads where id in ${tx(ids)} order by id
      `;
      expect(after).toEqual(before);
      const activitiesAfter = await tx`
        select id from app.lead_activities where lead_id in ${tx(ids)}
      `;
      expect(activitiesAfter).toHaveLength(4);
    });
  });
});
