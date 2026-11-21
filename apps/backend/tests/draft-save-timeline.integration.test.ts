import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codePropertyCatalog, type LeadActivity } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { toLeadActivity } from '../src/leads/staff-queries.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import {
  ABANDONED_LEAD_RETENTION_DAYS,
  DatabaseAbandonedLeadPruner,
} from '../src/retention/abandoned-leads.js';

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

// A distinct id range for issue #87.
const SITE = '87000000-0000-4000-8000-000000008741';
const OWNER = '87000000-0000-4000-8000-000000008742';
/** The website's key: the actor of every draft save. */
const WEBSITE = '87000000-0000-4000-8000-000000008743';
const SCHEDULER = '87000000-0000-4000-8000-000000008744';
const REQUEST = '87000000-0000-4000-8000-000000008745';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789',
};
const DAY = 24 * 60 * 60 * 1000;

type SystemEntry = Extract<LeadActivity, { kind: 'system' }>;

// Issue #87 (owner decision, 21 Nov 2026): a customer's draft save is on the
// staff timeline with the values they filled in, and goes when their data does.
databaseTest('customer draft saves on the staff timeline', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leads: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;
  let planA: string;
  let planB: string;
  const website = { workspaceId: SITE, actorId: WEBSITE, requestId: REQUEST };

  const timeline = async (leadId: string, includeWork = true) => {
    const result = await work.getLead({
      workspaceId: SITE,
      actorId: OWNER,
      leadId,
      includeWork,
      catalog: codePropertyCatalog,
    });
    if (!result) throw new Error('lead not found');
    return result.activities;
  };
  const saves = async (leadId: string) =>
    (await timeline(leadId)).filter(
      (entry): entry is SystemEntry => entry.kind === 'system' && entry.event === 'draft_saved',
    );
  const stored = (leadId: string) =>
    admin<{ body: string | null; data: Record<string, unknown>; actorId: string }[]>`
      select body, data, actor_id as "actorId" from app.lead_activities
      where workspace_id = ${SITE} and lead_id = ${leadId} and data ->> 'event' = 'draft_saved'
      order by created_at, id
    `;
  const draft = async (email: string) => {
    const created = await leads.createLead({
      ...website,
      leadType: 'sim_order',
      contact: { fullName: 'Ada Example', email },
      form: {
        schemaVersion: 1,
        payload: { delivery: 'pickup', shippingAddress: '1 First Street' },
      },
      order: { planId: planA, quantity: 1 },
      consentVersion: 'ci',
    });
    if (!created.grant) throw new Error('expected a draft grant');
    return { leadId: created.lead.id, grantToken: created.grant.token };
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.outbox_jobs where workspace_id = ${SITE}`;
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`delete from app.contacts where email like 'draft-save-87%@example.test'`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'ci-draft-save-timeline-8741', 'CI Draft Save Timeline')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    const environment = customerEmailEnvironmentFromEnv(ENV);
    leads = new DatabaseLeadStore(database, environment);
    work = new DatabaseLeadWorkStore(database, environment);
    const plans = new DatabasePlanStore(database);
    const plan = async (name: string) => {
      const made = await plans.create(
        { workspaceId: SITE, actorId: OWNER, requestId: REQUEST },
        {
          leadType: 'sim_order',
          name,
          priceMinor: 4000,
          billingPeriod: 'month',
          paymentRequired: false,
          requiredDocuments: [],
          active: true,
          customValues: {},
        },
      );
      if (made.kind !== 'created') throw new Error(`plan not created: ${made.kind}`);
      return made.plan.id;
    };
    planA = await plan('Rogers 30GB');
    planB = await plan('Rogers 60GB');
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from app.outbox_jobs where workspace_id = ${SITE}`;
      await admin`delete from app.workspaces where id = ${SITE}`;
      await admin`delete from app.contacts where email like 'draft-save-87%@example.test'`;
    }
    await database?.close();
    await admin?.end();
  });

  it('shows an address and plan change once, by the website, with the new values', async () => {
    const { leadId, grantToken } = await draft('draft-save-87-change@example.test');
    // Creating the draft is not an edit.
    expect(await saves(leadId)).toEqual([]);

    const outcome = await leads.updateLead({
      ...website,
      leadId,
      grantToken,
      contact: { fullName: 'Ada Example', phone: '+1 403 555 0100' },
      form: {
        schemaVersion: 1,
        payload: { delivery: 'pickup', shippingAddress: '22 Second Avenue\nCalgary AB' },
      },
      order: { planId: planB, quantity: 1 },
    });
    expect(outcome.status).toBe('updated');

    const [entry, ...others] = await saves(leadId);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({
      kind: 'system',
      event: 'draft_saved',
      actorId: WEBSITE,
      fields: ['phone', 'shippingAddress', 'plan'],
      values: [
        { key: 'phone', value: '+1 403 555 0100' },
        { key: 'shippingAddress', value: '22 Second Avenue\nCalgary AB' },
        { key: 'plan', value: 'Rogers 60GB' },
      ],
    });
    expect(Date.parse(entry?.createdAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    // The values are stored in the entry's body, the field keys in its data: nothing else.
    const [row] = await stored(leadId);
    expect(row?.data).toEqual({
      event: 'draft_saved',
      fields: ['phone', 'shippingAddress', 'plan'],
    });
    expect(row?.body).toContain('22 Second Avenue');
    // The audit event is what it was before: coarse field names, no value.
    const audits = await admin<{ after: unknown }[]>`
      select after from app.audit_events
      where workspace_id = ${SITE} and entity_id = ${leadId} and action = 'lead.updated'
    `;
    expect(JSON.stringify(audits)).not.toMatch(/Second Avenue|403 555/);
  });

  it('writes no entry for a save that changes nothing', async () => {
    const { leadId, grantToken } = await draft('draft-save-87-same@example.test');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await leads.updateLead({
        ...website,
        leadId,
        grantToken,
        contact: { fullName: 'Ada Example', email: 'draft-save-87-same@example.test' },
        form: {
          schemaVersion: 1,
          payload: { delivery: 'pickup', shippingAddress: '1 First Street' },
        },
        order: { planId: planA, quantity: 1 },
      });
      expect(outcome.status).toBe('updated');
    }
    expect(await stored(leadId)).toEqual([]);
    expect(await timeline(leadId)).toEqual([]);
  });

  it('keeps the submission entry, beside the change made in the submitting save', async () => {
    const { leadId, grantToken } = await draft('draft-save-87-submit@example.test');
    const outcome = await leads.updateLead({
      ...website,
      leadId,
      grantToken,
      form: { schemaVersion: 1, payload: { delivery: 'esim' } },
      submit: true,
    });
    expect(outcome.status).toBe('updated');
    const entries = (await timeline(leadId)).filter(
      (entry): entry is SystemEntry => entry.kind === 'system',
    );
    expect(entries.map((entry) => entry.event).sort()).toEqual(['draft_saved', 'submitted']);
    expect(entries.find((entry) => entry.event === 'draft_saved')).toMatchObject({
      fields: ['delivery', 'shippingAddress'],
      values: [
        { key: 'delivery', value: 'esim' },
        { key: 'shippingAddress', value: '' },
      ],
    });

    // A submission that changes nothing writes the submission alone.
    const second = await draft('draft-save-87-submit-only@example.test');
    await leads.updateLead({ ...website, ...second, submit: true });
    expect(await saves(second.leadId)).toEqual([]);
  });

  it('shows the entries to nobody who may not see the lead’s details', async () => {
    const { leadId, grantToken } = await draft('draft-save-87-roles@example.test');
    await leads.updateLead({
      ...website,
      leadId,
      grantToken,
      contact: { phone: '+1 587 555 0199' },
    });
    expect(await saves(leadId)).toHaveLength(1);
    // What the staff route reads for a role without contact access (rule 4).
    expect(await timeline(leadId, false)).toEqual([]);
  });

  it('leaves out a value whose property the site hides, still naming the field', async () => {
    const { leadId, grantToken } = await draft('draft-save-87-hidden@example.test');
    await leads.updateLead({
      ...website,
      leadId,
      grantToken,
      form: { schemaVersion: 1, payload: { delivery: 'pickup', shippingAddress: '9 Ninth Road' } },
    });
    const hidden = {
      ...codePropertyCatalog,
      forType: (leadType: string) =>
        codePropertyCatalog.forType(leadType).filter((entry) => entry.key !== 'shippingAddress'),
    };
    const result = await work.getLead({
      workspaceId: SITE,
      actorId: OWNER,
      leadId,
      includeWork: true,
      catalog: hidden,
    });
    const entry = result?.activities.find(
      (activity): activity is SystemEntry =>
        activity.kind === 'system' && activity.event === 'draft_saved',
    );
    expect(entry?.fields).toEqual(['shippingAddress']);
    expect(entry?.values ?? []).toEqual([]);
  });

  // AGENTS.md rule 7: the values sit where a note's text does, so erasing the
  // customer's data nulls them the same way.
  it('erases the values with the customer’s data: the entry stays, naming the fields only', async () => {
    const { leadId, grantToken } = await draft('draft-save-87-erase@example.test');
    await leads.updateLead({
      ...website,
      leadId,
      grantToken,
      contact: { fullName: 'Ada Erased', phone: '+1 780 555 0142' },
      form: { schemaVersion: 1, payload: { delivery: 'pickup', shippingAddress: '5 Fifth Lane' } },
    });
    expect((await saves(leadId))[0]?.values).toHaveLength(3);

    // The draft is abandoned: 90 days pass and the daily job restricts it.
    const now = new Date();
    await admin`
      update app.leads set updated_at = ${new Date(now.getTime() - (ABANDONED_LEAD_RETENTION_DAYS + 1) * DAY)}
      where id = ${leadId}
    `;
    const result = await new DatabaseAbandonedLeadPruner(database).restrictAbandoned({
      workspaceId: SITE,
      actorId: SCHEDULER,
      now,
    });
    expect(result.restrictedLeads).toBeGreaterThanOrEqual(1);

    const rows = await stored(leadId);
    expect(rows).toEqual([
      {
        body: null,
        data: { event: 'draft_saved', fields: ['fullName', 'phone', 'shippingAddress'] },
        actorId: WEBSITE,
      },
    ]);
    // Nothing the customer typed is left anywhere in the lead's timeline rows.
    const [left] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.lead_activities
      where workspace_id = ${SITE} and lead_id = ${leadId}
        and (body is not null or data::text ~* 'fifth lane|ada erased|780 555')
    `;
    expect(left).toEqual({ n: 0 });
    // A restricted lead is not on any staff screen; were its timeline read,
    // the entry would name the fields and carry no value.
    expect(
      await work.getLead({
        workspaceId: SITE,
        actorId: OWNER,
        leadId,
        includeWork: true,
        catalog: codePropertyCatalog,
      }),
    ).toBeUndefined();
    const [row] = rows;
    if (!row) throw new Error('expected the entry');
    const read = toLeadActivity({
      id: '87000000-0000-4000-8000-000000008751',
      actorId: row.actorId,
      kind: 'system',
      body: row.body,
      data: row.data,
      mailStatus: null,
      createdAt: now.toISOString(),
    });
    expect(read).toMatchObject({
      event: 'draft_saved',
      fields: ['fullName', 'phone', 'shippingAddress'],
    });
    expect(read).not.toHaveProperty('values');
  });
});
