import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import type { CreateCustomProperty } from '@gt-sales/contracts';

import { DatabasePropertyStore, type CreatePropertyOutcome } from '../src/properties/store.js';

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

// Distinct id range for the property store integration tests.
const SITE = '18000000-0000-4000-8000-000000000f01';
const OTHER_SITE = '18000000-0000-4000-8000-000000000f02';
const ACTOR = '28000000-0000-4000-8000-000000000f01';
const OTHER_ACTOR = '28000000-0000-4000-8000-000000000f02';
const REQUEST = '38000000-0000-4000-8000-000000000f01';
const LEAD_1 = '98000000-0000-4000-8000-000000000001';
const LEAD_2 = '98000000-0000-4000-8000-000000000002';
const LEAD_3 = '98000000-0000-4000-8000-000000000003';
const LEAD_4 = '98000000-0000-4000-8000-000000000004';
const LEAD_5 = '98000000-0000-4000-8000-000000000005';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ctx = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };
const otherCtx = { workspaceId: OTHER_SITE, actorId: OTHER_ACTOR };

const textInput = (label: string): CreateCustomProperty => ({
  label,
  kind: 'text',
  options: [],
  staffOnly: false,
  sensitive: false,
  leadTypes: [],
});

function keyOf(outcome: CreatePropertyOutcome): string {
  if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
  return outcome.property.key;
}

databaseTest('property store (custom properties, built-in overrides, layouts)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabasePropertyStore;

  const insertLead = async (
    id: string,
    workspaceId: string,
    customValues: Record<string, string | number | boolean | null>,
    state: { trashed?: boolean; restricted?: boolean } = {},
  ) => {
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        custom_values, deleted_at, customer_data_restricted_at
      ) values (
        ${id}, ${workspaceId}, 'sim_order', 'submitted', 'pending', 'ci', '{}'::jsonb,
        ${admin.json({ schemaVersion: 1, payload: {} })}, ${admin.json(customValues)},
        ${state.trashed ? new Date() : null}, ${state.restricted ? new Date() : null}
      )
    `;
  };

  const auditRows = (action: string) => admin<
    {
      entity: string;
      entityId: string;
      actorId: string;
      requestId: string;
      before: unknown;
      after: unknown;
    }[]
  >`
    select entity, entity_id as "entityId", actor_id as "actorId", request_id as "requestId", before, after
    from app.audit_events
    where workspace_id = ${SITE} and action = ${action}
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
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    // More than one connection, so concurrent writes really run side by side.
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabasePropertyStore(database);
  });

  // Each test starts from two empty sites; deleting a site removes its rows.
  beforeEach(async () => {
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'prop-store-f01', 'Property Store Site'),
        (${OTHER_SITE}, 'prop-store-f02', 'Property Store Other')
    `;
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await database?.close();
    await admin?.end();
  });

  it('creates a custom property with a generated key, then _2 for the same label, and reserves tombstoned keys', async () => {
    const first = await store.create(ctx, 'lead', textInput('Referral code'));
    expect(first).toMatchObject({
      kind: 'created',
      property: {
        object: 'lead',
        key: 'custom_referral_code',
        origin: 'custom',
        label: 'Referral code',
        kind: 'text',
        options: [],
        hidden: false,
        leadTypes: [],
        version: 1,
      },
    });
    const second = await store.create(ctx, 'lead', textInput('Referral code'));
    expect(keyOf(second)).toBe('custom_referral_code_2');
    expect(second.kind === 'created' && first.kind === 'created').toBe(true);
    if (second.kind === 'created' && first.kind === 'created') {
      expect(second.property.position).toBeGreaterThan(first.property.position);
    }

    const [row] = await admin<{ id: string; createdBy: string; updatedBy: string }[]>`
      select id, created_by as "createdBy", updated_by as "updatedBy"
      from app.properties
      where workspace_id = ${SITE} and key = 'custom_referral_code'
    `;
    expect(row).toMatchObject({ createdBy: ACTOR, updatedBy: ACTOR });

    await expect(store.remove(ctx, 'lead', 'custom_referral_code')).resolves.toEqual({
      kind: 'deleted',
    });
    const third = await store.create(ctx, 'lead', textInput('Referral code'));
    expect(keyOf(third)).toBe('custom_referral_code_3');

    const created = await auditRows('property.created');
    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({
      entity: 'property',
      entityId: row?.id,
      actorId: ACTOR,
      requestId: REQUEST,
      before: null,
      after: { key: 'custom_referral_code', label: 'Referral code', kind: 'text' },
    });
  });

  it('two concurrent creates with the same label get distinct keys', async () => {
    // Open every pool connection first, so the creates start together.
    await Promise.all([1, 2, 3, 4].map(() => store.catalog(ctx)));
    const input = textInput('Promo');
    const [a, b] = await Promise.all([
      store.create(ctx, 'lead', input),
      store.create(ctx, 'lead', input),
    ]);
    expect(new Set([keyOf(a), keyOf(b)]).size).toBe(2);
    expect(new Set([keyOf(a), keyOf(b)])).toEqual(new Set(['custom_promo', 'custom_promo_2']));
  });

  it('stops at 100 custom properties', async () => {
    // 99 live rows and one tombstone, inserted directly; the tombstone does not count.
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position)
      select ${SITE}, 'lead', 'custom_bulk_' || n, 'custom', 'Bulk ' || n, 'text', n
      from generate_series(1, 100) as n
    `;
    await admin`
      update app.properties set deleted_at = now()
      where workspace_id = ${SITE} and key = 'custom_bulk_100'
    `;

    const hundredth = await store.create(ctx, 'lead', textInput('Bulk 100'));
    // The tombstoned key stays reserved.
    expect(keyOf(hundredth)).toBe('custom_bulk_100_2');
    if (hundredth.kind === 'created') expect(hundredth.property.position).toBe(101);
    await expect(store.create(ctx, 'lead', textInput('One more'))).resolves.toEqual({
      kind: 'limit_reached',
    });
    // Another object has its own limit.
    expect(keyOf(await store.create(ctx, 'plan', textInput('One more')))).toBe('custom_one_more');
  });

  it('a built-in accepts label and hidden only', async () => {
    // No row yet: the code definition is version 1.
    await expect(
      store.update(ctx, 'lead', 'city', { expectedVersion: 2, label: 'Town' }),
    ).resolves.toEqual({ kind: 'version_conflict' });

    const relabelled = await store.update(ctx, 'lead', 'city', {
      expectedVersion: 1,
      label: 'Town',
    });
    expect(relabelled).toMatchObject({
      kind: 'updated',
      property: { key: 'city', origin: 'builtin', kind: 'text', label: 'Town', hidden: false },
    });
    const version = relabelled.kind === 'updated' ? relabelled.property.version : 0;
    expect(version).toBe(2);
    expect((await store.catalog(ctx)).get('city')?.label).toBe('Town');

    await expect(
      store.update(ctx, 'lead', 'city', { expectedVersion: 1, hidden: true }),
    ).resolves.toEqual({ kind: 'version_conflict' });
    await expect(
      store.update(ctx, 'lead', 'city', { expectedVersion: version, staffOnly: true }),
    ).resolves.toEqual({ kind: 'builtin_locked' });
    await expect(
      store.update(ctx, 'lead', 'city', {
        expectedVersion: version,
        options: [{ value: 'a', label: 'A', hidden: false }],
      }),
    ).resolves.toEqual({ kind: 'builtin_locked' });

    const hidden = await store.update(ctx, 'lead', 'city', {
      expectedVersion: version,
      hidden: true,
    });
    expect(hidden).toMatchObject({
      kind: 'updated',
      property: { label: 'Town', hidden: true, version: 3 },
    });
    expect((await store.catalog(ctx)).get('city')?.hidden).toBe(true);

    await expect(store.remove(ctx, 'lead', 'city')).resolves.toEqual({ kind: 'builtin' });
    await expect(
      store.update(ctx, 'lead', 'custom_nothing', { expectedVersion: 1, label: 'X' }),
    ).resolves.toEqual({ kind: 'not_found' });
    // `city` is a built-in of leads only; on another object it is an unknown key.
    await expect(
      store.update(ctx, 'plan', 'city', { expectedVersion: 1, label: 'X' }),
    ).resolves.toEqual({ kind: 'not_found' });

    const updates = await auditRows('property.updated');
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      entity: 'property',
      before: { key: 'city', origin: 'builtin', label: 'City', version: 1 },
      after: { key: 'city', origin: 'builtin', label: 'Town', version: 2 },
    });
  });

  it('removing an option in use answers option_in_use with the count; hiding it is allowed', async () => {
    const created = await store.create(ctx, 'lead', {
      ...textInput('Source'),
      kind: 'choice',
      options: [
        { value: 'web', label: 'Web', hidden: false },
        { value: 'phone', label: 'Phone', hidden: false },
      ],
    });
    const key = keyOf(created);
    await insertLead(LEAD_1, SITE, { [key]: 'web' });
    await insertLead(LEAD_2, SITE, { [key]: 'web' });
    await insertLead(LEAD_3, OTHER_SITE, { [key]: 'phone' });

    await expect(
      store.update(ctx, 'lead', key, {
        expectedVersion: 1,
        options: [{ value: 'phone', label: 'Phone', hidden: false }],
      }),
    ).resolves.toEqual({
      kind: 'option_in_use',
      optionValue: 'web',
      leadCount: 2,
      active: 2,
      trashed: 0,
      restricted: 0,
    });

    const hidden = await store.update(ctx, 'lead', key, {
      expectedVersion: 1,
      options: [
        { value: 'web', label: 'Web', hidden: true },
        { value: 'phone', label: 'Phone', hidden: false },
      ],
    });
    expect(hidden).toMatchObject({
      kind: 'updated',
      property: { version: 2, options: [{ value: 'web', hidden: true }, { value: 'phone' }] },
    });

    // Another site's leads do not count: nobody here holds `phone`.
    const dropped = await store.update(ctx, 'lead', key, {
      expectedVersion: 2,
      options: [
        { value: 'web', label: 'Web', hidden: true },
        { value: 'email', label: 'Email', hidden: false },
      ],
    });
    expect(dropped).toMatchObject({ kind: 'updated', property: { version: 3 } });
    await expect(
      store.update(ctx, 'lead', key, { expectedVersion: 2, label: 'Stale' }),
    ).resolves.toEqual({ kind: 'version_conflict' });
  });

  it('refuses options on a kind without them, a choice left with none, and repeated option values', async () => {
    const text = keyOf(await store.create(ctx, 'lead', textInput('Plain text')));
    const choice = keyOf(
      await store.create(ctx, 'lead', {
        ...textInput('Tier'),
        kind: 'choice',
        options: [{ value: 'gold', label: 'Gold', hidden: false }],
      }),
    );

    await expect(
      store.update(ctx, 'lead', text, {
        expectedVersion: 1,
        options: [{ value: 'a', label: 'A', hidden: false }],
      }),
    ).resolves.toEqual({ kind: 'invalid_options' });
    await expect(
      store.update(ctx, 'lead', choice, { expectedVersion: 1, options: [] }),
    ).resolves.toEqual({ kind: 'invalid_options' });
    await expect(
      store.update(ctx, 'lead', choice, {
        expectedVersion: 1,
        options: [
          { value: 'gold', label: 'Gold', hidden: false },
          { value: 'gold', label: 'Gold again', hidden: true },
        ],
      }),
    ).resolves.toEqual({ kind: 'invalid_options' });

    // Nothing changed: both rows are still at version 1, and a valid change goes through.
    expect((await store.model(ctx, 'lead')).rows.map((row) => [row.key, row.version])).toEqual([
      [text, 1],
      [choice, 1],
    ]);
    await expect(
      store.update(ctx, 'lead', text, { expectedVersion: 1, options: [] }),
    ).resolves.toMatchObject({ kind: 'updated', property: { options: [], version: 2 } });
  });

  it('deleting a property with values answers in_use; after clearing them it tombstones and catalog() no longer returns it', async () => {
    const key = keyOf(await store.create(ctx, 'lead', textInput('Gift note')));
    await insertLead(LEAD_1, SITE, { [key]: 'hello' });
    await insertLead(LEAD_2, SITE, { [key]: null });

    await expect(store.remove(ctx, 'lead', key)).resolves.toEqual({
      kind: 'in_use',
      leadCount: 1,
      active: 1,
      trashed: 0,
      restricted: 0,
    });

    await admin`
      update app.leads set custom_values = custom_values - ${key}::text
      where workspace_id = ${SITE} and id = ${LEAD_1}
    `;
    await expect(store.remove(ctx, 'lead', key)).resolves.toEqual({ kind: 'deleted' });

    expect((await store.catalog(ctx)).get(key)).toBeUndefined();
    expect((await store.model(ctx, 'lead')).rows.map((row) => row.key)).not.toContain(key);
    const [tombstone] = await admin<{ deleted: boolean; updatedBy: string }[]>`
      select deleted_at is not null as deleted, updated_by as "updatedBy"
      from app.properties where workspace_id = ${SITE} and key = ${key}
    `;
    expect(tombstone).toEqual({ deleted: true, updatedBy: ACTOR });

    await expect(store.remove(ctx, 'lead', key)).resolves.toEqual({ kind: 'not_found' });
    await expect(
      store.update(ctx, 'lead', key, { expectedVersion: 1, label: 'Back' }),
    ).resolves.toEqual({ kind: 'not_found' });

    const deleted = await auditRows('property.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      entity: 'property',
      before: { key, label: 'Gift note' },
      after: null,
    });
  });

  it('in-use counts include trashed and restricted leads, split by what the owner can do', async () => {
    const note = keyOf(await store.create(ctx, 'lead', textInput('Gift note')));
    const tier = keyOf(
      await store.create(ctx, 'lead', {
        ...textInput('Tier'),
        kind: 'choice',
        options: [
          { value: 'gold', label: 'Gold', hidden: false },
          { value: 'silver', label: 'Silver', hidden: false },
        ],
      }),
    );
    const values = { [note]: 'hello', [tier]: 'gold' };
    await insertLead(LEAD_1, SITE, values);
    await insertLead(LEAD_2, SITE, values, { trashed: true });
    await insertLead(LEAD_3, SITE, values, { trashed: true });
    await insertLead(LEAD_4, SITE, values, { restricted: true });
    // Trashed and restricted: it can never be edited, so it counts as restricted.
    await insertLead(LEAD_5, SITE, values, { trashed: true, restricted: true });

    const usage = { leadCount: 5, active: 1, trashed: 2, restricted: 2 };
    await expect(store.remove(ctx, 'lead', note)).resolves.toEqual({ kind: 'in_use', ...usage });
    await expect(
      store.update(ctx, 'lead', tier, {
        expectedVersion: 1,
        options: [{ value: 'silver', label: 'Silver', hidden: false }],
      }),
    ).resolves.toEqual({ kind: 'option_in_use', optionValue: 'gold', ...usage });

    // Only trashed and restricted leads left: still refused, nothing active.
    await admin`
      update app.leads set custom_values = custom_values - ${note}::text
      where workspace_id = ${SITE} and id = ${LEAD_1}
    `;
    await expect(store.remove(ctx, 'lead', note)).resolves.toEqual({
      kind: 'in_use',
      leadCount: 4,
      active: 0,
      trashed: 2,
      restricted: 2,
    });
  });

  it('plan properties: website visibility, no built-ins, usage counted over plans, a layout keyed by no type', async () => {
    const created = await store.create(ctx, 'plan', {
      ...textInput('Network'),
      websiteVisible: true,
    });
    expect(created).toMatchObject({
      kind: 'created',
      property: { object: 'plan', key: 'custom_network', websiteVisible: true },
    });
    // A lead property of the same label gets the same key: keys are per object.
    expect(keyOf(await store.create(ctx, 'lead', textInput('Network')))).toBe('custom_network');
    const [stored] = await admin<{ websiteVisible: boolean }[]>`
      select website_visible as "websiteVisible" from app.properties
      where workspace_id = ${SITE} and object = 'plan' and key = 'custom_network'
    `;
    expect(stored).toEqual({ websiteVisible: true });

    await expect(
      store.update(ctx, 'plan', 'custom_network', { expectedVersion: 1, websiteVisible: false }),
    ).resolves.toMatchObject({ kind: 'updated', property: { websiteVisible: false, version: 2 } });
    expect((await store.model(ctx, 'plan')).rows).toMatchObject([
      { key: 'custom_network', websiteVisible: false },
    ]);
    // A lead built-in key is nothing on plans.
    await expect(
      store.update(ctx, 'plan', 'city', { expectedVersion: 1, label: 'Town' }),
    ).resolves.toEqual({ kind: 'not_found' });
    await expect(store.remove(ctx, 'plan', 'city')).resolves.toEqual({ kind: 'not_found' });

    const tier = keyOf(
      await store.create(ctx, 'plan', {
        ...textInput('Tier'),
        kind: 'choice',
        options: [
          { value: 'gold', label: 'Gold', hidden: false },
          { value: 'silver', label: 'Silver', hidden: false },
        ],
      }),
    );
    // Plans hold the values; a lead holding the same key does not count for plans.
    await insertLead(LEAD_1, SITE, { custom_network: 'Rogers', [tier]: 'gold' });
    await admin`
      insert into app.plans (workspace_id, lead_type, name, custom_values)
      values
        (${SITE}, 'sim_order', 'A', ${admin.json({ custom_network: 'Rogers', [tier]: 'gold' })}),
        (${SITE}, 'internet', 'B', ${admin.json({ custom_network: 'Bell' })}),
        (${SITE}, 'mobility', 'C', ${admin.json({ custom_network: null })}),
        (${OTHER_SITE}, 'sim_order', 'D', ${admin.json({ custom_network: 'Fido' })})
    `;
    const usage = { leadCount: 0, active: 2, trashed: 0, restricted: 0, planCount: 2 };
    await expect(store.remove(ctx, 'plan', 'custom_network')).resolves.toEqual({
      kind: 'in_use',
      ...usage,
    });
    await expect(
      store.update(ctx, 'plan', tier, {
        expectedVersion: 1,
        options: [{ value: 'silver', label: 'Silver', hidden: false }],
      }),
    ).resolves.toEqual({
      kind: 'option_in_use',
      optionValue: 'gold',
      leadCount: 0,
      active: 1,
      trashed: 0,
      restricted: 0,
      planCount: 1,
    });

    await admin`
      update app.plans set custom_values = custom_values - 'custom_network'
      where workspace_id = ${SITE}
    `;
    await expect(store.remove(ctx, 'plan', 'custom_network')).resolves.toEqual({
      kind: 'deleted',
    });
    // The lead property of the same key is untouched.
    expect((await store.catalog(ctx, 'lead')).get('custom_network')).toBeDefined();

    const saved = await store.saveLayout(
      ctx,
      'plan',
      '',
      { sections: [{ id: 'main', label: 'Main', keys: [tier] }] },
      undefined,
    );
    expect(saved).toMatchObject({ kind: 'saved', layout: { object: 'plan', leadType: '' } });
    await expect(
      store.saveLayout(
        ctx,
        'plan',
        '',
        { sections: [{ id: 'main', label: 'Main', keys: ['city'] }] },
        1,
      ),
    ).resolves.toEqual({ kind: 'unknown_key', key: 'city' });
  });

  it('saveLayout refuses an unknown key and guards the version', async () => {
    const key = keyOf(await store.create(ctx, 'lead', textInput('Hidden extra')));
    const hiddenOutcome = await store.update(ctx, 'lead', key, {
      expectedVersion: 1,
      hidden: true,
    });
    expect(hiddenOutcome.kind).toBe('updated');

    const layout = {
      sections: [
        { id: 'request', label: 'Request', keys: ['city', 'planId'] },
        { id: 'custom', label: 'Custom', keys: [key] },
      ],
    };
    await expect(
      store.saveLayout(
        ctx,
        'lead',
        'sim_order',
        { sections: [{ id: 'a', label: 'A', keys: ['city', 'custom_missing'] }] },
        undefined,
      ),
    ).resolves.toEqual({ kind: 'unknown_key', key: 'custom_missing' });
    // No saved row: a version cannot match.
    await expect(store.saveLayout(ctx, 'lead', 'sim_order', layout, 1)).resolves.toEqual({
      kind: 'version_conflict',
    });

    const saved = await store.saveLayout(ctx, 'lead', 'sim_order', layout, undefined);
    expect(saved).toMatchObject({
      kind: 'saved',
      layout: { object: 'lead', leadType: 'sim_order', layout, version: 1 },
    });
    if (saved.kind === 'saved') expect(saved.layout.updatedAt).toEqual(expect.any(String));

    await expect(store.saveLayout(ctx, 'lead', 'sim_order', layout, 2)).resolves.toEqual({
      kind: 'version_conflict',
    });
    await expect(store.saveLayout(ctx, 'lead', 'sim_order', layout, 1)).resolves.toMatchObject({
      kind: 'saved',
      layout: { version: 2 },
    });
    // Without a version over a saved layout: a conflict, never an overwrite.
    const other = { sections: [{ id: 'other', label: 'Other', keys: ['planId'] }] };
    await expect(store.saveLayout(ctx, 'lead', 'sim_order', other, undefined)).resolves.toEqual({
      kind: 'version_conflict',
    });
    await expect(store.saveLayout(ctx, 'lead', 'sim_order', layout, 2)).resolves.toMatchObject({
      kind: 'saved',
      layout: { layout, version: 3 },
    });
    // The object's default layout is its own row.
    await expect(store.saveLayout(ctx, 'lead', '', layout, undefined)).resolves.toMatchObject({
      kind: 'saved',
      layout: { leadType: '', version: 1 },
    });

    const model = await store.model(ctx, 'lead');
    expect(model.layouts.map((entry) => [entry.leadType, entry.version])).toEqual([
      ['', 1],
      ['sim_order', 3],
    ]);
    expect(model.rows.map((row) => row.key)).toContain(key);

    const [layoutRow] = await admin<{ id: string }[]>`
      select id from app.property_layouts where workspace_id = ${SITE} and lead_type = 'sim_order'
    `;
    const audits = await auditRows('property_layout.updated');
    expect(audits).toHaveLength(4);
    expect(audits[0]).toMatchObject({ entity: 'property_layout', entityId: layoutRow?.id });
  });

  it('rows of one workspace never appear in another', async () => {
    const key = keyOf(await store.create(ctx, 'lead', textInput('Referral code')));
    await store.update(ctx, 'lead', 'city', { expectedVersion: 1, label: 'Town' });
    await store.saveLayout(
      ctx,
      'lead',
      'sim_order',
      { sections: [{ id: 'a', label: 'A', keys: [key] }] },
      undefined,
    );

    const otherCatalog = await store.catalog(otherCtx);
    expect(otherCatalog.get(key)).toBeUndefined();
    expect(otherCatalog.get('city')?.label).toBe('City');
    await expect(store.model(otherCtx, 'lead')).resolves.toEqual({ rows: [], layouts: [] });

    // The other site's keys are its own: no suffix, and SITE's key is unknown there.
    expect(keyOf(await store.create(otherCtx, 'lead', textInput('Referral code')))).toBe(key);
    await expect(
      store.saveLayout(
        otherCtx,
        'lead',
        'sim_order',
        { sections: [{ id: 'a', label: 'A', keys: ['custom_referral_code_2'] }] },
        undefined,
      ),
    ).resolves.toEqual({ kind: 'unknown_key', key: 'custom_referral_code_2' });
    await expect(store.remove(otherCtx, 'lead', 'custom_unknown')).resolves.toEqual({
      kind: 'not_found',
    });

    const siteModel = await store.model(ctx, 'lead');
    expect(siteModel.rows.map((row) => [row.key, row.label])).toEqual([
      ['city', 'Town'],
      [key, 'Referral code'],
    ]);
    expect(siteModel.layouts).toHaveLength(1);
  });
});
