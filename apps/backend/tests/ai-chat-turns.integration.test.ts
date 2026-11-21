/*
 * Ask AI's saved chat against real Postgres: a turn's history is the turns
 * saved strictly before its own question (audit finding #96), and turns that
 * overlap at the end of a full conversation never pass its 200-message cap
 * (#97).
 *
 * Rows live on one site of this file's own id range, deleted before each test
 * and after the run, so the suite is re-runnable.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_CHAT_LIMITS } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

import { DatabaseAiConversationStore } from '../src/ai/conversation-store.js';

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

const SITE = 'ae300000-0000-4000-8000-0000000000e3';
const MEMBER = 'af300000-0000-4000-8000-0000000000f3';

databaseTest('Ask AI saved chat: history position and the message cap', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let conversations: DatabaseAiConversationStore;
  const scope = { workspaceId: SITE, actorId: MEMBER };

  async function begin(conversationId: string, text: string, create: boolean) {
    const begun = await conversations.beginTurn(scope, {
      conversationId,
      create,
      title: text.slice(0, 60),
      requestId: crypto.randomUUID(),
      text,
      attachmentIds: [],
    });
    return begun;
  }

  async function answer(conversationId: string, requestId: string, text: string) {
    await conversations.appendAnswer(scope, {
      conversationId,
      messageId: crypto.randomUUID(),
      requestId,
      text,
      outcome: 'completed',
      sources: [],
      expiredDrafts: 0,
    });
  }

  /** A whole turn, with the request id its two rows share. */
  async function storedTurn(conversationId: string, text: string, create: boolean) {
    const requestId = crypto.randomUUID();
    const begun = await conversations.beginTurn(scope, {
      conversationId,
      create,
      title: text.slice(0, 60),
      requestId,
      text,
      attachmentIds: [],
    });
    if (begun.status !== 'started') throw new Error(begun.status);
    await answer(conversationId, requestId, `Answer to ${text}`);
    return begun.userMessageId;
  }

  async function messageCount(conversationId: string): Promise<number> {
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.ai_messages where conversation_id = ${conversationId}
    `;
    return row?.count ?? 0;
  }

  async function cleanUp(): Promise<void> {
    await admin`delete from app.workspaces where id = ${SITE}`;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    conversations = new DatabaseAiConversationStore(database);
  });

  beforeEach(async () => {
    await cleanUp();
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'ci-ai-saved-chat-position', 'CI AI Saved Chat Position')`;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values (${SITE}, ${MEMBER}, 'staff', 'active')
    `;
  });

  afterAll(async () => {
    await cleanUp();
    await database?.close();
    await admin?.end();
  });

  it('replays only the turns saved before the question it is anchored on', async () => {
    const conversationId = crypto.randomUUID();
    await storedTurn(conversationId, 'First question', true);
    const second = await storedTurn(conversationId, 'Second question', false);
    // Another tab's turn, saved after the second question was.
    await storedTurn(conversationId, 'Third question', false);

    const history = await conversations.history(scope, {
      conversationId,
      beforeMessageId: second,
      reservedChars: 0,
    });
    expect(history.map((message) => message.text)).toEqual([
      'First question',
      'Answer to First question',
    ]);
    // An anchor that is not in this conversation replays nothing.
    expect(
      await conversations.history(scope, {
        conversationId,
        beforeMessageId: crypto.randomUUID(),
        reservedChars: 0,
      }),
    ).toEqual([]);
  });

  it('never lets turns that overlap near the cap pass it', async () => {
    const conversationId = crypto.randomUUID();
    await storedTurn(conversationId, 'Opening question', true);
    const limit = AI_CHAT_LIMITS.maxConversationMessages;
    // Fill to four rows short of the cap with whole stored turns.
    const turns = (limit - 4 - 2) / 2;
    await admin`
      insert into app.ai_messages
        (workspace_id, conversation_id, actor_id, role, text, outcome, request_id)
      select ${SITE}, ${conversationId}, ${MEMBER}, r.role, 'filler', 'completed', g.request_id
      from (select gen_random_uuid() as request_id from generate_series(1, ${turns}::int)) g
      cross join (values ('user'), ('assistant')) r(role)
    `;
    expect(await messageCount(conversationId)).toBe(limit - 4);

    // Two turns are accepted and still waiting for their answers: 198 rows
    // stored or reserved. A third would make 202.
    const firstRequest = crypto.randomUUID();
    const secondRequest = crypto.randomUUID();
    const first = await conversations.beginTurn(scope, {
      conversationId,
      create: false,
      title: 'x',
      requestId: firstRequest,
      text: 'First overlapping question',
      attachmentIds: [],
    });
    const second = await conversations.beginTurn(scope, {
      conversationId,
      create: false,
      title: 'x',
      requestId: secondRequest,
      text: 'Second overlapping question',
      attachmentIds: [],
    });
    const third = await begin(conversationId, 'Third overlapping question', false);
    expect([first.status, second.status, third.status]).toEqual(['started', 'started', 'full']);

    await answer(conversationId, firstRequest, 'First answer');
    await answer(conversationId, secondRequest, 'Second answer');
    expect(await messageCount(conversationId)).toBe(limit);
    const stored = await conversations.get(scope, conversationId);
    expect(stored?.messages).toHaveLength(limit);
    expect(stored?.messages.at(-1)?.text).toMatch(/answer$/);

    // A full conversation takes no further question.
    expect((await begin(conversationId, 'One more', false)).status).toBe('full');
  });
});
