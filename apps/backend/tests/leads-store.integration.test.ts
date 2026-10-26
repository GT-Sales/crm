import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';

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

// A distinct id range from every other integration test file sharing this
// disposable database (packages/db's rls/website-auth suites, and
// apps/backend's isolation.spec.ts).
const WORKSPACE = '11000000-0000-4000-8000-000000000b01';
const WORKSPACE_B = '11000000-0000-4000-8000-000000000b02';
const ACTOR = '21000000-0000-4000-8000-000000000b01';
const REQUEST_ID = '31000000-0000-4000-8000-000000000b01';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const scope = { workspaceId: WORKSPACE, actorId: ACTOR, requestId: REQUEST_ID };
const base = { ...scope, leadType: 'sim_order', consentVersion: 'terms-2026-09' };

/** A draft's grant token; every lead created here without `submit` has one. */
function draftToken(created: { grant: { token: string } | null }): string {
  if (!created.grant) throw new Error('expected a draft grant');
  return created.grant.token;
}

databaseTest('DatabaseLeadStore', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseLeadStore;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    // One connection can hold the submission lock while another observes waiters.
    admin = postgres(migrationUrl, { max: 2, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE}, 'ci-leads-workspace', 'CI Leads Workspace'),
        (${WORKSPACE_B}, 'ci-leads-workspace-b', 'CI Leads Workspace B')
      on conflict (id) do nothing
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    store = new DatabaseLeadStore(database);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  test('stores the lead type and external reference, once per site and type', async () => {
    const ref = `MS-${Date.now()}`;
    const created = await store.createLead({ ...base, externalRef: ref });
    const [row] = await admin<{ lead_type: string; external_ref: string; status: string }[]>`
      select lead_type, external_ref, status from app.leads where id = ${created.lead.id}
    `;
    expect(row).toEqual({ lead_type: 'sim_order', external_ref: ref, status: 'incomplete' });

    // The same order number on the same site is one record, however many times
    // the website retries; another lead type or another site may reuse it.
    await expect(store.createLead({ ...base, externalRef: ref })).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await expect(
      store.createLead({ ...base, leadType: 'partner_application', externalRef: ref }),
    ).resolves.toBeDefined();
    await expect(
      store.createLead({ ...base, workspaceId: WORKSPACE_B, externalRef: ref }),
    ).resolves.toBeDefined();
  });

  test('a partner code is stored verbatim but never linked without a partner registry', async () => {
    const created = await store.createLead({ ...base, attribution: { partnerCode: 'MAPLE10' } });
    const [row] = await admin<{ attribution: Record<string, unknown> }[]>`
      select attribution from app.leads where id = ${created.lead.id}
    `;
    expect(row?.attribution).toEqual({ partnerCode: 'MAPLE10' });
  });

  test('merges people across sites by normalized email and refreshes known details', async () => {
    const email = `merge-${Date.now()}@example.test`;
    const first = await store.createLead({
      ...base,
      contact: { fullName: 'Jane Doe', email: `  ${email.toUpperCase()} ` },
    });
    const second = await store.createLead({
      ...base,
      workspaceId: WORKSPACE_B,
      leadType: 'internet',
      contact: { email, phone: '+1 555 0100' },
    });
    const rows = await admin<{ id: string; contact_id: string }[]>`
      select id, contact_id from app.leads where id in (${first.lead.id}, ${second.lead.id})
    `;
    const contactId = rows[0]?.contact_id;
    if (!contactId) throw new Error('expected the first lead to carry a contact');
    expect(rows.every((row) => row.contact_id === contactId)).toBe(true);
    const [contact] = await admin<
      { email: string; full_name: string | null; phone: string | null }[]
    >`
      select email, full_name, phone from app.contacts where id = ${contactId}
    `;
    // Lower-cased and trimmed; the second submission filled in the phone
    // without erasing the name the first one supplied.
    expect(contact).toEqual({ email, full_name: 'Jane Doe', phone: '+1 555 0100' });

    // An anonymous draft has no contact until an email arrives on a later save.
    const anonymous = await store.createLead({ ...base, contact: { fullName: 'No email yet' } });
    const [before] = await admin<{ contact_id: string | null }[]>`
      select contact_id from app.leads where id = ${anonymous.lead.id}
    `;
    expect(before?.contact_id).toBeNull();
    const updated = await store.updateLead({
      ...scope,
      leadId: anonymous.lead.id,
      grantToken: draftToken(anonymous),
      contact: { email },
    });
    expect(updated).toMatchObject({ status: 'updated' });
    const [after] = await admin<{ contact_id: string | null }[]>`
      select contact_id from app.leads where id = ${anonymous.lead.id}
    `;
    expect(after?.contact_id).toBe(contactId);
  });

  test('the runtime role can only reach contacts through a verified actor context', async () => {
    const runtimeUrl = new URL(migrationUrl ?? '');
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    const runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
    try {
      expect(await runtimeSql`select id from app.contacts`).toHaveLength(0);
      await expect(
        runtimeSql`insert into app.contacts (email) values ('no-actor@example.test')`,
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtimeSql.end();
    }
  });

  test('a forged grant fails, a grant for a different lead fails, and an expired grant fails', async () => {
    const leadA = await store.createLead(base);
    const leadB = await store.createLead(base);

    const forged = await store.updateLead({
      ...scope,
      leadId: leadA.lead.id,
      grantToken: 'gtdg_this-was-never-issued-by-us',
      contact: { fullName: 'Forged' },
    });
    expect(forged).toEqual({ status: 'grant_invalid' });

    const wrongLead = await store.updateLead({
      ...scope,
      leadId: leadB.lead.id,
      grantToken: draftToken(leadA),
      contact: { fullName: 'Wrong lead' },
    });
    expect(wrongLead).toEqual({ status: 'grant_invalid' });

    await admin`
      update app.draft_grants set expires_at = now() - interval '1 minute'
      where lead_id = ${leadA.lead.id}
    `;
    const expired = await store.updateLead({
      ...scope,
      leadId: leadA.lead.id,
      grantToken: draftToken(leadA),
      contact: { fullName: 'Too late' },
    });
    expect(expired).toEqual({ status: 'grant_expired' });
  });

  test('repeated saves with a valid grant update the same lead row', async () => {
    const created = await store.createLead({ ...base, contact: { fullName: 'Jane Doe' } });

    const first = await store.updateLead({
      ...scope,
      leadId: created.lead.id,
      grantToken: draftToken(created),
      contact: { email: 'jane@example.test' },
    });
    expect(first).toMatchObject({ status: 'updated', lead: { id: created.lead.id } });

    const second = await store.updateLead({
      ...scope,
      leadId: created.lead.id,
      grantToken: draftToken(created),
      contact: { phone: '+1 555 0100' },
    });
    expect(second).toMatchObject({ status: 'updated', lead: { id: created.lead.id } });

    const [row] = await admin<{ full_name: string; email: string; phone: string }[]>`
      select full_name, email, phone from app.leads where id = ${created.lead.id}
    `;
    expect(row).toEqual({
      full_name: 'Jane Doe',
      email: 'jane@example.test',
      phone: '+1 555 0100',
    });

    const rowCount =
      await admin`select count(*)::int as count from app.leads where id = ${created.lead.id}`;
    expect(rowCount[0]?.['count']).toBe(1);

    const audits = await admin<
      { action: string; after: { changedFields?: string[]; fullName?: string } }[]
    >`
      select action, after from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id = ${created.lead.id}
      order by created_at
    `;
    expect(audits.map((event) => event.action)).toEqual([
      'lead.created',
      'lead.updated',
      'lead.updated',
    ]);
    expect(audits.every((event) => event.after.fullName === undefined)).toBe(true);
    expect(audits[1]?.after.changedFields).toEqual(['contact', 'contactId']);
  });

  test('a save waiting behind submission rejects the committed draft', async () => {
    const created = await store.createLead({ ...base, contact: { fullName: 'Before submission' } });
    let pending: Promise<unknown> = Promise.resolve();
    await admin.begin(async (tx) => {
      const [connection] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!connection) throw new Error('missing lock-holder connection');
      await tx`select id from app.leads where id = ${created.lead.id} for update`;
      pending = store.updateLead({
        ...scope,
        leadId: created.lead.id,
        grantToken: draftToken(created),
        contact: { fullName: 'Late edit' },
      });
      await vi.waitFor(
        async () => {
          const [waiting] = await admin<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
            where datname = current_database() and ${connection.pid} = any(pg_blocking_pids(pid))
        `;
          expect(waiting?.count).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      await tx`update app.leads set status = 'submitted' where id = ${created.lead.id}`;
    });
    expect(await pending).toEqual({ status: 'draft_submitted' });
    const [row] = await admin`select full_name from app.leads where id = ${created.lead.id}`;
    expect(row?.full_name).toBe('Before submission');
  });

  test('queues no analytics job: websites keep their own conversion events', async () => {
    const created = await store.createLead(base);

    const jobs = await admin<{ job_type: string }[]>`
      select job_type from app.outbox_jobs
      where workspace_id = ${WORKSPACE} and dedupe_key = ${created.lead.id}
    `;
    expect(jobs).toEqual([]);
  });

  test('creates a submitted lead with no draft grant when asked to submit', async () => {
    const created = await store.createLead({ ...base, submit: true });

    expect(created.lead.status).toBe('submitted');
    expect(created.grant).toBeNull();
    const [lead] = await admin<{ status: string }[]>`
      select status from app.leads where id = ${created.lead.id}
    `;
    expect(lead?.status).toBe('submitted');
    const grants = await admin`select id from app.draft_grants where lead_id = ${created.lead.id}`;
    expect(grants).toHaveLength(0);
    const [audit] = await admin<{ after: { status: string } }[]>`
      select after from app.audit_events
      where entity = 'lead' and entity_id = ${created.lead.id} and action = 'lead.created'
    `;
    expect(audit?.after.status).toBe('submitted');
  });

  test('lists by type and hides restricted and deleted leads', async () => {
    const workspaceId = '11000000-0000-4000-8000-000000000b03';
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${workspaceId}, 'ci-leads-workspace-c', 'CI Leads Workspace C')
      on conflict (id) do nothing
    `;
    // The disposable database persists between runs; this list asserts exact
    // membership, so it starts from an empty site.
    await admin`delete from app.leads where workspace_id = ${workspaceId}`;
    const scoped = { ...base, workspaceId };
    const sim = await store.createLead(scoped);
    const internet = await store.createLead({ ...scoped, leadType: 'internet' });
    const restricted = await store.createLead(scoped);
    const deleted = await store.createLead(scoped);
    await admin`update app.leads set customer_data_restricted_at = now() where id = ${restricted.lead.id}`;
    await admin`update app.leads set deleted_at = now() where id = ${deleted.lead.id}`;

    const all = await store.listLeads({ workspaceId, actorId: ACTOR });
    expect(all.leads.map((lead) => lead.id).sort()).toEqual([sim.lead.id, internet.lead.id].sort());
    expect(all.page.total).toBe(2);

    const onlyInternet = await store.listLeads({
      workspaceId,
      actorId: ACTOR,
      leadType: 'internet',
    });
    expect(onlyInternet.leads).toMatchObject([
      { id: internet.lead.id, leadType: 'internet', contactId: null, assignedActorId: null },
    ]);
  });

  test('reads only the grant-bound unfinished draft under runtime RLS', async () => {
    const contact = {
      fullName: 'Saved customer',
      email: 'saved@example.test',
      phone: '1712345678',
      countryCode: 'BD',
    };
    const form = {
      schemaVersion: 1,
      payload: { currentCountry: 'Bangladesh', destination: 'Toronto', arrivalDate: '2026-12-01' },
    };
    const created = await store.createLead({
      ...base,
      consentVersion: 'privacy-2026-10-v2',
      contact,
      form,
    });
    const input = {
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      leadId: created.lead.id,
      grantToken: draftToken(created),
    };
    expect(await store.readLead(input)).toEqual({
      status: 'read',
      draft: { leadId: created.lead.id, leadType: 'sim_order', contact, form },
    });
    expect(await store.readLead({ ...input, grantToken: 'gtdg_forged' })).toEqual({
      status: 'grant_invalid',
    });
    expect(await store.readLead({ ...input, workspaceId: WORKSPACE_B })).toEqual({
      status: 'grant_invalid',
    });
    const other = await store.createLead({ ...base, consentVersion: 'privacy-2026-10-v2' });
    expect(await store.readLead({ ...input, leadId: other.lead.id })).toEqual({
      status: 'grant_invalid',
    });
    await admin`update app.draft_grants set revoked_at = now() where lead_id = ${created.lead.id}`;
    expect(await store.readLead(input)).toEqual({ status: 'grant_expired' });
    await admin`update app.draft_grants set revoked_at = null, expires_at = now() - interval '1 second' where lead_id = ${created.lead.id}`;
    expect(await store.readLead(input)).toEqual({ status: 'grant_expired' });
    await admin`update app.draft_grants set expires_at = now() + interval '1 day' where lead_id = ${created.lead.id}`;
    await admin`update app.leads set status = 'submitted' where id = ${created.lead.id}`;
    expect(await store.readLead(input)).toEqual({ status: 'draft_submitted' });
  });
});
