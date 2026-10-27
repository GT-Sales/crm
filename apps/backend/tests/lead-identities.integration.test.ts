import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';

import { openSensitiveValue } from '../src/crypto/cipher.js';
import { DatabaseIdentityStore } from '../src/leads/identity-store.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { claimLegacyTables, releaseLegacyTables } from './support/legacy-canadawide.js';

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
const CANADAWIDE_CANDIDATE = '12000000-0000-4000-8000-000000000d01';
const OTHER_WORKSPACE = '12000000-0000-4000-8000-000000000d02';
const ACTOR = '22000000-0000-4000-8000-000000000d01';
const OWNER = '22000000-0000-4000-8000-000000000d02';
const REQUEST_ID = '32000000-0000-4000-8000-000000000d01';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const KEY = 'ci-sensitive-fields-key-0123456789abcdef';
// Made-up numbers that pass the Luhn check, never a real person's.
const SIN = '046454286';
const OTHER_SIN = '130692544';

const contact = {
  fullName: 'Avery Example',
  email: 'avery.identity@example.test',
  phone: '403 555 0101',
  countryCode: 'CA',
};

const mobilityPayload = {
  planId: 'cw-100gb',
  planLabel: '100 GB $40',
  lineCount: 1,
  firstName: 'Avery',
  lastName: 'Example',
  keepNumber: false,
  simType: 'esim',
  currentProvider: 'Rogers',
  streetAddress: '12 Example Street',
  city: 'Calgary',
  postalCode: 'T2P 1J9',
};

const internetPayload = {
  planId: 'ab-1gbps',
  planLabel: '1Gbps',
  landingCity: 'calgary',
  dateOfBirth: '1990-04-12',
  streetAddress: '12 Example Street',
  city: 'Calgary',
  postalCode: 'T2P 1J9',
  currentProvider: 'Shaw',
  consent: true,
  consentedAt: '2026-10-26T10:00:00.000Z',
};

databaseTest('lead identities (migrations 0005–0006)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadsStore: DatabaseLeadStore;
  let store: DatabaseIdentityStore;
  let canadawide: string;

  const lead = async (
    workspaceId: string,
    leadType = 'mobility',
    payload: Record<string, unknown> = mobilityPayload,
  ) =>
    (
      await leadsStore.createLead({
        workspaceId,
        actorId: ACTOR,
        requestId: REQUEST_ID,
        leadType,
        contact,
        form: { schemaVersion: 1, payload },
        consentVersion: 'cw-mobility-v1',
        submit: true,
      })
    ).lead.id;

  const scope = (workspaceId: string, leadId: string) => ({
    workspaceId,
    actorId: ACTOR,
    requestId: REQUEST_ID,
    leadId,
    consentedAt: new Date('2026-10-27T09:00:00.000Z'),
  });

  /** A verified licence photo on the lead, as the documents service leaves one. */
  const licenceFile = async (
    workspaceId: string,
    leadId: string,
    overrides: { documentType?: string; status?: string } = {},
  ) => {
    const status = overrides.status ?? 'available';
    const [row] = await admin<{ id: string }[]>`
      insert into app.files (
        workspace_id, record_type, record_id, document_type, bucket, staging_key, object_key,
        declared_content_type, detected_mime, declared_size_bytes, size_bytes, checksum_sha256,
        status, uploaded_by, expires_at
      ) values (
        ${workspaceId}, 'lead', ${leadId}, ${overrides.documentType ?? 'drivers_licence'},
        'documents', ${`staging/ci/${randomUUID()}`},
        ${status === 'available' ? `candidate/ci/${randomUUID()}` : null},
        'image/jpeg', ${status === 'available' ? 'image/jpeg' : null}, 1000,
        ${status === 'available' ? 1000 : null},
        ${status === 'available' ? 'a'.repeat(64) : null}, ${status}, ${ACTOR},
        now() + interval '1 hour'
      )
      returning id
    `;
    return row!.id;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await claimLegacyTables(admin);
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${CANADAWIDE_CANDIDATE}, 'canadawide', 'CanadaWide'),
             (${OTHER_WORKSPACE}, 'ci-identity-other', 'CI Identity Other')
      on conflict do nothing
    `;
    const [row] = await admin<{ id: string }[]>`
      select id from app.workspaces where slug = 'canadawide'
    `;
    if (!row) throw new Error('expected the canadawide workspace');
    canadawide = row.id;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    leadsStore = new DatabaseLeadStore(database);
    store = new DatabaseIdentityStore(KEY, database);
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await releaseLegacyTables(admin);
    await admin.end();
  });

  test('keeps a SIN sealed to its row, with only the last three digits readable', async () => {
    const leadId = await lead(canadawide);
    const outcome = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: SIN,
      dateOfBirth: '1990-01-31',
    });
    expect(outcome).toMatchObject({ status: 'recorded', mirrored: true, replayed: false });
    if (outcome.status !== 'recorded') throw new Error('expected recorded');

    const [row] = await admin<
      { sin_sealed: string; sin_last3: string; dob: string; consent: Date; created_by: string }[]
    >`
      select sin_sealed, sin_last3, date_of_birth::text as dob,
             credit_check_consent_at as consent, created_by
      from app.lead_identities where id = ${outcome.identity.id}
    `;
    expect(row!.sin_sealed).not.toContain(SIN);
    expect(row!.sin_last3).toBe('286');
    expect(row!.dob).toBe('1990-01-31');
    expect(row!.consent.toISOString()).toBe('2026-10-27T09:00:00.000Z');
    expect(row!.created_by).toBe(ACTOR);
    const binding = {
      workspaceId: canadawide,
      recordId: outcome.identity.id,
      field: 'sin' as const,
    };
    expect(openSensitiveValue(KEY, binding, row!.sin_sealed)).toBe(SIN);
    // Moved to another row, it does not open.
    expect(
      openSensitiveValue(KEY, { ...binding, recordId: leadId }, row!.sin_sealed),
    ).toBeUndefined();

    // Nowhere in the CRM's own tables in the clear: not the identity, not the audit trail.
    const [clear] = await admin<{ hits: number }[]>`
      select (
        (select count(*) from app.lead_identities i where i.workspace_id = ${canadawide}
           and row_to_json(i)::text like ${'%' + SIN + '%'})
        + (select count(*) from app.audit_events a where a.workspace_id = ${canadawide}
           and row_to_json(a)::text like ${'%' + SIN + '%'})
      )::int as hits
    `;
    expect(clear!.hits).toBe(0);
    const [audit] = await admin<{ actor_label: string; after: Record<string, unknown> }[]>`
      select actor_label, after from app.audit_events
      where workspace_id = ${canadawide} and action = 'lead.identity_received' and entity_id = ${leadId}
    `;
    expect(audit).toEqual({
      actor_label: 'website credential',
      after: { identityId: outcome.identity.id, idType: 'sin', legacyCopy: true },
    });
  });

  test("copies the identity into the old admin's table, SIN in the clear as it always had", async () => {
    const leadId = await lead(canadawide);
    const outcome = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: SIN,
      dateOfBirth: '1990-01-31',
    });
    if (outcome.status !== 'recorded') throw new Error('expected recorded');
    const [row] = await admin`
      select lead_id, id_type, id_file_path, sin, date_of_birth::text as dob,
             credit_check_consent, consented_at
      from public.mobility_id_uploads where id = ${outcome.identity.id}
    `;
    expect(row).toMatchObject({
      lead_id: leadId,
      id_type: 'sin',
      id_file_path: null,
      sin: SIN,
      dob: '1990-01-31',
      credit_check_consent: true,
    });
  });

  test('answers a retried SIN with the identity on file, and caps a lead at three', async () => {
    const leadId = await lead(canadawide);
    const first = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: SIN,
      dateOfBirth: '1990-01-31',
    });
    const again = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: SIN,
      dateOfBirth: '1990-01-31',
    });
    if (first.status !== 'recorded') throw new Error('expected recorded');
    expect(again).toMatchObject({ status: 'recorded', replayed: true, identity: first.identity });

    // Same last three digits and birth date, a different number: a new identity.
    const other = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: OTHER_SIN.slice(0, 6) + '286',
      dateOfBirth: '1990-01-31',
    });
    expect(other.status).toBe('recorded');
    const third = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: OTHER_SIN,
      dateOfBirth: '1985-06-01',
    });
    expect(third).toMatchObject({ status: 'recorded', replayed: false });
    const fourth = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: OTHER_SIN,
      dateOfBirth: '1985-06-02',
    });
    expect(fourth).toEqual({ status: 'limit_reached' });
    expect(await store.eligibility({ workspaceId: canadawide, actorId: ACTOR, leadId })).toEqual({
      status: 'limit_reached',
    });
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.lead_identities where lead_id = ${leadId}
    `;
    expect(count!.n).toBe(3);
  });

  test('takes an identity only for a recent, live lead of a type that has one, on its own site', async () => {
    const internet = await lead(canadawide, 'internet', internetPayload);
    const trashed = await lead(canadawide);
    const old = await lead(canadawide);
    const elsewhere = await lead(OTHER_WORKSPACE);
    await admin`update app.leads set deleted_at = now() where id = ${trashed}`;
    await admin`update app.leads set created_at = now() - interval '25 hours' where id = ${old}`;

    for (const leadId of [internet, trashed, old]) {
      expect(await store.eligibility({ workspaceId: canadawide, actorId: ACTOR, leadId })).toEqual({
        status: 'not_found',
      });
      expect(
        await store.recordSin({
          ...scope(canadawide, leadId),
          sin: SIN,
          dateOfBirth: '1990-01-31',
        }),
      ).toEqual({ status: 'not_found' });
    }
    // Another site's lead, asked for under CanadaWide's credential, is not there at all.
    expect(
      await store.eligibility({ workspaceId: canadawide, actorId: ACTOR, leadId: elsewhere }),
    ).toEqual({ status: 'not_found' });
    // On its own site it is eligible, with nothing to copy to the old admin.
    expect(
      await store.eligibility({ workspaceId: OTHER_WORKSPACE, actorId: ACTOR, leadId: elsewhere }),
    ).toEqual({ status: 'eligible', legacy: false });
    const outcome = await store.recordSin({
      ...scope(OTHER_WORKSPACE, elsewhere),
      sin: SIN,
      dateOfBirth: '1990-01-31',
    });
    expect(outcome).toMatchObject({ status: 'recorded', mirrored: false });
    const legacy =
      await admin`select 1 from public.mobility_id_uploads where lead_id = ${elsewhere}`;
    expect(legacy).toHaveLength(0);
  });

  test('records a verified licence photo once, with its copied path in the old admin', async () => {
    const leadId = await lead(canadawide);
    expect(await store.eligibility({ workspaceId: canadawide, actorId: ACTOR, leadId })).toEqual({
      status: 'eligible',
      legacy: true,
    });
    const fileId = await licenceFile(canadawide, leadId);
    const path = `${leadId}/${fileId}.jpg`;
    const outcome = await store.recordLicence({
      ...scope(canadawide, leadId),
      fileId,
      legacyPath: path,
    });
    expect(outcome).toMatchObject({
      status: 'recorded',
      mirrored: true,
      replayed: false,
      identity: { idType: 'drivers_licence' },
    });
    if (outcome.status !== 'recorded') throw new Error('expected recorded');
    const [legacy] = await admin`
      select id_type, id_file_path, sin, date_of_birth
      from public.mobility_id_uploads where id = ${outcome.identity.id}
    `;
    expect(legacy).toEqual({
      id_type: 'drivers-licence',
      id_file_path: path,
      sin: null,
      date_of_birth: null,
    });

    const again = await store.recordLicence({
      ...scope(canadawide, leadId),
      fileId,
      legacyPath: path,
    });
    expect(again).toMatchObject({ status: 'recorded', replayed: true, identity: outcome.identity });

    // Without a copied path the old admin is skipped, never left with a broken row.
    const unmirrored = await store.recordLicence({
      ...scope(canadawide, leadId),
      fileId: await licenceFile(canadawide, leadId),
      legacyPath: null,
    });
    expect(unmirrored).toMatchObject({ status: 'recorded', mirrored: false });
  });

  test("refuses a file that is not this lead's verified licence", async () => {
    const leadId = await lead(canadawide);
    const otherLead = await lead(canadawide);
    for (const fileId of [
      await licenceFile(canadawide, leadId, { documentType: 'passport' }),
      await licenceFile(canadawide, leadId, { status: 'uploading' }),
      await licenceFile(canadawide, otherLead),
    ]) {
      expect(
        await store.recordLicence({ ...scope(canadawide, leadId), fileId, legacyPath: null }),
      ).toEqual({ status: 'file_not_usable' });
    }
  });

  test('reveals a SIN with an audit row, and nothing for the wrong lead or key', async () => {
    const leadId = await lead(canadawide);
    const recordedSin = await store.recordSin({
      ...scope(canadawide, leadId),
      sin: SIN,
      dateOfBirth: '1990-01-31',
    });
    if (recordedSin.status !== 'recorded') throw new Error('expected recorded');
    const identityId = recordedSin.identity.id;
    const reveal = { workspaceId: canadawide, actorId: OWNER, requestId: REQUEST_ID };

    expect(await store.revealSin({ ...reveal, leadId, identityId })).toEqual({
      status: 'revealed',
      sin: SIN,
    });
    const audits = await admin<{ actor_id: string; actor_label: string; after: unknown }[]>`
      select actor_id, actor_label, after from app.audit_events
      where workspace_id = ${canadawide} and action = 'lead.identity_revealed' and entity_id = ${leadId}
    `;
    expect(audits).toEqual([
      { actor_id: OWNER, actor_label: 'staff actor', after: { identityId } },
    ]);

    const otherLead = await lead(canadawide);
    expect(await store.revealSin({ ...reveal, leadId: otherLead, identityId })).toEqual({
      status: 'not_found',
    });
    expect(
      await store.revealSin({ ...reveal, workspaceId: OTHER_WORKSPACE, leadId, identityId }),
    ).toEqual({ status: 'not_found' });
    const wrongKey = new DatabaseIdentityStore(`${KEY}-rotated`, database);
    expect(await wrongKey.revealSin({ ...reveal, leadId, identityId })).toEqual({
      status: 'unreadable',
    });
  });

  test('gives the runtime role no way to rewrite or remove an identity', async () => {
    const leadId = await lead(canadawide);
    await store.recordSin({ ...scope(canadawide, leadId), sin: SIN, dateOfBirth: '1990-01-31' });
    const [grants] = await admin<{ can_update: boolean; can_delete: boolean }[]>`
      select has_table_privilege('app_runtime', 'app.lead_identities', 'update') as can_update,
             has_table_privilege('app_runtime', 'app.lead_identities', 'delete') as can_delete
    `;
    expect(grants).toEqual({ can_update: false, can_delete: false });
    await expect(
      database.withTenantTx({ workspaceId: canadawide, actorId: ACTOR }, (tx) =>
        tx.execute(sql`update app.lead_identities set sin_last3 = '000' where lead_id = ${leadId}`),
      ),
    ).rejects.toThrow();
  });
});
