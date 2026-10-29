import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { codePropertyCatalog } from '@gt-sales/contracts';
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

// Distinct id range for property filter/sort/column integration tests.
const SITE = '17000000-0000-4000-8000-000000000f01';
const OTHER_SITE = '17000000-0000-4000-8000-000000000f02';
const ACTOR = '27000000-0000-4000-8000-000000000f01';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const LEAD_SIM_1 = '97000000-0000-4000-8000-000000000001';
const LEAD_SIM_2 = '97000000-0000-4000-8000-000000000002';
const LEAD_SIM_3 = '97000000-0000-4000-8000-000000000003';
const LEAD_SIM_MALFORMED = '97000000-0000-4000-8000-000000000004';
const LEAD_SIM_TRASHED = '97000000-0000-4000-8000-000000000005';
const LEAD_SIM_RESTRICTED = '97000000-0000-4000-8000-000000000006';
const LEAD_MOB_1 = '97000000-0000-4000-8000-000000000007';
const LEAD_MOB_2 = '97000000-0000-4000-8000-000000000008';
const LEAD_MOB_MALFORMED = '97000000-0000-4000-8000-000000000009';
const LEAD_OTHER_SITE = '97000000-0000-4000-8000-000000000010';

databaseTest('lead property filters, sorting and columns (staff-queries)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;

  const insertLead = async (input: {
    id: string;
    workspaceId: string;
    leadType: string;
    stage: string;
    fullName?: string;
    externalRef?: string;
    payload: Record<string, string | number | boolean | null>;
    trashed?: boolean;
    restricted?: boolean;
  }) => {
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, full_name, external_ref,
        consent_version, attribution, payload, deleted_at, customer_data_restricted_at
      ) values (
        ${input.id},
        ${input.workspaceId},
        ${input.leadType},
        'submitted',
        ${input.stage},
        ${input.fullName ?? null},
        ${input.externalRef ?? null},
        'ci',
        '{}'::jsonb,
        ${admin.json({ schemaVersion: 1, payload: input.payload })},
        ${input.trashed ? new Date() : null},
        ${input.restricted ? new Date() : null}
      )
    `;
  };

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
      values
        (${SITE}, 'prop-filters-f01', 'Prop Filters Site'),
        (${OTHER_SITE}, 'prop-filters-f02', 'Prop Filters Other')
    `;

    // SIM order 1: student, arrival 2026-11-10, gotVisa true, wildcard reference "100%_batch"
    await insertLead({
      id: LEAD_SIM_1,
      workspaceId: SITE,
      leadType: 'sim_order',
      stage: 'pending',
      fullName: 'Charlie Alpha',
      externalRef: 'REF-02',
      payload: {
        permitType: 'student',
        arrivalDate: '2026-11-10',
        gotVisa: true,
        reference: '100%_batch',
        canadaAddress: '  Toronto  ',
        dateOfBirth: '1999-01-01',
      },
    });

    // SIM order 2: student, arrival 2026-11-05, gotVisa false, empty string reference
    await insertLead({
      id: LEAD_SIM_2,
      workspaceId: SITE,
      leadType: 'sim_order',
      stage: 'verified',
      fullName: 'Alice Beta',
      externalRef: 'REF-01',
      payload: {
        permitType: 'student',
        arrivalDate: '2026-11-05',
        gotVisa: false,
        reference: '   ',
        canadaAddress: 'Vancouver',
      },
    });

    // SIM order 3: worker, arrival 2026-11-10 (tie on date with SIM 1), missing reference & gotVisa
    await insertLead({
      id: LEAD_SIM_3,
      workspaceId: SITE,
      leadType: 'sim_order',
      stage: 'pending',
      fullName: 'Bob Gamma',
      payload: {
        permitType: 'worker',
        arrivalDate: '2026-11-10',
        canadaAddress: 'Montreal',
      },
    });

    // SIM order 4: malformed date ("not-a-date") and non-wildcard reference ("1000Xbatch")
    await insertLead({
      id: LEAD_SIM_MALFORMED,
      workspaceId: SITE,
      leadType: 'sim_order',
      stage: 'pending',
      payload: {
        permitType: 'tourist',
        arrivalDate: 'not-a-date',
        reference: '1000Xbatch',
        canadaAddress: 'Toronto',
      },
    });

    // SIM order 5: trashed student order
    await insertLead({
      id: LEAD_SIM_TRASHED,
      workspaceId: SITE,
      leadType: 'sim_order',
      stage: 'pending',
      trashed: true,
      payload: {
        permitType: 'student',
        arrivalDate: '2026-11-01',
      },
    });

    // SIM order 6: restricted student order (must never appear)
    await insertLead({
      id: LEAD_SIM_RESTRICTED,
      workspaceId: SITE,
      leadType: 'sim_order',
      stage: 'pending',
      restricted: true,
      payload: {
        permitType: 'student',
        arrivalDate: '2026-11-01',
      },
    });

    // Mobility 1: lineCount = 10, city = Calgary, consentedAt valid ISO
    await insertLead({
      id: LEAD_MOB_1,
      workspaceId: SITE,
      leadType: 'mobility',
      stage: 'new',
      payload: {
        lineCount: 10,
        city: 'Calgary',
        consentedAt: '2026-10-20T12:00:00.000Z',
      },
    });

    // Mobility 2: lineCount = 2, city = "  calgary "
    await insertLead({
      id: LEAD_MOB_2,
      workspaceId: SITE,
      leadType: 'mobility',
      stage: 'new',
      payload: {
        lineCount: 2,
        city: '  calgary ',
        consentedAt: '2026-10-25T12:00:00.000Z',
      },
    });

    // Mobility 3: string where a number belongs ("ten"), malformed dateTime
    await insertLead({
      id: LEAD_MOB_MALFORMED,
      workspaceId: SITE,
      leadType: 'mobility',
      stage: 'new',
      payload: {
        lineCount: 'ten',
        consentedAt: 'not-a-datetime',
      },
    });

    // Other workspace lead (must never appear in SITE queries)
    await insertLead({
      id: LEAD_OTHER_SITE,
      workspaceId: OTHER_SITE,
      leadType: 'sim_order',
      stage: 'pending',
      payload: {
        permitType: 'student',
        arrivalDate: '2026-11-05',
      },
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

  test('filters by text (case-insensitive eq, escaped contains, empty, notEmpty)', async () => {
    const eqRes = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'mobility',
      where: [{ key: 'city', op: 'eq', value: 'CALGARY' }],
    });
    expect(eqRes.leads.map((l) => l.id).sort()).toEqual([LEAD_MOB_1, LEAD_MOB_2]);

    const containsRes = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'reference', op: 'contains', value: '100%_' }],
    });
    expect(containsRes.leads.map((l) => l.id)).toEqual([LEAD_SIM_1]);

    const emptyRes = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'reference', op: 'empty' }],
    });
    expect(emptyRes.leads.map((l) => l.id).sort()).toEqual([LEAD_SIM_2, LEAD_SIM_3]);

    const notEmptyRes = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'reference', op: 'notEmpty' }],
    });
    expect(notEmptyRes.leads.map((l) => l.id).sort()).toEqual([LEAD_SIM_1, LEAD_SIM_MALFORMED]);
  });

  test('filters by choice (eq, in), date, dateTime, count and yesNo without raising on malformed values', async () => {
    const choiceEq = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'permitType', op: 'eq', value: 'student' }],
    });
    expect(choiceEq.leads.map((l) => l.id).sort()).toEqual([LEAD_SIM_1, LEAD_SIM_2]);

    const choiceIn = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'permitType', op: 'in', value: ['student', 'worker'] }],
    });
    expect(choiceIn.leads.map((l) => l.id).sort()).toEqual([LEAD_SIM_1, LEAD_SIM_2, LEAD_SIM_3]);

    const dateLte = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'arrivalDate', op: 'lte', value: '2026-11-06' }],
    });
    expect(dateLte.leads.map((l) => l.id)).toEqual([LEAD_SIM_2]);

    const countGte = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'mobility',
      where: [{ key: 'lineCount', op: 'gte', value: 5 }],
    });
    expect(countGte.leads.map((l) => l.id)).toEqual([LEAD_MOB_1]);

    const yesNoFalse = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'gotVisa', op: 'eq', value: false }],
    });
    expect(yesNoFalse.leads.map((l) => l.id)).toEqual([LEAD_SIM_2]);
  });

  test('sorts asc and desc for text, date and count with nulls last and stable tie-breaker by id', async () => {
    const dateAsc = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      sort: 'prop.arrivalDate:asc',
    });
    expect(dateAsc.leads.map((l) => l.id)).toEqual([
      LEAD_SIM_2,
      LEAD_SIM_1,
      LEAD_SIM_3,
      LEAD_SIM_MALFORMED,
    ]);

    const dateDesc = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      sort: 'prop.arrivalDate:desc',
    });
    expect(dateDesc.leads.map((l) => l.id)).toEqual([
      LEAD_SIM_1,
      LEAD_SIM_3,
      LEAD_SIM_2,
      LEAD_SIM_MALFORMED,
    ]);

    const countAsc = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'mobility',
      sort: 'prop.lineCount:asc',
    });
    expect(countAsc.leads.map((l) => l.id)).toEqual([LEAD_MOB_2, LEAD_MOB_1, LEAD_MOB_MALFORMED]);

    const countDesc = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'mobility',
      sort: 'prop.lineCount:desc',
    });
    expect(countDesc.leads.map((l) => l.id)).toEqual([LEAD_MOB_1, LEAD_MOB_2, LEAD_MOB_MALFORMED]);

    const textAsc = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      sort: 'prop.canadaAddress:asc',
    });
    expect(textAsc.leads.map((l) => l.id)).toEqual([
      LEAD_SIM_3,
      LEAD_SIM_1,
      LEAD_SIM_MALFORMED,
      LEAD_SIM_2,
    ]);
  });

  test('computes page totals, page 2, trash view, board view and requested non-sensitive columns', async () => {
    const page1 = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'permitType', op: 'in', value: ['student', 'worker'] }],
      sort: 'prop.arrivalDate:asc',
      columns: ['arrivalDate', 'permitType', 'dateOfBirth'],
      page: 1,
      pageSize: 2,
    });
    expect(page1.page).toEqual({ page: 1, pageSize: 2, total: 3 });
    expect(page1.leads.map((l) => l.id)).toEqual([LEAD_SIM_2, LEAD_SIM_1]);
    expect(page1.leads[1]?.properties).toEqual({
      arrivalDate: '2026-11-10',
      permitType: 'student',
    });

    const page2 = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      where: [{ key: 'permitType', op: 'in', value: ['student', 'worker'] }],
      sort: 'prop.arrivalDate:asc',
      page: 2,
      pageSize: 2,
    });
    expect(page2.page).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(page2.leads.map((l) => l.id)).toEqual([LEAD_SIM_3]);
    expect(page2.leads[0]?.properties).toBeUndefined();

    const trashRes = await leadStore.listLeads({
      workspaceId: SITE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      view: 'trash',
      where: [{ key: 'permitType', op: 'eq', value: 'student' }],
    });
    expect(trashRes.leads.map((l) => l.id)).toEqual([LEAD_SIM_TRASHED]);

    const boardCols = await work.board(
      {
        workspaceId: SITE,
        actorId: ACTOR,
        catalog: codePropertyCatalog,
        leadType: 'sim_order',
        where: [{ key: 'permitType', op: 'eq', value: 'student' }],
      },
      50,
    );
    const pendingCol = boardCols.find((col) => col.stage === 'pending');
    const verifiedCol = boardCols.find((col) => col.stage === 'verified');
    expect(pendingCol?.total).toBe(1);
    expect(pendingCol?.leads.map((l) => l.id)).toEqual([LEAD_SIM_1]);
    expect(verifiedCol?.total).toBe(1);
    expect(verifiedCol?.leads.map((l) => l.id)).toEqual([LEAD_SIM_2]);
  });
});
