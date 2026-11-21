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
const SITE_1 = '17000000-0000-4000-8000-000000000c01';
const SITE_2 = '17000000-0000-4000-8000-000000000c02';
const MEMBER_A = '18000000-0000-4000-8000-000000000c01';
const MEMBER_B = '18000000-0000-4000-8000-000000000c02';
const MACHINE = '18000000-0000-4000-8000-000000000c09';
const RESTRICTED = '19000000-0000-4000-8000-000000000c01';
const LIVE = '19000000-0000-4000-8000-000000000c02';
const OTHER_SITE_LEAD = '19000000-0000-4000-8000-000000000c03';

const INSUFFICIENT_PRIVILEGE = '42501';
const INVALID_PARAMETER_VALUE = '22023';
const SHA = 'c'.repeat(64);

const FUNCTIONS = [
  'erase_restricted_lead_ai_turns',
  'erased_ai_attachments',
  'delete_erased_ai_attachments',
  'departed_ai_conversations',
  'delete_departed_ai_conversations',
];

function card(leadId: string, site = 'ci-ai-erasure-1') {
  return {
    id: `lead-${leadId}`,
    kind: 'lead',
    label: 'A customer',
    href: `/w/${site}/leads/${leadId}`,
    scope: 'Lead summary',
    asOf: '2026-11-01T00:00:00.000Z',
  };
}

databaseTest('0039: Ask AI chat erasure and departed members', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;

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

  async function conversation(input: {
    workspaceId: string;
    actorId: string;
    title?: string;
    ageDays?: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await admin`
      insert into app.ai_conversations (id, workspace_id, actor_id, title, last_message_at)
      values (${id}, ${input.workspaceId}, ${input.actorId}, ${input.title ?? 'A chat'},
        now() - ${input.ageDays ?? 0}::integer * interval '1 day')
    `;
    return id;
  }

  /** One whole turn: the question and its answer under one request id. */
  async function turn(input: {
    workspaceId: string;
    actorId: string;
    conversationId: string;
    question: string;
    answer: string;
    sources?: postgres.JSONValue[];
    followUp?: postgres.JSONValue;
  }): Promise<{ questionId: string; answerId: string }> {
    const requestId = crypto.randomUUID();
    const questionId = crypto.randomUUID();
    const answerId = crypto.randomUUID();
    await admin`
      insert into app.ai_messages
        (id, workspace_id, conversation_id, actor_id, role, text, outcome, request_id)
      values (${questionId}, ${input.workspaceId}, ${input.conversationId}, ${input.actorId},
        'user', ${input.question}, 'completed', ${requestId})
    `;
    await admin`
      insert into app.ai_messages
        (id, workspace_id, conversation_id, actor_id, role, text, outcome, request_id, sources, follow_up)
      values (${answerId}, ${input.workspaceId}, ${input.conversationId}, ${input.actorId},
        'assistant', ${input.answer}, 'completed', ${requestId},
        ${admin.json(input.sources ?? [])},
        ${input.followUp === undefined ? null : admin.json(input.followUp)})
    `;
    return { questionId, answerId };
  }

  async function attachment(input: {
    workspaceId: string;
    actorId: string;
    conversationId: string;
    messageId: string;
    key: string;
    text?: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await admin`
      insert into app.ai_attachments
        (id, workspace_id, actor_id, conversation_id, message_id, kind, media_type, file_name,
         byte_size, sha256, bucket, object_key, status, extracted_text)
      values (${id}, ${input.workspaceId}, ${input.actorId}, ${input.conversationId},
        ${input.messageId}, ${input.text === undefined ? 'image' : 'text'},
        ${input.text === undefined ? 'image/png' : 'text/plain'}, 'file.png', 1024, ${SHA},
        'documents', ${input.key}, 'ready', ${input.text ?? null})
    `;
    return id;
  }

  async function message(id: string) {
    const [row] = await admin<
      {
        text: string;
        sources: unknown;
        followUp: unknown;
        erased: boolean;
      }[]
    >`
      select text, sources, follow_up as "followUp", erased_at is not null as erased
      from app.ai_messages where id = ${id}
    `;
    return row;
  }

  function erase(context: { workspaceId?: string }, workspaceId: string, leadIds: string[]) {
    return asRuntime({ ...context, actorId: MACHINE }, (tx) =>
      tx<{ messages: number; conversations: number }[]>`
        select * from app.erase_restricted_lead_ai_turns(${workspaceId}::uuid, ${`{${leadIds.join(',')}}`}::uuid[])
      `.then((rows) => rows[0]),
    );
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
      values (${SITE_1}, 'ci-ai-erasure-1', 'CI AI Erasure 1'), (${SITE_2}, 'ci-ai-erasure-2', 'CI AI Erasure 2')
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version, external_ref, customer_data_restricted_at)
      values
        (${RESTRICTED}, ${SITE_1}, 'sim_order', 'incomplete', 'ci-v1', 'MS-1022', now()),
        (${LIVE}, ${SITE_1}, 'sim_order', 'incomplete', 'ci-v1', 'MS-1023', null),
        (${OTHER_SITE_LEAD}, ${SITE_2}, 'sim_order', 'incomplete', 'ci-v1', 'MS-1022', now())
    `;
  });

  afterAll(async () => {
    await runtimeSql?.end();
    if (admin) {
      await cleanUp();
      await admin.end();
    }
  });

  it('adds erased_at and five definer functions with an empty search_path that only app_runtime may run', async () => {
    const [column] = await admin<{ type: string; nullable: string }[]>`
      select data_type as type, is_nullable as nullable from information_schema.columns
      where table_schema = 'app' and table_name = 'ai_messages' and column_name = 'erased_at'
    `;
    expect(column).toEqual({ type: 'timestamp with time zone', nullable: 'YES' });
    const definitions = await admin<
      {
        name: string;
        secdef: boolean;
        config: string[] | null;
        publicExecute: boolean;
        runtimeExecute: boolean;
        backupExecute: boolean;
      }[]
    >`
      select p.proname as name, p.prosecdef as secdef, p.proconfig as config,
        has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute",
        has_function_privilege('app_runtime', p.oid, 'EXECUTE') as "runtimeExecute",
        has_function_privilege('backup_reader', p.oid, 'EXECUTE') as "backupExecute"
      from pg_proc p
      where p.pronamespace = 'app'::regnamespace and p.proname = any(${FUNCTIONS})
      order by p.proname
    `;
    expect(definitions).toEqual(
      [...FUNCTIONS].sort().map((name) => ({
        name,
        secdef: true,
        config: ['search_path=""'],
        publicExecute: false,
        runtimeExecute: true,
        backupExecute: false,
      })),
    );
    // The runtime role still holds no UPDATE or DELETE on messages itself.
    const [grants] = await admin<{ update: boolean; delete: boolean }[]>`
      select has_table_privilege('app_runtime', 'app.ai_messages', 'UPDATE') as update,
             has_table_privilege('app_runtime', 'app.ai_messages', 'DELETE') as delete
    `;
    expect(grants).toEqual({ update: false, delete: false });
  });

  it('empties every turn that links or numbers a restricted lead, for every member, and nothing else', async () => {
    const chatA = await conversation({ workspaceId: SITE_1, actorId: MEMBER_A, title: 'Orders' });
    const opener = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chatA,
      question: 'How is the newest order?',
      answer: 'Jane Doe ordered a SIM.',
      sources: [card(RESTRICTED)],
      followUp: { question: 'Email her?', choices: ['Yes', 'No'] },
    });
    const kept = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chatA,
      question: 'And the other one?',
      answer: 'MS-1023 is waiting. MS-10220 too.',
      sources: [card(LIVE)],
    });
    const byNumber = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chatA,
      question: 'What about ms-1022?',
      answer: 'It is waiting for documents.',
    });
    const file = await attachment({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chatA,
      messageId: byNumber.questionId,
      key: 'erased/file',
      text: 'Jane Doe, passport 123',
    });
    // Another member's chat about the same lead, by its href only.
    const chatB = await conversation({ workspaceId: SITE_1, actorId: MEMBER_B, title: 'Mine' });
    const colleague = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_B,
      conversationId: chatB,
      question: 'Summary please',
      answer: 'Here it is.',
      sources: [{ ...card(RESTRICTED), id: 'lead-renamed' }],
    });
    // The other site holds a restricted lead with the same number: untouched.
    const chatOther = await conversation({ workspaceId: SITE_2, actorId: MEMBER_A });
    const otherSite = await turn({
      workspaceId: SITE_2,
      actorId: MEMBER_A,
      conversationId: chatOther,
      question: 'MS-1022?',
      answer: 'Shipped.',
      sources: [card(OTHER_SITE_LEAD, 'ci-ai-erasure-2')],
    });

    expect(await erase({ workspaceId: SITE_1 }, SITE_1, [RESTRICTED, LIVE])).toEqual({
      messages: 6,
      conversations: 2,
    });

    for (const id of [
      opener.questionId,
      opener.answerId,
      byNumber.questionId,
      byNumber.answerId,
      colleague.questionId,
      colleague.answerId,
    ]) {
      expect(await message(id)).toEqual({ text: '', sources: [], followUp: null, erased: true });
    }
    expect(await message(kept.answerId)).toMatchObject({
      text: 'MS-1023 is waiting. MS-10220 too.',
      erased: false,
    });
    expect(await message(kept.questionId)).toMatchObject({ erased: false });
    expect(await message(otherSite.answerId)).toMatchObject({ text: 'Shipped.', erased: false });

    const [fileRow] = await admin<{ text: string | null }[]>`
      select extracted_text as text from app.ai_attachments where id = ${file}
    `;
    expect(fileRow?.text).toBeNull();
    // The first question of each chat was erased, so its title goes too.
    const titles = await admin<{ id: string; title: string }[]>`
      select id, title from app.ai_conversations where id in (${chatA}, ${chatB}, ${chatOther})
    `;
    expect(new Map(titles.map((row) => [row.id, row.title]))).toEqual(
      new Map([
        [chatA, 'Chat with a removed message'],
        [chatB, 'Chat with a removed message'],
        [chatOther, 'A chat'],
      ]),
    );

    // A second run erases nothing more.
    expect(await erase({ workspaceId: SITE_1 }, SITE_1, [RESTRICTED])).toEqual({
      messages: 0,
      conversations: 0,
    });
  });

  it('erases nothing for a lead that is not restricted, and keeps a renamed title', async () => {
    const chat = await conversation({ workspaceId: SITE_1, actorId: MEMBER_A, title: 'Renamed' });
    await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      question: 'Start',
      answer: 'Nothing about anyone.',
    });
    const live = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      question: 'MS-1023?',
      answer: 'Waiting.',
      sources: [card(LIVE)],
    });
    const later = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      question: 'And MS-1022?',
      answer: 'Restricted.',
    });
    expect(await erase({ workspaceId: SITE_1 }, SITE_1, [LIVE])).toEqual({
      messages: 0,
      conversations: 0,
    });
    expect(await message(live.answerId)).toMatchObject({ erased: false });
    expect(await erase({ workspaceId: SITE_1 }, SITE_1, [RESTRICTED])).toEqual({
      messages: 2,
      conversations: 1,
    });
    expect(await message(later.questionId)).toMatchObject({ erased: true });
    const [row] = await admin<{ title: string }[]>`
      select title from app.ai_conversations where id = ${chat}
    `;
    expect(row?.title).toBe('Renamed');
  });

  it('lists the files of erased turns and deletes only those rows', async () => {
    const chat = await conversation({ workspaceId: SITE_1, actorId: MEMBER_A });
    const erased = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      question: 'This file',
      answer: 'About the lead.',
      sources: [card(RESTRICTED)],
    });
    const keep = await turn({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      question: 'That file',
      answer: 'Nothing personal.',
    });
    const gone = await attachment({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      messageId: erased.questionId,
      key: 'erased/a',
    });
    const stays = await attachment({
      workspaceId: SITE_1,
      actorId: MEMBER_A,
      conversationId: chat,
      messageId: keep.questionId,
      key: 'kept/a',
    });
    await erase({ workspaceId: SITE_1 }, SITE_1, [RESTRICTED]);

    const machine = { workspaceId: SITE_1, actorId: MACHINE };
    const listed = await asRuntime(
      machine,
      (tx) => tx<{ id: string; bucket: string; object_key: string }[]>`
        select * from app.erased_ai_attachments(${SITE_1}::uuid, 100)
      `,
    );
    expect(listed).toEqual([{ id: gone, bucket: 'documents', object_key: 'erased/a' }]);
    const [deleted] = await asRuntime(
      machine,
      (tx) => tx<{ count: number }[]>`
        select app.delete_erased_ai_attachments(${SITE_1}::uuid, ${`{${gone},${stays}}`}::uuid[]) as count
      `,
    );
    expect(deleted?.count).toBe(1);
    const left = await admin<{ id: string }[]>`
      select id from app.ai_attachments where conversation_id = ${chat}
    `;
    expect(left.map((row) => row.id)).toEqual([stays]);
  });

  it('refuses another site, a missing actor where one is needed and unbounded input', async () => {
    await expect(erase({ workspaceId: SITE_2 }, SITE_1, [RESTRICTED])).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    const many = Array.from({ length: 1001 }, () => crypto.randomUUID());
    await expect(erase({ workspaceId: SITE_1 }, SITE_1, many)).rejects.toMatchObject({
      code: INVALID_PARAMETER_VALUE,
    });
    await expect(
      asRuntime(
        { workspaceId: SITE_1 },
        (tx) => tx`select * from app.erased_ai_attachments(${SITE_1}::uuid, 10)`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(
        { workspaceId: SITE_1, actorId: MACHINE },
        (tx) => tx`select * from app.departed_ai_conversations(${SITE_1}::uuid, now(), 0)`,
      ),
    ).rejects.toMatchObject({ code: INVALID_PARAMETER_VALUE });
    await expect(
      asRuntime(
        { workspaceId: SITE_1, actorId: MACHINE },
        (tx) =>
          tx`select app.delete_departed_ai_conversations(${SITE_2}::uuid, now(), '{}'::uuid[])`,
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  describe('departed members', () => {
    const REMOVED_LONG_AGO = MEMBER_A;
    const REMOVED_RECENTLY = MEMBER_B;
    const ACTIVE = '18000000-0000-4000-8000-000000000c03';

    async function memberships(): Promise<void> {
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status, revoked_at)
        values
          (${SITE_1}, ${REMOVED_LONG_AGO}, 'staff', 'revoked', now() - interval '40 days'),
          (${SITE_1}, ${REMOVED_RECENTLY}, 'staff', 'revoked', now() - interval '5 days'),
          (${SITE_1}, ${ACTIVE}, 'staff', 'active', null),
          (${SITE_2}, ${REMOVED_LONG_AGO}, 'staff', 'active', null)
      `;
    }

    function departed(before: Date) {
      return asRuntime(
        { workspaceId: SITE_1, actorId: MACHINE },
        (tx) => tx<{ conversation_id: string; bucket: string | null; object_key: string | null }[]>`
          select * from app.departed_ai_conversations(${SITE_1}::uuid, ${before.toISOString()}::timestamptz, 100)
          order by object_key nulls first
        `,
      );
    }

    function remove(before: Date, ids: string[]) {
      return asRuntime({ workspaceId: SITE_1, actorId: MACHINE }, (tx) =>
        tx<{ count: number }[]>`
          select app.delete_departed_ai_conversations(${SITE_1}::uuid, ${before.toISOString()}::timestamptz, ${`{${ids.join(',')}}`}::uuid[]) as count
        `.then((rows) => rows[0]?.count),
      );
    }

    it('lists and deletes the chats of someone who left the site before the cutoff, with their files', async () => {
      await memberships();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      const old = await conversation({
        workspaceId: SITE_1,
        actorId: REMOVED_LONG_AGO,
        ageDays: 41,
      });
      const { questionId } = await turn({
        workspaceId: SITE_1,
        actorId: REMOVED_LONG_AGO,
        conversationId: old,
        question: 'Q',
        answer: 'A',
      });
      await attachment({
        workspaceId: SITE_1,
        actorId: REMOVED_LONG_AGO,
        conversationId: old,
        messageId: questionId,
        key: 'departed/a',
      });
      await conversation({ workspaceId: SITE_1, actorId: REMOVED_RECENTLY, ageDays: 41 });
      await conversation({ workspaceId: SITE_1, actorId: ACTIVE, ageDays: 400 });
      // Still a member of the other site: that site's chats stay.
      const elsewhere = await conversation({
        workspaceId: SITE_2,
        actorId: REMOVED_LONG_AGO,
        ageDays: 41,
      });
      // Never a member at all (no row): treated as departed once the chat is old.
      const stranger = '18000000-0000-4000-8000-000000000c04';
      const orphan = await conversation({ workspaceId: SITE_1, actorId: stranger, ageDays: 41 });

      const listed = await departed(cutoff);
      expect(listed).toEqual([
        { conversation_id: orphan, bucket: null, object_key: null },
        { conversation_id: old, bucket: 'documents', object_key: 'departed/a' },
      ]);
      expect(await remove(cutoff, [old, orphan, elsewhere])).toBe(2);
      const [left] = await admin<{ count: number }[]>`
        select count(*)::int as count from app.ai_conversations where id in (${old}, ${orphan})
      `;
      expect(left?.count).toBe(0);
      const [kept] = await admin<{ count: number }[]>`
        select count(*)::int as count from app.ai_conversations where id = ${elsewhere}
      `;
      expect(kept?.count).toBe(1);
    });

    it('keeps the chats of a member added back, and never deletes what changed since it was listed', async () => {
      await memberships();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      const old = await conversation({
        workspaceId: SITE_1,
        actorId: REMOVED_LONG_AGO,
        ageDays: 41,
      });
      expect((await departed(cutoff)).map((row) => row.conversation_id)).toEqual([old]);
      // Added back (accept_staff_invitations reactivates the same row).
      await admin`
        update app.memberships set status = 'active', revoked_at = null
        where workspace_id = ${SITE_1} and user_id = ${REMOVED_LONG_AGO}
      `;
      expect(await departed(cutoff)).toEqual([]);
      expect(await remove(cutoff, [old])).toBe(0);
    });

    it('never treats a cutoff less than a day ago as such', async () => {
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status, revoked_at)
        values (${SITE_1}, ${REMOVED_RECENTLY}, 'staff', 'revoked', now() - interval '2 hours')
      `;
      await conversation({ workspaceId: SITE_1, actorId: REMOVED_RECENTLY, ageDays: 3 });
      expect(await departed(new Date(Date.now() + 60_000))).toEqual([]);
    });
  });
});
