import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { sql } from 'drizzle-orm';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  ABANDONED_LEAD_RETENTION_DAYS,
  DatabaseAbandonedLeadPruner,
} from '../src/retention/abandoned-leads.js';
import { getDisposableTestDatabaseUrl, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WORKSPACE = '11000000-0000-4000-8000-000000000e41';
const ACTOR = '21000000-0000-4000-8000-000000000e41';
const ABANDONED = '41000000-0000-4000-8000-000000000e41';
const RECENT = '41000000-0000-4000-8000-000000000e42';
const SUBMITTED = '41000000-0000-4000-8000-000000000e43';
const WITH_DOCS = '41000000-0000-4000-8000-000000000e44';
const OLD_RESTRICTED = '41000000-0000-4000-8000-000000000e45';
const OLD_TRIMMED = '41000000-0000-4000-8000-000000000e46';
const ORPHAN_CONTACT = '51000000-0000-4000-8000-000000000e41';
const SHARED_CONTACT = '51000000-0000-4000-8000-000000000e42';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

interface LeadRow {
  id: string;
  fullName: string | null;
  email: string | null;
  payload: unknown;
  customValues: unknown;
  restricted: boolean;
}

// SEC-12: an incomplete lead untouched for 90 days loses every visitor answer,
// custom property values included; newer and submitted leads keep theirs.
databaseTest('abandoned lead retention (restrictAbandoned)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;

  const insertLead = (id: string, status: string, updatedAt: Date) => admin`
    insert into app.leads (
      id, workspace_id, lead_type, status, consent_version, attribution, full_name, email,
      payload, custom_values, updated_at
    ) values (
      ${id}, ${WORKSPACE}, 'internet', ${status}, 'ci', '{}'::jsonb, 'Ada Visitor',
      'ada@example.test', ${admin.json({ schemaVersion: 1, payload: { city: 'Calgary' } })},
      ${admin.json({ custom_referral_code: 'REF-1', custom_budget: 4500 })}, ${updatedAt}
    )
  `;

  const rows = () => admin<LeadRow[]>`
    select id, full_name as "fullName", email, payload, custom_values as "customValues",
      customer_data_restricted_at is not null as restricted
    from app.leads where workspace_id = ${WORKSPACE} and id in (${ABANDONED}, ${RECENT}, ${SUBMITTED})
    order by id
  `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await admin`delete from app.contacts where id in (${ORPHAN_CONTACT}, ${SHARED_CONTACT})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-abandoned-retention', 'CI Abandoned Retention')
    `;
    await insertLead(ABANDONED, 'incomplete', daysAgo(ABANDONED_LEAD_RETENTION_DAYS + 1));
    await insertLead(RECENT, 'incomplete', daysAgo(ABANDONED_LEAD_RETENTION_DAYS - 1));
    await insertLead(SUBMITTED, 'submitted', daysAgo(ABANDONED_LEAD_RETENTION_DAYS + 30));

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    if (admin)
      await admin`delete from app.contacts where id in (${ORPHAN_CONTACT}, ${SHARED_CONTACT})`;
    await database?.close();
    await admin?.end();
  });

  test('erases the custom values of an abandoned draft with its answers', async () => {
    const result = await new DatabaseAbandonedLeadPruner(database).restrictAbandoned({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(result).toEqual({
      restrictedLeads: 1,
      finishedLeads: 0,
      deletedObjects: 0,
      failedDeletes: 0,
    });

    const kept = { custom_referral_code: 'REF-1', custom_budget: 4500 };
    expect(await rows()).toEqual([
      {
        id: ABANDONED,
        fullName: null,
        email: null,
        payload: null,
        customValues: {},
        restricted: true,
      },
      {
        id: RECENT,
        fullName: 'Ada Visitor',
        email: 'ada@example.test',
        payload: { schemaVersion: 1, payload: { city: 'Calgary' } },
        customValues: kept,
        restricted: false,
      },
      {
        id: SUBMITTED,
        fullName: 'Ada Visitor',
        email: 'ada@example.test',
        payload: { schemaVersion: 1, payload: { city: 'Calgary' } },
        customValues: kept,
        restricted: false,
      },
    ]);

    const [empty] = await admin<{ empty: boolean }[]>`
      select custom_values = '{}'::jsonb as empty from app.leads where id = ${ABANDONED}
    `;
    expect(empty).toEqual({ empty: true });
  });

  // Audit M-2: what the lead row only points at goes with it.
  test('erases documents, identities, tasks, notes, contact and attribution extras', async () => {
    await admin`delete from app.leads where workspace_id = ${WORKSPACE}`;
    await admin`
      insert into app.contacts (id, email, full_name) values
        (${ORPHAN_CONTACT}, 'orphan@example.test', 'Ada Visitor'),
        (${SHARED_CONTACT}, 'shared@example.test', 'Bo Visitor')
    `;
    const insertDraft = (id: string, contact: string | null) => admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, consent_version, attribution, full_name, email,
        phone, country_code, payload, custom_values, contact_id, order_details, updated_at
      ) values (
        ${id}, ${WORKSPACE}, 'sim_order', 'incomplete', 'ci',
        ${admin.json({ utmSource: 'google', utmMedium: 'cpc', landingPath: '/order?email=ada@example.test', utmTerm: 'ada', utmContent: 'ada-banner' })},
        'Ada Visitor', 'ada@example.test', '+14035550100', 'CA',
        ${admin.json({ schemaVersion: 1, payload: { city: 'Calgary' } })},
        ${admin.json({ custom_referral_code: 'REF-1' })}, ${contact},
        ${admin.json({ planId: null, quantity: 2, courier: 'canada_post', trackingNumber: 'TRACK1' })},
        ${daysAgo(ABANDONED_LEAD_RETENTION_DAYS + 5)}
      )
    `;
    await insertDraft(WITH_DOCS, ORPHAN_CONTACT);
    await insertDraft(OLD_RESTRICTED, SHARED_CONTACT);
    // An older restricted draft with nothing left to finish but its row: no
    // contact, file, identity, task or note, only what the row itself kept.
    await insertDraft(OLD_TRIMMED, null);
    // A submitted lead elsewhere keeps the shared contact alive.
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version, contact_id)
      values (${SUBMITTED}, ${WORKSPACE}, 'internet', 'submitted', 'ci', ${SHARED_CONTACT})
    `;
    // One current file per lead and type (#81): the licence is its own type.
    const addFile = (lead: string, key: string, documentType = 'passport') => admin<
      { id: string }[]
    >`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, candidate_key, object_key, declared_content_type, detected_mime,
        declared_size_bytes, size_bytes, checksum_sha256, status, uploaded_by, expires_at, finalized_at)
      values (${WORKSPACE}, 'lead', ${lead}, ${documentType}, 'documents', ${`staging/${key}`},
        ${`final/${key}`}, ${`final/${key}`}, 'application/pdf', 'application/pdf', 10, 10,
        ${'f'.repeat(64)}, 'available', ${ACTOR}, now(), now())
      returning id
    `;
    const [licence] = await addFile(WITH_DOCS, 'ci-m2-licence', 'drivers_licence');
    await addFile(WITH_DOCS, 'ci-m2-passport');
    await addFile(OLD_RESTRICTED, 'ci-m2-old');
    await admin`
      insert into app.lead_identities (workspace_id, lead_id, id_type, file_id, credit_check_consent_at, created_by)
      values (${WORKSPACE}, ${WITH_DOCS}, 'drivers_licence', ${licence!.id}, now(), ${ACTOR})
    `;
    await admin`
      insert into app.lead_identities (workspace_id, lead_id, id_type, sin_sealed, sin_last3,
        date_of_birth, credit_check_consent_at, created_by)
      values (${WORKSPACE}, ${OLD_RESTRICTED}, 'sin', 'v1.sealed-for-the-test', '286', '1990-01-31', now(), ${ACTOR})
    `;
    for (const lead of [WITH_DOCS, OLD_RESTRICTED]) {
      await admin`insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
        values (${WORKSPACE}, ${lead}, 'Call Ada about her passport', ${ACTOR})`;
      await admin`insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body)
        values (${WORKSPACE}, ${lead}, ${ACTOR}, 'note', 'Ada said her SIN is 123')`;
    }
    // Restricted before M-2, as the first version of the job did it: the
    // name, email, phone, country and answers are erased; the custom values,
    // the attribution extras and everything the row points at are not.
    await admin`
      update app.leads set full_name = null, email = null, phone = null, country_code = null,
        payload = null, customer_data_restricted_at = ${daysAgo(10)}
      where id in (${OLD_RESTRICTED}, ${OLD_TRIMMED})
    `;

    const deleted: string[] = [];
    const pruner = new DatabaseAbandonedLeadPruner(database, {
      objects: {
        deleteObject: async ({ objectKey }) => {
          if (objectKey === 'staging/ci-m2-old') throw new Error('storage down');
          deleted.push(objectKey);
        },
      },
    });
    const result = await pruner.restrictAbandoned({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(result).toEqual({
      restrictedLeads: 1,
      finishedLeads: 2,
      deletedObjects: 5,
      failedDeletes: 1,
    });
    expect(deleted.sort()).toEqual([
      'final/ci-m2-licence',
      'final/ci-m2-old',
      'final/ci-m2-passport',
      'staging/ci-m2-licence',
      'staging/ci-m2-passport',
    ]);

    // Issue #109: a draft restricted today and one restricted by an older
    // version of the job end with the same permitted fields, whichever
    // leftovers brought the older one back into the run.
    const leadsLeft = await admin<Record<string, unknown>[]>`
      select id, full_name as "fullName", email, phone, country_code as "countryCode", payload,
        custom_values as "customValues", contact_id as "contactId", attribution,
        order_details as "orderDetails", customer_data_restricted_at is not null as restricted
      from app.leads where id in (${WITH_DOCS}, ${OLD_RESTRICTED}, ${OLD_TRIMMED}) order by id
    `;
    const permitted = {
      fullName: null,
      email: null,
      phone: null,
      countryCode: null,
      payload: null,
      customValues: {},
      contactId: null,
      attribution: { utmSource: 'google', utmMedium: 'cpc' },
      orderDetails: { planId: null, quantity: 2 },
      restricted: true,
    };
    expect(leadsLeft).toEqual([
      { id: WITH_DOCS, ...permitted },
      { id: OLD_RESTRICTED, ...permitted },
      { id: OLD_TRIMMED, ...permitted },
    ]);
    // The older drafts keep the day they were restricted.
    const stamps = await admin<{ id: string; at: Date }[]>`
      select id, customer_data_restricted_at as at from app.leads
      where id in (${OLD_RESTRICTED}, ${OLD_TRIMMED}) order by id
    `;
    expect(stamps.map((row) => row.at.toISOString())).toEqual([
      daysAgo(10).toISOString(),
      daysAgo(10).toISOString(),
    ]);
    const counts = await admin<
      { files: number; identities: number; tasks: number; notes: number }[]
    >`
      select
        (select count(*)::int from app.files where record_id in (${WITH_DOCS}, ${OLD_RESTRICTED}) and status <> 'deleted') as files,
        (select count(*)::int from app.lead_identities where lead_id in (${WITH_DOCS}, ${OLD_RESTRICTED})) as identities,
        (select count(*)::int from app.lead_tasks where lead_id in (${WITH_DOCS}, ${OLD_RESTRICTED})) as tasks,
        (select count(*)::int from app.lead_activities where lead_id in (${WITH_DOCS}, ${OLD_RESTRICTED}) and body is not null) as notes
    `;
    expect(counts).toEqual([{ files: 0, identities: 0, tasks: 0, notes: 0 }]);
    const contactsLeft = await admin<{ id: string }[]>`
      select id from app.contacts where id in (${ORPHAN_CONTACT}, ${SHARED_CONTACT}) order by id
    `;
    expect(contactsLeft).toEqual([{ id: SHARED_CONTACT }]);

    // The run says what it finished, once per lead.
    const audits = await admin<{ entityId: string; action: string }[]>`
      select entity_id as "entityId", action from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id in (${OLD_RESTRICTED}, ${OLD_TRIMMED})
      order by entity_id
    `;
    expect(audits).toEqual([
      { entityId: OLD_RESTRICTED, action: 'lead.restricted_data_erased' },
      { entityId: OLD_TRIMMED, action: 'lead.restricted_data_erased' },
    ]);

    // A second run finds nothing left to do.
    const again = await pruner.restrictAbandoned({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(again).toEqual({
      restrictedLeads: 0,
      finishedLeads: 0,
      deletedObjects: 0,
      failedDeletes: 0,
    });
  });

  // Migration 0042: the one attribution change a restricted lead still takes.
  test('a restricted lead’s attribution can lose the erased keys and nothing else', async () => {
    const GUARDED = '41000000-0000-4000-8000-000000000e47';
    await admin`delete from app.leads where id = ${GUARDED}`;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version, attribution,
        customer_data_restricted_at)
      values (${GUARDED}, ${WORKSPACE}, 'internet', 'incomplete', 'ci',
        ${admin.json({ utmSource: 'google', utmTerm: 'ada', landingPath: '/order' })}, ${daysAgo(3)})
    `;
    const attempt = (attribution: Record<string, string>) =>
      database
        .withTenantTx({ workspaceId: WORKSPACE, actorId: ACTOR }, (tx) =>
          tx.execute(
            sql`update app.leads set attribution = ${JSON.stringify(attribution)}::jsonb where id = ${GUARDED}`,
          ),
        )
        .then(
          () => 'saved',
          (error: unknown) =>
            error instanceof Error && error.cause instanceof Error ? error.cause.message : 'other',
        );
    // Rewriting a kept key, adding one, or dropping a kept key with the erased ones.
    expect(await attempt({ utmSource: 'bing' })).toBe('customer_data_restricted');
    expect(await attempt({ utmSource: 'google', utmCampaign: 'ada' })).toBe(
      'customer_data_restricted',
    );
    expect(await attempt({ utmSource: 'google', utmTerm: 'someone else' })).toBe(
      'customer_data_restricted',
    );
    // Dropping only some of the erased keys is not the erasure either.
    expect(await attempt({ utmSource: 'google', utmTerm: 'ada' })).toBe('customer_data_restricted');
    expect(await attempt({ utmSource: 'google' })).toBe('saved');
    // Emptying it stays allowed, as before.
    expect(await attempt({})).toBe('saved');
    await admin`delete from app.leads where id = ${GUARDED}`;
  });

  test('the erasure function refuses another site and live leads', async () => {
    const OTHER = '11000000-0000-4000-8000-000000000e42';
    const refused = await database
      .withTenantTx({ workspaceId: WORKSPACE, actorId: ACTOR }, (tx) =>
        tx.execute(
          sql`select * from app.erase_restricted_lead_data(${OTHER}::uuid, '{}'::uuid[], '{}'::uuid[])`,
        ),
      )
      .then(
        () => 'ran',
        (error: unknown) =>
          error instanceof Error && error.cause instanceof Error ? error.cause.message : 'other',
      );
    expect(refused).toBe('workspace_context_mismatch');
    const [live] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.lead_activities where lead_id = ${SUBMITTED}
    `;
    await admin`insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body)
      values (${WORKSPACE}, ${SUBMITTED}, ${ACTOR}, 'note', 'kept')`;
    await database.withTenantTx({ workspaceId: WORKSPACE, actorId: ACTOR }, (tx) =>
      tx.execute(
        sql`select * from app.erase_restricted_lead_data(${WORKSPACE}::uuid, ${`{${SUBMITTED}}`}::uuid[], '{}'::uuid[])`,
      ),
    );
    const [kept] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.lead_activities where lead_id = ${SUBMITTED} and body = 'kept'
    `;
    expect({ before: live!.n, kept: kept!.n }).toEqual({ before: live!.n, kept: 1 });
  });
});
