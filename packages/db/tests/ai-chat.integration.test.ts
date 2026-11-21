import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../src/migrations.js';
import {
  getDisposableTestDatabaseUrl,
  setTestRuntimePassword,
  TEST_RUNTIME_PASSWORD,
} from '../src/test-helpers.js';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE_1 = '17000000-0000-4000-8000-000000000a01';
const SITE_2 = '17000000-0000-4000-8000-000000000a02';
const ACTOR_A = '18000000-0000-4000-8000-000000000a01';
const ACTOR_B = '18000000-0000-4000-8000-000000000a02';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';

const SHA = 'a'.repeat(64);
const TABLES = ['ai_attachments', 'ai_conversations', 'ai_messages'] as const;

databaseTest('Ask AI saved chat: ai_conversations, ai_messages, ai_attachments', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;

  /** One app_runtime transaction with the tenant context withTenantTx would set. */
  function asRuntime<T>(
    workspaceId: string,
    actorId: string,
    body: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return runtimeSql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${workspaceId}, true),
               set_config('app.actor_id', ${actorId}, true)
      `;
      return body(tx);
    });
  }

  function insertConversation(
    tx: postgres.TransactionSql,
    row: { id?: string; workspaceId: string; actorId: string; title?: string },
  ) {
    return tx<{ id: string }[]>`
      insert into app.ai_conversations (id, workspace_id, actor_id, title)
      values (${row.id ?? crypto.randomUUID()}, ${row.workspaceId}, ${row.actorId},
        ${row.title ?? 'Leads this week'})
      returning id
    `;
  }

  function insertMessage(
    tx: postgres.TransactionSql,
    row: {
      workspaceId: string;
      actorId: string;
      conversationId: string;
      role?: string;
      outcome?: string;
      requestId?: string | null;
      errorCode?: string | null;
    },
  ) {
    return tx<{ id: string }[]>`
      insert into app.ai_messages
        (workspace_id, actor_id, conversation_id, role, text, outcome, error_code, request_id)
      values (${row.workspaceId}, ${row.actorId}, ${row.conversationId}, ${row.role ?? 'user'},
        'How many leads came in today?', ${row.outcome ?? 'completed'}, ${row.errorCode ?? null},
        ${row.requestId ?? null})
      returning id
    `;
  }

  function insertAttachment(
    tx: postgres.TransactionSql,
    row: { workspaceId: string; actorId: string; kind?: string; mediaType?: string },
  ) {
    return tx<{ id: string }[]>`
      insert into app.ai_attachments
        (workspace_id, actor_id, kind, media_type, file_name, byte_size, bucket, object_key)
      values (${row.workspaceId}, ${row.actorId}, ${row.kind ?? 'image'},
        ${row.mediaType ?? 'image/png'}, 'letter.png', 1024, 'documents',
        ${`ai/${crypto.randomUUID()}`})
      returning id
    `;
  }

  async function cleanUp(): Promise<void> {
    // Cascades to every conversation, message and attachment of both sites.
    await admin`delete from app.workspaces where id in (${SITE_1}, ${SITE_2})`;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await setTestRuntimePassword(admin);
    await cleanUp();
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE_1}, 'ci-ai-chat-1', 'CI AI Chat 1'), (${SITE_2}, 'ci-ai-chat-2', 'CI AI Chat 2')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
  });

  afterAll(async () => {
    await runtimeSql?.end();
    if (admin) {
      await cleanUp();
      await admin.end();
    }
  });

  it('has row security on and forced, the owner and backup policies, and least-privilege grants', async () => {
    const tables = await admin<
      { tablename: string; rowSecurity: boolean; forced: boolean; policies: string[] }[]
    >`
      select
        c.relname as tablename,
        c.relrowsecurity as "rowSecurity",
        c.relforcerowsecurity as forced,
        array(
          select p.policyname::text from pg_policies p
          where p.schemaname = 'app' and p.tablename = c.relname
          order by p.policyname
        ) as policies
      from pg_class c
      where c.relnamespace = 'app'::regnamespace and c.relname = any(${[...TABLES]}::text[])
      order by c.relname
    `;
    expect(tables).toEqual(
      TABLES.map((tablename) => ({
        tablename,
        rowSecurity: true,
        forced: true,
        policies: [`${tablename}_backup_reader_read`, `${tablename}_owner_policy`],
      })),
    );

    const privileges = await admin<
      {
        tablename: string;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
        backup: boolean;
      }[]
    >`
      select
        t.name as tablename,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'SELECT') as select,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'INSERT') as insert,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'UPDATE') as update,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'DELETE') as delete,
        has_table_privilege('backup_reader', format('app.%I', t.name), 'SELECT') as backup
      from unnest(${[...TABLES]}::text[]) as t(name)
      order by t.name
    `;
    expect(privileges).toEqual([
      {
        tablename: 'ai_attachments',
        select: true,
        insert: true,
        update: true,
        delete: true,
        backup: true,
      },
      {
        tablename: 'ai_conversations',
        select: true,
        insert: true,
        update: true,
        delete: true,
        backup: true,
      },
      {
        tablename: 'ai_messages',
        select: true,
        insert: true,
        update: false,
        delete: false,
        backup: true,
      },
    ]);
  });

  it('a conversation is visible and writable only to its own member on its own site', async () => {
    const [mine] = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertConversation(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
    );
    if (!mine) throw new Error('the conversation was not inserted');

    const own = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx`select id from app.ai_conversations where id = ${mine.id}`;
    });
    expect(own).toHaveLength(1);

    // A colleague on the same site neither sees, renames nor deletes it.
    for (const statement of [
      (tx: postgres.TransactionSql) =>
        tx`select id from app.ai_conversations where id = ${mine.id}`,
      (tx: postgres.TransactionSql) =>
        tx`update app.ai_conversations set title = 'Taken' where id = ${mine.id} returning id`,
      (tx: postgres.TransactionSql) =>
        tx`delete from app.ai_conversations where id = ${mine.id} returning id`,
    ]) {
      expect(await asRuntime(SITE_1, ACTOR_B, statement)).toHaveLength(0);
      // The same member in another site's context does not either.
      expect(await asRuntime(SITE_2, ACTOR_A, statement)).toHaveLength(0);
    }

    // The id exists but is someone else's: an insert under it meets the
    // primary key (the route answers conversation_not_found, never 403).
    await expect(
      asRuntime(SITE_1, ACTOR_B, (tx) =>
        insertConversation(tx, { id: mine.id, workspaceId: SITE_1, actorId: ACTOR_B }),
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    // Nobody writes a conversation for another member or into another site.
    await expect(
      asRuntime(SITE_1, ACTOR_B, (tx) =>
        insertConversation(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) =>
        insertConversation(tx, { workspaceId: SITE_2, actorId: ACTOR_A }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // Nor can the owner of a row move it to another member or site.
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_conversations set actor_id = ${ACTOR_B} where id = ${mine.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_conversations set workspace_id = ${SITE_2} where id = ${mine.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // A title is one line of 1-120 characters.
    for (const title of ['   ', 'a'.repeat(121), 'two\nlines', 'tab\there']) {
      await expect(
        asRuntime(SITE_1, ACTOR_A, (tx) =>
          insertConversation(tx, { workspaceId: SITE_1, actorId: ACTOR_A, title }),
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }

    const renamed = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx`update app.ai_conversations set title = ${'b'.repeat(120)} where id = ${mine.id} returning id`;
    });
    expect(renamed).toHaveLength(1);
  });

  it('a message is private, never edited, belongs to its own member’s conversation and is stored once per turn', async () => {
    const [conversation] = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertConversation(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
    );
    if (!conversation) throw new Error('the conversation was not inserted');
    const requestId = crypto.randomUUID();
    const [message] = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertMessage(tx, {
        workspaceId: SITE_1,
        actorId: ACTOR_A,
        conversationId: conversation.id,
        requestId,
      }),
    );
    if (!message) throw new Error('the message was not inserted');

    const select = (tx: postgres.TransactionSql) =>
      tx`select id from app.ai_messages where id = ${message.id}`;
    expect(await asRuntime(SITE_1, ACTOR_A, select)).toHaveLength(1);
    expect(await asRuntime(SITE_1, ACTOR_B, select)).toHaveLength(0);
    expect(await asRuntime(SITE_2, ACTOR_A, select)).toHaveLength(0);

    // No UPDATE and no DELETE for the runtime role, even on its own row.
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_messages set text = 'rewritten' where id = ${message.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`delete from app.ai_messages where id = ${message.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // Not on behalf of another member, nor into another site.
    await expect(
      asRuntime(SITE_1, ACTOR_B, (tx) =>
        insertMessage(tx, {
          workspaceId: SITE_1,
          actorId: ACTOR_A,
          conversationId: conversation.id,
        }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(SITE_2, ACTOR_A, (tx) =>
        insertMessage(tx, {
          workspaceId: SITE_1,
          actorId: ACTOR_A,
          conversationId: conversation.id,
        }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // A colleague who knows the id still cannot add their own message to it:
    // the foreign key carries the actor, and it is checked without RLS.
    await expect(
      asRuntime(SITE_1, ACTOR_B, (tx) =>
        insertMessage(tx, {
          workspaceId: SITE_1,
          actorId: ACTOR_B,
          conversationId: conversation.id,
        }),
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

    // The same request id stores one question and one answer.
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) =>
        insertMessage(tx, {
          workspaceId: SITE_1,
          actorId: ACTOR_A,
          conversationId: conversation.id,
          requestId,
        }),
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    const answer = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertMessage(tx, {
        workspaceId: SITE_1,
        actorId: ACTOR_A,
        conversationId: conversation.id,
        role: 'assistant',
        outcome: 'failed',
        errorCode: 'provider_unavailable',
        requestId,
      }),
    );
    expect(answer).toHaveLength(1);

    // A question always completed and carries no error; an answer uses ai_turns' words.
    for (const row of [
      { role: 'user', outcome: 'failed' },
      { role: 'user', outcome: 'completed', errorCode: 'timeout' },
      { role: 'assistant', outcome: 'pending' },
      { role: 'system', outcome: 'completed' },
      { role: 'assistant', outcome: 'failed', errorCode: 'Not A Code' },
    ]) {
      await expect(
        asRuntime(SITE_1, ACTOR_A, (tx) =>
          insertMessage(tx, {
            workspaceId: SITE_1,
            actorId: ACTOR_A,
            conversationId: conversation.id,
            ...row,
          }),
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it('an attachment is private, linked only to its own conversation once ready, and goes with it', async () => {
    const [conversation] = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertConversation(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
    );
    if (!conversation) throw new Error('the conversation was not inserted');
    const [message] = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertMessage(tx, { workspaceId: SITE_1, actorId: ACTOR_A, conversationId: conversation.id }),
    );
    if (!message) throw new Error('the message was not inserted');
    const [file] = await asRuntime(SITE_1, ACTOR_A, (tx) =>
      insertAttachment(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
    );
    if (!file) throw new Error('the attachment was not inserted');

    const select = (tx: postgres.TransactionSql) =>
      tx`select id from app.ai_attachments where id = ${file.id}`;
    expect(await asRuntime(SITE_1, ACTOR_A, select)).toHaveLength(1);
    expect(await asRuntime(SITE_1, ACTOR_B, select)).toHaveLength(0);
    expect(await asRuntime(SITE_2, ACTOR_A, select)).toHaveLength(0);
    const othersDelete = await asRuntime(SITE_1, ACTOR_B, (tx) => {
      return tx`delete from app.ai_attachments where id = ${file.id} returning id`;
    });
    expect(othersDelete).toHaveLength(0);

    await expect(
      asRuntime(SITE_1, ACTOR_B, (tx) =>
        insertAttachment(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(SITE_2, ACTOR_A, (tx) =>
        insertAttachment(tx, { workspaceId: SITE_1, actorId: ACTOR_A }),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set actor_id = ${ACTOR_B} where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // The kind matches the media type, and a text file's text only on a text file.
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) =>
        insertAttachment(tx, {
          workspaceId: SITE_1,
          actorId: ACTOR_A,
          kind: 'image',
          mediaType: 'application/pdf',
        }),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set extracted_text = 'x', status = 'ready', sha256 = ${SHA} where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // A pending file cannot be sent, and the two links are set together.
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set conversation_id = ${conversation.id}, message_id = ${message.id} where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set status = 'ready' where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx`update app.ai_attachments set status = 'ready', sha256 = ${SHA} where id = ${file.id}`;
    });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set conversation_id = ${conversation.id} where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // A colleague's conversation, or a message of another conversation, is no target.
    const [theirs] = await asRuntime(SITE_1, ACTOR_B, (tx) =>
      insertConversation(tx, { workspaceId: SITE_1, actorId: ACTOR_B }),
    );
    const [theirMessage] = await asRuntime(SITE_1, ACTOR_B, (tx) =>
      insertMessage(tx, {
        workspaceId: SITE_1,
        actorId: ACTOR_B,
        conversationId: theirs?.id ?? '',
      }),
    );
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set conversation_id = ${theirs?.id ?? ''}, message_id = ${theirMessage?.id ?? ''} where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`update app.ai_attachments set conversation_id = ${conversation.id}, message_id = ${theirMessage?.id ?? ''} where id = ${file.id}`;
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

    const linked = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx`update app.ai_attachments set conversation_id = ${conversation.id}, message_id = ${message.id} where id = ${file.id} returning id`;
    });
    expect(linked).toHaveLength(1);

    // Deleting the conversation removes its messages and files by cascade,
    // although the runtime role holds no DELETE on ai_messages.
    const removed = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx`delete from app.ai_conversations where id = ${conversation.id} returning id`;
    });
    expect(removed).toHaveLength(1);
    const [left] = await admin<{ messages: number; files: number }[]>`
      select
        (select count(*)::int from app.ai_messages where conversation_id = ${conversation.id}) as messages,
        (select count(*)::int from app.ai_attachments where id = ${file.id}) as files
    `;
    expect(left).toEqual({ messages: 0, files: 0 });

    // The colleague's conversation is untouched.
    const [kept] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.ai_messages where conversation_id = ${theirs?.id ?? ''}
    `;
    expect(kept?.count).toBe(1);
  });

  it('ai_turns records input tokens, zero by default and never negative', async () => {
    const turn = {
      workspaceId: SITE_1,
      actorId: ACTOR_A,
      requestId: crypto.randomUUID(),
    };
    const [row] = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx<{ input_tokens: number }[]>`
        insert into app.ai_turns
          (workspace_id, actor_id, request_id, engine, prompt_version, outcome, duration_ms)
        values (${turn.workspaceId}, ${turn.actorId}, ${turn.requestId}, 'fake', 1, 'completed', 5)
        returning input_tokens
      `;
    });
    expect(row).toEqual({ input_tokens: 0 });
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.ai_turns
            (workspace_id, actor_id, request_id, engine, prompt_version, outcome, duration_ms, input_tokens)
          values (${SITE_1}, ${ACTOR_A}, ${crypto.randomUUID()}, 'fake', 1, 'completed', 5, -1)
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
  it('ai_turns records the effort level: normal by default, normal or high only', async () => {
    const [row] = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx<{ effort: string }[]>`
        insert into app.ai_turns
          (workspace_id, actor_id, request_id, engine, prompt_version, outcome, duration_ms)
        values (${SITE_1}, ${ACTOR_A}, ${crypto.randomUUID()}, 'fake', 1, 'completed', 5)
        returning effort
      `;
    });
    expect(row).toEqual({ effort: 'normal' });
    const [high] = await asRuntime(SITE_1, ACTOR_A, (tx) => {
      return tx<{ effort: string }[]>`
        insert into app.ai_turns
          (workspace_id, actor_id, request_id, engine, prompt_version, outcome, duration_ms, effort)
        values (${SITE_1}, ${ACTOR_A}, ${crypto.randomUUID()}, 'fake', 1, 'completed', 5, 'high')
        returning effort
      `;
    });
    expect(high).toEqual({ effort: 'high' });
    for (const effort of ['max', 'HIGH', '']) {
      await expect(
        asRuntime(SITE_1, ACTOR_A, (tx) => {
          return tx`
            insert into app.ai_turns
              (workspace_id, actor_id, request_id, engine, prompt_version, outcome, duration_ms, effort)
            values (${SITE_1}, ${ACTOR_A}, ${crypto.randomUUID()}, 'fake', 1, 'completed', 5, ${effort})
          `;
        }),
        effort,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      asRuntime(SITE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.ai_turns
            (workspace_id, actor_id, request_id, engine, prompt_version, outcome, duration_ms, effort)
          values (${SITE_1}, ${ACTOR_A}, ${crypto.randomUUID()}, 'fake', 1, 'completed', 5, null)
        `;
      }),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('ai_messages keeps an optional effort level, normal or high, on both rows of a turn', async () => {
    const requestId = crypto.randomUUID();
    const rows = await asRuntime(SITE_1, ACTOR_A, async (tx) => {
      const [conversation] = await insertConversation(tx, {
        workspaceId: SITE_1,
        actorId: ACTOR_A,
      });
      const id = conversation?.id ?? '';
      // A row written as before (no effort) reads null.
      await insertMessage(tx, { workspaceId: SITE_1, actorId: ACTOR_A, conversationId: id });
      await tx`
        insert into app.ai_messages
          (workspace_id, actor_id, conversation_id, role, text, outcome, request_id, effort)
        values (${SITE_1}, ${ACTOR_A}, ${id}, 'user', 'Why did orders drop?', 'completed',
          ${requestId}, 'high'),
          (${SITE_1}, ${ACTOR_A}, ${id}, 'assistant', 'Because…', 'completed', ${requestId}, 'high')
      `;
      return tx<{ role: string; effort: string | null }[]>`
        select role, effort from app.ai_messages where conversation_id = ${id}
        order by created_at, id
      `;
    });
    expect(rows).toEqual([
      { role: 'user', effort: null },
      { role: 'user', effort: 'high' },
      { role: 'assistant', effort: 'high' },
    ]);
    await expect(
      asRuntime(SITE_1, ACTOR_A, async (tx) => {
        const [conversation] = await insertConversation(tx, {
          workspaceId: SITE_1,
          actorId: ACTOR_A,
        });
        return tx`
          insert into app.ai_messages
            (workspace_id, actor_id, conversation_id, role, text, outcome, effort)
          values (${SITE_1}, ${ACTOR_A}, ${conversation?.id ?? ''}, 'user', 'x', 'completed', 'max')
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});
