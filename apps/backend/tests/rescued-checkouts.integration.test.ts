import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codePropertyCatalog, type LeadType } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabaseReportStore } from '../src/reports/store.js';
import { DatabaseTrackingStore } from '../src/tracking/store.js';
import {
  disposableTestDatabaseUrl,
  flowKey,
  insertActiveFlow,
  seedBuiltInFlow,
} from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008406'; // SIM checkouts rescued
const TYPES_SITE = '18000000-0000-4000-8000-000000008407'; // every lead type
const OLD_PLAN_SITE = '18000000-0000-4000-8000-000000008408'; // a plan gone inactive
const SITES = [SITE, TYPES_SITE, OLD_PLAN_SITE];
const STAFF = '28000000-0000-4000-8000-000000008406';
const CREDENTIAL = '28000000-0000-4000-8000-000000008407';
const PLAN = '48000000-0000-4000-8000-000000008406';
const OLD_PLAN = '48000000-0000-4000-8000-000000008408';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789',
};

const flow = (trigger: unknown, steps: readonly unknown[]) => ({
  schemaVersion: 1,
  trigger,
  steps,
});
const send = (id: string, template: string) => ({ id, kind: 'send_email', template });

databaseTest('rescued checkouts count as submitted', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const website = (workspaceId: string) => ({
    workspaceId,
    actorId: CREDENTIAL,
    requestId: randomUUID(),
  });

  /** A checkout the customer left unfinished, through the website's own draft path. */
  const draft = async (
    workspaceId: string,
    leadType: LeadType,
    input: { email: string; planId?: string },
  ) => {
    const created = await leadStore.createLead({
      ...website(workspaceId),
      leadType,
      consentVersion: 'ci',
      contact: { fullName: 'Ravi Patel', email: input.email },
      ...(input.planId ? { order: { planId: input.planId, quantity: 1 } } : {}),
    });
    const grant = created.grant?.token;
    if (!grant) throw new Error('expected a draft grant');
    return { leadId: created.lead.id, grant };
  };

  const move = (workspaceId: string, leadId: string, stage: string) =>
    work.updateLead({
      workspaceId,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      stage,
      catalog: codePropertyCatalog,
    });

  const runs = (leadId: string) =>
    admin<{ automationKey: string; status: string; occurrence: string | null }[]>`
      select automation_key as "automationKey", status, occurrence
      from app.automation_runs where lead_id = ${leadId}
      order by created_at, id
    `;

  const leadRow = async (leadId: string) => {
    const [row] = await admin<
      { status: string; stage: string; orderDetails: Record<string, unknown> }[]
    >`
      select status, stage, order_details as "orderDetails" from app.leads where id = ${leadId}
    `;
    return row;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.outbox_jobs where workspace_id in ${admin(SITES)}`;
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
    for (const [index, id] of SITES.entries()) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${id}, ${`rescued-checkouts-840${index + 6}`}, ${`Rescue Site ${index + 1}`})
      `;
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status)
        values (${id}, ${STAFF}, 'staff', 'active')
      `;
      await admin`
        insert into app.workspace_email_settings (
          workspace_id, from_name, from_address, reply_to, logo_url, brand_color, footer_text,
          site_url, updated_by
        ) values (
          ${id}, 'Rescue Sim', 'orders@rescue.example', null, null, '#123abc', '',
          'https://rescue.example', ${STAFF}
        )
      `;
    }
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, price_minor, billing_period, active, position)
      values (${PLAN}, ${SITE}, 'sim_order', 'Rescue plan', 2500, 'month', true, 0),
             (${OLD_PLAN}, ${OLD_PLAN_SITE}, 'sim_order', 'Old plan', 2500, 'month', true, 0)
    `;
    await seedBuiltInFlow(admin, {
      workspaceId: SITE,
      key: 'order_received',
      enabled: true,
      actorId: STAFF,
    });
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8406', 1),
      name: 'Pending flow',
      enabled: true,
      definition: flow(
        { kind: 'stage_entered', leadType: 'sim_order', stage: 'pending', when: null },
        [send('s_pending', 'information_needed')],
      ),
      actorId: STAFF,
    });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    leadStore = new DatabaseLeadStore(database, environment);
    work = new DatabaseLeadWorkStore(database, environment);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('a staff move out of Incomplete submits the lead, freezes its plan and fires the submitted and stage flows', async () => {
    const { leadId } = await draft(SITE, 'sim_order', {
      email: 'rescue-one@example.test',
      planId: PLAN,
    });
    expect(await leadRow(leadId)).toMatchObject({ status: 'incomplete', stage: 'incomplete' });
    const outcome = await move(SITE, leadId, 'pending');
    if (outcome.status !== 'updated') throw new Error(`not updated: ${outcome.status}`);
    const occurrence = outcome.activities.find((entry) => entry.kind === 'status_change')?.id;

    const row = await leadRow(leadId);
    expect(row).toMatchObject({ status: 'submitted', stage: 'pending' });
    expect(row?.orderDetails).toMatchObject({
      planId: PLAN,
      quantity: 1,
      plan: { planId: PLAN, name: 'Rescue plan', priceMinor: 2500 },
    });
    expect(
      await admin`
        select actor_id as "actorId" from app.lead_activities
        where lead_id = ${leadId} and kind = 'system' and data ->> 'event' = 'submitted'
      `,
    ).toEqual([{ actorId: STAFF }]);
    const [audit] = await admin<
      { before: Record<string, unknown>; after: Record<string, unknown> }[]
    >`
      select before, after from app.audit_events
      where entity_id = ${leadId} and action = 'lead.updated' and actor_id = ${STAFF}
    `;
    expect(audit?.before).toMatchObject({ status: 'incomplete', stage: 'incomplete' });
    expect(audit?.after).toMatchObject({ status: 'submitted', stage: 'pending' });
    expect(
      await admin`
        select dedupe_key as "dedupeKey" from app.outbox_jobs
        where payload ->> 'leadId' = ${leadId} and payload ->> 'template' = 'order_received'
      `,
    ).toEqual([{ dedupeKey: `${leadId}:order_received:submitted` }]);
    expect(await runs(leadId)).toEqual([
      { automationKey: 'order_received', status: 'completed', occurrence: 'submitted' },
      { automationKey: flowKey('8406', 1), status: 'completed', occurrence },
    ]);
  });

  it('the same for every lead type', async () => {
    const types: LeadType[] = ['internet', 'mobility', 'partner_application', 'contact_message'];
    for (const [index, leadType] of types.entries()) {
      await insertActiveFlow(admin, {
        workspaceId: TYPES_SITE,
        key: flowKey('8407', index + 1),
        name: `Submitted ${leadType}`,
        enabled: true,
        definition: flow({ kind: 'lead_submitted', leadTypes: [leadType], when: null }, [
          send('s_thanks', 'order_received'),
        ]),
        actorId: STAFF,
      });
    }
    for (const [index, leadType] of types.entries()) {
      const { leadId } = await draft(TYPES_SITE, leadType, {
        email: `rescue-${leadType}@example.test`,
      });
      expect(await leadRow(leadId)).toMatchObject({ status: 'incomplete', stage: 'new' });
      const next = leadType === 'contact_message' ? 'replied' : 'contacted';
      expect(await move(TYPES_SITE, leadId, next)).toMatchObject({ status: 'updated' });
      expect((await leadRow(leadId))?.status).toBe('submitted');
      expect(await runs(leadId)).toEqual([
        { automationKey: flowKey('8407', index + 1), status: 'completed', occurrence: 'submitted' },
      ]);
    }
  });

  it('a move into a closing stage is no rescue: the lead stays unsubmitted and no flow fires', async () => {
    await insertActiveFlow(admin, {
      workspaceId: TYPES_SITE,
      key: flowKey('8407', 9),
      name: 'Closed flow',
      enabled: true,
      definition: flow(
        {
          kind: 'lead_submitted',
          leadTypes: [
            'sim_order',
            'internet',
            'mobility',
            'partner_application',
            'contact_message',
          ],
          when: null,
        },
        [send('s_closed', 'order_received')],
      ),
      actorId: STAFF,
    });
    for (const [leadType, stage] of [
      ['sim_order', 'cancelled'],
      ['internet', 'lost'],
      ['internet', 'non_serviceable_address'],
      ['mobility', 'lost'],
      ['partner_application', 'declined'],
      ['contact_message', 'closed'],
    ] as const) {
      const { leadId, grant } = await draft(TYPES_SITE, leadType, {
        email: `closing-${leadType}-${stage}@example.test`,
      });
      expect(await move(TYPES_SITE, leadId, stage)).toMatchObject({
        status: 'updated',
        lead: { stage },
      });
      const row = await leadRow(leadId);
      expect(row?.status).toBe('incomplete');
      expect(await runs(leadId)).toEqual([]);
      expect(
        await admin`
          select 1 from app.lead_activities
          where lead_id = ${leadId} and kind = 'system' and data ->> 'event' = 'submitted'
        `,
      ).toEqual([]);
      expect(await admin`select 1 from app.automation_timers where lead_id = ${leadId}`).toEqual(
        [],
      );
      expect(
        await admin`select 1 from app.outbox_jobs where payload ->> 'leadId' = ${leadId}`,
      ).toEqual([]);
      // The customer's draft is still theirs to finish.
      expect(
        await leadStore.updateLead({ ...website(TYPES_SITE), leadId, grantToken: grant }),
      ).toMatchObject({ status: 'updated' });
    }
  });

  it('a rescued plan no longer available stays unfrozen', async () => {
    const { leadId } = await draft(OLD_PLAN_SITE, 'sim_order', {
      email: 'rescue-old-plan@example.test',
      planId: OLD_PLAN,
    });
    await admin`update app.plans set active = false where id = ${OLD_PLAN}`;
    expect(await move(OLD_PLAN_SITE, leadId, 'pending')).toMatchObject({ status: 'updated' });
    const row = await leadRow(leadId);
    expect(row?.status).toBe('submitted');
    expect(row?.orderDetails).toEqual({ planId: OLD_PLAN, quantity: 1 });
  });

  it("the customer's draft grant then answers draft_submitted", async () => {
    const { leadId, grant } = await draft(SITE, 'sim_order', {
      email: 'rescue-grant@example.test',
      planId: PLAN,
    });
    expect(await move(SITE, leadId, 'pending')).toMatchObject({ status: 'updated' });
    expect(
      await leadStore.updateLead({
        ...website(SITE),
        leadId,
        grantToken: grant,
        form: { schemaVersion: 1, payload: { delivery: 'esim' } },
        submit: true,
      }),
    ).toEqual({ status: 'draft_submitted' });
  });

  it('a second move fires no second submitted mail', async () => {
    const { leadId } = await draft(SITE, 'sim_order', {
      email: 'rescue-twice@example.test',
      planId: PLAN,
    });
    expect(await move(SITE, leadId, 'pending')).toMatchObject({ status: 'updated' });
    expect(await move(SITE, leadId, 'cancelled')).toMatchObject({ status: 'updated' });
    expect(await move(SITE, leadId, 'pending')).toMatchObject({ status: 'updated' });
    const received = await admin`
      select 1 from app.outbox_jobs
      where payload ->> 'leadId' = ${leadId} and payload ->> 'template' = 'order_received'
    `;
    expect(received).toHaveLength(1);
    expect(
      (await runs(leadId)).filter((run) => run.automationKey === 'order_received'),
    ).toHaveLength(1);
  });

  it('a rescued lead counts as submitted in the source report and on the tracking list', async () => {
    const reports = new DatabaseReportStore(database);
    const tracking = new DatabaseTrackingStore(database);
    const email = 'rescue-counted@example.test';
    const before = await reports.sourceReport({
      workspaceId: SITE,
      actorId: STAFF,
      leadType: 'sim_order',
    });
    const { leadId } = await draft(SITE, 'sim_order', { email, planId: PLAN });
    expect(await tracking.listOrders({ ...website(SITE), normalizedEmail: email })).toEqual([]);
    expect(await move(SITE, leadId, 'pending')).toMatchObject({ status: 'updated' });
    const after = await reports.sourceReport({
      workspaceId: SITE,
      actorId: STAFF,
      leadType: 'sim_order',
    });
    expect(after.totals.received).toBe(before.totals.received + 1);
    expect(after.totals.submitted).toBe(before.totals.submitted + 1);
    const listed = await tracking.listOrders({ ...website(SITE), normalizedEmail: email });
    expect(listed).toHaveLength(1);
  });
});
