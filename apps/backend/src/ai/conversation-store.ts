import { sql, type SQL } from 'drizzle-orm';
import {
  withTenantTx,
  type DatabaseClient,
  type TenantContext,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  AI_ASSISTANT_LIMITS,
  AI_CHAT_LIMITS,
  aiAssistantHistoryText,
  aiAttachmentKindSchema,
  aiAttachmentMediaTypeSchema,
  aiConversationSchema,
  aiFollowUpSchema,
  aiSourceSchema,
  aiStoredMessageSchema,
  formatAiConversationCursor,
  type AiAttachmentKind,
  type AiAttachmentMediaType,
  type AiAttachmentSummary,
  type AiConversation,
  type AiFollowUp,
  type AiMessageOutcome,
  type AiSource,
  type AiStoredMessage,
} from '@gt-sales/contracts';

/**
 * Ask AI's saved conversations: a member's own chats on one site, their
 * messages and the files those messages carry.
 *
 * Private by construction, twice over. Every statement runs inside
 * `withTenantTx` as the member, so the tables' owner policy shows and accepts
 * only rows of this site and this actor; and every statement ALSO names
 * `workspace_id` and `actor_id` itself, so the boundary never rests on row
 * security alone, nor on the routes. A conversation that is someone else's
 * reads exactly like one that does not exist.
 *
 * Messages are written once and never edited (the runtime role holds no
 * UPDATE or DELETE on them): the member's message when the turn starts, the
 * answer when it ends. They go only with their conversation, by cascade.
 */

/** The parts of a file a turn needs to hand it to the model. */
export interface AiTurnAttachment {
  readonly id: string;
  readonly kind: AiAttachmentKind;
  readonly mediaType: AiAttachmentMediaType;
  readonly fileName: string;
  readonly byteSize: number;
  readonly bucket: string;
  readonly objectKey: string;
  /** A text file's decoded text; null for an image or a PDF. */
  readonly extractedText: string | null;
}

/** One replayable message of an earlier, completed turn. */
export interface AiReplayMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** The files of a member's message, newest message's last; none for an answer. */
  readonly attachments: readonly AiTurnAttachment[];
}

export interface BeginAiTurnInput {
  readonly conversationId: string;
  /** The title a new conversation gets (`conversationTitleFrom`). */
  readonly title: string;
  /** The chat request's client id: the idempotency key of both rows. */
  readonly requestId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
}

export type BeginAiTurnOutcome =
  | {
      readonly status: 'started';
      readonly conversation: AiConversation;
      readonly created: boolean;
      readonly userMessageId: string;
      readonly attachments: readonly AiTurnAttachment[];
    }
  /** Not this member's on this site (absent, or someone else's: the same answer). */
  | { readonly status: 'not_found' }
  /** The two rows of this turn would pass `maxConversationMessages`. */
  | { readonly status: 'full' }
  /** A file that is not this member's, not ready, or already sent. */
  | { readonly status: 'invalid_attachments' }
  /** This request id already stored its question in this conversation. */
  | { readonly status: 'duplicate' };

export interface AppendAiAnswerInput {
  readonly conversationId: string;
  /** Chosen by the route before the stream ends, so `done.messageId` can name it. */
  readonly messageId: string;
  readonly requestId: string;
  readonly text: string;
  readonly outcome: AiMessageOutcome;
  readonly errorCode?: string;
  readonly sources: readonly AiSource[];
  readonly followUp?: AiFollowUp;
  readonly expiredDrafts: number;
}

export interface ListAiConversationsInput {
  readonly cursor?: { readonly micros: string; readonly id: string };
  readonly limit: number;
  readonly q?: string;
}

export interface AiConversationStore {
  list(
    scope: TenantContext,
    input: ListAiConversationsInput,
  ): Promise<{ conversations: AiConversation[]; nextCursor?: string }>;
  get(
    scope: TenantContext,
    conversationId: string,
  ): Promise<{ conversation: AiConversation; messages: AiStoredMessage[] } | undefined>;
  rename(
    scope: TenantContext,
    conversationId: string,
    title: string,
  ): Promise<AiConversation | undefined>;
  /** Deletes the conversation (its messages and files by cascade); the files' objects to remove. */
  delete(
    scope: TenantContext,
    conversationId: string,
  ): Promise<{ objects: { bucket: string; objectKey: string }[] } | undefined>;
  /**
   * One transaction: create the conversation on its first message or load it,
   * check the message limit, link this message's files and store the
   * member's message. Nothing is written unless all of it is.
   */
  beginTurn(scope: TenantContext, input: BeginAiTurnInput): Promise<BeginAiTurnOutcome>;
  /** The whole completed turns before `beforeMessageId`, newest kept within the history limits. */
  history(
    scope: TenantContext,
    input: { conversationId: string; beforeMessageId: string; reservedChars: number },
  ): Promise<AiReplayMessage[]>;
  /** Stores the answer once, however the turn ended. */
  appendAnswer(scope: TenantContext, input: AppendAiAnswerInput): Promise<void>;
}

/** Rows read back to build the replayed history: enough for 12 whole turns among failed ones. */
export const AI_HISTORY_SCAN_MESSAGES = 48;

/** The first title of a conversation: its opening message's first 60 characters, on one line. */
export function conversationTitleFrom(message: string): string {
  const line = message
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = Array.from(line).slice(0, 60).join('').trim();
  return title.length > 0 ? title : 'New chat';
}

/** A text clipped to `max` characters (code points), as the database counts them. */
export function clipCharacters(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max).join('');
}

/** A timestamp as an ISO string the contract accepts (the driver hands raw text back). */
function iso(column: SQL): SQL {
  return sql`to_json(${column})#>>'{}'`;
}

function isoText(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/** `%term%` for ILIKE, with the term's own wildcards escaped (as the lead search does it). */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

const CONVERSATION_COLUMNS = sql`
  c.id, c.title,
  ${iso(sql`c.created_at`)} as "createdAt",
  ${iso(sql`c.updated_at`)} as "updatedAt",
  ${iso(sql`c.last_message_at`)} as "lastMessageAt"
`;

function toConversation(row: Record<string, unknown>): AiConversation {
  return aiConversationSchema.parse({
    id: row['id'],
    title: row['title'],
    createdAt: isoText(row['createdAt']),
    updatedAt: isoText(row['updatedAt']),
    lastMessageAt: isoText(row['lastMessageAt']),
  });
}

function toAttachment(row: Record<string, unknown>): AiTurnAttachment {
  return {
    id: String(row['id']),
    kind: aiAttachmentKindSchema.parse(row['kind']),
    mediaType: aiAttachmentMediaTypeSchema.parse(row['mediaType']),
    fileName: String(row['fileName']),
    byteSize: Number(row['byteSize']),
    bucket: String(row['bucket']),
    objectKey: String(row['objectKey']),
    extractedText: typeof row['extractedText'] === 'string' ? row['extractedText'] : null,
  };
}

function summaryOf(attachment: AiTurnAttachment): AiAttachmentSummary {
  return {
    id: attachment.id,
    kind: attachment.kind,
    mediaType: attachment.mediaType,
    fileName: attachment.fileName,
    byteSize: attachment.byteSize,
  };
}

const ATTACHMENT_COLUMNS = sql`
  a.id, a.kind, a.media_type as "mediaType", a.file_name as "fileName",
  a.byte_size as "byteSize", a.bucket, a.object_key as "objectKey",
  a.extracted_text as "extractedText", a.message_id as "messageId"
`;

/** Sources and follow-up as stored: re-validated, so a row that no longer parses shows none. */
function storedSources(value: unknown): AiSource[] {
  const parsed = aiSourceSchema.array().max(20).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function storedFollowUp(value: unknown): AiFollowUp | undefined {
  const parsed = aiFollowUpSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A refusal raised inside the turn's transaction so nothing of it is kept. */
class TurnRefused extends Error {
  constructor(readonly outcome: 'not_found' | 'full' | 'invalid_attachments' | 'duplicate') {
    super(outcome);
    this.name = 'TurnRefused';
  }
}

/** The conversation's foreign keys or primary key, from postgres-js or wrapped by drizzle. */
export function isConversationKeyViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (
      'code' in current &&
      (current.code === '23503' || current.code === '23505') &&
      'constraint_name' in current &&
      typeof current.constraint_name === 'string' &&
      [
        'ai_conversations_pkey',
        'ai_messages_conversation_fk',
        'ai_attachments_conversation_fk',
        'ai_attachments_message_fk',
      ].includes(current.constraint_name)
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** The request id's unique index: this turn's question (or answer) is already stored. */
export function isDuplicateTurnViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === 'ai_messages_request_unique'
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

type Tx = TenantTransaction;

export class DatabaseAiConversationStore implements AiConversationStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  list(
    scope: TenantContext,
    input: ListAiConversationsInput,
  ): Promise<{ conversations: AiConversation[]; nextCursor?: string }> {
    const conditions: SQL[] = [
      sql`c.workspace_id = ${scope.workspaceId}`,
      sql`c.actor_id = ${scope.actorId}`,
    ];
    if (input.q !== undefined) conditions.push(sql`c.title ilike ${likePattern(input.q)}`);
    if (input.cursor !== undefined) {
      // Strictly older in (last_message_at desc, id desc); the instant is
      // rebuilt from whole microseconds in SQL, never through a JS Date.
      conditions.push(
        sql`(c.last_message_at, c.id) < (timestamptz 'epoch' + ${input.cursor.micros}::bigint * interval '1 microsecond', ${input.cursor.id}::uuid)`,
      );
    }
    return this.database.withTenantTx(scope, async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select ${CONVERSATION_COLUMNS},
          (extract(epoch from c.last_message_at) * 1000000)::bigint::text as micros
        from app.ai_conversations c
        where ${sql.join(conditions, sql` and `)}
        order by c.last_message_at desc, c.id desc
        limit ${input.limit + 1}
      `);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        conversations: page.map(toConversation),
        ...(rows.length > input.limit && last
          ? {
              nextCursor: formatAiConversationCursor({
                micros: String(last['micros']),
                id: String(last['id']),
              }),
            }
          : {}),
      };
    });
  }

  get(
    scope: TenantContext,
    conversationId: string,
  ): Promise<{ conversation: AiConversation; messages: AiStoredMessage[] } | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [conversation] = await tx.execute<Record<string, unknown>>(sql`
        select ${CONVERSATION_COLUMNS}
        from app.ai_conversations c
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${conversationId}
      `);
      if (!conversation) return undefined;
      const messages = await tx.execute<Record<string, unknown>>(sql`
        select m.id, m.role, m.text, m.outcome, m.error_code as "errorCode", m.sources,
          m.follow_up as "followUp", m.expired_drafts as "expiredDrafts",
          ${iso(sql`m.created_at`)} as "createdAt"
        from app.ai_messages m
        where m.workspace_id = ${scope.workspaceId} and m.actor_id = ${scope.actorId}
          and m.conversation_id = ${conversationId}
        order by m.created_at, m.id
        limit ${AI_CHAT_LIMITS.maxConversationMessages}
      `);
      const files = await attachmentsOf(
        tx,
        scope,
        conversationId,
        messages.filter((row) => row['role'] === 'user').map((row) => String(row['id'])),
      );
      return {
        conversation: toConversation(conversation),
        messages: messages.map((row) => {
          const followUp = storedFollowUp(row['followUp']);
          const errorCode = typeof row['errorCode'] === 'string' ? row['errorCode'] : undefined;
          return aiStoredMessageSchema.parse({
            id: row['id'],
            role: row['role'],
            text: row['text'],
            outcome: row['outcome'],
            ...(errorCode === undefined ? {} : { errorCode }),
            sources: storedSources(row['sources']),
            ...(followUp === undefined ? {} : { followUp }),
            expiredDrafts: Number(row['expiredDrafts']),
            createdAt: isoText(row['createdAt']),
            attachments: (files.get(String(row['id'])) ?? []).map(summaryOf),
          });
        }),
      };
    });
  }

  rename(
    scope: TenantContext,
    conversationId: string,
    title: string,
  ): Promise<AiConversation | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx.execute<Record<string, unknown>>(sql`
        update app.ai_conversations c set title = ${title}, updated_at = now()
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${conversationId}
        returning ${CONVERSATION_COLUMNS}
      `);
      return row ? toConversation(row) : undefined;
    });
  }

  delete(
    scope: TenantContext,
    conversationId: string,
  ): Promise<{ objects: { bucket: string; objectKey: string }[] } | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      // The files' keys first: the cascade removes their rows with the conversation.
      const files = await tx.execute<{ bucket: string; objectKey: string }>(sql`
        select a.bucket, a.object_key as "objectKey"
        from app.ai_attachments a
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.conversation_id = ${conversationId}
      `);
      const [deleted] = await tx.execute<{ id: string }>(sql`
        delete from app.ai_conversations c
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${conversationId}
        returning c.id
      `);
      if (!deleted) return undefined;
      return {
        objects: files.map((file) => ({ bucket: file.bucket, objectKey: file.objectKey })),
      };
    });
  }

  async beginTurn(scope: TenantContext, input: BeginAiTurnInput): Promise<BeginAiTurnOutcome> {
    try {
      return await this.database.withTenantTx(scope, async (tx) => {
        // Created on its first message under the browser's id. An id someone
        // else holds is invisible here: the insert does nothing and the read
        // below finds nothing, which answers exactly like an unknown id.
        const inserted = await tx.execute<{ id: string }>(sql`
          insert into app.ai_conversations (id, workspace_id, actor_id, title, last_message_at)
          values (${input.conversationId}, ${scope.workspaceId}, ${scope.actorId}, ${input.title}, now())
          on conflict (id) do nothing
          returning id
        `);
        // Locked, so two turns of one conversation count its messages in turn.
        const [conversation] = await tx.execute<{ id: string }>(sql`
          select c.id from app.ai_conversations c
          where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
            and c.id = ${input.conversationId}
          for update
        `);
        if (!conversation) throw new TurnRefused('not_found');

        const [count] = await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from app.ai_messages m
          where m.workspace_id = ${scope.workspaceId} and m.actor_id = ${scope.actorId}
            and m.conversation_id = ${input.conversationId}
        `);
        if ((count?.count ?? 0) + 2 > AI_CHAT_LIMITS.maxConversationMessages) {
          throw new TurnRefused('full');
        }

        let attachments: AiTurnAttachment[] = [];
        if (input.attachmentIds.length > 0) {
          const rows = await tx.execute<Record<string, unknown>>(sql`
            select ${ATTACHMENT_COLUMNS}, a.status
            from app.ai_attachments a
            where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
              and a.id = any(${uuidArray(input.attachmentIds)})
            for update
          `);
          if (
            rows.length !== input.attachmentIds.length ||
            rows.some((row) => row['status'] !== 'ready' || row['messageId'] !== null)
          ) {
            throw new TurnRefused('invalid_attachments');
          }
          // In the order the member attached them.
          const byId = new Map(rows.map((row) => [String(row['id']), toAttachment(row)]));
          attachments = input.attachmentIds.flatMap((id) => {
            const found = byId.get(id.toLowerCase()) ?? byId.get(id);
            return found ? [found] : [];
          });
          if (attachments.length !== input.attachmentIds.length) {
            throw new TurnRefused('invalid_attachments');
          }
        }

        const [message] = await tx.execute<{ id: string }>(sql`
          insert into app.ai_messages
            (workspace_id, conversation_id, actor_id, role, text, outcome, request_id)
          values (${scope.workspaceId}, ${input.conversationId}, ${scope.actorId}, 'user',
            ${clipCharacters(input.text, AI_CHAT_LIMITS.maxStoredMessageChars)}, 'completed',
            ${input.requestId})
          on conflict (workspace_id, conversation_id, request_id, role)
            where request_id is not null do nothing
          returning id
        `);
        if (!message) throw new TurnRefused('duplicate');

        if (attachments.length > 0) {
          await tx.execute(sql`
            update app.ai_attachments a
            set conversation_id = ${input.conversationId}, message_id = ${message.id}
            where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
              and a.id = any(${uuidArray(attachments.map((file) => file.id))})
              and a.message_id is null and a.status = 'ready'
          `);
        }

        const [touched] = await tx.execute<Record<string, unknown>>(sql`
          update app.ai_conversations c set last_message_at = now(), updated_at = now()
          where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
            and c.id = ${input.conversationId}
          returning ${CONVERSATION_COLUMNS}
        `);
        if (!touched) throw new TurnRefused('not_found');
        return {
          status: 'started' as const,
          conversation: toConversation(touched),
          created: inserted.length > 0,
          userMessageId: message.id,
          attachments,
        };
      });
    } catch (error) {
      if (error instanceof TurnRefused) return { status: error.outcome };
      // The database's own backstops, should a race get past the reads above.
      if (isDuplicateTurnViolation(error)) return { status: 'duplicate' };
      if (isConversationKeyViolation(error)) return { status: 'not_found' };
      throw error;
    }
  }

  history(
    scope: TenantContext,
    input: { conversationId: string; beforeMessageId: string; reservedChars: number },
  ): Promise<AiReplayMessage[]> {
    return this.database.withTenantTx(scope, async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select m.id, m.role, m.text, m.outcome, m.follow_up as "followUp"
        from app.ai_messages m
        where m.workspace_id = ${scope.workspaceId} and m.actor_id = ${scope.actorId}
          and m.conversation_id = ${input.conversationId}
          and m.id <> ${input.beforeMessageId}
        order by m.created_at desc, m.id desc
        limit ${AI_HISTORY_SCAN_MESSAGES}
      `);
      const chronological = [...rows].reverse();
      // Whole completed turns only: a question followed by its answer that
      // finished. A stopped, failed or access-lost answer is dropped with its
      // question, so the model sees question, answer, question, answer.
      const turns: { question: Record<string, unknown>; answer: string }[] = [];
      for (let index = 0; index + 1 < chronological.length; index += 1) {
        const question = chronological[index];
        const answer = chronological[index + 1];
        if (question?.['role'] !== 'user' || answer?.['role'] !== 'assistant') continue;
        index += 1;
        if (answer['outcome'] !== 'completed') continue;
        const followUp = storedFollowUp(answer['followUp']);
        turns.push({
          question,
          // The text a browser would have replayed (and the server signed).
          answer: aiAssistantHistoryText({ text: String(answer['text']), followUp }),
        });
      }
      // Newest kept, within the same limits a browser's history obeys.
      const kept: typeof turns = [];
      let characters = input.reservedChars;
      for (const turn of [...turns].reverse()) {
        const question = clipCharacters(
          String(turn.question['text']),
          AI_ASSISTANT_LIMITS.maxMessageChars,
        );
        const size = Array.from(question).length + Array.from(turn.answer).length;
        if (kept.length * 2 + 2 > AI_ASSISTANT_LIMITS.maxHistoryMessages) break;
        if (characters + size > AI_ASSISTANT_LIMITS.maxConversationChars) break;
        characters += size;
        kept.unshift({ question: { ...turn.question, text: question }, answer: turn.answer });
      }
      const files = await attachmentsOf(
        tx,
        scope,
        input.conversationId,
        kept.map((turn) => String(turn.question['id'])),
      );
      return kept.flatMap((turn): AiReplayMessage[] => [
        {
          role: 'user',
          text: String(turn.question['text']),
          attachments: files.get(String(turn.question['id'])) ?? [],
        },
        { role: 'assistant', text: turn.answer, attachments: [] },
      ]);
    });
  }

  async appendAnswer(scope: TenantContext, input: AppendAiAnswerInput): Promise<void> {
    await this.database.withTenantTx(scope, async (tx) => {
      await tx.execute(sql`
        insert into app.ai_messages
          (id, workspace_id, conversation_id, actor_id, role, text, outcome, error_code,
           sources, follow_up, expired_drafts, request_id)
        values (${input.messageId}, ${scope.workspaceId}, ${input.conversationId},
          ${scope.actorId}, 'assistant',
          ${clipCharacters(input.text, AI_CHAT_LIMITS.maxStoredMessageChars)},
          ${input.outcome}, ${input.errorCode ?? null},
          ${JSON.stringify(input.sources)}::jsonb,
          ${input.followUp === undefined ? null : JSON.stringify(input.followUp)}::jsonb,
          ${Math.min(100, Math.max(0, input.expiredDrafts))}, ${input.requestId})
        on conflict (workspace_id, conversation_id, request_id, role)
          where request_id is not null do nothing
      `);
      await tx.execute(sql`
        update app.ai_conversations c set last_message_at = now(), updated_at = now()
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${input.conversationId}
      `);
    });
  }
}

/** Each listed message's files, in the order they were added. */
async function attachmentsOf(
  tx: Tx,
  scope: TenantContext,
  conversationId: string,
  messageIds: readonly string[],
): Promise<Map<string, AiTurnAttachment[]>> {
  const byMessage = new Map<string, AiTurnAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select ${ATTACHMENT_COLUMNS}
    from app.ai_attachments a
    where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
      and a.conversation_id = ${conversationId}
      and a.message_id = any(${uuidArray(messageIds)})
    order by a.created_at, a.id
  `);
  for (const row of rows) {
    const messageId = String(row['messageId']);
    const list = byMessage.get(messageId) ?? [];
    if (list.length < AI_CHAT_LIMITS.maxAttachmentsPerMessage) list.push(toAttachment(row));
    byMessage.set(messageId, list);
  }
  return byMessage;
}
