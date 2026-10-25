import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseOutboxStore } from '../src/jobs/store.js';

function disposableDatabaseUrl(): string | undefined {
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  const enabled = process.env.DB_TEST_ALLOW_DESTRUCTIVE === '1';
  if (!url && !enabled && !process.env.CI) return undefined;
  if (!url || !enabled) throw new Error('Outbox DB tests require both destructive-test variables.');
  if (!decodeURIComponent(new URL(url).pathname).endsWith('_test')) {
    throw new Error('Outbox DB tests require a disposable database ending in _test.');
  }
  return url;
}

const migrationUrl = disposableDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;
const WORKSPACE_A = '10000000-0000-4000-8000-000000000781';
const WORKSPACE_B = '10000000-0000-4000-8000-000000000782';
const ACTOR = '20000000-0000-4000-8000-000000000781';
const PASSWORD = 'local_ci_runtime_password';

databaseTest('database outbox store', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseOutboxStore;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${PASSWORD}'`);
    });
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_A}, 'ci-outbox-a', 'CI Outbox A'),
        (${WORKSPACE_B}, 'ci-outbox-b', 'CI Outbox B')
      on conflict (id) do nothing
    `;
    // Alerts are append-only history and are not deduplicated, while the job
    // rows below keep their ids across reruns. Clear this file's alert rows so
    // a repeat run on a persisted disposable database still asserts exactly one
    // failure alert for the fixed jobs.
    await admin`
      delete from app.outbox_job_alerts
      where workspace_id in (${WORKSPACE_A}, ${WORKSPACE_B})
    `;
    await admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload)
      values
        (${WORKSPACE_A}, 'analytics_order_submitted', 'order:a1', ${admin.json({ orderId: crypto.randomUUID() })}),
        (${WORKSPACE_A}, 'analytics_order_submitted', 'order:a2', ${admin.json({ orderId: crypto.randomUUID() })}),
        (${WORKSPACE_B}, 'analytics_order_submitted', 'order:b1', ${admin.json({ orderId: crypto.randomUUID() })})
      on conflict (workspace_id, job_type, dedupe_key) do update set available_at = now(), status = 'pending', attempts = 0, lease_owner_id = null, lease_expires_at = null
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabaseOutboxStore(database);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  test('parallel SKIP LOCKED claims are exclusive and workspace scoped', async () => {
    const now = new Date();
    const claim = (leaseOwnerId: string) =>
      store.claim({
        workspaceId: WORKSPACE_A,
        actorId: ACTOR,
        leaseOwnerId,
        limit: 1,
        now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        maxAttempts: 8,
      });
    const [first, second] = await Promise.all([
      claim(crypto.randomUUID()),
      claim(crypto.randomUUID()),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const firstJob = first[0];
    const secondJob = second[0];
    if (!firstJob || !secondJob) throw new Error('expected two claimed jobs');
    expect(firstJob.id).not.toBe(secondJob.id);
    expect([...first, ...second].every((job) => job.workspaceId === WORKSPACE_A)).toBe(true);

    const persisted = await admin`
      select status, lease_owner_id
      from app.outbox_jobs
      where id = ${firstJob.id}
    `;
    expect(persisted[0]).toMatchObject({
      status: 'processing',
      lease_owner_id: firstJob.leaseOwnerId,
    });
  });

  test('terminal failure creates an alert and staff retry requeues it', async () => {
    const processing = await admin`
      select id, lease_owner_id
      from app.outbox_jobs
      where workspace_id = ${WORKSPACE_A} and status = 'processing'
      limit 1
    `;
    const jobId = String(processing[0]?.id);
    const leaseOwnerId = String(processing[0]?.lease_owner_id);
    expect(
      await store.recordOutcome({
        workspaceId: WORKSPACE_A,
        actorId: ACTOR,
        jobId,
        leaseOwnerId,
        outcome: { status: 'failed', errorCode: 'provider_rejected' },
        now: new Date(),
      }),
    ).toBe('recorded');
    const alerts = await admin`
      select alert_code from app.outbox_job_alerts
      where workspace_id = ${WORKSPACE_A} and job_id = ${jobId}
    `;
    expect(alerts).toHaveLength(1);
    expect(
      await store.queueHealth({ authorizedWorkspaceIds: [WORKSPACE_A], actorId: ACTOR }),
    ).toEqual({ failed: 1, uncertain: 0 });
    expect(
      await store.queueHealth({ authorizedWorkspaceIds: [WORKSPACE_B], actorId: ACTOR }),
    ).toEqual({ failed: 0, uncertain: 0 });
    expect(
      await store.retry({
        workspaceId: WORKSPACE_A,
        actorId: ACTOR,
        jobId,
        requestId: crypto.randomUUID(),
      }),
    ).toBe('retried');
    const requeued = await admin`select status, attempts from app.outbox_jobs where id = ${jobId}`;
    expect(requeued[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(
      await store.queueHealth({ authorizedWorkspaceIds: [WORKSPACE_A], actorId: ACTOR }),
    ).toEqual({ failed: 0, uncertain: 0 });
  });

  test('an expired lease is reclaimed by another owner and the original owner loses it', async () => {
    // A dedicated workspace so the claimable pool for this test is exactly the
    // single job inserted below.
    const LEASE_WORKSPACE = '10000000-0000-4000-8000-000000000783';
    const FIRST_OWNER = '20000000-0000-4000-8000-0000000007a1';
    const SECOND_OWNER = '20000000-0000-4000-8000-0000000007b2';
    const claimedAt = new Date('2026-09-16T12:00:00.000Z');

    await admin`
      insert into app.workspaces (id, slug, name)
      values (${LEASE_WORKSPACE}, 'ci-outbox-lease', 'CI Outbox Lease')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload, available_at)
      values (${LEASE_WORKSPACE}, 'analytics_order_submitted', 'order:lease-reclaim', ${admin.json({ orderId: crypto.randomUUID() })}, ${claimedAt})
      on conflict (workspace_id, job_type, dedupe_key) do update
        set status = 'pending', attempts = 0, lease_owner_id = null, lease_expires_at = null,
            available_at = excluded.available_at
    `;

    // Owner A takes the job with a lease that has already expired.
    const first = await store.claim({
      workspaceId: LEASE_WORKSPACE,
      actorId: ACTOR,
      leaseOwnerId: FIRST_OWNER,
      limit: 1,
      now: claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
      maxAttempts: 8,
    });
    expect(first).toHaveLength(1);
    const job = first[0];
    if (!job) throw new Error('expected one claimed job');
    expect(job.attempts).toBe(1);
    expect(job.leaseOwnerId).toBe(FIRST_OWNER);

    // Owner B claims after A's lease expired and reclaims the same job.
    const reclaimAt = new Date(claimedAt.getTime() + 2_000);
    const second = await store.claim({
      workspaceId: LEASE_WORKSPACE,
      actorId: ACTOR,
      leaseOwnerId: SECOND_OWNER,
      limit: 1,
      now: reclaimAt,
      leaseExpiresAt: new Date(reclaimAt.getTime() + 60_000),
      maxAttempts: 8,
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(job.id);
    expect(second[0]?.leaseOwnerId).toBe(SECOND_OWNER);
    expect(second[0]?.attempts).toBe(2);

    const persisted = await admin`
      select attempts, status, lease_owner_id
      from app.outbox_jobs
      where id = ${job.id}
    `;
    expect(persisted[0]).toMatchObject({
      attempts: 2,
      status: 'processing',
      lease_owner_id: SECOND_OWNER,
    });

    // The original owner's outcome is rejected; the new owner records it.
    expect(
      await store.recordOutcome({
        workspaceId: LEASE_WORKSPACE,
        actorId: ACTOR,
        jobId: job.id,
        leaseOwnerId: FIRST_OWNER,
        outcome: { status: 'completed', providerId: 'provider-a' },
        now: reclaimAt,
      }),
    ).toBe('lease_lost');

    expect(
      await store.recordOutcome({
        workspaceId: LEASE_WORKSPACE,
        actorId: ACTOR,
        jobId: job.id,
        leaseOwnerId: SECOND_OWNER,
        outcome: { status: 'completed', providerId: 'provider-b' },
        now: reclaimAt,
      }),
    ).toBe('recorded');

    const completed = await admin`
      select status, provider_id, lease_owner_id
      from app.outbox_jobs
      where id = ${job.id}
    `;
    expect(completed[0]).toMatchObject({
      status: 'completed',
      provider_id: 'provider-b',
      lease_owner_id: null,
    });
  });

  test('dedupe keys are unique per workspace and job type', async () => {
    await expect(admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload)
      values (${WORKSPACE_A}, 'analytics_order_submitted', 'order:a1', '{}'::jsonb)
    `).rejects.toMatchObject({ code: '23505' });
  });

  test('retry paths preserve the previous attempt’s provider evidence', async () => {
    const EVIDENCE_WORKSPACE = '10000000-0000-4000-8000-000000000784';
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${EVIDENCE_WORKSPACE}, 'ci-outbox-evidence', 'CI Outbox Evidence')
      on conflict (id) do nothing
    `;
    // A failed job can already carry the provider's evidence from a previous
    // attempt; the schema ties `provider_id`/`outcome` to no status. An operator
    // requeue must reset the attempt state without erasing that evidence.
    const inserted = await admin<{ id: string }[]>`
      insert into app.outbox_jobs (
        workspace_id, job_type, dedupe_key, payload, status, attempts,
        provider_id, outcome, last_error_code
      ) values (
        ${EVIDENCE_WORKSPACE}, 'analytics_order_submitted', 'order:evidence',
        ${admin.json({ orderId: crypto.randomUUID() })}, 'failed', 3,
        'provider-prior', ${admin.json({ messageId: 'msg-1' })}, 'provider_rejected'
      )
      on conflict (workspace_id, job_type, dedupe_key) do update set
        status = 'failed',
        attempts = 3,
        provider_id = 'provider-prior',
        outcome = ${admin.json({ messageId: 'msg-1' })},
        last_error_code = 'provider_rejected'
      returning id
    `;
    const jobId = inserted[0]?.id;
    if (!jobId) throw new Error('failed to seed the evidence job');

    expect(
      await store.retry({
        workspaceId: EVIDENCE_WORKSPACE,
        actorId: ACTOR,
        jobId,
        requestId: crypto.randomUUID(),
      }),
    ).toBe('retried');

    const requeued = await admin`
      select status, attempts, provider_id, outcome, last_error_code
      from app.outbox_jobs
      where id = ${jobId}
    `;
    expect(requeued[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      provider_id: 'provider-prior',
      outcome: { messageId: 'msg-1' },
      last_error_code: null,
    });

    // The runner-side retry branch must preserve the same evidence: claim the
    // requeued job and record a retryable outcome, then read the row back.
    const ownerId = crypto.randomUUID();
    const now = new Date();
    const claimed = await store.claim({
      workspaceId: EVIDENCE_WORKSPACE,
      actorId: ACTOR,
      leaseOwnerId: ownerId,
      limit: 1,
      now,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      maxAttempts: 8,
    });
    expect(claimed).toHaveLength(1);
    expect(
      await store.recordOutcome({
        workspaceId: EVIDENCE_WORKSPACE,
        actorId: ACTOR,
        jobId,
        leaseOwnerId: ownerId,
        outcome: {
          status: 'retry',
          errorCode: 'provider_rate_limited',
          availableAt: new Date(now.getTime() + 5_000),
        },
        now,
      }),
    ).toBe('recorded');

    const retriedAgain = await admin`
      select status, attempts, provider_id, outcome, last_error_code
      from app.outbox_jobs
      where id = ${jobId}
    `;
    expect(retriedAgain[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      provider_id: 'provider-prior',
      outcome: { messageId: 'msg-1' },
      last_error_code: 'provider_rate_limited',
    });
  });

  test('staff resolve an uncertain job as delivered or not delivered (REL-20)', async () => {
    const RESOLVE_WORKSPACE = '10000000-0000-4000-8000-000000000785';
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${RESOLVE_WORKSPACE}, 'ci-outbox-resolve', 'CI Outbox Resolve')
      on conflict (id) do nothing
    `;
    await admin`delete from app.outbox_job_alerts where workspace_id = ${RESOLVE_WORKSPACE}`;
    await admin`delete from app.outbox_jobs where workspace_id = ${RESOLVE_WORKSPACE}`;
    const seed = async (dedupeKey: string, status: string) => {
      const rows = await admin<{ id: string }[]>`
        insert into app.outbox_jobs (
          workspace_id, job_type, dedupe_key, payload, status, attempts, uncertain_at,
          provider_id, last_error_code
        ) values (
          ${RESOLVE_WORKSPACE}, 'analytics_order_submitted', ${dedupeKey},
          ${admin.json({ orderId: crypto.randomUUID() })}, ${status}, 1, now(),
          'provider-evidence', 'provider_timeout'
        )
        returning id
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('failed to seed a job');
      await admin`
        insert into app.outbox_job_alerts (workspace_id, job_id, alert_code)
        values (${RESOLVE_WORKSPACE}, ${id}, 'provider_timeout')
      `;
      return id;
    };
    const delivered = await seed('order:resolve-delivered', 'uncertain');
    const notDelivered = await seed('order:resolve-not-delivered', 'uncertain');
    const alreadyFailed = await seed('order:resolve-failed', 'failed');
    const resolve = (jobId: string, isDelivered: boolean) =>
      store.resolveUncertain({
        workspaceId: RESOLVE_WORKSPACE,
        actorId: ACTOR,
        jobId,
        requestId: crypto.randomUUID(),
        delivered: isDelivered,
      });

    expect(await resolve(delivered, true)).toBe('completed');
    expect(await resolve(notDelivered, false)).toBe('failed');
    expect(await resolve(alreadyFailed, true)).toBe('not_uncertain');
    expect(await resolve(crypto.randomUUID(), true)).toBe('not_found');
    // Resolving twice is a conflict, not a second state change.
    expect(await resolve(delivered, false)).toBe('not_uncertain');

    const rows = await admin<{ id: string; status: string; provider_id: string; done: boolean }[]>`
      select id, status, provider_id, completed_at is not null as done
      from app.outbox_jobs where workspace_id = ${RESOLVE_WORKSPACE}
    `;
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    expect(byId.get(delivered)).toMatchObject({
      status: 'completed',
      provider_id: 'provider-evidence',
      done: true,
    });
    expect(byId.get(notDelivered)).toMatchObject({ status: 'failed', done: false });
    const openAlerts = await admin<{ job_id: string }[]>`
      select job_id from app.outbox_job_alerts
      where workspace_id = ${RESOLVE_WORKSPACE} and resolved_at is null
    `;
    expect(openAlerts.map((row) => String(row.job_id))).toEqual([alreadyFailed]);
    // The not-delivered job can now take the normal staff retry.
    expect(
      await store.retry({
        workspaceId: RESOLVE_WORKSPACE,
        actorId: ACTOR,
        jobId: notDelivered,
        requestId: crypto.randomUUID(),
      }),
    ).toBe('retried');
    const listed = await store.listActive(RESOLVE_WORKSPACE, ACTOR);
    expect(listed.total).toBe(2);
    expect(listed.jobs.map((job) => job.id).sort()).toEqual([alreadyFailed, notDelivered].sort());
  });
});
