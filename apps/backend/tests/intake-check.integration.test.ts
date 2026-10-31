import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  INTAKE_CHECK_CONTACT,
  runIntakeCheck,
  type IntakeCheckDependencies,
} from '../src/intake-check/check.js';
import { DatabaseIntakeCheckStore, type IntakeCheckStore } from '../src/intake-check/store.js';
import { DatabaseLeadStore } from '../src/leads/store.js';

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

// The intake check suites' id range (…f7NN), distinct from every other file.
const SITE = '16000000-0000-4000-8000-00000000f701';
const OTHER_SITE = '16000000-0000-4000-8000-00000000f702';
/** Real-looking sites: one with a role, one with a membership, one with a site key. */
const ROLE_SITE = '16000000-0000-4000-8000-00000000f703';
const MEMBER_SITE = '16000000-0000-4000-8000-00000000f704';
const KEY_SITE = '16000000-0000-4000-8000-00000000f705';
const MISSING_SITE = '16000000-0000-4000-8000-00000000f7ff';
const ACTOR = '26000000-0000-4000-8000-00000000f701';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('the intake check on the database', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leads: DatabaseLeadStore;
  let store: DatabaseIntakeCheckStore;

  const run = (
    workspaceId: string,
    overrides: Partial<IntakeCheckDependencies> = {},
    requestId: string = randomUUID(),
  ) => runIntakeCheck({ leads, store, ...overrides }, { workspaceId, actorId: ACTOR, requestId });

  /**
   * A lead inserted straight into the site, `minutesAgo` old: by default one
   * the check itself would have made (its synthetic email), else a real one.
   */
  const insertLead = async (
    workspaceId: string,
    minutesAgo: number,
    email: string = INTAKE_CHECK_CONTACT.email,
  ): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (
        workspace_id, lead_type, status, stage, consent_version, email, created_at, updated_at
      ) values (
        ${workspaceId}, 'internet', 'submitted', 'new', 'ci', ${email},
        now() - make_interval(mins => ${minutesAgo}), now() - make_interval(mins => ${minutesAgo})
      )
      returning id
    `;
    if (!row) throw new Error('lead insert returned no row');
    return row.id;
  };

  const count = async (table: string, workspaceId: string): Promise<number> => {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from ${admin('app')}.${admin(table)}
      where workspace_id = ${workspaceId}
    `;
    return row?.n ?? -1;
  };

  const syntheticContacts = async (): Promise<number> => {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.contacts where email = ${INTAKE_CHECK_CONTACT.email}
    `;
    return row?.n ?? -1;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    for (const [id, slug] of [
      [SITE, 'intake-check-f701'],
      [OTHER_SITE, 'intake-check-f702'],
      [ROLE_SITE, 'intake-check-f703'],
      [MEMBER_SITE, 'intake-check-f704'],
      [KEY_SITE, 'intake-check-f705'],
    ] as const) {
      await admin`
        insert into app.workspaces (id, slug, name, status) values (${id}, ${slug}, ${slug}, 'active')
        on conflict (id) do nothing
      `;
    }
    const sites = [SITE, OTHER_SITE, ROLE_SITE, MEMBER_SITE, KEY_SITE];
    await admin`delete from app.leads where workspace_id in ${admin(sites)}`;
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(sites)}`;
    await admin`
      insert into app.roles (workspace_id, name) values (${ROLE_SITE}, 'owner')
      on conflict (workspace_id, name) do nothing
    `;
    await admin`delete from app.memberships where workspace_id = ${MEMBER_SITE}`;
    await admin`
      insert into app.memberships (workspace_id, membership_type, status, invited_email)
      values (${MEMBER_SITE}, 'staff', 'pending', 'staff@example.test')
    `;
    await admin`delete from app.service_credentials where workspace_id = ${KEY_SITE}`;
    await admin`
      insert into app.service_credentials (workspace_id, secret_hash)
      values (${KEY_SITE}, ${`intake-check-f705-${randomUUID()}`})
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    leads = new DatabaseLeadStore(database);
    store = new DatabaseIntakeCheckStore(database);
    // The run's one log line per run is not under test here.
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await database?.close();
    await admin?.end();
  });

  test('a run creates, verifies and deletes its lead and leaves no row behind', async () => {
    const requests = [randomUUID(), randomUUID()];
    for (const requestId of requests) {
      expect(await run(SITE, {}, requestId)).toMatchObject({ status: 'ok' });
    }
    for (const table of [
      'leads',
      'lead_activities',
      'draft_grants',
      'outbox_jobs',
      'automation_runs',
      'email_messages',
    ]) {
      expect(await count(table, SITE), table).toBe(0);
    }
    expect(await syntheticContacts()).toBe(1);
    const audits = await admin<{ action: string }[]>`
      select action from app.audit_events
      where workspace_id = ${SITE} and request_id in ${admin(requests)}
    `;
    expect(audits.map((row) => row.action)).toEqual(['lead.created', 'lead.created']);
  });

  test('leftovers older than ten minutes are removed first', async () => {
    const leftover = await insertLead(SITE, 11);
    expect(await run(SITE)).toMatchObject({ status: 'ok' });
    expect(await admin`select id from app.leads where id = ${leftover}`).toHaveLength(0);
    expect(await count('leads', SITE)).toBe(0);
  });

  test("leftovers are only the check's own leads", async () => {
    const real = await insertLead(SITE, 60, 'customer@example.test');
    const own = await insertLead(SITE, 11);
    try {
      expect(await run(SITE)).toMatchObject({ status: 'ok' });
      expect(await admin`select id from app.leads where id = ${own}`).toHaveLength(0);
      expect(await admin`select id from app.leads where id = ${real}`).toHaveLength(1);
      const [mobility] = await admin<{ id: string }[]>`
        insert into app.leads (workspace_id, lead_type, status, stage, consent_version, email, created_at)
        values (${SITE}, 'mobility', 'submitted', 'new', 'ci', ${INTAKE_CHECK_CONTACT.email},
          now() - interval '1 hour')
        returning id
      `;
      expect(await run(SITE)).toMatchObject({ status: 'ok' });
      expect(await admin`select id from app.leads where id = ${mobility?.id ?? ''}`).toHaveLength(
        1,
      );
    } finally {
      await admin`delete from app.leads where workspace_id = ${SITE}`;
    }
  });

  test('refuses a site that has a role, a member or a site key, and writes nothing', async () => {
    for (const site of [ROLE_SITE, MEMBER_SITE, KEY_SITE]) {
      const real = await insertLead(site, 3 * 24 * 60, 'customer@example.test');
      const own = await insertLead(site, 11);
      expect(await run(site), site).toMatchObject({
        status: 'failed',
        step: 'leftovers',
        code: 'intake_check_site_not_test',
      });
      const left = await admin<{ id: string }[]>`
        select id from app.leads where workspace_id = ${site} order by id
      `;
      expect(left.map((row) => row.id).sort(), site).toEqual([real, own].sort());
      expect(await count('outbox_jobs', site), site).toBe(0);
      expect(await count('automation_runs', site), site).toBe(0);
    }
  });

  test("a concurrent run's fresh lead is not a leftover", async () => {
    const fresh = await insertLead(SITE, 2);
    try {
      expect(await run(SITE)).toMatchObject({ status: 'ok' });
      expect(await admin`select id from app.leads where id = ${fresh}`).toHaveLength(1);
      expect(await count('leads', SITE)).toBe(1);
    } finally {
      await admin`delete from app.leads where id = ${fresh}`;
    }
  });

  test("never deletes another site's leads", async () => {
    const other = await insertLead(OTHER_SITE, 11);
    try {
      expect(await run(SITE)).toMatchObject({ status: 'ok' });
      expect(await admin`select id from app.leads where id = ${other}`).toHaveLength(1);
      expect(await store.readLead({ workspaceId: SITE, actorId: ACTOR }, other)).toBeUndefined();
      expect(await store.deleteLead({ workspaceId: SITE, actorId: ACTOR }, other)).toEqual({
        deleted: 0,
        remaining: 0,
      });
      expect(await admin`select id from app.leads where id = ${other}`).toHaveLength(1);
    } finally {
      await admin`delete from app.leads where id = ${other}`;
    }
  });

  test('the cascade needs no delete grant on the timeline', async () => {
    const leadId = await insertLead(SITE, 1);
    await admin`
      insert into app.lead_activities (workspace_id, lead_id, actor_id, kind)
      values (${SITE}, ${leadId}, ${ACTOR}, 'system')
    `;
    await admin`
      insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
      values (${SITE}, ${leadId}, 'Call back', ${ACTOR})
    `;
    expect(await store.deleteLead({ workspaceId: SITE, actorId: ACTOR }, leadId)).toEqual({
      deleted: 1,
      remaining: 0,
    });
    expect(await admin`select id from app.lead_activities where lead_id = ${leadId}`).toHaveLength(
      0,
    );
    expect(await admin`select id from app.lead_tasks where lead_id = ${leadId}`).toHaveLength(0);
  });

  test('a create on a site that does not exist fails at create with a bounded code', async () => {
    await run(SITE);
    const before = await syntheticContacts();
    expect(await run(MISSING_SITE)).toMatchObject({
      status: 'failed',
      step: 'create',
      code: 'sqlstate_23503',
    });
    expect(await syntheticContacts()).toBe(before);
    expect(await count('leads', MISSING_SITE)).toBe(0);
  });

  test('a failed delete is cleaned up by the next run', async () => {
    let failOnce = true;
    const flaky: IntakeCheckStore = {
      deleteLeftovers: (scope, before) => store.deleteLeftovers(scope, before),
      readLead: (scope, leadId) => store.readLead(scope, leadId),
      deleteLead: async (scope, leadId) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('delete_refused');
        }
        return store.deleteLead(scope, leadId);
      },
    };
    expect(await run(SITE, { store: flaky })).toMatchObject({
      status: 'failed',
      step: 'delete',
      code: 'delete_refused',
    });
    expect(await count('leads', SITE)).toBe(1);

    const later = () => new Date(Date.now() + 11 * 60_000);
    expect(await run(SITE, { store: flaky, now: later })).toMatchObject({ status: 'ok' });
    expect(await count('leads', SITE)).toBe(0);
  });
});
