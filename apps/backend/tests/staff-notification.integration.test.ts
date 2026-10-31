import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { fireFlows, type FlowEvent } from '../src/automations/engine.js';
import type { StaffNotificationEnvironment } from '../src/automations/staff-notification.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseStaffStore } from '../src/staff/store.js';
import { disposableTestDatabaseUrl, flowKey, insertActiveFlow } from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008501'; // notifications
const SIGNIN_SITE = '18000000-0000-4000-8000-000000008502'; // sign-in, active
const OTHER_SIGNIN_SITE = '18000000-0000-4000-8000-000000008503'; // sign-in, active
const SITES = [SITE, SIGNIN_SITE, OTHER_SIGNIN_SITE];
const OWNER = '28000000-0000-4000-8000-000000008501';
const ASSIGNEE = '28000000-0000-4000-8000-000000008502'; // has an address
const ADDRESSED = '28000000-0000-4000-8000-000000008503'; // has an address
const NO_ADDRESS = '28000000-0000-4000-8000-000000008504'; // active, never signed in since
const GONE = '28000000-0000-4000-8000-000000008505'; // revoked
const SIGNER = '28000000-0000-4000-8000-000000008506'; // signs in
const WEBSITE = '28000000-0000-4000-8000-000000008507'; // a website credential: no member
const INVITEE = '28000000-0000-4000-8000-000000008508'; // first sign-in, invited
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789',
};

const ready: StaffNotificationEnvironment = {
  ready: true,
  adminOrigin: 'https://crm.example',
  sender: null,
  contactHash: () => 'unused',
};

const flow = (steps: readonly unknown[]) => ({
  schemaVersion: 1,
  trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'on_hold', when: null },
  steps,
});

databaseTest('staff notifications and the notification address', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const insertLead = async (assignedActorId: string | null): Promise<string> => {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        full_name, email, assigned_actor_id
      ) values (
        ${id}, ${SITE}, 'sim_order', 'submitted', 'on_hold', 'ci', '{}'::jsonb,
        '{"schemaVersion":1,"payload":{}}'::jsonb, 'Nadia Khan', 'customer@example.test',
        ${assignedActorId}
      )
    `;
    return id;
  };

  const fire = (
    leadId: string,
    occurrence: string,
    staffNotifications = ready,
    actorId = OWNER,
    after?: (actor: string | undefined) => void,
  ) =>
    database.withTenantTx({ workspaceId: SITE, actorId }, async (tx) => {
      const event: FlowEvent = {
        kind: 'stage_entered',
        leadId,
        leadType: 'sim_order',
        stage: 'on_hold',
        occurrence,
        depth: 0,
        chain: [],
        parentRunId: null,
        at: new Date(),
      };
      const fired = await fireFlows(
        tx,
        { workspaceId: SITE, actorId, requestId: randomUUID(), environment, staffNotifications },
        [event],
      );
      const [setting] = await tx.execute<{ actorId: string }>(
        sql`select current_setting('app.actor_id', true) as "actorId"`,
      );
      after?.(setting?.actorId);
      return fired;
    });

  const jobs = (leadId: string) =>
    admin<{ dedupeKey: string; payload: Record<string, unknown> }[]>`
      select dedupe_key as "dedupeKey", payload from app.outbox_jobs
      where job_type = 'staff_notification_email' and payload ->> 'leadId' = ${leadId}
      order by dedupe_key
    `;

  const stepOf = async (leadId: string) => {
    const [row] = await admin<{ outcome: string; reason: string | null; detail: string | null }[]>`
      select s.outcome, s.reason, s.detail
      from app.automation_step_runs s
      join app.automation_runs r on r.workspace_id = s.workspace_id and r.id = s.run_id
      where r.lead_id = ${leadId}
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
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'getcanadasim-8501', 'GetCanadaSim'),
             (${SIGNIN_SITE}, 'signin-8502', 'Sign In One'),
             (${OTHER_SIGNIN_SITE}, 'signin-8503', 'Sign In Two')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, notification_email)
      values (${SITE}, ${OWNER}, 'staff', 'active', 'owner@staff.example'),
             (${SITE}, ${ASSIGNEE}, 'staff', 'active', 'assignee@staff.example'),
             (${SITE}, ${ADDRESSED}, 'staff', 'active', 'addressed@staff.example'),
             (${SITE}, ${NO_ADDRESS}, 'staff', 'active', null),
             (${SITE}, ${GONE}, 'staff', 'revoked', 'gone@staff.example'),
             (${SITE}, ${SIGNER}, 'staff', 'revoked', null),
             (${SIGNIN_SITE}, ${SIGNER}, 'staff', 'active', null),
             (${OTHER_SIGNIN_SITE}, ${SIGNER}, 'staff', 'active', null)
    `;
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8501', 1),
      name: 'Follow up new orders',
      enabled: true,
      definition: flow([
        {
          id: 's_notify',
          kind: 'notify_staff',
          toAssignee: true,
          actorIds: [ADDRESSED, NO_ADDRESS],
          note: 'Call them before noon.',
        },
      ]),
      actorId: OWNER,
    });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 2,
    });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('notify_staff queues one job per recipient without an address in it', async () => {
    const leadId = await insertLead(ASSIGNEE);
    await fire(leadId, 'notify-1');
    const queued = await jobs(leadId);
    const flowKeyOne = flowKey('8501', 1);
    expect(queued.map((job) => job.dedupeKey).sort()).toEqual(
      [
        `${leadId}:${flowKeyOne}:notify-1:s_notify:${ADDRESSED}`,
        `${leadId}:${flowKeyOne}:notify-1:s_notify:${ASSIGNEE}`,
      ].sort(),
    );
    for (const job of queued) expect(JSON.stringify(job.payload)).not.toContain('@');
    expect(queued.find((job) => job.payload.actorId === ASSIGNEE)?.payload).toEqual({
      actorId: ASSIGNEE,
      flowKey: flowKeyOne,
      flowName: 'Follow up new orders',
      siteName: 'GetCanadaSim',
      leadId,
      leadPath: `/w/getcanadasim-8501/leads/${leadId}`,
      note: 'Call them before noon.',
    });
    expect(await stepOf(leadId)).toEqual({
      outcome: 'done',
      reason: null,
      detail: `member_has_no_address:${NO_ADDRESS}`,
    });
    // The same occurrence again: no new run, no new job.
    await fire(leadId, 'notify-1');
    expect(await jobs(leadId)).toHaveLength(2);
  });

  it('a member without an address or gone is named in the detail', async () => {
    const leadId = await insertLead(GONE);
    await fire(leadId, 'notify-2');
    expect((await jobs(leadId)).map((job) => job.payload.actorId)).toEqual([ADDRESSED]);
    expect(await stepOf(leadId)).toEqual({
      outcome: 'done',
      reason: null,
      detail: `member_unavailable:${GONE},member_has_no_address:${NO_ADDRESS}`,
    });
  });

  it('a write by the website still names the site and links the lead, and keeps its actor', async () => {
    const leadId = await insertLead(ASSIGNEE);
    let actorAfter: string | undefined;
    await fire(leadId, 'notify-4', ready, WEBSITE, (actor) => {
      actorAfter = actor;
    });
    const queued = await jobs(leadId);
    expect(queued).toHaveLength(2);
    expect(queued[0]?.payload).toMatchObject({
      siteName: 'GetCanadaSim',
      leadPath: `/w/getcanadasim-8501/leads/${leadId}`,
    });
    expect(actorAfter).toBe(WEBSITE);
  });

  it('a website write on a flow with no activator, mailing only the assignee, still names the site', async () => {
    await insertActiveFlow(admin, {
      workspaceId: SITE,
      key: flowKey('8501', 2),
      name: 'Assignee only',
      enabled: true,
      definition: {
        ...flow([
          { id: 's_notify', kind: 'notify_staff', toAssignee: true, actorIds: [], note: '' },
        ]),
        trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when: null },
      },
      actorId: OWNER,
      activatedBy: null,
    });
    const leadId = await insertLead(ASSIGNEE);
    await database.withTenantTx({ workspaceId: SITE, actorId: WEBSITE }, (tx) =>
      fireFlows(
        tx,
        {
          workspaceId: SITE,
          actorId: WEBSITE,
          requestId: randomUUID(),
          environment,
          staffNotifications: ready,
        },
        [
          {
            kind: 'stage_entered',
            leadId,
            leadType: 'sim_order',
            stage: 'verified',
            occurrence: 'notify-5',
            depth: 0,
            chain: [],
            parentRunId: null,
            at: new Date(),
          },
        ],
      ),
    );
    expect((await jobs(leadId)).map((job) => job.payload)).toEqual([
      expect.objectContaining({
        actorId: ASSIGNEE,
        siteName: 'GetCanadaSim',
        leadPath: `/w/getcanadasim-8501/leads/${leadId}`,
      }),
    ]);
  });

  it('no deployment sender skips no_staff_sender', async () => {
    const leadId = await insertLead(ASSIGNEE);
    await fire(leadId, 'notify-3', { ...ready, ready: false });
    expect(await jobs(leadId)).toEqual([]);
    expect(await stepOf(leadId)).toEqual({
      outcome: 'skipped',
      reason: 'no_staff_sender',
      detail: null,
    });
  });

  it('sign-in records the verified address on every active membership, and only when it changed', async () => {
    const store = new DatabaseStaffStore(database);
    const state = () =>
      admin<{ workspaceId: string; email: string | null; version: string }[]>`
        select workspace_id as "workspaceId", notification_email as email, xmin::text as version
        from app.memberships where user_id = ${SIGNER}
        order by workspace_id
      `;
    const signIn = (verifiedEmail: string) =>
      store.bootstrapStaff({ actorId: SIGNER, verifiedEmail, requestId: randomUUID() });

    const workspaces = await signIn(' Signer@Staff.Example ');
    expect(workspaces.map((workspace) => workspace.id).sort()).toEqual(
      [SIGNIN_SITE, OTHER_SIGNIN_SITE].sort(),
    );
    const first = await state();
    expect(first.map(({ workspaceId, email }) => ({ workspaceId, email }))).toEqual(
      [
        { workspaceId: SITE, email: null },
        { workspaceId: SIGNIN_SITE, email: 'signer@staff.example' },
        { workspaceId: OTHER_SIGNIN_SITE, email: 'signer@staff.example' },
      ].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1)),
    );
    await signIn('signer@staff.example');
    expect(await state()).toEqual(first);
    await signIn('new.signer@staff.example');
    const changed = await state();
    expect(changed.filter((row) => row.email === 'new.signer@staff.example')).toHaveLength(2);
    expect(changed.find((row) => row.workspaceId === SITE)?.email).toBeNull();
  });

  it('a first sign-in that accepts an invitation records the address on the new membership', async () => {
    await admin`
      insert into app.memberships (workspace_id, membership_type, status, invited_email)
      values (${OTHER_SIGNIN_SITE}, 'staff', 'pending', 'invitee@staff.example')
    `;
    const workspaces = await new DatabaseStaffStore(database).bootstrapStaff({
      actorId: INVITEE,
      verifiedEmail: 'Invitee@Staff.Example',
      requestId: randomUUID(),
    });
    expect(workspaces.map((workspace) => workspace.id)).toEqual([OTHER_SIGNIN_SITE]);
    expect(
      await admin`
        select status, notification_email as email from app.memberships
        where user_id = ${INVITEE}
      `,
    ).toEqual([{ status: 'active', email: 'invitee@staff.example' }]);
  });

  it('the address is never returned', async () => {
    const store = new DatabaseStaffStore(database);
    const answers = [
      await store.bootstrapStaff({
        actorId: OWNER,
        verifiedEmail: 'owner@staff.example',
        requestId: randomUUID(),
      }),
      await store.listAssignableMembers(SITE, OWNER),
      await store.loadStaffAccess(OWNER, SITE),
    ];
    for (const answer of answers) {
      const json = JSON.stringify(answer);
      expect(json).not.toContain('notification');
      expect(json).not.toContain('@staff.example');
    }
  });
});
