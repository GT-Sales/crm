import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorResponseSchema, createLeadResponseSchema } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { createApp } from '../src/app.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { generateServiceSecret } from '../src/website/credential.js';
import {
  credentialPermitsLeadType,
  fixedCredentialLeadTypesSchema,
} from '../src/website/credential-schema.js';
import {
  CredentialLeadTypesUnavailableError,
  DatabaseWebsiteCredentialStore,
} from '../src/website/store.js';

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

// A distinct id range for issue #84.
const SITE = '84000000-0000-4000-8000-000000008401';
/** A site that has taken leads, for the backfill. */
const BUSY_SITE = '84000000-0000-4000-8000-000000008402';
/** A site with no lead yet, for the backfill. */
const NEW_SITE = '84000000-0000-4000-8000-000000008403';
const OWNER = '84000000-0000-4000-8000-000000008411';
const LIMITED_KEY = '84000000-0000-4000-8000-000000008421';
const UNLIMITED_KEY = '84000000-0000-4000-8000-000000008422';
const BUSY_KEY = '84000000-0000-4000-8000-000000008423';
const BUSY_SET_KEY = '84000000-0000-4000-8000-000000008424';
const NEW_KEY = '84000000-0000-4000-8000-000000008425';
const SITES = [SITE, BUSY_SITE, NEW_SITE];
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789',
};

// Issue #84: a website key creates and saves only the lead types it is permitted.
databaseTest('website keys are limited to their lead types', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let server: Server;
  let baseUrl: string;
  const limited = generateServiceSecret();
  const unlimited = generateServiceSecret();

  const call = async (
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${baseUrl}/api/v1/website${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json();
    return { status: response.status, body: json };
  };
  const errorOf = (body: unknown) => apiErrorResponseSchema.parse(body).error;
  const lead = (leadType: string, email: string, extra: Record<string, unknown> = {}) => ({
    leadType,
    contact: { fullName: 'Ada Example', email },
    consentVersion: 'ci',
    ...extra,
  });
  const leadsOf = (leadType: string) =>
    admin<{ id: string; status: string; fullName: string | null }[]>`
      select id, status, full_name as "fullName" from app.leads
      where workspace_id = ${SITE} and lead_type = ${leadType} order by created_at
    `;
  const setLeadTypes = (credentialId: string, leadTypes: string[] | null) =>
    admin`update app.service_credentials set lead_types = ${leadTypes} where id = ${credentialId}`;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting the sites removes their keys, leads, grants, idempotency keys and audit rows.
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(SITES)}`;
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
    await admin`delete from app.contacts where email like 'lead-types-84%@example.test'`;
    await admin`
      insert into app.workspaces (id, slug, name) values
        (${SITE}, 'ci-credential-lead-types-8401', 'CI Key Lead Types'),
        (${BUSY_SITE}, 'ci-credential-lead-types-8402', 'CI Key Lead Types Busy'),
        (${NEW_SITE}, 'ci-credential-lead-types-8403', 'CI Key Lead Types New')
    `;
    await admin`
      insert into app.service_credentials (id, workspace_id, secret_hash, scopes, lead_types) values
        (${LIMITED_KEY}, ${SITE}, ${limited.secretHash}, array['leads:write'], array['contact_message']),
        (${UNLIMITED_KEY}, ${SITE}, ${unlimited.secretHash}, array['leads:write'], null)
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    const leadStore = new DatabaseLeadStore(database, customerEmailEnvironmentFromEnv(ENV));
    server = createApp({
      website: {
        auth: {
          resolveCredential: database.resolveWebsiteCredential,
          // The limiter is not under test; its windows would outlive a run.
          rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
          botCheck: () => true,
        },
        leads: { store: leadStore },
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (admin) {
      await admin`delete from app.outbox_jobs where workspace_id in ${admin(SITES)}`;
      await admin`delete from app.workspaces where id in ${admin(SITES)}`;
      await admin`delete from app.contacts where email like 'lead-types-84%@example.test'`;
    }
    await database?.close();
    await admin?.end();
  });

  it('takes a permitted type as a draft and as a submitted lead', async () => {
    const draft = await call(
      'POST',
      '/leads',
      limited.secret,
      lead('contact_message', 'lead-types-84-draft@example.test'),
    );
    expect(draft.status).toBe(201);
    const submitted = await call(
      'POST',
      '/leads',
      limited.secret,
      lead('contact_message', 'lead-types-84-submitted@example.test', { submit: true }),
    );
    expect(submitted.status).toBe(201);
    expect((await leadsOf('contact_message')).map((row) => row.status)).toEqual([
      'incomplete',
      'submitted',
    ]);
  });

  it('refuses a type outside the key’s set with a clear error and creates nothing', async () => {
    for (const extra of [{}, { submit: true }]) {
      const refused = await call(
        'POST',
        '/leads',
        limited.secret,
        lead('partner_application', 'lead-types-84-refused@example.test', extra),
        { 'Idempotency-Key': `lead-types-84-${'submit' in extra ? 'submit' : 'draft'}` },
      );
      expect(refused.status).toBe(403);
      expect(errorOf(refused.body)).toMatchObject({
        code: 'lead_type_not_permitted',
        details: { field: 'leadType' },
      });
    }
    // No lead, no contact, no claimed idempotency key, no audit event.
    expect(await leadsOf('partner_application')).toEqual([]);
    const [left] = await admin<{ contacts: number; keys: number; audits: number }[]>`
      select
        (select count(*)::int from app.contacts where email = 'lead-types-84-refused@example.test') as contacts,
        (select count(*)::int from app.idempotency_keys where workspace_id = ${SITE}) as keys,
        (select count(*)::int from app.audit_events
          where workspace_id = ${SITE} and actor_id = ${LIMITED_KEY} and action = 'lead.created') as audits
    `;
    // The two leads of the test above, and nothing from the refusals.
    expect(left).toEqual({ contacts: 0, keys: 0, audits: 2 });
  });

  it('refuses to save or submit a draft whose type the key is no longer permitted', async () => {
    const created = await call(
      'POST',
      '/leads',
      limited.secret,
      lead('contact_message', 'lead-types-84-change@example.test'),
    );
    const { lead: summary, draftGrant } = createLeadResponseSchema.parse(created.body);
    if (!draftGrant) throw new Error('expected a draft grant');
    const save = (body: unknown) =>
      call('PATCH', `/leads/${summary.id}`, limited.secret, body, {
        'x-draft-grant': draftGrant.token,
      });
    expect((await save({ contact: { fullName: 'Ada First' } })).status).toBe(200);

    await setLeadTypes(LIMITED_KEY, ['internet']);
    try {
      for (const body of [{ contact: { fullName: 'Ada Second' } }, { submit: true }]) {
        const refused = await save(body);
        expect(refused.status).toBe(403);
        expect(errorOf(refused.body).code).toBe('lead_type_not_permitted');
      }
      const [row] = await admin<{ status: string; fullName: string | null }[]>`
        select status, full_name as "fullName" from app.leads where id = ${summary.id}
      `;
      expect(row).toEqual({ status: 'incomplete', fullName: 'Ada First' });
    } finally {
      await setLeadTypes(LIMITED_KEY, ['contact_message']);
    }
    // Permitted again, the same draft is submitted.
    expect((await save({ submit: true })).status).toBe(200);
  });

  it('leaves a key with no list (made before lead types existed) unlimited', async () => {
    for (const leadType of ['contact_message', 'partner_application']) {
      const created = await call(
        'POST',
        '/leads',
        unlimited.secret,
        lead(leadType, `lead-types-84-unlimited-${leadType}@example.test`),
      );
      expect(created.status).toBe(201);
    }
  });

  it('issues a key with its lead types and lists them', async () => {
    const store = new DatabaseWebsiteCredentialStore(database);
    const secret = generateServiceSecret();
    const record = await store.createCredential({
      actorId: OWNER,
      workspaceId: NEW_SITE,
      scopes: ['leads:write'],
      leadTypes: ['internet', 'mobility'],
      secretHash: secret.secretHash,
      requestId: '84000000-0000-4000-8000-000000008451',
    });
    expect(record.leadTypes).toEqual(['internet', 'mobility']);
    const listed = await store.listCredentials({ actorId: OWNER, workspaceId: NEW_SITE });
    expect(listed.map((entry) => entry.leadTypes)).toEqual([['internet', 'mobility']]);
    const [audit] = await admin<{ after: unknown }[]>`
      select after from app.audit_events
      where workspace_id = ${NEW_SITE} and action = 'service_credential.created'
    `;
    expect(audit?.after).toEqual({ scopes: ['leads:write'], leadTypes: ['internet', 'mobility'] });
    await admin`delete from app.service_credentials where id = ${record.id}`;
  });

  // The backend is deployed before the owner applies migration 0043.
  it('before the migration: nothing is limited, the list shows no types and no key is issued', async () => {
    const before = fixedCredentialLeadTypesSchema(false);
    const store = new DatabaseWebsiteCredentialStore(database, before);
    const listed = await store.listCredentials({ actorId: OWNER, workspaceId: SITE });
    expect(listed.map((entry) => entry.leadTypes)).toEqual([null, null]);
    await expect(
      store.createCredential({
        actorId: OWNER,
        workspaceId: SITE,
        scopes: ['leads:write'],
        leadTypes: ['internet'],
        secretHash: generateServiceSecret().secretHash,
        requestId: '84000000-0000-4000-8000-000000008452',
      }),
    ).rejects.toBeInstanceOf(CredentialLeadTypesUnavailableError);
    const permitted = await database.withTenantTx(
      { workspaceId: SITE, actorId: LIMITED_KEY },
      (tx) =>
        credentialPermitsLeadType(
          tx,
          { workspaceId: SITE, credentialId: LIMITED_KEY, leadType: 'partner_application' },
          before,
        ),
    );
    expect(permitted).toBe(true);
  });

  it('permits nothing to a key that is not this site’s', async () => {
    const permitted = await database.withTenantTx(
      { workspaceId: SITE, actorId: LIMITED_KEY },
      (tx) =>
        credentialPermitsLeadType(tx, {
          workspaceId: SITE,
          credentialId: BUSY_KEY,
          leadType: 'contact_message',
        }),
    );
    expect(permitted).toBe(false);
  });

  // Migration 0044, run inside a transaction that is rolled back: its one
  // statement covers every site's keys, and other suites share this database.
  it('backfills existing keys from their site’s leads, every type for a site with none', async () => {
    await admin`
      insert into app.service_credentials (id, workspace_id, secret_hash, scopes, lead_types) values
        (${BUSY_KEY}, ${BUSY_SITE}, ${generateServiceSecret().secretHash}, array['leads:write'], null),
        (${BUSY_SET_KEY}, ${BUSY_SITE}, ${generateServiceSecret().secretHash}, array['leads:write'], array['sim_order']),
        (${NEW_KEY}, ${NEW_SITE}, ${generateServiceSecret().secretHash}, array['leads:write'], null)
    `;
    // A draft, a submitted lead and an archived one: every lead the site holds counts.
    await admin`
      insert into app.leads (workspace_id, lead_type, status, consent_version, deleted_at) values
        (${BUSY_SITE}, 'mobility', 'incomplete', 'ci', null),
        (${BUSY_SITE}, 'internet', 'submitted', 'ci', null),
        (${BUSY_SITE}, 'internet', 'submitted', 'ci', now()),
        (${BUSY_SITE}, 'contact_message', 'submitted', 'ci', now())
    `;
    const migration = (
      await readFile(
        new URL(
          '../../../packages/db/drizzle/0044_credential_lead_types_backfill.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).replaceAll('--> statement-breakpoint', '');
    const ROLLBACK = new Error('rollback');
    const read = (tx: postgres.TransactionSql) => tx<{ id: string; leadTypes: string[] | null }[]>`
      select id, lead_types as "leadTypes" from app.service_credentials
      where id in ${tx([BUSY_KEY, BUSY_SET_KEY, NEW_KEY, UNLIMITED_KEY])} order by id
    `;
    let first: { id: string; leadTypes: string[] | null }[] = [];
    let second: { id: string; leadTypes: string[] | null }[] = [];
    await admin
      .begin(async (tx) => {
        await tx.unsafe(migration);
        first = await read(tx);
        // A second run changes nothing, and keeps a list corrected since.
        await tx`update app.service_credentials set lead_types = array['internet'] where id = ${NEW_KEY}`;
        await tx.unsafe(migration);
        second = await read(tx);
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
    expect(first).toEqual([
      // This suite's own site holds contact messages and a partner application by now.
      { id: UNLIMITED_KEY, leadTypes: ['contact_message', 'partner_application'] },
      { id: BUSY_KEY, leadTypes: ['contact_message', 'internet', 'mobility'] },
      { id: BUSY_SET_KEY, leadTypes: ['sim_order'] },
      {
        id: NEW_KEY,
        leadTypes: ['sim_order', 'internet', 'mobility', 'partner_application', 'contact_message'],
      },
    ]);
    expect(second).toEqual([
      first[0],
      first[1],
      first[2],
      { id: NEW_KEY, leadTypes: ['internet'] },
    ]);
    // Rolled back: this database's other keys are as they were.
    const [after] = await admin<{ leadTypes: string[] | null }[]>`
      select lead_types as "leadTypes" from app.service_credentials where id = ${BUSY_KEY}
    `;
    expect(after).toEqual({ leadTypes: null });
  });
});
