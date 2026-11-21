import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from '../src/migrations.js';
import {
  getDisposableTestDatabaseUrl,
  setTestRuntimePassword,
  TEST_RUNTIME_PASSWORD,
} from '../src/test-helpers.js';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Ids of their own, apart from every other suite sharing the database.
const SITE_1 = '17000000-0000-4000-8000-000000000b01';
const SITE_2 = '17000000-0000-4000-8000-000000000b02';
const MEMBER_A = '18000000-0000-4000-8000-000000000b01';
const MEMBER_B = '18000000-0000-4000-8000-000000000b02';
/** The scheduler's machine actor: a member of no conversation. */
const MACHINE = '18000000-0000-4000-8000-000000000b09';

const INSUFFICIENT_PRIVILEGE = '42501';
const INVALID_PARAMETER_VALUE = '22023';
const SHA = 'b'.repeat(64);

databaseTest('0036: app.sweep_unsent_ai_attachments', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;

  /** One app_runtime transaction with the context withTenantTx would set. */
  function asRuntime<T>(
    context: { workspaceId?: string; actorId?: string },
    body: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return runtimeSql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${context.workspaceId ?? ''}, true),
               set_config('app.actor_id', ${context.actorId ?? ''}, true)
      `;
      return body(tx);
    });
  }

  function sweep(
    context: { workspaceId?: string; actorId?: string },
    workspaceId: string,
    before: Date,
    limit = 100,
  ) {
    return asRuntime(
      context,
      (tx) => tx<{ bucket: string; object_key: string }[]>`
        select bucket, object_key
        from app.sweep_unsent_ai_attachments(${workspaceId}::uuid, ${before.toISOString()}::timestamptz, ${limit}::integer)
        order by object_key
      `,
    );
  }

  /** An attachment row written as the migration role, with its age chosen. */
  async function attachment(row: {
    workspaceId: string;
    actorId: string;
    key: string;
    ageHours: number;
    sentIn?: { conversationId: string; messageId: string };
  }): Promise<void> {
    await admin`
      insert into app.ai_attachments
        (workspace_id, actor_id, conversation_id, message_id, kind, media_type, file_name,
         byte_size, sha256, bucket, object_key, status, created_at)
      values (${row.workspaceId}, ${row.actorId}, ${row.sentIn?.conversationId ?? null},
        ${row.sentIn?.messageId ?? null}, 'image', 'image/png', 'letter.png', 1024, ${SHA},
        'documents', ${row.key}, 'ready', now() - ${row.ageHours}::integer * interval '1 hour')
    `;
  }

  async function cleanUp(): Promise<void> {
    await admin`delete from app.workspaces where id in (${SITE_1}, ${SITE_2})`;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await setTestRuntimePassword(admin);
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
  });

  beforeEach(async () => {
    await cleanUp();
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE_1}, 'ci-ai-sweep-1', 'CI AI Sweep 1'), (${SITE_2}, 'ci-ai-sweep-2', 'CI AI Sweep 2')
    `;
  });

  afterAll(async () => {
    await runtimeSql?.end();
    if (admin) {
      await cleanUp();
      await admin.end();
    }
  });

  it('is a definer function with an empty search_path that only app_runtime may run', async () => {
    const [definition] = await admin<
      {
        secdef: boolean;
        config: string[] | null;
        publicExecute: boolean;
        runtimeExecute: boolean;
        backupExecute: boolean;
      }[]
    >`
      select p.prosecdef as secdef, p.proconfig as config,
        has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute",
        has_function_privilege('app_runtime', p.oid, 'EXECUTE') as "runtimeExecute",
        has_function_privilege('backup_reader', p.oid, 'EXECUTE') as "backupExecute"
      from pg_proc p
      where p.pronamespace = 'app'::regnamespace and p.proname = 'sweep_unsent_ai_attachments'
    `;
    expect(definition).toEqual({
      secdef: true,
      config: ['search_path=""'],
      publicExecute: false,
      runtimeExecute: true,
      backupExecute: false,
    });
  });

  it('removes every member’s unsent files older than a day on its own site, returning their keys', async () => {
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    await admin`
      insert into app.ai_conversations (id, workspace_id, actor_id, title)
      values (${conversationId}, ${SITE_1}, ${MEMBER_A}, 'Sent files')
    `;
    await admin`
      insert into app.ai_messages (id, workspace_id, conversation_id, actor_id, role, text, outcome)
      values (${messageId}, ${SITE_1}, ${conversationId}, ${MEMBER_A}, 'user', 'See the file', 'completed')
    `;
    await attachment({ workspaceId: SITE_1, actorId: MEMBER_A, key: 'a/old', ageHours: 30 });
    await attachment({ workspaceId: SITE_1, actorId: MEMBER_B, key: 'b/old', ageHours: 48 });
    await attachment({ workspaceId: SITE_1, actorId: MEMBER_A, key: 'a/new', ageHours: 2 });
    await attachment({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      key: 'a/sent',
      ageHours: 72,
      sentIn: { conversationId, messageId },
    });
    await attachment({
      workspaceId: SITE_2,
      actorId: MEMBER_A,
      key: 'other-site/old',
      ageHours: 72,
    });

    // The machine actor sees none of these rows itself (owner policy)...
    const visible = await asRuntime(
      { workspaceId: SITE_1, actorId: MACHINE },
      (tx) => tx`select id from app.ai_attachments`,
    );
    expect(visible).toHaveLength(0);

    // ...and a cutoff in the future still spares a file younger than a day.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    expect(await sweep({ workspaceId: SITE_1, actorId: MACHINE }, SITE_1, tomorrow)).toEqual([
      { bucket: 'documents', object_key: 'a/old' },
      { bucket: 'documents', object_key: 'b/old' },
    ]);

    const left = await admin<{ key: string }[]>`
      select object_key as key from app.ai_attachments
      where workspace_id in (${SITE_1}, ${SITE_2}) order by object_key
    `;
    expect(left.map((row) => row.key)).toEqual(['a/new', 'a/sent', 'other-site/old']);
    // Nothing more to sweep on a second pass.
    expect(await sweep({ workspaceId: SITE_1, actorId: MACHINE }, SITE_1, tomorrow)).toEqual([]);
  });

  it('removes at most the batch it is given', async () => {
    for (const key of ['k/1', 'k/2', 'k/3']) {
      await attachment({ workspaceId: SITE_1, actorId: MEMBER_A, key, ageHours: 30 });
    }
    expect(
      await sweep({ workspaceId: SITE_1, actorId: MACHINE }, SITE_1, new Date(), 2),
    ).toHaveLength(2);
    expect(
      await sweep({ workspaceId: SITE_1, actorId: MACHINE }, SITE_1, new Date(), 2),
    ).toHaveLength(1);
  });

  it('refuses another site, a missing actor and an unbounded batch', async () => {
    await attachment({ workspaceId: SITE_2, actorId: MEMBER_A, key: 'other/old', ageHours: 30 });
    await expect(
      sweep({ workspaceId: SITE_1, actorId: MACHINE }, SITE_2, new Date()),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(sweep({ actorId: MACHINE }, SITE_2, new Date())).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(sweep({ workspaceId: SITE_2 }, SITE_2, new Date())).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    for (const limit of [0, 1001]) {
      await expect(
        sweep({ workspaceId: SITE_2, actorId: MACHINE }, SITE_2, new Date(), limit),
      ).rejects.toMatchObject({ code: INVALID_PARAMETER_VALUE });
    }
    const [kept] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.ai_attachments where workspace_id = ${SITE_2}
    `;
    expect(kept?.count).toBe(1);
  });

  it('skips a file a turn is linking right now', async () => {
    await attachment({ workspaceId: SITE_1, actorId: MEMBER_A, key: 'locked/old', ageHours: 30 });
    const other = postgres(
      Object.assign(new URL(migrationUrl ?? ''), {
        username: 'app_runtime',
        password: TEST_RUNTIME_PASSWORD,
      }).toString(),
      { max: 1, prepare: false, ssl: false },
    );
    try {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => {};
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const turn = other.begin(async (tx) => {
        await tx`
          select set_config('app.workspace_id', ${SITE_1}, true),
                 set_config('app.actor_id', ${MEMBER_A}, true)
        `;
        await tx`select id from app.ai_attachments where object_key = 'locked/old' for update`;
        locked();
        await held;
      });
      await lockTaken;
      expect(await sweep({ workspaceId: SITE_1, actorId: MACHINE }, SITE_1, new Date())).toEqual(
        [],
      );
      release();
      await turn;
    } finally {
      await other.end();
    }
  });
});
