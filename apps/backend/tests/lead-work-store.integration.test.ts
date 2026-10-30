import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import {
  codePropertyCatalog,
  leadActivitySchema,
  leadDetailSchema,
  leadTaskSchema,
} from '@gt-sales/contracts';

import { hashContact } from '../src/email/hash.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabaseStaffStore } from '../src/staff/store.js';

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
const WORKSPACE = '13000000-0000-4000-8000-000000000e01';
const OTHER_WORKSPACE = '13000000-0000-4000-8000-000000000e02';
// Its own site, so the follow-ups test counts exactly.
const DUE_WORKSPACE = '13000000-0000-4000-8000-000000000e03';
const ACTOR = '23000000-0000-4000-8000-000000000e01';
const COLLEAGUE = '23000000-0000-4000-8000-000000000e02';
const STRANGER = '23000000-0000-4000-8000-000000000e03';
const ACTOR_MEMBERSHIP = '33000000-0000-4000-8000-000000000e01';
const COLLEAGUE_MEMBERSHIP = '33000000-0000-4000-8000-000000000e02';
const ACTOR_OTHER_MEMBERSHIP = '33000000-0000-4000-8000-000000000e03';
const ACTOR_DUE_MEMBERSHIP = '33000000-0000-4000-8000-000000000e04';
const REQUEST_ID = '43000000-0000-4000-8000-000000000e01';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const MAIL_SECRET = 'ci-email-contact-hash-secret-0123456789';

const scope = { workspaceId: WORKSPACE, actorId: ACTOR, catalog: codePropertyCatalog };
const writeScope = { ...scope, requestId: REQUEST_ID };

const internetPayload = {
  planId: 'ab-1gbps',
  planLabel: '1Gbps',
  dateOfBirth: '1990-04-12',
  streetAddress: '12 Example Street',
  city: 'Calgary',
  consent: true,
  consentedAt: '2026-10-26T10:00:00.000Z',
};

databaseTest('DatabaseLeadWorkStore', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;

  async function createInternetLead(contact: { fullName: string; email: string; phone: string }) {
    const created = await leadStore.createLead({
      ...writeScope,
      leadType: 'internet',
      contact,
      form: { schemaVersion: 1, payload: internetPayload },
      consentVersion: 'cw-internet-contact-2026-10',
      submit: true,
    });
    return created.lead.id;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Each run starts from empty sites; the cascade clears their leads, tasks and timeline.
    await admin`
      delete from app.workspaces where id in (${WORKSPACE}, ${OTHER_WORKSPACE}, ${DUE_WORKSPACE})
    `;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE}, 'ci-lead-work', 'CI Lead Work'),
        (${OTHER_WORKSPACE}, 'ci-lead-work-other', 'CI Lead Work Other'),
        (${DUE_WORKSPACE}, 'ci-lead-work-due', 'CI Lead Work Due')
    `;
    await admin`
      insert into app.memberships (id, workspace_id, user_id, membership_type, status, accepted_at)
      values
        (${ACTOR_MEMBERSHIP}, ${WORKSPACE}, ${ACTOR}, 'staff', 'active', now()),
        (${COLLEAGUE_MEMBERSHIP}, ${WORKSPACE}, ${COLLEAGUE}, 'staff', 'active', now()),
        (${ACTOR_OTHER_MEMBERSHIP}, ${OTHER_WORKSPACE}, ${ACTOR}, 'staff', 'active', now()),
        (${ACTOR_DUE_MEMBERSHIP}, ${DUE_WORKSPACE}, ${ACTOR}, 'staff', 'active', now())
    `;
    // A revoked member keeps a row but can no longer be given work.
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, revoked_at)
      values (${WORKSPACE}, ${STRANGER}, 'staff', 'revoked', now())
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    leadStore = new DatabaseLeadStore(database);
    work = new DatabaseLeadWorkStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  test('a new lead starts at its type’s first stage with an empty timeline', async () => {
    const leadId = await createInternetLead({
      fullName: 'Robin Start',
      email: 'robin.start@example.test',
      phone: '403 555 0110',
    });
    const result = await work.getLead({ ...scope, leadId, includeWork: true });
    expect(result?.lead.stage).toBe('new');
    expect(result?.lead.form?.payload).toMatchObject({ planId: 'ab-1gbps' });
    expect(result?.activities).toEqual([]);
    expect(result?.tasks).toEqual([]);
    expect(leadDetailSchema.safeParse(result?.lead).success).toBe(true);
  });

  test('the lead page lists the same person’s other requests on this site only', async () => {
    const person = {
      fullName: 'Jordan Again',
      email: 'jordan.again@example.test',
      phone: '403 555 0150',
    };
    const first = await createInternetLead(person);
    const second = await createInternetLead({ ...person, email: 'Jordan.Again@example.test' });
    const third = await createInternetLead(person);
    await work.setArchived({ ...writeScope, leadId: third, archived: true });
    // Someone else, and the same person on another site, are not related here.
    await createInternetLead({ ...person, email: 'someone.else@example.test' });
    await leadStore.createLead({
      ...writeScope,
      workspaceId: OTHER_WORKSPACE,
      leadType: 'internet',
      contact: person,
      form: { schemaVersion: 1, payload: internetPayload },
      consentVersion: 'cw-internet-contact-2026-10',
      submit: true,
    });

    const page = await work.getLead({ ...scope, leadId: first, includeWork: true });
    expect(page?.related.map((entry) => entry.id)).toEqual([third, second]);
    expect(page?.related[0]).toMatchObject({ leadType: 'internet', stage: 'new' });
    expect(page?.related[0]?.deletedAt).not.toBeNull();
    expect(page?.related[1]?.deletedAt).toBeNull();

    const hidden = await work.getLead({ ...scope, leadId: first, includeWork: false });
    expect(hidden?.related).toEqual([]);
  });

  test('the lead page lists the identities given, a SIN masked and its sealed text never', async () => {
    const leadId = await createInternetLead({
      fullName: 'Sam Identity',
      email: 'sam.identity@example.test',
      phone: '403 555 0151',
    });
    const [sin] = await admin<{ id: string }[]>`
      insert into app.lead_identities (
        workspace_id, lead_id, id_type, sin_sealed, sin_last3, date_of_birth,
        credit_check_consent_at, created_by
      ) values (
        ${WORKSPACE}, ${leadId}, 'sin', 'v1.sealed-for-the-test', '286', '1990-01-31', now(), ${ACTOR}
      )
      returning id
    `;
    const page = await work.getLead({ ...scope, leadId, includeWork: true });
    expect(page?.identities).toEqual([
      {
        id: sin!.id,
        idType: 'sin',
        sinMasked: '*** *** 286',
        dateOfBirth: '1990-01-31',
        fileId: null,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('sealed-for-the-test');

    const hidden = await work.getLead({ ...scope, leadId, includeWork: false });
    expect(hidden?.identities).toEqual([]);
  });

  test('a stage change is checked against the type, recorded on the timeline and audited', async () => {
    const leadId = await createInternetLead({
      fullName: 'Casey Stage',
      email: 'casey.stage@example.test',
      phone: '403 555 0111',
    });

    expect(await work.updateLead({ ...writeScope, leadId, stage: 'activated' })).toEqual({
      status: 'invalid_stage',
    });

    const outcome = await work.updateLead({ ...writeScope, leadId, stage: 'existing_shaw' });
    if (outcome.status !== 'updated') throw new Error(`expected updated, got ${outcome.status}`);
    expect(outcome.lead.stage).toBe('existing_shaw');
    expect(outcome.activities).toEqual([
      expect.objectContaining({
        kind: 'status_change',
        from: 'new',
        to: 'existing_shaw',
        actorId: ACTOR,
      }),
    ]);

    // The same stage again changes nothing and writes nothing.
    const again = await work.updateLead({ ...writeScope, leadId, stage: 'existing_shaw' });
    expect(again).toMatchObject({ status: 'updated', activities: [] });

    const audit = await admin<{ action: string; before: unknown; after: unknown }[]>`
      select action, before, after from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id = ${leadId} and action = 'lead.updated'
    `;
    expect(audit).toEqual([
      { action: 'lead.updated', before: { stage: 'new' }, after: { stage: 'existing_shaw' } },
    ]);
  });

  test('only an active member of the site can be assigned, and unassigning is recorded', async () => {
    const leadId = await createInternetLead({
      fullName: 'Drew Assign',
      email: 'drew.assign@example.test',
      phone: '403 555 0112',
    });

    for (const assignee of [STRANGER, '23000000-0000-4000-8000-0000000000ff']) {
      expect(await work.updateLead({ ...writeScope, leadId, assignedActorId: assignee })).toEqual({
        status: 'assignee_not_found',
      });
    }

    const assigned = await work.updateLead({ ...writeScope, leadId, assignedActorId: COLLEAGUE });
    if (assigned.status !== 'updated') throw new Error('expected updated');
    expect(assigned.lead.assignedActorId).toBe(COLLEAGUE);
    expect(assigned.activities).toEqual([
      expect.objectContaining({ kind: 'assignment', from: null, to: COLLEAGUE }),
    ]);

    const unassigned = await work.updateLead({ ...writeScope, leadId, assignedActorId: null });
    if (unassigned.status !== 'updated') throw new Error('expected updated');
    expect(unassigned.lead.assignedActorId).toBeNull();
    expect(unassigned.activities).toEqual([
      expect.objectContaining({ kind: 'assignment', from: COLLEAGUE, to: null }),
    ]);
  });

  test('an order correction checks each field, keeps the plan label, and records names only', async () => {
    // On the other site, so this file's per-site counts stay internet-only.
    const orderScope = { ...writeScope, workspaceId: OTHER_WORKSPACE };
    const created = await leadStore.createLead({
      ...orderScope,
      leadType: 'sim_order',
      contact: {
        fullName: 'Arjun Order',
        email: 'arjun.order@example.test',
        phone: '+91 99999 00001',
      },
      form: {
        schemaVersion: 1,
        payload: {
          planId: 'unlimited-data-rogers',
          planLabel: 'Unlimited Data · $40, Rogers',
          delivery: 'esim',
          arrivalDate: '2026-11-02',
          customerNotes: 'Call after 6pm',
        },
      },
      consentVersion: 'gcs-order-2026-10',
      submit: true,
    });
    const leadId = created.lead.id;
    // A submitted order starts incomplete; verified is reached through pending.
    expect(await work.updateLead({ ...orderScope, leadId, stage: 'pending' })).toMatchObject({
      status: 'updated',
    });

    const outcome = await work.updateLead({
      ...orderScope,
      leadId,
      stage: 'verified',
      form: { planId: '75gb-fido', arrivalDate: '2026-11-09', simNumber: '4165550104' },
    });
    if (outcome.status !== 'updated') throw new Error('expected updated');
    expect(outcome.lead.form).toEqual({
      schemaVersion: 1,
      payload: {
        planId: '75gb-fido',
        planLabel: '75GB · $35, Fido',
        delivery: 'esim',
        arrivalDate: '2026-11-09',
        customerNotes: 'Call after 6pm',
        simNumber: '4165550104',
      },
    });
    expect(outcome.activities.map((entry) => entry.kind).sort()).toEqual(['edit', 'status_change']);
    expect(outcome.activities).toContainEqual(
      expect.objectContaining({ kind: 'edit', fields: ['planId', 'arrivalDate', 'simNumber'] }),
    );

    // Neither the timeline nor the audit trail keeps the values.
    const stored = await admin<{ data: unknown; after: unknown }[]>`
      select a.data, e.after
      from app.lead_activities a, app.audit_events e
      where a.lead_id = ${leadId} and a.kind = 'edit'
        and e.entity_id = ${leadId} and e.action = 'lead.updated'
    `;
    expect(JSON.stringify(stored)).not.toContain('4165550104');
    expect(JSON.stringify(stored)).not.toContain('Fido');

    // A refused field changes nothing at all, the stage included.
    const refused: Array<[Record<string, string>, string]> = [
      [{ customerNotes: 'rewritten' }, 'customerNotes'],
      [{ delivery: 'pickup' }, 'shippingAddress'],
    ];
    for (const [form, field] of refused) {
      expect(await work.updateLead({ ...orderScope, leadId, stage: 'cancelled', form })).toEqual({
        status: 'invalid_field',
        field,
      });
    }
    const unchanged = await work.getLead({
      workspaceId: OTHER_WORKSPACE,
      catalog: codePropertyCatalog,
      actorId: ACTOR,
      leadId,
      includeWork: false,
    });
    expect(unchanged?.lead.stage).toBe('verified');

    // The same values again are no change and write nothing.
    const again = await work.updateLead({ ...orderScope, leadId, form: { planId: '75gb-fido' } });
    expect(again).toMatchObject({ status: 'updated', activities: [] });
  });

  test('a lead is new until someone who works leads opens it, and only the first open is kept', async () => {
    const leadId = await createInternetLead({
      fullName: 'Nova Unopened',
      email: 'nova.unopened@example.test',
      phone: '403 555 0160',
    });
    const before = await work.getLead({ ...scope, leadId, includeWork: true });
    expect(before?.lead.isNew).toBe(true);
    const unopened = async () =>
      (await work.summary(scope)).types.find((entry) => entry.leadType === 'internet')?.unopened;
    const countBefore = await unopened();

    const opened = await Promise.all([
      work.markOpened({ ...writeScope, leadId }),
      work.markOpened({ ...writeScope, leadId }),
    ]);
    expect(opened.filter((entry) => entry.status === 'opened' && entry.activity)).toHaveLength(1);
    expect(opened).toContainEqual({
      status: 'opened',
      activity: expect.objectContaining({ kind: 'system', event: 'opened', actorId: ACTOR }),
    });
    expect(await work.markOpened({ ...writeScope, leadId })).toEqual({
      status: 'opened',
      activity: null,
    });

    const after = await work.getLead({ ...scope, leadId, includeWork: true });
    expect(after?.lead.isNew).toBe(false);
    expect(after?.activities.filter((entry) => entry.kind === 'system')).toHaveLength(1);
    // Opening is not work on the lead: its place in the inbox stays.
    expect(after?.lead.updatedAt).toBe(before?.lead.updatedAt);
    expect(await unopened()).toBe((countBefore ?? 0) - 1);

    expect(
      await work.markOpened({ ...writeScope, leadId: '13000000-0000-4000-8000-0000000000ff' }),
    ).toEqual({ status: 'not_found' });
  });

  test('a contact correction moves the lead to the right contact and records field names only', async () => {
    const leadId = await createInternetLead({
      fullName: 'Ellis Typo',
      email: 'ellis.typo@exmaple.test',
      phone: '403 555 0113',
    });

    const outcome = await work.updateLead({
      ...writeScope,
      leadId,
      contact: { email: 'ellis.fixed@example.test', phone: '403 555 0199' },
    });
    if (outcome.status !== 'updated') throw new Error('expected updated');
    expect(outcome.lead.contact).toMatchObject({
      email: 'ellis.fixed@example.test',
      phone: '403 555 0199',
      fullName: 'Ellis Typo',
    });
    expect(outcome.activities).toEqual([
      expect.objectContaining({ kind: 'edit', fields: ['email', 'phone'] }),
    ]);

    const [contact] = await admin<{ email: string; phone: string }[]>`
      select c.email, c.phone from app.contacts c
      join app.leads l on l.contact_id = c.id
      where l.id = ${leadId}
    `;
    expect(contact).toEqual({ email: 'ellis.fixed@example.test', phone: '403 555 0199' });

    // Neither the timeline nor the audit trail keeps the values.
    const stored = await admin<{ data: unknown; after: unknown }[]>`
      select a.data, e.after
      from app.lead_activities a, app.audit_events e
      where a.lead_id = ${leadId} and a.kind = 'edit'
        and e.entity_id = ${leadId} and e.action = 'lead.updated'
    `;
    expect(JSON.stringify(stored)).not.toContain('example.test');
    expect(JSON.stringify(stored)).not.toContain('0199');
  });

  test('notes land on the timeline newest first and move the lead up the inbox', async () => {
    const leadId = await createInternetLead({
      fullName: 'Frankie Note',
      email: 'frankie.note@example.test',
      phone: '403 555 0114',
    });
    const before = await work.getLead({ ...scope, leadId, includeWork: true });

    const first = await work.addNote({ ...writeScope, leadId, body: 'Called, no answer.' });
    const second = await work.addNote({
      ...writeScope,
      leadId,
      body: 'Booked install for Monday.',
    });
    if (first.status !== 'created' || second.status !== 'created')
      throw new Error('expected notes');

    const after = await work.getLead({ ...scope, leadId, includeWork: true });
    expect(after?.activities.map((entry) => entry.kind === 'note' && entry.body)).toEqual([
      'Booked install for Monday.',
      'Called, no answer.',
    ]);
    expect(after?.activities.every((entry) => leadActivitySchema.safeParse(entry).success)).toBe(
      true,
    );
    expect(Date.parse(after?.lead.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(before?.lead.updatedAt ?? ''),
    );
  });

  test('tasks complete, reopen and cancel; the lead summarises its open ones', async () => {
    const leadId = await createInternetLead({
      fullName: 'Gale Task',
      email: 'gale.task@example.test',
      phone: '403 555 0115',
    });

    expect(
      await work.createTask({ ...writeScope, leadId, title: 'x', assignedActorId: STRANGER }),
    ).toEqual({ status: 'assignee_not_found' });

    const later = await work.createTask({
      ...writeScope,
      leadId,
      title: 'Send the contract',
      dueAt: '2026-11-20T12:00:00.000Z',
      assignedActorId: ACTOR,
    });
    const sooner = await work.createTask({
      ...writeScope,
      leadId,
      title: 'Call back',
      dueAt: '2026-11-02T12:00:00.000Z',
      assignedActorId: ACTOR,
    });
    const undated = await work.createTask({ ...writeScope, leadId, title: 'Check the address' });
    if (later.status !== 'saved' || sooner.status !== 'saved' || undated.status !== 'saved') {
      throw new Error('expected tasks');
    }
    expect(leadTaskSchema.safeParse(later.task).success).toBe(true);

    const detail = await work.getLead({ ...scope, leadId, includeWork: true });
    expect(detail?.tasks.map((task) => task.title)).toEqual([
      'Call back',
      'Send the contract',
      'Check the address',
    ]);
    expect(detail?.lead.openTaskCount).toBe(3);
    expect(detail?.lead.nextTaskDueAt).toBe('2026-11-02T12:00:00.000Z');

    const done = await work.updateTask({ ...writeScope, taskId: sooner.task.id, status: 'done' });
    if (done.status !== 'saved') throw new Error('expected saved');
    expect(done.task.status).toBe('done');
    expect(done.task.completedAt).not.toBeNull();

    const reopened = await work.updateTask({
      ...writeScope,
      taskId: sooner.task.id,
      status: 'open',
    });
    if (reopened.status !== 'saved') throw new Error('expected saved');
    expect(reopened.task.completedAt).toBeNull();

    const cancelled = await work.updateTask({
      ...writeScope,
      taskId: undated.task.id,
      status: 'cancelled',
      title: 'Check the address (dropped)',
    });
    if (cancelled.status !== 'saved') throw new Error('expected saved');
    expect(cancelled.task).toMatchObject({
      status: 'cancelled',
      completedAt: null,
      title: 'Check the address (dropped)',
    });

    const mine = await work.listTasks({ ...scope, assignee: 'me', status: 'open' }, 1, 50);
    const mineHere = mine.tasks.filter((task) => task.leadId === leadId);
    expect(mineHere.map((task) => task.title)).toEqual(['Call back', 'Send the contract']);
    expect(mineHere[0]?.lead).toMatchObject({
      id: leadId,
      leadType: 'internet',
      contact: { fullName: 'Gale Task' },
    });

    expect(
      await work.updateTask({
        ...writeScope,
        taskId: '53000000-0000-4000-8000-0000000000ee',
        status: 'done',
      }),
    ).toEqual({ status: 'not_found' });
  });

  test('the trash hides a lead, refuses work on it, and restores it in place', async () => {
    const leadId = await createInternetLead({
      fullName: 'Harper Trash',
      email: 'harper.trash@example.test',
      phone: '403 555 0116',
    });
    const task = await work.createTask({
      ...writeScope,
      leadId,
      title: 'Follow up',
      assignedActorId: ACTOR,
    });
    if (task.status !== 'saved') throw new Error('expected task');
    const before = await work.getLead({ ...scope, leadId, includeWork: false });

    const trashed = await work.setArchived({ ...writeScope, leadId, archived: true });
    if (trashed.status === 'not_found') throw new Error('expected the lead');
    expect(trashed.status).toBe('changed');
    expect(trashed.lead.deletedAt).not.toBeNull();
    expect(trashed.activity).toMatchObject({ kind: 'system', event: 'trashed' });
    // The inbox order is untouched.
    expect(trashed.lead.updatedAt).toBe(before?.lead.updatedAt);

    expect(await work.setArchived({ ...writeScope, leadId, archived: true })).toMatchObject({
      status: 'unchanged',
      activity: null,
    });
    expect(await work.updateLead({ ...writeScope, leadId, stage: 'won' })).toEqual({
      status: 'trashed',
    });
    expect(await work.addNote({ ...writeScope, leadId, body: 'x' })).toEqual({ status: 'trashed' });
    expect(await work.createTask({ ...writeScope, leadId, title: 'x' })).toEqual({
      status: 'trashed',
    });
    expect(await work.updateTask({ ...writeScope, taskId: task.task.id, status: 'done' })).toEqual({
      status: 'trashed',
    });

    const active = await leadStore.listLeads({ ...scope, pageSize: 200 });
    expect(active.leads.some((lead) => lead.id === leadId)).toBe(false);
    const trash = await leadStore.listLeads({ ...scope, view: 'trash' });
    expect(trash.leads.map((lead) => lead.id)).toContain(leadId);
    const mine = await work.listTasks({ ...scope, assignee: 'me', status: 'open' }, 1, 200);
    expect(mine.tasks.some((entry) => entry.id === task.task.id)).toBe(false);

    const restored = await work.setArchived({ ...writeScope, leadId, archived: false });
    if (restored.status === 'not_found') throw new Error('expected the lead');
    expect(restored.lead.deletedAt).toBeNull();
    expect(restored.activity).toMatchObject({ kind: 'system', event: 'restored' });
  });

  test('the list filters by stage, assignee and search, with wildcards taken literally', async () => {
    const quinn = await createInternetLead({
      fullName: 'Quinn 100% Search',
      email: 'quinn.search@example.test',
      phone: '+1 (604) 555-0177',
    });
    const remy = await createInternetLead({
      fullName: 'Remy Search',
      email: 'remy_search@example.test',
      phone: '604 555 0178',
    });
    await work.updateLead({
      ...writeScope,
      leadId: quinn,
      stage: 'qualified',
      assignedActorId: ACTOR,
    });

    const ids = async (input: Parameters<DatabaseLeadStore['listLeads']>[0]) =>
      (await leadStore.listLeads({ pageSize: 200, ...input })).leads.map((lead) => lead.id);

    expect(await ids({ ...scope, stage: 'qualified' })).toContain(quinn);
    expect(await ids({ ...scope, stage: 'qualified' })).not.toContain(remy);
    expect(await ids({ ...scope, assignee: 'me' })).toContain(quinn);
    expect(await ids({ ...scope, assignee: 'none' })).toContain(remy);
    expect(await ids({ ...scope, assignee: 'none' })).not.toContain(quinn);
    expect(await ids({ ...scope, assignee: COLLEAGUE })).not.toContain(quinn);
    expect(await ids({ ...scope, search: 'quinn.SEARCH' })).toEqual([quinn]);
    expect(await ids({ ...scope, search: '6045550177' })).toEqual([quinn]);
    // `%` and `_` are characters, not wildcards.
    expect(await ids({ ...scope, search: '100%' })).toEqual([quinn]);
    expect(await ids({ ...scope, search: 'remy_' })).toEqual([remy]);
    expect(await ids({ ...scope, search: 'y_s' })).toEqual([remy]);
  });

  test('the board lists every catalogue stage in order, with counts and a capped page each', async () => {
    const board = await work.board({ ...scope, leadType: 'internet' }, 2);
    expect(board.map((column) => column.stage)).toEqual([
      'new',
      'contacted',
      'qualified',
      'existing_shaw',
      'non_serviceable_address',
      'old_due',
      'installed',
      'won',
      'lost',
    ]);
    const fresh = board.find((column) => column.stage === 'new');
    expect(fresh?.leads.length).toBe(2);
    expect(fresh?.total).toBeGreaterThan(2);

    // A stored stage the catalogue does not know still gets a column.
    const odd = await createInternetLead({
      fullName: 'Odd Stage',
      email: 'odd.stage@example.test',
      phone: '403 555 0117',
    });
    await admin`update app.leads set stage = 'retired_stage' where id = ${odd}`;
    const withOdd = await work.board({ ...scope, leadType: 'internet' }, 2);
    expect(withOdd.at(-1)).toMatchObject({ stage: 'retired_stage', total: 1 });
  });

  test('the summary counts active leads per type and the trash', async () => {
    const summary = await work.summary(scope);
    const internet = summary.types.find((entry) => entry.leadType === 'internet');
    const [counts] = await admin<{ active: number; trashed: number }[]>`
      select
        count(*) filter (where deleted_at is null)::int as active,
        count(*) filter (where deleted_at is not null)::int as trashed
      from app.leads where workspace_id = ${WORKSPACE}
    `;
    expect(internet?.total).toBe(counts?.active);
    expect(summary.archived).toBe(counts?.trashed);
  });

  test('follow-ups due by a calendar day: the list, the summary and the team’s tasks', async () => {
    const dueScope = { ...writeScope, workspaceId: DUE_WORKSPACE };
    const lead = async (
      leadType: 'internet' | 'sim_order',
      name: string,
      payload: Record<string, unknown>,
      externalRef?: string,
    ) => {
      const created = await leadStore.createLead({
        ...dueScope,
        leadType,
        externalRef,
        contact: { fullName: name, email: `${name.toLowerCase()}@example.test`, phone: '000' },
        form: { schemaVersion: 1, payload },
        consentVersion: 'ci-due',
        submit: true,
      });
      return created.lead.id;
    };
    const task = async (leadId: string, title: string, dueAt: string | null) => {
      const created = await work.createTask({ ...dueScope, leadId, title, dueAt });
      if (created.status !== 'saved') throw new Error('expected a task');
      return created.task.id;
    };

    const overdue = await lead('internet', 'Overdue', internetPayload);
    await task(overdue, 'Call about the install', '2026-11-01T12:00:00.000Z');
    await task(overdue, 'Send the contract', '2026-11-20T12:00:00.000Z');
    const order = await lead(
      'sim_order',
      'Arriving',
      { planId: '75gb-fido', delivery: 'esim', arrivalDate: '2026-11-09' },
      'MS-900',
    );
    // Late on the day itself is still due by that day.
    await task(order, 'Check the visa', '2026-11-05T23:30:00.000Z');
    const notYet = await lead('internet', 'Notyet', internetPayload);
    await task(notYet, 'Tomorrow’s call', '2026-11-06T00:00:00.000Z');
    const finished = await task(notYet, 'Old call', '2026-10-01T12:00:00.000Z');
    await work.updateTask({ ...dueScope, taskId: finished, status: 'done' });
    const undated = await lead('internet', 'Undated', internetPayload);
    await task(undated, 'Whenever', null);
    const trashed = await lead('internet', 'Trashed', internetPayload);
    await task(trashed, 'Never shown', '2026-10-01T12:00:00.000Z');
    await work.setArchived({ ...dueScope, leadId: trashed, archived: true });

    const due = await leadStore.listLeads({
      workspaceId: DUE_WORKSPACE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      dueBy: '2026-11-05',
    });
    // The most overdue first, whatever moved last.
    expect(due.leads.map((entry) => entry.id)).toEqual([overdue, order]);
    expect(due.page.total).toBe(2);
    expect(due.leads.map((entry) => entry.nextTaskDueAt)).toEqual([
      '2026-11-01T12:00:00.000Z',
      '2026-11-05T23:30:00.000Z',
    ]);
    const all = await leadStore.listLeads({
      workspaceId: DUE_WORKSPACE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
    });
    expect(all.leads.map((entry) => entry.id).sort()).toEqual(
      [overdue, order, notYet, undated].sort(),
    );

    // The order's arrival counts down on lists; a lead type without a countdown has none.
    expect(due.leads.find((entry) => entry.id === order)?.countdownDate).toBe('2026-11-09');
    expect(due.leads.find((entry) => entry.id === overdue)?.countdownDate).toBeNull();
    // A stored value that is not a calendar day counts down to nothing.
    await admin`
      update app.leads set payload = jsonb_set(payload, '{payload,arrivalDate}', '"soon"')
      where id = ${order}
    `;
    const odd = await leadStore.listLeads({
      workspaceId: DUE_WORKSPACE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
      dueBy: '2026-11-05',
    });
    expect(odd.leads.find((entry) => entry.id === order)?.countdownDate).toBeNull();

    const summary = await work.summary({
      workspaceId: DUE_WORKSPACE,
      actorId: ACTOR,
      dueBy: '2026-11-05',
    });
    expect(summary.types).toEqual([
      expect.objectContaining({ leadType: 'internet', total: 3, followUpsDue: 1 }),
      expect.objectContaining({ leadType: 'sim_order', total: 1, followUpsDue: 1 }),
    ]);
    const plain = await work.summary({ workspaceId: DUE_WORKSPACE, actorId: ACTOR });
    expect(plain.types.every((entry) => entry.followUpsDue === undefined)).toBe(true);

    const teamDue = await work.listTasks(
      {
        workspaceId: DUE_WORKSPACE,
        actorId: ACTOR,
        assignee: 'all',
        status: 'open',
        dueBy: '2026-11-05',
      },
      1,
      6,
    );
    expect(teamDue.total).toBe(2);
    expect(teamDue.tasks.map((entry) => entry.title)).toEqual([
      'Call about the install',
      'Check the visa',
    ]);
    expect(teamDue.tasks[1]?.lead).toMatchObject({
      id: order,
      leadType: 'sim_order',
      externalRef: 'MS-900',
      contact: { fullName: 'Arriving' },
    });
    const teamOpen = await work.listTasks(
      { workspaceId: DUE_WORKSPACE, actorId: ACTOR, assignee: 'all', status: 'open' },
      1,
      50,
    );
    // Every open task on an active lead, undated last; none of the trashed lead's.
    expect(teamOpen.tasks.map((entry) => entry.title)).toEqual([
      'Call about the install',
      'Check the visa',
      'Tomorrow’s call',
      'Send the contract',
      'Whenever',
    ]);
  });

  test('a mail to the customer waits in the outbox; its entry keeps no address or number', async () => {
    // On the other site, beside the order-correction test's order; its sender is the deployment's.
    const mailScope = { ...writeScope, workspaceId: OTHER_WORKSPACE };
    const mailWork = new DatabaseLeadWorkStore(
      database,
      customerEmailEnvironmentFromEnv({
        EMAIL_PROVIDER: 'fake',
        NODE_ENV: 'test',
        EMAIL_CONTACT_HASH_SECRET: MAIL_SECRET,
        EMAIL_SENDERS_JSON: JSON.stringify([
          {
            workspaceId: OTHER_WORKSPACE,
            fromAddress: 'order@site.example',
            fromName: 'The Site',
            siteUrl: 'https://site.example',
          },
        ]),
      }),
    );
    const created = await leadStore.createLead({
      ...mailScope,
      leadType: 'sim_order',
      externalRef: 'MS-777',
      contact: { fullName: 'Mail Person', email: 'mail.person@example.test', phone: '000' },
      form: {
        schemaVersion: 1,
        payload: { planId: '75gb-fido', delivery: 'esim', arrivalDate: '2026-11-09' },
      },
      consentVersion: 'ci-mail',
      submit: true,
    });
    const leadId = created.lead.id;
    const queue = (id = leadId, store = mailWork) =>
      store.queueCustomerEmail({
        ...mailScope,
        requestId: crypto.randomUUID(),
        leadId: id,
        template: 'sim_number_ready',
      });

    expect(await queue()).toEqual({ status: 'missing', missing: ['SIM number'] });
    // A deployment that cannot send has no sender for any site.
    expect(await queue(leadId, work)).toEqual({ status: 'no_sender' });
    await work.updateLead({ ...mailScope, leadId, form: { simNumber: '+1 778-555-0142' } });
    expect(await queue()).toMatchObject({
      status: 'queued',
      activity: {
        kind: 'system',
        event: 'customer_emailed',
        template: 'sim_number_ready',
        templateVersion: 0,
      },
    });

    const jobs = await admin<{ job_type: string; status: string; payload: unknown }[]>`
      select job_type, status, payload from app.outbox_jobs
      where workspace_id = ${OTHER_WORKSPACE} and payload ->> 'leadId' = ${leadId}
    `;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: 'lead_customer_email',
      status: 'pending',
      payload: {
        leadId,
        template: 'sim_number_ready',
        templateVersion: 0,
        toAddress: 'mail.person@example.test',
        contactHash: hashContact('mail.person@example.test', MAIL_SECRET),
        sender: { fromName: 'The Site', fromAddress: 'order@site.example' },
      },
    });
    expect(JSON.stringify(jobs[0]?.payload)).toContain('+1 778-555-0142');
    // Only the job holds the address and the number.
    const stored = await admin<{ data: unknown; after: unknown }[]>`
      select a.data, e.after
      from app.lead_activities a, app.audit_events e
      where a.lead_id = ${leadId} and a.kind = 'system' and a.data ->> 'event' = 'customer_emailed'
        and e.entity_id = ${leadId} and e.action = 'lead.customer_emailed'
    `;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('mail.person');
    expect(JSON.stringify(stored)).not.toContain('778-555');
    const page = await work.getLead({
      workspaceId: OTHER_WORKSPACE,
      catalog: codePropertyCatalog,
      actorId: ACTOR,
      leadId,
      includeWork: true,
    });
    expect(page?.activities[0]).toMatchObject({ event: 'customer_emailed' });

    await work.setArchived({ ...mailScope, leadId, archived: true });
    expect(await queue()).toEqual({ status: 'trashed' });
    expect(await queue('53000000-0000-4000-8000-0000000000ef')).toEqual({ status: 'not_found' });
  });

  test('another site cannot read or change these leads', async () => {
    const leadId = await createInternetLead({
      fullName: 'Isla Isolated',
      email: 'isla.isolated@example.test',
      phone: '403 555 0118',
    });
    const otherScope = {
      workspaceId: OTHER_WORKSPACE,
      actorId: ACTOR,
      catalog: codePropertyCatalog,
    };
    expect(await work.getLead({ ...otherScope, leadId, includeWork: true })).toBeUndefined();
    expect(
      await work.updateLead({ ...otherScope, requestId: REQUEST_ID, leadId, stage: 'won' }),
    ).toEqual({ status: 'not_found' });
    expect(await work.addNote({ ...otherScope, requestId: REQUEST_ID, leadId, body: 'x' })).toEqual(
      { status: 'not_found' },
    );
  });

  test('a display name is set on each of the actor’s active memberships and listed to colleagues', async () => {
    const staff = new DatabaseStaffStore(database);
    const renamed = await staff.setDisplayName({
      actorId: ACTOR,
      displayName: 'Takib',
      requestId: REQUEST_ID,
    });
    // All three test sites; the revoked membership elsewhere is not renamed.
    expect(renamed).toBe(3);

    const members = await staff.listAssignableMembers(WORKSPACE, COLLEAGUE);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: ACTOR, displayName: 'Takib', isSelf: false }),
        expect.objectContaining({ actorId: COLLEAGUE, displayName: null, isSelf: true }),
      ]),
    );
    expect(members.some((member) => member.actorId === STRANGER)).toBe(false);
  });
});
