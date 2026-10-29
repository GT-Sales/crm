import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOM_PROPERTY_KINDS,
  buildPropertyCatalog,
  isValidLeadPropertyFilter,
  isValidLeadSort,
  leadPropertyOperators,
  propertyRowSchema,
  type LeadPropertyFilter,
  type PropertyRow,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';

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

// Distinct id range for the custom value tests.
const SITE = '19000000-0000-4000-8000-000000000f61';
const ACTOR = '29000000-0000-4000-8000-000000000f61';
const REQUEST_ID = '39000000-0000-4000-8000-000000000f61';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// Ids sort A < B < C < M, so a lead with no value and the malformed one tie last by id.
const LEAD_A = '99000000-0000-4000-8000-000000000001';
const LEAD_B = '99000000-0000-4000-8000-000000000002';
const LEAD_C = '99000000-0000-4000-8000-000000000003';
const LEAD_M = '99000000-0000-4000-8000-000000000004';
const LEAD_EDIT = '99000000-0000-4000-8000-000000000010';
const LEAD_RESTRICTED = '99000000-0000-4000-8000-000000000011';

type CustomKind = (typeof CUSTOM_PROPERTY_KINDS)[number];
type Stored = string | number | boolean | { readonly [key: string]: number };

const STAMP = '2026-10-29T12:00:00.000Z';
function customRow(overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key'>): PropertyRow {
  return propertyRowSchema.parse({
    object: 'lead',
    origin: 'custom',
    label: overrides.key,
    kind: 'text',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: false,
    leadTypes: [],
    position: 0,
    version: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  });
}

const keyOf = (kind: CustomKind) => `custom_${kind}`;

const catalog = buildPropertyCatalog([
  ...CUSTOM_PROPERTY_KINDS.map((kind, position) =>
    customRow({
      key: keyOf(kind),
      kind,
      position,
      options:
        kind === 'choice'
          ? [
              { value: 'gold', label: 'Gold', hidden: false },
              { value: 'silver', label: 'Silver', hidden: false },
              { value: 'bronze', label: 'Bronze', hidden: true },
            ]
          : [],
    }),
  ),
  customRow({ key: 'custom_secret', sensitive: true, position: 20 }),
  customRow({ key: 'custom_hidden', hidden: true, position: 21 }),
  customRow({ key: 'custom_net', leadTypes: ['internet'], position: 22 }),
]);

/** Two good values per kind (A, B), one malformed value per kind (M); C has none. */
const VALUES: Record<CustomKind, { a: Stored; b: Stored; malformed: Stored }> = {
  text: { a: 'Alpha Ref', b: 'beta 50%_off', malformed: 42 },
  longText: { a: 'Line one\nline two', b: 'Other notes', malformed: true },
  number: { a: 1.5, b: 200, malformed: '12' },
  money: { a: 1999, b: 50000, malformed: '1999' },
  date: { a: '2026-11-01', b: '2026-12-15', malformed: 'not-a-date' },
  yesNo: { a: true, b: false, malformed: 'true' },
  choice: { a: 'gold', b: 'silver', malformed: 7 },
  email: { a: 'a@example.test', b: 'b@example.test', malformed: 123 },
  phone: { a: '+16045550100', b: '4035550199', malformed: 6045550100 },
  url: { a: 'https://a.example/x', b: 'https://b.example', malformed: false },
};

type Case = [op: LeadPropertyFilter['op'], value: LeadPropertyFilter['value'], ids: string[]];
const EMPTY: Case = ['empty', undefined, [LEAD_C]];
const NOT_EMPTY: Case = ['notEmpty', undefined, [LEAD_A, LEAD_B]];

/** Each kind's operators with what they match; the traps would match the malformed row unguarded. */
const CASES: Record<CustomKind, Case[]> = {
  text: [
    ['eq', 'ALPHA REF', [LEAD_A]],
    ['contains', '50%_', [LEAD_B]],
    ['contains', '42', []],
    EMPTY,
    NOT_EMPTY,
  ],
  longText: [
    ['eq', 'other notes', [LEAD_B]],
    ['contains', 'line two', [LEAD_A]],
    ['contains', 'true', []],
    EMPTY,
    NOT_EMPTY,
  ],
  number: [
    ['eq', 1.5, [LEAD_A]],
    ['eq', 12, []],
    ['lte', 100, [LEAD_A]],
    ['gte', 12, [LEAD_B]],
    EMPTY,
    NOT_EMPTY,
  ],
  money: [
    ['eq', 1999, [LEAD_A]],
    ['lte', 2000, [LEAD_A]],
    ['gte', 1999, [LEAD_A, LEAD_B]],
    EMPTY,
    NOT_EMPTY,
  ],
  date: [
    ['eq', '2026-11-01', [LEAD_A]],
    ['lte', '2026-11-30', [LEAD_A]],
    ['gte', '2026-11-02', [LEAD_B]],
    EMPTY,
    NOT_EMPTY,
  ],
  yesNo: [['eq', true, [LEAD_A]], ['eq', false, [LEAD_B]], EMPTY],
  choice: [
    ['eq', 'gold', [LEAD_A]],
    ['in', ['gold', 'silver'], [LEAD_A, LEAD_B]],
    EMPTY,
    NOT_EMPTY,
  ],
  email: [
    ['eq', 'A@Example.Test', [LEAD_A]],
    ['contains', 'b@', [LEAD_B]],
    ['contains', '123', []],
    EMPTY,
    NOT_EMPTY,
  ],
  phone: [['eq', '4035550199', [LEAD_B]], ['contains', '604555', [LEAD_A]], EMPTY, NOT_EMPTY],
  url: [
    ['eq', 'https://b.example', [LEAD_B]],
    ['contains', 'a.example', [LEAD_A]],
    EMPTY,
    NOT_EMPTY,
  ],
};

const valuesOf = (pick: 'a' | 'b' | 'malformed') =>
  Object.fromEntries(CUSTOM_PROPERTY_KINDS.map((kind) => [keyOf(kind), VALUES[kind][pick]]));

databaseTest('custom values in lead lists, boards, detail and edits', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;

  const insertLead = async (input: {
    id: string;
    leadType: string;
    stage: string;
    payload: Record<string, string | number | boolean>;
    customValues: Record<string, Stored>;
    restricted?: boolean;
  }) => {
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        custom_values, customer_data_restricted_at
      ) values (
        ${input.id}, ${SITE}, ${input.leadType}, 'submitted', ${input.stage}, 'ci', '{}'::jsonb,
        ${admin.json({ schemaVersion: 1, payload: input.payload })},
        ${admin.json(input.customValues)},
        ${input.restricted ? new Date() : null}
      )
    `;
  };

  const list = (input: { where?: LeadPropertyFilter[]; sort?: string; columns?: string[] }) =>
    leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog,
      leadType: 'internet',
      ...input,
    });

  const storedValues = async (leadId: string) => {
    const [row] = await admin<{ customValues: unknown }[]>`
      select custom_values as "customValues" from app.leads where id = ${leadId}
    `;
    return row?.customValues;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });

    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'custom-values-f61', 'Custom Values Site')
    `;

    await insertLead({
      id: LEAD_A,
      leadType: 'internet',
      stage: 'new',
      payload: { city: 'Calgary', dateOfBirth: '1990-04-12' },
      customValues: { ...valuesOf('a'), custom_secret: 'A-SECRET-VALUE', custom_legacy: 'x' },
    });
    await insertLead({
      id: LEAD_B,
      leadType: 'internet',
      stage: 'new',
      payload: { city: 'Edmonton' },
      customValues: valuesOf('b'),
    });
    await insertLead({
      id: LEAD_C,
      leadType: 'internet',
      stage: 'new',
      payload: { city: 'Banff' },
      customValues: {},
    });
    await insertLead({
      id: LEAD_M,
      leadType: 'internet',
      stage: 'new',
      payload: {},
      customValues: { ...valuesOf('malformed'), custom_secret: { nested: 1 } },
    });
    await insertLead({
      id: LEAD_EDIT,
      leadType: 'sim_order',
      stage: 'pending',
      payload: { arrivalDate: '2026-11-02', delivery: 'esim' },
      customValues: { custom_text: 'Old ref', custom_choice: 'bronze' },
    });
    await insertLead({
      id: LEAD_RESTRICTED,
      leadType: 'sim_order',
      stage: 'pending',
      payload: {},
      customValues: { custom_text: 'Kept' },
      restricted: true,
    });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    leadStore = new DatabaseLeadStore(database);
    work = new DatabaseLeadWorkStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  describe.each(CUSTOM_PROPERTY_KINDS)('%s', (kind) => {
    const key = keyOf(kind);

    it('filters with every operator of the kind, never matching the malformed row and never throwing', async () => {
      const cases = CASES[kind];
      expect(new Set(cases.map(([op]) => op))).toEqual(new Set(leadPropertyOperators(kind)));
      for (const [op, value, ids] of cases) {
        const filter: LeadPropertyFilter = value === undefined ? { key, op } : { key, op, value };
        expect(isValidLeadPropertyFilter(filter, 'internet', catalog)).toBe(true);
        const result = await list({ where: [filter] });
        expect({ op, value, ids: result.leads.map((lead) => lead.id).sort() }).toEqual({
          op,
          value,
          ids,
        });
        expect(result.leads.map((lead) => lead.id)).not.toContain(LEAD_M);
      }
    });

    it('sorts with the malformed row last in both directions', async () => {
      // false sorts before true; every other kind's A value sorts first.
      const [low, high] = kind === 'yesNo' ? [LEAD_B, LEAD_A] : [LEAD_A, LEAD_B];
      for (const [direction, expected] of [
        ['asc', [low, high, LEAD_C, LEAD_M]],
        ['desc', [high, low, LEAD_C, LEAD_M]],
      ] as const) {
        const sort = `prop.${key}:${direction}`;
        expect(isValidLeadSort(sort, 'internet', catalog)).toBe(true);
        const result = await list({ sort });
        expect(result.leads.map((lead) => lead.id)).toEqual(expected);
      }
    });
  });

  it('columns= returns custom values beside form values and never a sensitive one', async () => {
    const result = await list({
      columns: ['custom_text', 'city', 'custom_secret', 'dateOfBirth', 'custom_yesNo'],
      sort: 'prop.custom_text:asc',
    });
    expect(result.leads.map((lead) => [lead.id, lead.properties])).toEqual([
      [LEAD_A, { custom_text: 'Alpha Ref', city: 'Calgary', custom_yesNo: true }],
      [LEAD_B, { custom_text: 'beta 50%_off', city: 'Edmonton', custom_yesNo: false }],
      [LEAD_C, { city: 'Banff' }],
      [LEAD_M, { custom_text: 42, custom_yesNo: 'true' }],
    ]);
    expect(JSON.stringify(result)).not.toContain('A-SECRET-VALUE');
    expect(JSON.stringify(result)).not.toContain('1990-04-12');

    // Form columns alone still work, with no custom value read.
    const formOnly = await list({ columns: ['city'], sort: 'prop.city:asc' });
    expect(formOnly.leads.map((lead) => lead.properties)).toEqual([
      { city: 'Banff' },
      { city: 'Calgary' },
      { city: 'Edmonton' },
      {},
    ]);
  });

  it('the board honours a custom where', async () => {
    const columns = await work.board(
      {
        workspaceId: SITE,
        actorId: ACTOR,
        catalog,
        leadType: 'internet',
        where: [{ key: 'custom_choice', op: 'eq', value: 'silver' }],
      },
      50,
    );
    const newColumn = columns.find((column) => column.stage === 'new');
    expect(newColumn?.total).toBe(1);
    expect(newColumn?.leads.map((lead) => lead.id)).toEqual([LEAD_B]);
    expect(columns.flatMap((column) => column.leads).map((lead) => lead.id)).toEqual([LEAD_B]);
  });

  it('PATCH customValues stores, clears with null, rejects a hidden option, an unknown key and a wrong kind as invalid_field, and writes one edit activity naming the keys', async () => {
    const scope = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST_ID, catalog };
    // Stores: a form key and custom keys in one edit; the kept hidden option and a no-op clear change nothing.
    const saved = await work.updateLead({
      ...scope,
      leadId: LEAD_EDIT,
      form: { arrivalDate: '2026-11-09' },
      customValues: {
        custom_text: '  New ref  ',
        custom_money: 2500,
        custom_choice: 'bronze',
        custom_url: null,
      },
    });
    if (saved.status !== 'updated') throw new Error(`expected updated, got ${saved.status}`);
    expect(saved.lead.customValues).toEqual({
      custom_text: 'New ref',
      custom_money: 2500,
      custom_choice: 'bronze',
    });
    expect(saved.activities).toEqual([
      expect.objectContaining({
        kind: 'edit',
        fields: ['arrivalDate', 'custom_text', 'custom_money'],
      }),
    ]);
    expect(await storedValues(LEAD_EDIT)).toEqual({
      custom_text: 'New ref',
      custom_money: 2500,
      custom_choice: 'bronze',
    });
    const entries = await admin<{ kind: string; data: unknown }[]>`
      select kind, data from app.lead_activities where lead_id = ${LEAD_EDIT}
    `;
    expect(entries).toEqual([
      { kind: 'edit', data: { fields: ['arrivalDate', 'custom_text', 'custom_money'] } },
    ]);
    const [audit] = await admin<{ before: unknown; after: unknown }[]>`
      select before, after from app.audit_events
      where entity_id = ${LEAD_EDIT} and action = 'lead.updated'
      order by created_at desc limit 1
    `;
    expect(audit?.after).toEqual({
      changedFields: ['arrivalDate', 'custom_text', 'custom_money'],
    });
    // Neither the timeline nor the audit trail keeps the values.
    expect(JSON.stringify([entries, audit])).not.toContain('New ref');
    expect(JSON.stringify([entries, audit])).not.toContain('2500');

    // Clears with null: the key goes.
    const cleared = await work.updateLead({
      ...scope,
      leadId: LEAD_EDIT,
      customValues: { custom_text: null },
    });
    if (cleared.status !== 'updated') throw new Error('expected updated');
    expect(cleared.activities).toEqual([
      expect.objectContaining({ kind: 'edit', fields: ['custom_text'] }),
    ]);
    expect(await storedValues(LEAD_EDIT)).toEqual({ custom_money: 2500, custom_choice: 'bronze' });

    // Moving off the hidden option is allowed; moving back is not.
    expect(
      await work.updateLead({
        ...scope,
        leadId: LEAD_EDIT,
        customValues: { custom_choice: 'silver' },
      }),
    ).toMatchObject({ status: 'updated' });

    const before = await storedValues(LEAD_EDIT);
    const refusals: Array<[Record<string, string | number | boolean | null>, string]> = [
      [{ custom_choice: 'bronze' }, 'custom_choice'],
      [{ custom_nope: 'x' }, 'custom_nope'],
      [{ custom_money: 19.99 }, 'custom_money'],
      [{ custom_yesNo: 'yes' }, 'custom_yesNo'],
      [{ custom_text: '' }, 'custom_text'],
      [{ custom_hidden: 'x' }, 'custom_hidden'],
      [{ custom_net: 'x' }, 'custom_net'],
      [{ arrivalDate: '2026-11-09' }, 'arrivalDate'],
    ];
    for (const [customValues, field] of refusals) {
      expect(
        await work.updateLead({
          ...scope,
          leadId: LEAD_EDIT,
          stage: 'verified',
          customValues: { custom_text: 'Would be set', ...customValues },
        }),
      ).toEqual({ status: 'invalid_field', field });
    }
    // A refused value changes nothing at all, the stage and the other values included.
    expect(await storedValues(LEAD_EDIT)).toEqual(before);
    const [row] = await admin<
      { stage: string }[]
    >`select stage from app.leads where id = ${LEAD_EDIT}`;
    expect(row?.stage).toBe('pending');
    const count = await admin<{ total: number }[]>`
      select count(*)::int as total from app.lead_activities where lead_id = ${LEAD_EDIT}
    `;
    expect(count[0]?.total).toBe(3);

    // The same value again is no change and writes nothing.
    expect(
      await work.updateLead({ ...scope, leadId: LEAD_EDIT, customValues: { custom_money: 2500 } }),
    ).toMatchObject({ status: 'updated', activities: [] });

    // A restricted lead does not exist here, whatever the edit carries.
    expect(
      await work.updateLead({
        ...scope,
        leadId: LEAD_RESTRICTED,
        customValues: { custom_text: 'Rewritten' },
      }),
    ).toEqual({ status: 'not_found' });
    expect(await storedValues(LEAD_RESTRICTED)).toEqual({ custom_text: 'Kept' });
  });

  it('detail returns customValues with contact access and omits them without', async () => {
    const scope = { workspaceId: SITE, actorId: ACTOR, leadId: LEAD_A, catalog };
    const page = await work.getLead({ ...scope, includeWork: true });
    expect(page?.lead.customValues).toEqual({ ...valuesOf('a'), custom_secret: 'A-SECRET-VALUE' });

    const hidden = await work.getLead({ ...scope, includeWork: false });
    expect(hidden?.lead).toBeDefined();
    expect(hidden?.lead.customValues).toBeUndefined();

    // A value that is not a plain value is left out rather than failing the page.
    const malformed = await work.getLead({ ...scope, leadId: LEAD_M, includeWork: true });
    expect(malformed?.lead.customValues).toEqual(valuesOf('malformed'));
    const none = await work.getLead({ ...scope, leadId: LEAD_C, includeWork: true });
    expect(none?.lead.customValues).toEqual({});
  });
});
