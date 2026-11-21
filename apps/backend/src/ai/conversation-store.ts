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
  aiEffortSchema,
  aiFollowUpSchema,
  aiSourceSchema,
  aiStoredMessageSchema,
  formatAiConversationCursor,
  type AiAttachmentKind,
  type AiAttachmentMediaType,
  type AiAttachmentSummary,
  type AiConversation,
  type AiEffort,
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
  /** An answer's follow-up choices as stored, so a clicked one can be told from typed words (B8). */
  readonly followUpChoices?: readonly string[];
  /**
   * The leads an answer's source cards link: what the model read in that
   * turn and can still see now it is replayed, for the mention check (B1,
   * T11). None for a member's message.
   */
  readonly leadIds?: readonly string[];
}

export interface BeginAiTurnInput {
  readonly conversationId: string;
  /**
   * The request's `newConversation`: only then is a conversation created under
   * `conversationId` (or, already this member's, gone on in: a retried first
   * message). Otherwise an id the member does not have is `not_found`.
   */
  readonly create: boolean;
  /** The title a new conversation gets (`conversationTitleFrom`). */
  readonly title: string;
  /** The chat request's client id: the idempotency key of both rows. */
  readonly requestId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  /**
   * The turn's effort level, stored on the member's message. Passed only once
   * 0037 holds the column (the route asks the schema probe); absent writes
   * the row exactly as before.
   */
  readonly effort?: AiEffort;
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
  /** A new conversation would pass the member's `maxConversationsPerActor` on this site. */
  | { readonly status: 'too_many_conversations' }
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
  /** As on `BeginAiTurnInput`: stored on the answer, only once 0037 holds the column. */
  readonly effort?: AiEffort;
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
  /**
   * The stored objects of the conversation's files, for the member's delete
   * to remove BEFORE the rows; undefined when it is not this member's.
   */
  listObjects(
    scope: TenantContext,
    conversationId: string,
  ): Promise<{ objects: { bucket: string; objectKey: string }[] } | undefined>;
  /**
   * Deletes the conversation (its messages and files by cascade), but only
   * when its files are still exactly `removedObjects` (the objects already
   * deleted): a file a concurrent turn added meanwhile answers `changed`, so
   * the caller deletes that object too before trying again.
   */
  delete(
    scope: TenantContext,
    conversationId: string,
    removedObjects: readonly { bucket: string; objectKey: string }[],
  ): Promise<'deleted' | 'changed' | 'not_found'>;
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

/** A uuid, as the pattern of a lead's source card id or href (`SourceRegistry.lead`). */
const UUID_PATTERN = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const LEAD_CARD_ID = `^lead-(${UUID_PATTERN})$`;
const LEAD_CARD_HREF = `/leads/(${UUID_PATTERN})$`;

/** Completed turns read back to build the replayed history (the newest are kept within the limits). */
export const AI_HISTORY_SCAN_MESSAGES = 48;

/** The most characters (code points, as the database counts them) of a first title. */
const FIRST_TITLE_CHARS = 60;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first title of a conversation: its opening message's first 60
 * characters, on one line. Control and format characters become spaces,
 * except the zero-width joiner and the emoji variation selector, which hold a
 * joined emoji together (👩‍👩‍👧‍👦, ❤️). The clip takes whole graphemes, so a
 * joined emoji is kept whole or left out, never cut.
 */
export function conversationTitleFrom(message: string): string {
  const line = message
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
      // The joiner and the emoji variation selector stay: they hold an emoji together.
      character === '\u200D' || character === '\uFE0F' ? character : ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  let title = '';
  let characters = 0;
  for (const { segment } of graphemes.segment(line)) {
    const size = Array.from(segment).length;
    if (characters + size > FIRST_TITLE_CHARS) break;
    title += segment;
    characters += size;
  }
  title = title.trim();
  return title.length > 0 ? title : 'New chat';
}

/** A text clipped to `max` characters (code points), as the database counts them. */
export function clipCharacters(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max).join('');
}

/** Postgres text cannot hold U+0000: it is dropped from what is stored (the model got it as typed). */
export function withoutNul(text: string): string {
  return text.includes('\u0000') ? text.split('\u0000').join('') : text;
}

/** A message's text as stored: without NUL, clipped to the stored limit. */
function storedText(text: string): string {
  return clipCharacters(withoutNul(text), AI_CHAT_LIMITS.maxStoredMessageChars);
}

/** JSON for a jsonb column, whose strings cannot hold U+0000 either. */
function storedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? withoutNul(item) : item,
  );
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

/** The leads a stored answer's source cards link (`SourceRegistry.lead`: its id or its href). */
function sourceLeadIds(value: unknown): string[] {
  const ids = new Set<string>();
  for (const source of storedSources(value)) {
    const id =
      new RegExp(LEAD_CARD_ID).exec(source.id)?.[1] ??
      new RegExp(LEAD_CARD_HREF).exec(source.href ?? '')?.[1];
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids];
}

function storedFollowUp(value: unknown): AiFollowUp | undefined {
  const parsed = aiFollowUpSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A refusal raised inside the turn's transaction so nothing of it is kept. */
class TurnRefused extends Error {
  constructor(
    readonly outcome:
      'not_found' | 'full' | 'too_many_conversations' | 'invalid_attachments' | 'duplicate',
  ) {
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
          ${iso(sql`m.created_at`)} as "createdAt",
          -- 0037's column, read through the row so the query also runs before it exists.
          to_jsonb(m)->>'effort' as effort,
          -- 0039's, the same way: the turn was emptied by a customer's erasure.
          (to_jsonb(m)->>'erased_at') is not null as erased
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
          const effort = aiEffortSchema.safeParse(row['effort']);
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
            ...(effort.success ? { effort: effort.data } : {}),
            ...(row['erased'] === true ? { erased: true as const } : {}),
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

  listObjects(
    scope: TenantContext,
    conversationId: string,
  ): Promise<{ objects: { bucket: string; objectKey: string }[] } | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [conversation] = await tx.execute<{ id: string }>(sql`
        select c.id from app.ai_conversations c
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${conversationId}
      `);
      if (!conversation) return undefined;
      return { objects: await objectsOf(tx, scope, conversationId) };
    });
  }

  delete(
    scope: TenantContext,
    conversationId: string,
    removedObjects: readonly { bucket: string; objectKey: string }[],
  ): Promise<'deleted' | 'changed' | 'not_found'> {
    return this.database.withTenantTx(scope, async (tx) => {
      // Locked, so no turn adds a file between this check and the delete.
      const [conversation] = await tx.execute<{ id: string }>(sql`
        select c.id from app.ai_conversations c
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${conversationId}
        for update
      `);
      if (!conversation) return 'not_found';
      const removed = new Set(removedObjects.map((file) => `${file.bucket}:${file.objectKey}`));
      const current = await objectsOf(tx, scope, conversationId);
      if (current.some((file) => !removed.has(`${file.bucket}:${file.objectKey}`)))
        return 'changed';
      await tx.execute(sql`
        delete from app.ai_conversations c
        where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          and c.id = ${conversationId}
      `);
      return 'deleted';
    });
  }

  async beginTurn(scope: TenantContext, input: BeginAiTurnInput): Promise<BeginAiTurnOutcome> {
    try {
      return await this.database.withTenantTx(scope, async (tx) => {
        // Created by its first message only (`create`), under the browser's
        // id, so a question asked into a conversation deleted elsewhere never
        // brings it back. An id someone else holds is invisible here: the
        // insert does nothing and the read below finds nothing, which answers
        // exactly like an unknown id.
        const inserted = input.create
          ? await tx.execute<{ id: string }>(sql`
              insert into app.ai_conversations (id, workspace_id, actor_id, title, last_message_at)
              values (${input.conversationId}, ${scope.workspaceId}, ${scope.actorId}, ${withoutNul(input.title)}, now())
              on conflict (id) do nothing
              returning id
            `)
          : [];
        // Locked, so two turns of one conversation count its messages in turn.
        const [conversation] = await tx.execute<{ id: string }>(sql`
          select c.id from app.ai_conversations c
          where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
            and c.id = ${input.conversationId}
          for update
        `);
        if (!conversation) throw new TurnRefused('not_found');

        // Audit B7: a member keeps at most `maxConversationsPerActor` chats
        // on a site. Asked only when this message created one, which the
        // refusal then takes back with the rest of the transaction.
        if (inserted.length > 0) {
          const [kept] = await tx.execute<{ count: number }>(sql`
            select count(*)::int as count from app.ai_conversations c
            where c.workspace_id = ${scope.workspaceId} and c.actor_id = ${scope.actorId}
          `);
          if ((kept?.count ?? 0) > AI_CHAT_LIMITS.maxConversationsPerActor) {
            throw new TurnRefused('too_many_conversations');
          }
        }

        // The stored rows, plus one for each accepted question whose answer is
        // not written yet: its slot is reserved, so turns that overlap cannot
        // together pass the cap and push the newest rows out of the 200 a
        // read returns.
        const [count] = await tx.execute<{ count: number }>(sql`
          select (
            count(*) + count(*) filter (
              where m.role = 'user' and m.request_id is not null
                and not exists (
                  select 1 from app.ai_messages a
                  where a.workspace_id = m.workspace_id and a.conversation_id = m.conversation_id
                    and a.request_id = m.request_id and a.role = 'assistant'
                )
            )
          )::int as count
          from app.ai_messages m
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
            (workspace_id, conversation_id, actor_id, role, text, outcome, request_id${
              input.effort === undefined ? sql`` : sql`, effort`
            })
          values (${scope.workspaceId}, ${input.conversationId}, ${scope.actorId}, 'user',
            ${storedText(input.text)}, 'completed', ${input.requestId}${
              input.effort === undefined ? sql`` : sql`, ${input.effort}`
            })
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
      // Whole completed turns only, each question paired with ITS answer by
      // the request id both rows carry (two tabs can interleave a
      // conversation's rows in time). A stopped, failed or access-lost answer
      // is dropped with its question, so the model sees question, answer,
      // question, answer. The join uses the partial unique index on
      // (workspace_id, conversation_id, request_id, role).
      //
      // Audit B2: a turn whose answer links a lead that is now restricted, or
      // no longer exists, is never replayed, whether or not the erasure has
      // emptied it yet (it runs in the restriction's own transaction once
      // 0039 is applied; this check needs no migration). An emptied turn has
      // no text and is skipped below as well.
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select q.id, q.text as question, a.text as answer, a.follow_up as "followUp",
          a.sources
        from app.ai_messages q
        join app.ai_messages a
          on a.workspace_id = q.workspace_id
         and a.conversation_id = q.conversation_id
         and a.request_id = q.request_id
         and a.role = 'assistant'
         and a.actor_id = ${scope.actorId}
         and a.outcome = 'completed'
         and not exists (
           select 1
           from jsonb_array_elements(
             case when jsonb_typeof(a.sources) = 'array' then a.sources else '[]'::jsonb end
           ) s
           cross join lateral (
             select coalesce(
               substring(s->>'id' from ${LEAD_CARD_ID}),
               substring(s->>'href' from ${LEAD_CARD_HREF})
             ) as lead_id
           ) card
           where jsonb_typeof(s) = 'object'
             and card.lead_id is not null
             and not exists (
               select 1 from app.leads l
               where l.workspace_id = q.workspace_id and l.id = card.lead_id::uuid
                 and l.customer_data_restricted_at is null
             )
         )
        where q.workspace_id = ${scope.workspaceId} and q.actor_id = ${scope.actorId}
          and q.conversation_id = ${input.conversationId}
          and q.role = 'user' and q.request_id is not null
          -- Strictly before the anchor question's saved position, by the same
          -- order the rows are read in: a question another tab saved after it
          -- is not history of this turn.
          and (q.created_at, q.id) < (
            select b.created_at, b.id from app.ai_messages b
            where b.workspace_id = ${scope.workspaceId} and b.actor_id = ${scope.actorId}
              and b.conversation_id = ${input.conversationId} and b.id = ${input.beforeMessageId}
          )
        order by q.created_at desc, q.id desc
        limit ${AI_HISTORY_SCAN_MESSAGES}
      `);
      const turns: {
        question: Record<string, unknown>;
        answer: string;
        choices?: readonly string[];
        leadIds: readonly string[];
      }[] = [];
      for (const row of [...rows].reverse()) {
        // The text a browser would have replayed (and the server signed).
        const followUp = storedFollowUp(row['followUp']);
        const answer = aiAssistantHistoryText({ text: String(row['answer']), followUp });
        const question = String(row['question']);
        // As the browser's history does: a side without text (an answer that
        // was only a card) is no turn to replay; a provider may refuse it.
        if (answer.trim().length === 0 || question.trim().length === 0) continue;
        turns.push({
          question: { id: row['id'], text: question },
          answer,
          ...(followUp ? { choices: followUp.choices } : {}),
          leadIds: sourceLeadIds(row['sources']),
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
        kept.unshift({ ...turn, question: { ...turn.question, text: question } });
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
        {
          role: 'assistant',
          text: turn.answer,
          attachments: [],
          ...(turn.choices ? { followUpChoices: turn.choices } : {}),
          ...(turn.leadIds.length > 0 ? { leadIds: turn.leadIds } : {}),
        },
      ]);
    });
  }

  async appendAnswer(scope: TenantContext, input: AppendAiAnswerInput): Promise<void> {
    await this.database.withTenantTx(scope, async (tx) => {
      await tx.execute(sql`
        insert into app.ai_messages
          (id, workspace_id, conversation_id, actor_id, role, text, outcome, error_code,
           sources, follow_up, expired_drafts, request_id${
             input.effort === undefined ? sql`` : sql`, effort`
           })
        values (${input.messageId}, ${scope.workspaceId}, ${input.conversationId},
          ${scope.actorId}, 'assistant',
          ${storedText(input.text)},
          ${input.outcome}, ${input.errorCode ?? null},
          ${storedJson(input.sources)}::jsonb,
          ${input.followUp === undefined ? null : storedJson(input.followUp)}::jsonb,
          ${Math.min(100, Math.max(0, input.expiredDrafts))}, ${input.requestId}${
            input.effort === undefined ? sql`` : sql`, ${input.effort}`
          })
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

/** The stored objects of every file of a conversation. */
async function objectsOf(
  tx: Tx,
  scope: TenantContext,
  conversationId: string,
): Promise<{ bucket: string; objectKey: string }[]> {
  const files = await tx.execute<{ bucket: string; objectKey: string }>(sql`
    select a.bucket, a.object_key as "objectKey"
    from app.ai_attachments a
    where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
      and a.conversation_id = ${conversationId}
  `);
  return files.map((file) => ({ bucket: file.bucket, objectKey: file.objectKey }));
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
