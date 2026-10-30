import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmailAdapter } from '@gt-sales/adapters';
import { TRACKING_CODE_JOB_TYPE, trackingCodeJobPayloadSchema } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { OutboxRunner, type EmailDeliveryRecorder } from '@gt-sales/jobs';

import { openTrackingCode } from '../src/crypto/cipher.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseEmailSettingsStore } from '../src/email/settings-store.js';
import { DatabaseEmailStore } from '../src/email/store.js';
import { DatabaseOutboxStore } from '../src/jobs/store.js';
import { createTrackingCodeHandler } from '../src/tracking/delivery.js';
import { TrackingService } from '../src/tracking/service.js';
import { DatabaseTrackingStore } from '../src/tracking/store.js';

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

const SITE = '00000000-0000-4000-8000-000000006601';
const BARE_SITE = '00000000-0000-4000-8000-000000006602'; // no saved email settings
const CREDENTIAL = '00000000-0000-4000-8000-000000006611';
const OUTBOX_ACTOR = '00000000-0000-4000-8000-000000006612';
const STAFF = '00000000-0000-4000-8000-000000006613';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SECRET = 'tracking-code-mail-test-secret-0123456789ab';
const CONTACT_SECRET = 'tracking-code-mail-contact-secret-01';
const NADIA = 'nadia.mail@example.com';

const ENV: NodeJS.ProcessEnv = {
  EMAIL_PROVIDER: 'fake',
  NODE_ENV: 'test',
  EMAIL_CONTACT_HASH_SECRET: CONTACT_SECRET,
};

databaseTest('the tracking code mail (sealed until sent, scrubbed after)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let email: FakeEmailAdapter;
  let clock: Date;
  const environment = customerEmailEnvironmentFromEnv(ENV);

  const service = (secret: string | undefined = SECRET) =>
    new TrackingService({
      store: new DatabaseTrackingStore(database),
      secret,
      contactHash: (address) => environment.contactHash(address),
      now: () => clock,
    });

  const recorder = (): EmailDeliveryRecorder => {
    const store = new DatabaseEmailStore(database);
    return {
      prepare: (input) =>
        store.prepareDelivery({ ...input, provider: 'fake', providerAccount: 'fake' }),
      recordResult: (input) => store.recordDeliveryResult(input),
    };
  };

  const run = async (
    workspaceId = SITE,
    options: { secret?: string | undefined; now?: Date } = {},
  ) => {
    const handler = createTrackingCodeHandler({
      email,
      eligibility: new DatabaseEmailStore(database),
      delivery: recorder(),
      environment,
      secret: 'secret' in options ? options.secret : SECRET,
      database,
      now: () => options.now ?? new Date(),
    });
    const runner = new OutboxRunner({
      store: new DatabaseOutboxStore(database),
      handlers: new Map([[TRACKING_CODE_JOB_TYPE, handler]]),
      now: () => options.now ?? new Date(),
    });
    return runner.run({ authorizedWorkspaceIds: [workspaceId], actorId: OUTBOX_ACTOR });
  };

  const jobs = (workspaceId = SITE) =>
    admin<{ id: string; status: string; providerId: string | null; payload: unknown }[]>`
      select id, status, provider_id as "providerId", payload from app.outbox_jobs
      where workspace_id = ${workspaceId} and job_type = ${TRACKING_CODE_JOB_TYPE}
      order by created_at, id
    `;

  const lastJobCode = async (workspaceId = SITE) => {
    const payload = trackingCodeJobPayloadSchema.parse((await jobs(workspaceId)).at(-1)?.payload);
    const code = openTrackingCode(
      SECRET,
      { workspaceId, challengeId: payload.challengeId },
      payload.sealedCode,
    );
    if (!code) throw new Error('the sealed code does not open');
    return { code, challengeId: payload.challengeId };
  };

  const request = (workspaceId = SITE, secret: string | undefined = SECRET) =>
    service(secret).requestCode({
      workspaceId,
      actorId: CREDENTIAL,
      email: ` ${NADIA.toUpperCase()} `,
    });

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its leads, challenges, jobs, templates and settings.
    await admin`delete from app.email_messages where workspace_id in (${SITE}, ${BARE_SITE})`;
    await admin`delete from app.workspaces where id in (${SITE}, ${BARE_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'tracking-mail-661', 'Tracking Mail Site'),
             (${BARE_SITE}, 'tracking-mail-662', 'Tracking Mail Bare Site')
    `;
    for (const site of [SITE, BARE_SITE]) {
      await admin`
        insert into app.leads (workspace_id, lead_type, status, stage, full_name, email,
          external_ref, payload, consent_version)
        values (${site}, 'sim_order', 'submitted', 'pending', 'Nadia Khan', ${NADIA},
          'MS-6601', ${admin.json({ schemaVersion: 1, payload: {} })}, 'ci')
      `;
    }
    await admin`
      insert into app.workspace_email_settings (workspace_id, from_name, from_address, site_url, updated_by)
      values (${SITE}, 'Mail Sim', 'orders@mail-sim.example', 'https://mail-sim.example', ${STAFF})
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });

    // The site's tracking_code template saved twice: version 2 is current.
    const settings = new DatabaseEmailSettingsStore(database);
    const write = { workspaceId: SITE, actorId: STAFF, requestId: crypto.randomUUID() };
    for (const [expectedVersion, subject] of [
      [0, 'Your first {site name} code'],
      [1, 'Your {site name} code'],
    ] as const) {
      const saved = await settings.putTemplate(write, 'tracking_code', {
        expectedVersion,
        subject,
        body: 'Your code is **{code}**. It expires 10 minutes after your request.',
      });
      expect(saved.kind).toBe('saved');
    }
  });

  beforeEach(async () => {
    email = new FakeEmailAdapter();
    clock = new Date();
    await admin`delete from app.tracking_challenges where workspace_id in (${SITE}, ${BARE_SITE})`;
    await admin`
      delete from app.outbox_jobs
      where workspace_id in (${SITE}, ${BARE_SITE}) and job_type = ${TRACKING_CODE_JOB_TYPE}
    `;
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('sends the code from the site’s template and sender, then keeps only the challenge id', async () => {
    await request();
    const { code, challengeId } = await lastJobCode();
    expect(await run()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    expect(email.deliveries).toHaveLength(1);
    const [message] = email.deliveries;
    expect(message).toMatchObject({
      workspaceId: SITE,
      template: 'tracking_code',
      toAddress: NADIA,
      sender: { fromName: 'Mail Sim', fromAddress: 'orders@mail-sim.example' },
      rendered: { subject: 'Your Mail Sim code' },
    });
    expect(message?.leadId).toBeUndefined();
    expect(message?.rendered?.text).toContain(code);
    expect(message?.rendered?.text).toContain('expires 10 minutes');

    const [job] = await jobs();
    expect(job).toMatchObject({ status: 'completed', payload: { challengeId } });
    expect(job?.payload).toEqual({ challengeId });
    const messages = await admin<{ template: string; templateVersion: number | null }[]>`
      select m.template, m.template_version as "templateVersion" from app.email_messages m
      join app.outbox_jobs j on j.workspace_id = m.workspace_id and j.message_id = m.message_id
      where j.id = ${job?.id ?? ''}
    `;
    expect(messages).toEqual([{ template: 'tracking_code', templateVersion: 2 }]);
  });

  it('sends nothing on a retried job, whose payload is already scrubbed', async () => {
    await request();
    await run();
    const [job] = await jobs();
    await admin`
      update app.outbox_jobs set status = 'pending', attempts = 0, completed_at = null,
        available_at = now() - interval '1 second'
      where id = ${job?.id ?? ''}
    `;
    email = new FakeEmailAdapter();
    expect(await run()).toMatchObject({ claimed: 1, completed: 1 });
    expect(email.deliveries).toEqual([]);
    expect((await jobs())[0]?.providerId).toBe('skipped:tracking_challenge_inactive');
  });

  it('sends nothing once the code was verified first', async () => {
    await request();
    const { code } = await lastJobCode();
    expect(
      (await service().verifyCode({ workspaceId: SITE, actorId: CREDENTIAL, email: NADIA, code }))
        .status,
    ).toBe('verified');
    await run();
    expect(email.deliveries).toEqual([]);
    expect((await jobs())[0]).toMatchObject({
      status: 'completed',
      providerId: 'skipped:tracking_challenge_inactive',
    });
  });

  it('never sends a superseded code, only the newest', async () => {
    await request();
    const first = await lastJobCode();
    await request();
    const second = await lastJobCode();
    await run();
    expect(email.deliveries).toHaveLength(1);
    expect(email.deliveries[0]?.rendered?.text).toContain(second.code);
    const all = await jobs();
    expect(all[0]).toMatchObject({
      providerId: 'skipped:superseded',
      payload: { challengeId: first.challengeId },
    });
  });

  it('skips an expired code without sending', async () => {
    await request();
    expect(await run(SITE, { now: new Date(clock.getTime() + 11 * 60_000) })).toMatchObject({
      completed: 1,
    });
    expect(email.deliveries).toEqual([]);
    expect((await jobs())[0]?.providerId).toBe('skipped:tracking_challenge_inactive');
  });

  it('skips a site without saved settings as no_sender, scrubbed', async () => {
    await request(BARE_SITE);
    const { challengeId } = await lastJobCode(BARE_SITE);
    await run(BARE_SITE);
    expect(email.deliveries).toEqual([]);
    expect((await jobs(BARE_SITE))[0]).toMatchObject({
      status: 'completed',
      providerId: 'skipped:no_sender',
    });
    expect((await jobs(BARE_SITE))[0]?.payload).toEqual({ challengeId });
  });

  it('fails permanently without the tracking secret, and keeps no address or sealed code', async () => {
    await request();
    const { challengeId } = await lastJobCode();
    expect(await run(SITE, { secret: undefined })).toMatchObject({ failed: 1 });
    const [job] = await admin<{ status: string; lastErrorCode: string | null; payload: unknown }[]>`
      select status, last_error_code as "lastErrorCode", payload from app.outbox_jobs
      where workspace_id = ${SITE} and job_type = ${TRACKING_CODE_JOB_TYPE}
    `;
    expect(job).toEqual({
      status: 'failed',
      lastErrorCode: 'tracking_not_configured',
      payload: { challengeId },
    });
    expect(email.deliveries).toEqual([]);
  });
});
