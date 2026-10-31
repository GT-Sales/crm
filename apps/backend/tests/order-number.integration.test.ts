import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { idempotencyKeyHash, requestFingerprint } from '../src/leads/idempotency.js';
import {
  DatabaseLeadStore,
  ExternalRefTakenError,
  OrderIntakeError,
  type CreateLeadInput,
} from '../src/leads/store.js';

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

// Distinct id range for the order number tests.
const SITE = '00000000-0000-4000-8000-000000005401';
const OTHER_SITE = '00000000-0000-4000-8000-000000005402';
const ACTOR = '00000000-0000-4000-8000-000000005411';
const REQUEST = '00000000-0000-4000-8000-000000005421';
const MISSING_PLAN = '00000000-0000-4000-8000-000000005431';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ctx = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };
const draft = (overrides: Partial<CreateLeadInput> = {}): CreateLeadInput => ({
  ...ctx,
  leadType: 'sim_order',
  consentVersion: 'getcanadasim-order-2026-10',
  contact: { fullName: 'Nadia Khan' },
  ...overrides,
});

databaseTest('order numbers from the site counter', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseLeadStore;

  const counter = async (workspaceId = SITE): Promise<number | undefined> => {
    const [row] = await admin<{ lastValue: number }[]>`
      select last_value as "lastValue" from app.site_counters
      where workspace_id = ${workspaceId} and counter = 'sim_order_ref'
    `;
    return row?.lastValue;
  };

  const storedRef = async (leadId: string): Promise<string | null | undefined> => {
    const [row] = await admin<{ externalRef: string | null }[]>`
      select external_ref as "externalRef" from app.leads where id = ${leadId}
    `;
    return row?.externalRef;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its leads, keys and counters.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'order-number-541', 'Order Number Site'),
        (${OTHER_SITE}, 'order-number-542', 'Order Number Other')
    `;
    // What the Get Canada Sim import left: two orders and a partner's own reference.
    await admin`
      insert into app.leads (workspace_id, lead_type, status, stage, consent_version, external_ref)
      values
        (${SITE}, 'sim_order', 'submitted', 'completed', 'legacy', 'MS-140'),
        (${SITE}, 'sim_order', 'submitted', 'pending', 'legacy', 'MS-143'),
        (${SITE}, 'partner_application', 'submitted', 'approved', 'legacy', 'PT-5')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 10,
    });
    store = new DatabaseLeadStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it("starts after the site's highest imported MS- number and counts on", async () => {
    expect(await counter()).toBeUndefined();
    const first = await store.createLead(draft());
    expect(first.lead.externalRef).toBe('MS-144');
    expect(await storedRef(first.lead.id)).toBe('MS-144');
    const second = await store.createLead(draft());
    expect(second.lead.externalRef).toBe('MS-145');
    expect(await counter()).toBe(145);
  });

  it('gives ten concurrent orders ten distinct numbers', async () => {
    const created = await Promise.all(Array.from({ length: 10 }, () => store.createLead(draft())));
    const refs = created.map((result) => result.lead.externalRef).sort();
    expect(refs).toEqual(Array.from({ length: 10 }, (_, index) => `MS-${146 + index}`).sort());
    expect(await counter()).toBe(155);
  });

  it('numbers only SIM orders, and each site from its own counter', async () => {
    const internet = await store.createLead(draft({ leadType: 'internet' }));
    expect(internet.lead.externalRef).toBeNull();
    expect(await storedRef(internet.lead.id)).toBeNull();
    const message = await store.createLead(draft({ leadType: 'contact_message' }));
    expect(message.lead.externalRef).toBeNull();

    const elsewhere = await store.createLead(draft({ workspaceId: OTHER_SITE }));
    expect(elsewhere.lead.externalRef).toBe('MS-1');
    expect(await counter(OTHER_SITE)).toBe(1);
    expect(await counter()).toBe(155);
  });

  it('a replayed keyed create returns the same number and takes none', async () => {
    const idempotency = {
      keyHash: idempotencyKeyHash('order-number-replay'),
      fingerprint: requestFingerprint({ marker: 'order-number-replay' }),
    };
    const first = await store.createLead(draft({ idempotency }));
    expect(first.lead.externalRef).toBe('MS-156');
    const again = await store.createLead(draft({ idempotency }));
    expect(again).toMatchObject({ replayed: true, lead: { id: first.lead.id } });
    expect(again.lead.externalRef).toBe('MS-156');
    expect(await counter()).toBe(156);
  });

  it('a refused create takes no number', async () => {
    await expect(
      store.createLead(draft({ order: { planId: MISSING_PLAN, quantity: 1 } })),
    ).rejects.toBeInstanceOf(OrderIntakeError);
    expect(await counter()).toBe(156);
    expect((await store.createLead(draft())).lead.externalRef).toBe('MS-157');
  });

  it('continues from wherever the counter was set, and a save returns the number', async () => {
    await admin`
      update app.site_counters set last_value = 200
      where workspace_id = ${SITE} and counter = 'sim_order_ref'
    `;
    const created = await store.createLead(draft());
    expect(created.lead.externalRef).toBe('MS-201');
    if (!created.grant) throw new Error('expected a draft grant');

    const saved = await store.updateLead({
      ...ctx,
      leadId: created.lead.id,
      grantToken: created.grant.token,
      contact: { email: 'nadia@example.test' },
    });
    expect(saved).toMatchObject({ status: 'updated', lead: { externalRef: 'MS-201' } });
    expect(await counter()).toBe(201);
  });
  it("keeps a website's own reference and takes no number for it, then numbers past it", async () => {
    const own = await store.createLead(draft({ externalRef: 'MS-9000' }));
    expect(own.lead.externalRef).toBe('MS-9000');
    expect(await counter()).toBe(201);
    // The next number never reuses one a lead already holds.
    const next = await store.createLead(draft());
    expect(next.lead.externalRef).toBe('MS-9001');
  });

  it('a counter set below numbers leads already hold jumps past them', async () => {
    await admin`
      update app.site_counters set last_value = 150
      where workspace_id = ${SITE} and counter = 'sim_order_ref'
    `;
    const created = await store.createLead(draft());
    expect(created.lead.externalRef).toBe('MS-9002');
    expect(await counter()).toBe(9002);
    // A counter set above them (the switch-day seed's gap) is kept.
    await admin`
      update app.site_counters set last_value = 9100
      where workspace_id = ${SITE} and counter = 'sim_order_ref'
    `;
    expect((await store.createLead(draft())).lead.externalRef).toBe('MS-9101');
  });

  it('a number taken by a concurrent import answers external_ref_taken and logs ids only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // An import inserts MS-9102 and has not committed when the create takes the number.
      const importing = admin.reserve();
      const conn = await importing;
      await conn`begin`;
      await conn`
        insert into app.leads (workspace_id, lead_type, status, stage, consent_version, external_ref)
        values (${SITE}, 'sim_order', 'submitted', 'pending', 'legacy', 'MS-9102')
      `;
      const creating = store.createLead(draft({ contact: { fullName: 'Omar Example' } }));
      // Handled from the start: the refusal can arrive while the commit is still answering.
      const refused = expect(creating).rejects.toBeInstanceOf(ExternalRefTakenError);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await conn`commit`;
      conn.release();
      await refused;
      // The number went back with the rollback; the next create is past the import.
      expect(await counter()).toBe(9101);
      expect((await store.createLead(draft())).lead.externalRef).toBe('MS-9103');
      const logged = warn.mock.calls.map((call) => String(call[0]));
      expect(logged).toEqual([
        JSON.stringify({ event: 'site_counter_collision', workspaceId: SITE, requestId: REQUEST }),
      ]);
      expect(logged.join('')).not.toContain('Omar');
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a website's own reference another order holds, without a collision log", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(store.createLead(draft({ externalRef: 'MS-9000' }))).rejects.toBeInstanceOf(
        ExternalRefTakenError,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
