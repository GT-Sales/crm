/*
 * Audit B2 and C13 end to end against real Postgres: a customer's data
 * restriction reaches Ask AI's saved chats (every member's, this site only),
 * the emptied turns are never replayed (also before the erasure has run),
 * their files go objects first, and the chats of someone who left the site
 * are deleted after `AI_DEPARTED_MEMBER_CHAT_DAYS`, objects first, but kept
 * when they are added back.
 *
 * Every row lives on two sites of this file's own id range, deleted before
 * each test and after the run, so the suite is re-runnable.
 */
import { randomBytes } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryR2DocumentStore } from '@gt-sales/adapters';
import type { AiSource } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

import {
  AI_DEPARTED_MEMBER_CHAT_DAYS,
  DatabaseAiAttachmentStore,
} from '../src/ai/attachment-store.js';
import { AiAttachmentService } from '../src/ai/attachments.js';
import {
  DatabaseAiChatSchemaProbe,
  fixedAiChatSchema,
  type AiChatSchemaProbe,
} from '../src/ai/chat-schema.js';
import { DatabaseAiConversationStore } from '../src/ai/conversation-store.js';
import {
  ABANDONED_LEAD_RETENTION_DAYS,
  DatabaseAbandonedLeadPruner,
} from '../src/retention/abandoned-leads.js';
import { aiChatCleanup, runDocumentCleanup } from '../src/scheduler.js';

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

const SITE = 'ae100000-0000-4000-8000-0000000000e1';
const SITE_2 = 'ae200000-0000-4000-8000-0000000000e2';
const MEMBER_A = 'af100000-0000-4000-8000-0000000000f1';
const MEMBER_B = 'af200000-0000-4000-8000-0000000000f2';
const MACHINE = 'af900000-0000-4000-8000-0000000000f9';
const ABANDONED = 'b0100000-0000-4000-8000-0000000000a1';
const LIVE = 'b0200000-0000-4000-8000-0000000000a2';
const OTHER_SITE = 'b0300000-0000-4000-8000-0000000000a3';
const DAY = 86_400_000;

function card(leadId: string, slug = 'ci-ai-erasure'): AiSource {
  return {
    id: `lead-${leadId}`,
    kind: 'lead',
    label: 'Jane Doe',
    href: `/w/${slug}/leads/${leadId}`,
    scope: 'Lead summary',
    asOf: new Date().toISOString(),
  };
}

/** An object store that records, for every delete, whether its row still existed. */
class RecordingObjects extends InMemoryR2DocumentStore {
  readonly deletedWhileRowExisted: boolean[] = [];
  constructor(private readonly rowExists: (objectKey: string) => Promise<boolean>) {
    super();
  }
  override async deleteObject(input: {
    workspaceId: string;
    bucket: string;
    objectKey: string;
  }): Promise<void> {
    if (!input.objectKey.endsWith('/upload')) {
      this.deletedWhileRowExisted.push(await this.rowExists(input.objectKey));
    }
    await super.deleteObject(input);
  }
}

databaseTest('Ask AI chats and a customer’s erasure, and members who left', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let conversations: DatabaseAiConversationStore;
  let objects: RecordingObjects;
  let service: AiAttachmentService;

  const scopeOf = (actorId: string, workspaceId = SITE) => ({ workspaceId, actorId });

  /** One whole stored turn, as a member's chat writes it. */
  async function storedTurn(input: {
    actorId: string;
    workspaceId?: string;
    conversationId?: string;
    question: string;
    answer: string;
    sources?: AiSource[];
  }): Promise<{ conversationId: string; questionId: string; answerId: string }> {
    const scope = scopeOf(input.actorId, input.workspaceId);
    const conversationId = input.conversationId ?? crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const begun = await conversations.beginTurn(scope, {
      conversationId,
      create: input.conversationId === undefined,
      title: input.question.slice(0, 60),
      requestId,
      text: input.question,
      attachmentIds: [],
    });
    if (begun.status !== 'started') throw new Error(begun.status);
    const answerId = crypto.randomUUID();
    await conversations.appendAnswer(scope, {
      conversationId,
      messageId: answerId,
      requestId,
      text: input.answer,
      outcome: 'completed',
      sources: input.sources ?? [],
      expiredDrafts: 0,
    });
    return { conversationId, questionId: begun.userMessageId, answerId };
  }

  /** A sent file on a stored question, with its two objects in storage. */
  async function sentFile(input: {
    actorId: string;
    conversationId: string;
    messageId: string;
  }): Promise<{ id: string; objectKey: string }> {
    const id = crypto.randomUUID();
    const folder = `ai-attachments/${crypto.randomUUID()}-${randomBytes(8).toString('hex')}`;
    const objectKey = `${folder}/f-${randomBytes(8).toString('hex')}`;
    objects.putObject(objectKey, new Uint8Array([1, 2, 3]));
    objects.putObject(`${folder}/upload`, new Uint8Array([1, 2, 3]));
    await admin`
      insert into app.ai_attachments
        (id, workspace_id, actor_id, conversation_id, message_id, kind, media_type, file_name,
         byte_size, sha256, bucket, object_key, status)
      values (${id}, ${SITE}, ${input.actorId}, ${input.conversationId}, ${input.messageId},
        'image', 'image/png', 'passport.png', 3, ${'d'.repeat(64)}, 'documents', ${objectKey}, 'ready')
    `;
    return { id, objectKey };
  }

  function cleanup(schema: AiChatSchemaProbe = new DatabaseAiChatSchemaProbe(database)) {
    return runDocumentCleanup(
      { sweepExpired: async () => ({ expiredIntents: 0, deletedObjects: 0, failedDeletes: 0 }) },
      { actorId: MACHINE, authorizedWorkspaceIds: [SITE, SITE_2] },
      undefined,
      aiChatCleanup(service, schema),
    );
  }

  async function restrictAbandoned(): Promise<void> {
    const result = await new DatabaseAbandonedLeadPruner(database).restrictAbandoned({
      workspaceId: SITE,
      actorId: MACHINE,
      now: new Date(),
    });
    expect(result.restrictedLeads).toBe(1);
  }

  async function cleanUp(): Promise<void> {
    await admin`delete from app.workspaces where id in (${SITE}, ${SITE_2})`;
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
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'ci-ai-erasure', 'CI AI Erasure'), (${SITE_2}, 'ci-ai-erasure-2', 'CI AI Erasure 2')
    `;
    const old = new Date(Date.now() - (ABANDONED_LEAD_RETENTION_DAYS + 1) * DAY);
    await admin`
      insert into app.leads
        (id, workspace_id, lead_type, status, consent_version, full_name, external_ref, updated_at)
      values
        (${ABANDONED}, ${SITE}, 'sim_order', 'incomplete', 'ci', 'Jane Doe', 'MS-7001', ${old}),
        (${LIVE}, ${SITE}, 'sim_order', 'submitted', 'ci', 'John Roe', 'MS-7002', now()),
        (${OTHER_SITE}, ${SITE_2}, 'sim_order', 'submitted', 'ci', 'Jane Doe', 'MS-7001', now())
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values (${SITE}, ${MEMBER_A}, 'staff', 'active'), (${SITE}, ${MEMBER_B}, 'staff', 'active'),
        (${SITE_2}, ${MEMBER_A}, 'staff', 'active')
    `;
    const attachments = new DatabaseAiAttachmentStore(database);
    objects = new RecordingObjects(async (objectKey) => {
      const [row] = await admin<{ count: number }[]>`
        select count(*)::int as count from app.ai_attachments where object_key = ${objectKey}
      `;
      return (row?.count ?? 0) > 0;
    });
    service = new AiAttachmentService(attachments, objects, { bucket: 'documents', kinds: [] });
  });

  afterAll(async () => {
    await cleanUp();
    await database?.close();
    await admin?.end();
  });

  it('never replays a turn about a restricted or missing lead, before any erasure has run', async () => {
    const about = await storedTurn({
      actorId: MEMBER_A,
      question: 'How is the newest order?',
      answer: 'Jane Doe ordered a SIM.',
      sources: [card(ABANDONED)],
    });
    await storedTurn({
      actorId: MEMBER_A,
      conversationId: about.conversationId,
      question: 'And the other?',
      answer: 'John Roe is submitted.',
      sources: [card(LIVE)],
    });
    await storedTurn({
      actorId: MEMBER_A,
      conversationId: about.conversationId,
      question: 'And this one?',
      answer: 'Deleted since.',
      sources: [card(crypto.randomUUID())],
    });
    const next = await storedTurn({
      actorId: MEMBER_A,
      conversationId: about.conversationId,
      question: 'Thanks',
      answer: 'You are welcome.',
    });
    const replayed = () =>
      conversations.history(scopeOf(MEMBER_A), {
        conversationId: about.conversationId,
        beforeMessageId: next.questionId,
        reservedChars: 0,
      });
    expect((await replayed()).map((message) => message.text)).toEqual([
      'How is the newest order?',
      'Jane Doe ordered a SIM.',
      'And the other?',
      'John Roe is submitted.',
    ]);

    // Restricted by someone else's hand (as before 0039 is applied): the
    // stored text is still there, but it is never sent to the model again.
    await admin`update app.leads set customer_data_restricted_at = now() where id = ${ABANDONED}`;
    expect((await replayed()).map((message) => message.text)).toEqual([
      'And the other?',
      'John Roe is submitted.',
    ]);
    const stored = await conversations.get(scopeOf(MEMBER_A), about.conversationId);
    expect(stored?.messages[1]).toMatchObject({ text: 'Jane Doe ordered a SIM.' });
    expect(stored?.messages[1]?.erased).toBeUndefined();
  });

  it('empties every member’s turns about the restricted lead in the restriction itself, and deletes their files objects first', async () => {
    const mine = await storedTurn({
      actorId: MEMBER_A,
      question: 'How is the newest order?',
      answer: 'Jane Doe ordered a SIM.',
      sources: [card(ABANDONED)],
    });
    const file = await sentFile({
      actorId: MEMBER_A,
      conversationId: mine.conversationId,
      messageId: mine.questionId,
    });
    const unrelated = await storedTurn({
      actorId: MEMBER_A,
      conversationId: mine.conversationId,
      question: 'And the other?',
      answer: 'John Roe is submitted.',
      sources: [card(LIVE)],
    });
    const keptFile = await sentFile({
      actorId: MEMBER_A,
      conversationId: mine.conversationId,
      messageId: unrelated.questionId,
    });
    const byNumber = await storedTurn({
      actorId: MEMBER_A,
      question: 'Any news on MS-7001?',
      answer: 'Waiting for the passport.',
    });
    const colleague = await storedTurn({
      actorId: MEMBER_B,
      question: 'Summary please',
      answer: 'Here it is.',
      sources: [card(ABANDONED)],
    });
    const otherSite = await storedTurn({
      actorId: MEMBER_A,
      workspaceId: SITE_2,
      question: 'Any news on MS-7001?',
      answer: 'Shipped.',
      sources: [card(OTHER_SITE, 'ci-ai-erasure-2')],
    });

    await restrictAbandoned();

    const read = async (actorId: string, conversationId: string, workspaceId = SITE) =>
      (await conversations.get(scopeOf(actorId, workspaceId), conversationId))?.messages ?? [];
    const emptied = { text: '', sources: [], erased: true };
    const first = await read(MEMBER_A, mine.conversationId);
    expect(first[0]).toMatchObject(emptied);
    expect(first[1]).toMatchObject(emptied);
    expect(first[1]?.followUp).toBeUndefined();
    expect(first[2]).toMatchObject({ text: 'And the other?' });
    expect(first[2]?.erased).toBeUndefined();
    expect(first[3]).toMatchObject({ text: 'John Roe is submitted.' });
    for (const message of await read(MEMBER_A, byNumber.conversationId)) {
      expect(message).toMatchObject(emptied);
    }
    for (const message of await read(MEMBER_B, colleague.conversationId)) {
      expect(message).toMatchObject(emptied);
    }
    for (const message of await read(MEMBER_A, otherSite.conversationId, SITE_2)) {
      expect(message.erased).toBeUndefined();
      expect(message.text.length).toBeGreaterThan(0);
    }
    const [title] = await admin<{ title: string }[]>`
      select title from app.ai_conversations where id = ${byNumber.conversationId}
    `;
    expect(title?.title).toBe('Chat with a removed message');

    // Never replayed: the emptied turn is gone from the history.
    const later = await storedTurn({
      actorId: MEMBER_A,
      conversationId: mine.conversationId,
      question: 'Thanks',
      answer: 'You are welcome.',
    });
    const history = await conversations.history(scopeOf(MEMBER_A), {
      conversationId: mine.conversationId,
      beforeMessageId: later.questionId,
      reservedChars: 0,
    });
    expect(history.map((message) => message.text)).toEqual([
      'And the other?',
      'John Roe is submitted.',
    ]);
    // Its file can no longer be opened, even before the cleanup.
    expect(await service.link(scopeOf(MEMBER_A), file.id)).toEqual({ status: 'not_found' });

    const result = await cleanup();
    expect(result).toMatchObject({
      aiChats: { erasedFiles: 1, departedConversations: 0, failedDeletes: 0, failedSites: 0 },
    });
    expect(objects.has(file.objectKey)).toBe(false);
    expect(objects.has(keptFile.objectKey)).toBe(true);
    expect(objects.deletedWhileRowExisted).toEqual([true]);
    const rows = await admin<{ id: string }[]>`
      select id from app.ai_attachments where id in (${file.id}, ${keptFile.id})
    `;
    expect(rows.map((row) => row.id)).toEqual([keptFile.id]);
  });

  it('keeps an erased file’s row when its object cannot be deleted, and finishes it on the next run', async () => {
    const mine = await storedTurn({
      actorId: MEMBER_A,
      question: 'About her',
      answer: 'Jane Doe.',
      sources: [card(ABANDONED)],
    });
    const file = await sentFile({
      actorId: MEMBER_A,
      conversationId: mine.conversationId,
      messageId: mine.questionId,
    });
    await restrictAbandoned();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteObject = vi
      .spyOn(objects, 'deleteObject')
      .mockRejectedValue(new Error('storage down'));
    expect(await cleanup()).toMatchObject({ aiChats: { erasedFiles: 0, failedDeletes: 1 } });
    deleteObject.mockRestore();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('ai_attachment_object_delete_failed');
    warn.mockRestore();
    const [still] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.ai_attachments where id = ${file.id}
    `;
    expect(still?.count).toBe(1);
    expect(await cleanup()).toMatchObject({ aiChats: { erasedFiles: 1, failedDeletes: 0 } });
    expect(objects.has(file.objectKey)).toBe(false);
  });

  it('deletes the chats of someone who left the site after the period, files first, and keeps them before it or once added back', async () => {
    const leftLongAgo = await storedTurn({ actorId: MEMBER_A, question: 'Q', answer: 'A' });
    const file = await sentFile({
      actorId: MEMBER_A,
      conversationId: leftLongAgo.conversationId,
      messageId: leftLongAgo.questionId,
    });
    const leftRecently = await storedTurn({ actorId: MEMBER_B, question: 'Q', answer: 'A' });
    // Member A still works on the other site: that site's chats stay.
    const elsewhere = await storedTurn({
      actorId: MEMBER_A,
      workspaceId: SITE_2,
      question: 'Q',
      answer: 'A',
    });
    const longAgo = new Date(Date.now() - (AI_DEPARTED_MEMBER_CHAT_DAYS + 5) * DAY);
    const recently = new Date(Date.now() - (AI_DEPARTED_MEMBER_CHAT_DAYS - 5) * DAY);
    await admin`update app.ai_conversations set last_message_at = ${longAgo} where workspace_id in (${SITE}, ${SITE_2})`;
    await admin`
      update app.memberships set status = 'revoked', revoked_at = ${longAgo}
      where workspace_id = ${SITE} and user_id = ${MEMBER_A}
    `;
    await admin`
      update app.memberships set status = 'revoked', revoked_at = ${recently}
      where workspace_id = ${SITE} and user_id = ${MEMBER_B}
    `;

    expect(await cleanup()).toMatchObject({
      aiChats: { departedConversations: 1, failedDeletes: 0, failedSites: 0 },
    });
    const left = await admin<{ id: string }[]>`
      select id from app.ai_conversations
      where id in (${leftLongAgo.conversationId}, ${leftRecently.conversationId}, ${elsewhere.conversationId})
    `;
    expect(left.map((row) => row.id).sort()).toEqual(
      [leftRecently.conversationId, elsewhere.conversationId].sort(),
    );
    expect(objects.has(file.objectKey)).toBe(false);
    expect(objects.deletedWhileRowExisted).toEqual([true]);

    // Member B is added back before the period ends: their chat stays, for good.
    await admin`
      update app.memberships set status = 'active', revoked_at = null
      where workspace_id = ${SITE} and user_id = ${MEMBER_B}
    `;
    await admin`
      update app.ai_conversations set last_message_at = now() - interval '400 days'
      where id = ${leftRecently.conversationId}
    `;
    expect(await cleanup()).toMatchObject({ aiChats: { departedConversations: 0 } });
    expect(await conversations.get(scopeOf(MEMBER_B), leftRecently.conversationId)).toBeDefined();
  });

  it('keeps a departed member’s chat whose file cannot be deleted', async () => {
    const turn = await storedTurn({ actorId: MEMBER_A, question: 'Q', answer: 'A' });
    const file = await sentFile({
      actorId: MEMBER_A,
      conversationId: turn.conversationId,
      messageId: turn.questionId,
    });
    const longAgo = new Date(Date.now() - (AI_DEPARTED_MEMBER_CHAT_DAYS + 5) * DAY);
    await admin`update app.ai_conversations set last_message_at = ${longAgo} where id = ${turn.conversationId}`;
    await admin`
      update app.memberships set status = 'revoked', revoked_at = ${longAgo}
      where workspace_id = ${SITE} and user_id = ${MEMBER_A}
    `;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(objects, 'deleteObject').mockRejectedValue(new Error('storage down'));
    expect(await cleanup()).toMatchObject({
      aiChats: { departedConversations: 0, failedDeletes: 1 },
    });
    warn.mockRestore();
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.ai_attachments where id = ${file.id}
    `;
    expect(row?.count).toBe(1);
  });

  it('is skipped, deleting nothing, while 0039 is not applied', async () => {
    const turn = await storedTurn({ actorId: MEMBER_A, question: 'Q', answer: 'A' });
    const longAgo = new Date(Date.now() - (AI_DEPARTED_MEMBER_CHAT_DAYS + 5) * DAY);
    await admin`update app.ai_conversations set last_message_at = ${longAgo} where id = ${turn.conversationId}`;
    await admin`
      update app.memberships set status = 'revoked', revoked_at = ${longAgo}
      where workspace_id = ${SITE} and user_id = ${MEMBER_A}
    `;
    expect(await cleanup(fixedAiChatSchema({ chatErasure: false }))).toMatchObject({
      aiChats: { skippedSites: 2, departedConversations: 0, erasedFiles: 0 },
    });
    expect(await conversations.get(scopeOf(MEMBER_A), turn.conversationId)).toBeDefined();
  });
});
