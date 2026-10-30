import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CreatePlanRequest, type Plan } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  IdempotencyError,
  idempotencyKeyHash,
  requestFingerprint,
  type IdempotencyInput,
} from '../src/leads/idempotency.js';
import {
  DatabaseLeadStore,
  type CreateLeadInput,
  type CreateLeadResult,
  type UpdateLeadInput,
} from '../src/leads/store.js';
import { DatabasePlanStore } from '../src/plans/store.js';

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

// Distinct id range for the lead idempotency tests.
const SITE = '1e000000-0000-4000-8000-000000000611';
const OTHER_SITE = '1e000000-0000-4000-8000-000000000612';
const ACTOR = '2e000000-0000-4000-8000-000000000611';
const REQUEST = '3e000000-0000-4000-8000-000000000611';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ctx = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };

const planInput: CreatePlanRequest = {
  leadType: 'sim_order',
  name: 'Idempotent plan',
  priceMinor: 4000,
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: [],
  active: true,
  customValues: {},
};

/** The key a website would send, hashed as the route will hash it; the body's fingerprint. */
const keyed = (key: string, body: unknown): IdempotencyInput => ({
  keyHash: idempotencyKeyHash(key),
  fingerprint: requestFingerprint(body),
});

const draftToken = (created: CreateLeadResult): string => {
  if (!created.grant) throw new Error('expected a draft grant');
  return created.grant.token;
};

databaseTest('idempotent website submission', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseLeadStore;
  let plan: Plan;

  /**
   * A website lead marked by its contact email, so a test can count the leads
   * one body produced (an external reference would be refused twice outright).
   */
  const base = ({
    marker,
    ...overrides
  }: Partial<CreateLeadInput> & { marker: string }): CreateLeadInput => ({
    ...ctx,
    leadType: 'sim_order',
    consentVersion: 'ci',
    contact: { fullName: 'Retry Person', email: `${marker}@example.test` },
    ...overrides,
  });

  const leadCount = async (marker: string, workspaceId = SITE) => {
    const [row] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.leads
      where workspace_id = ${workspaceId} and email = ${`${marker}@example.test`}
    `;
    return row?.total ?? 0;
  };

  const auditCount = async (leadId: string, action: string) => {
    const [row] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.audit_events
      where entity = 'lead' and entity_id = ${leadId} and action = ${action}
    `;
    return row?.total ?? 0;
  };

  const keyRows = async (key: string) =>
    admin<{ workspaceId: string; leadId: string | null; status: string; createdAt: Date }[]>`
      select workspace_id as "workspaceId", lead_id as "leadId", status, created_at as "createdAt"
      from app.idempotency_keys where key_hash = ${idempotencyKeyHash(key)}
      order by workspace_id
    `;

  const orderDetails = async (leadId: string): Promise<{ plan?: { frozenAt?: string } }> => {
    const [row] = await admin<{ orderDetails: { plan?: { frozenAt?: string } } }[]>`
      select order_details as "orderDetails" from app.leads where id = ${leadId}
    `;
    return row?.orderDetails ?? {};
  };

  const submit = (leadId: string, grantToken: string, idempotency?: IdempotencyInput) =>
    ({
      ...ctx,
      leadId,
      grantToken,
      submit: true,
      ...(idempotency ? { idempotency } : {}),
    }) satisfies UpdateLeadInput;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its leads, grants, keys, plans and timeline.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'lead-idempotency-611', 'Lead Idempotency Site'),
        (${OTHER_SITE}, 'lead-idempotency-612', 'Lead Idempotency Other')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabaseLeadStore(database);
    const created = await new DatabasePlanStore(database).create(ctx, planInput);
    if (created.kind !== 'created') throw new Error(`plan not created: ${created.kind}`);
    plan = created.plan;
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('replays a submitted create with the same key and body, writing nothing more', async () => {
    const body = { marker: 'idem-submitted', submit: true };
    const idempotency = keyed('key-submitted', body);
    const first = await store.createLead(base({ ...body, idempotency }));
    expect(first).toMatchObject({ replayed: false, grant: null, lead: { status: 'submitted' } });

    const again = await store.createLead(base({ ...body, idempotency }));
    expect(again).toEqual({ ...first, replayed: true });
    expect(await leadCount('idem-submitted')).toBe(1);
    expect(await auditCount(first.lead.id, 'lead.created')).toBe(1);
    expect(await keyRows('key-submitted')).toMatchObject([
      { workspaceId: SITE, leadId: first.lead.id, status: 'completed' },
    ]);
  });

  it('refuses the same key with a changed body', async () => {
    const idempotency = keyed('key-changed', { marker: 'idem-changed', submit: true });
    await store.createLead(base({ marker: 'idem-changed', submit: true, idempotency }));

    const changed = store.createLead(
      base({
        marker: 'idem-changed',
        submit: true,
        idempotency: keyed('key-changed', { marker: 'idem-changed-2', submit: true }),
      }),
    );
    await expect(changed).rejects.toBeInstanceOf(IdempotencyError);
    await expect(changed).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await leadCount('idem-changed')).toBe(1);
  });

  it('lets one of two concurrent creates with one key write the lead', async () => {
    const body = { marker: 'idem-concurrent', submit: true };
    const idempotency = keyed('key-concurrent', body);
    const results = await Promise.all([
      store.createLead(base({ ...body, idempotency })),
      store.createLead(base({ ...body, idempotency })),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    const [left, right] = results;
    expect(left?.lead.id).toBe(right?.lead.id);
    expect(await leadCount('idem-concurrent')).toBe(1);
    expect(await auditCount(left?.lead.id ?? '', 'lead.created')).toBe(1);
  });

  it('replays a draft create with a fresh working grant for the same lead', async () => {
    const body = { marker: 'idem-draft' };
    const idempotency = keyed('key-draft', body);
    const first = await store.createLead(base({ ...body, idempotency }));
    const again = await store.createLead(base({ ...body, idempotency }));

    expect(again.replayed).toBe(true);
    expect(again.lead).toEqual(first.lead);
    expect(draftToken(again)).not.toBe(draftToken(first));
    expect(await leadCount('idem-draft')).toBe(1);

    // The new grant works; the first one does too, it is never stored to be handed back.
    for (const token of [draftToken(again), draftToken(first)]) {
      await expect(
        store.readLead({ ...ctx, leadId: first.lead.id, grantToken: token }),
      ).resolves.toMatchObject({ status: 'read' });
    }
    const saved = await store.updateLead({
      ...ctx,
      leadId: first.lead.id,
      grantToken: draftToken(again),
      form: { schemaVersion: 1, payload: { step: 2 } },
    });
    expect(saved).toMatchObject({ status: 'updated', lead: { id: first.lead.id } });
  });

  it('replays a submitting update and freezes the plan once', async () => {
    const draft = await store.createLead(
      base({ marker: 'idem-update', order: { planId: plan.id, quantity: 1 } }),
    );
    const token = draftToken(draft);
    const idempotency = keyed('key-update', { leadId: draft.lead.id, submit: true });

    const first = await store.updateLead(submit(draft.lead.id, token, idempotency));
    expect(first).toMatchObject({ status: 'updated', lead: { status: 'submitted' } });
    expect(first).not.toHaveProperty('replayed');
    const frozenAt = (await orderDetails(draft.lead.id)).plan?.frozenAt;
    expect(frozenAt).toEqual(expect.any(String));

    const again = await store.updateLead(submit(draft.lead.id, token, idempotency));
    expect(again).toEqual({ ...first, replayed: true });
    expect((await orderDetails(draft.lead.id)).plan?.frozenAt).toBe(frozenAt);
    expect(await auditCount(draft.lead.id, 'lead.updated')).toBe(1);

    // Without the key the retry is the plain refusal it always was.
    await expect(store.updateLead(submit(draft.lead.id, token))).resolves.toEqual({
      status: 'draft_submitted',
    });
    // A replay still needs the lead's own grant.
    await expect(
      store.updateLead(submit(draft.lead.id, 'gtdg_forged', idempotency)),
    ).resolves.toEqual({ status: 'grant_invalid' });
    // The same key with another body on the same lead is a conflict.
    await expect(
      store.updateLead(
        submit(draft.lead.id, token, keyed('key-update', { leadId: draft.lead.id, x: 1 })),
      ),
    ).resolves.toEqual({ status: 'idempotency_conflict' });
  });

  it("refuses a key on another lead's submitting update", async () => {
    const first = await store.createLead(base({ marker: 'idem-other-a' }));
    const second = await store.createLead(base({ marker: 'idem-other-b' }));
    const idempotency = keyed('key-other-lead', { submit: true });

    await expect(
      store.updateLead(submit(first.lead.id, draftToken(first), idempotency)),
    ).resolves.toMatchObject({ status: 'updated' });
    await expect(
      store.updateLead(submit(second.lead.id, draftToken(second), idempotency)),
    ).resolves.toEqual({ status: 'idempotency_conflict' });

    const [row] = await admin<{ status: string }[]>`
      select status from app.leads where id = ${second.lead.id}
    `;
    expect(row?.status).toBe('incomplete');
  });

  it('keeps no claim when a keyed submit is refused', async () => {
    const draft = await store.createLead(base({ marker: 'idem-refused' }));
    await admin`
      update app.draft_grants set expires_at = now() - interval '1 minute'
      where lead_id = ${draft.lead.id}
    `;
    await expect(
      store.updateLead(
        submit(draft.lead.id, draftToken(draft), keyed('key-refused', { submit: true })),
      ),
    ).resolves.toEqual({ status: 'grant_expired' });
    expect(await keyRows('key-refused')).toEqual([]);
  });

  it('reports a key another request still holds as in progress', async () => {
    await admin`
      insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
      values (
        ${SITE}, 'lead_submission', ${idempotencyKeyHash('key-pending')},
        ${requestFingerprint({ marker: 'idem-pending' })}
      )
    `;
    const pending = store.createLead(
      base({
        marker: 'idem-pending',
        idempotency: keyed('key-pending', { marker: 'idem-pending' }),
      }),
    );
    await expect(pending).rejects.toMatchObject({ code: 'idempotency_in_progress' });
    expect(await leadCount('idem-pending')).toBe(0);
  });

  it('creates a new lead once the key is older than the replay window', async () => {
    const body = { marker: 'idem-expired', submit: true };
    const idempotency = keyed('key-expired', body);
    const first = await store.createLead(base({ ...body, idempotency }));
    await admin`
      update app.idempotency_keys set created_at = now() - interval '25 hours'
      where key_hash = ${idempotency.keyHash}
    `;

    const later = await store.createLead(base({ ...body, idempotency }));
    expect(later.replayed).toBe(false);
    expect(later.lead.id).not.toBe(first.lead.id);
    expect(await leadCount('idem-expired')).toBe(2);
    const [row] = await keyRows('key-expired');
    expect(row).toMatchObject({ leadId: later.lead.id, status: 'completed' });
    expect(Date.now() - (row?.createdAt.getTime() ?? 0)).toBeLessThan(60 * 60 * 1000);
  });

  it('scopes a key to its site', async () => {
    const body = { marker: 'idem-sites', submit: true };
    const idempotency = keyed('key-sites', body);
    const here = await store.createLead(base({ ...body, idempotency }));
    const there = await store.createLead(base({ ...body, idempotency, workspaceId: OTHER_SITE }));

    expect([here.replayed, there.replayed]).toEqual([false, false]);
    expect(there.lead.id).not.toBe(here.lead.id);
    expect(await leadCount('idem-sites')).toBe(1);
    expect(await leadCount('idem-sites', OTHER_SITE)).toBe(1);
    expect((await keyRows('key-sites')).map((row) => row.workspaceId).sort()).toEqual(
      [SITE, OTHER_SITE].sort(),
    );
  });

  it('creates a lead per call when no key is sent, as before', async () => {
    const body = { marker: 'idem-none', submit: true };
    const first = await store.createLead(base(body));
    const second = await store.createLead(base(body));
    expect([first.replayed, second.replayed]).toEqual([false, false]);
    expect(await leadCount('idem-none')).toBe(2);
    const [row] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.idempotency_keys
      where lead_id in (${first.lead.id}, ${second.lead.id})
    `;
    expect(row?.total).toBe(0);
  });
});
