import { sql, type SQL } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';
import {
  aiAttachmentKindSchema,
  aiAttachmentMediaTypeSchema,
  type AiAttachmentKind,
  type AiAttachmentMediaType,
} from '@gt-sales/contracts';

/**
 * The rows of the files members attach to Ask AI messages (`app.ai_attachments`).
 *
 * Like the conversation store, every statement runs as the member inside
 * `withTenantTx` (the owner policy) and names `workspace_id` and `actor_id`
 * itself. The one exception is the sweep, which a machine actor runs for a
 * whole site through the 0036 function, since the owner policy shows a
 * machine actor no member's row.
 */

export interface AiAttachmentRecord {
  readonly id: string;
  readonly kind: AiAttachmentKind;
  readonly mediaType: AiAttachmentMediaType;
  readonly fileName: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly bucket: string;
  readonly objectKey: string;
  readonly status: 'pending' | 'ready';
  /** Set once the message that carries it is stored; then the file can no longer be removed alone. */
  readonly messageId: string | null;
  /** Its message was emptied by a customer's erasure: never linked again, deleted by the cleanup. */
  readonly erased?: boolean;
}

export interface CreatePendingAttachmentInput {
  readonly id: string;
  readonly kind: AiAttachmentKind;
  readonly mediaType: AiAttachmentMediaType;
  readonly fileName: string;
  readonly byteSize: number;
  readonly bucket: string;
  readonly objectKey: string;
}

export interface MarkAttachmentReadyInput {
  /** This finalize's own verified copy, recorded only if the row is still pending. */
  readonly objectKey: string;
  readonly mediaType: AiAttachmentMediaType;
  readonly byteSize: number;
  readonly sha256: string;
  readonly extractedText: string | null;
}

export interface StoredObject {
  readonly bucket: string;
  readonly objectKey: string;
}

export interface AiAttachmentStore {
  createPending(scope: TenantContext, input: CreatePendingAttachmentInput): Promise<void>;
  get(scope: TenantContext, attachmentId: string): Promise<AiAttachmentRecord | undefined>;
  /**
   * Pending → ready with this attempt's verified object, a compare-and-set on
   * `status = 'pending'`: undefined when another finalize won (or the row is
   * gone), and the caller then deletes its own copy.
   */
  markReady(
    scope: TenantContext,
    attachmentId: string,
    input: MarkAttachmentReadyInput,
  ): Promise<AiAttachmentRecord | undefined>;
  /**
   * The first step of the member's delete of an unsent file: back to
   * `pending` (no longer sendable, as a turn links only `ready` files), and
   * its object, for the caller to delete BEFORE the row. `sent` once a
   * message carries it; undefined when it is not this member's.
   */
  beginRemoval(
    scope: TenantContext,
    attachmentId: string,
  ): Promise<StoredObject | 'sent' | undefined>;
  /** Removes an unsent row; with `pendingOnly`, only one no finalize has made ready. */
  removeUnsent(
    scope: TenantContext,
    attachmentId: string,
    options?: { pendingOnly?: boolean },
  ): Promise<StoredObject | undefined>;
  /** The machine sweep: unsent rows of the whole site created before `before`, at most `limit`. */
  sweepUnsent(
    scope: TenantContext,
    input: { before: Date; limit: number },
  ): Promise<StoredObject[]>;
  /**
   * The machine cleanup (0039): files of turns emptied by a customer's
   * erasure, every member's, for the caller to delete their objects first.
   */
  erasedFiles(scope: TenantContext, input: { limit: number }): Promise<ErasedFile[]>;
  /** Removes the listed rows that still belong to an erased turn; returns how many. */
  deleteErasedFiles(scope: TenantContext, ids: readonly string[]): Promise<number>;
  /**
   * The machine cleanup (0039): conversations of someone with no active
   * membership on the site since before `before`, with their files' objects.
   */
  departedConversations(
    scope: TenantContext,
    input: { before: Date; limit: number },
  ): Promise<DepartedConversation[]>;
  /** Deletes the listed conversations that are still departed by the same rule; returns how many. */
  deleteDepartedConversations(
    scope: TenantContext,
    input: { before: Date; ids: readonly string[] },
  ): Promise<number>;
}

export interface ErasedFile extends StoredObject {
  readonly id: string;
}

export interface DepartedConversation {
  readonly id: string;
  readonly objects: readonly StoredObject[];
}

/** Unsent files are swept a day after they were created. */
export const AI_ATTACHMENT_UNSENT_TTL_MS = 24 * 60 * 60_000;

/** Rows one sweep call removes for one site at most (the function's own cap is 1000). */
export const AI_ATTACHMENT_SWEEP_BATCH = 200;

/**
 * How long the conversations of someone who left a site are kept (audit C13):
 * deleted, files first, once they have had no active membership on the site
 * for this many days (and the conversation is at least as old). Added back
 * within the period, the member finds their chats as they left them. Nobody
 * can open a departed member's chats in the meantime: they are private to
 * that member, and every route asks for a live membership.
 */
export const AI_DEPARTED_MEMBER_CHAT_DAYS = 30;

/** Conversations one departed-member cleanup call lists for one site at most (the function's cap is 1000). */
export const AI_DEPARTED_SWEEP_BATCH = 100;

function toRecord(row: Record<string, unknown>): AiAttachmentRecord {
  const status = row['status'];
  if (status !== 'pending' && status !== 'ready') throw new Error('attachment row status');
  return {
    id: String(row['id']),
    kind: aiAttachmentKindSchema.parse(row['kind']),
    mediaType: aiAttachmentMediaTypeSchema.parse(row['mediaType']),
    fileName: String(row['fileName']),
    byteSize: Number(row['byteSize']),
    sha256: typeof row['sha256'] === 'string' ? row['sha256'] : null,
    bucket: String(row['bucket']),
    objectKey: String(row['objectKey']),
    status,
    messageId: typeof row['messageId'] === 'string' ? row['messageId'] : null,
  };
}

const COLUMNS = sql`
  a.id, a.kind, a.media_type as "mediaType", a.file_name as "fileName",
  a.byte_size as "byteSize", a.sha256, a.bucket, a.object_key as "objectKey", a.status,
  a.message_id as "messageId"
`;

export class DatabaseAiAttachmentStore implements AiAttachmentStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  async createPending(scope: TenantContext, input: CreatePendingAttachmentInput): Promise<void> {
    await this.database.withTenantTx(scope, (tx) =>
      tx.execute(sql`
        insert into app.ai_attachments
          (id, workspace_id, actor_id, kind, media_type, file_name, byte_size, bucket, object_key)
        values (${input.id}, ${scope.workspaceId}, ${scope.actorId}, ${input.kind},
          ${input.mediaType}, ${input.fileName}, ${input.byteSize}, ${input.bucket},
          ${input.objectKey})
      `),
    );
  }

  get(scope: TenantContext, attachmentId: string): Promise<AiAttachmentRecord | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      // `erased`: its message was emptied by a customer's erasure (0039's
      // column, read through the row so this runs before it exists).
      const [row] = await tx.execute<Record<string, unknown>>(sql`
        select ${COLUMNS},
          exists (
            select 1 from app.ai_messages m
            where m.workspace_id = a.workspace_id and m.conversation_id = a.conversation_id
              and m.id = a.message_id and (to_jsonb(m)->>'erased_at') is not null
          ) as erased
        from app.ai_attachments a
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.id = ${attachmentId}
      `);
      if (!row) return undefined;
      const record = toRecord(row);
      return row['erased'] === true ? { ...record, erased: true } : record;
    });
  }

  markReady(
    scope: TenantContext,
    attachmentId: string,
    input: MarkAttachmentReadyInput,
  ): Promise<AiAttachmentRecord | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx.execute<Record<string, unknown>>(sql`
        update app.ai_attachments a
        set status = 'ready', object_key = ${input.objectKey}, media_type = ${input.mediaType},
          byte_size = ${input.byteSize}, sha256 = ${input.sha256},
          extracted_text = ${input.extractedText}
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.id = ${attachmentId} and a.status = 'pending' and a.message_id is null
        returning ${COLUMNS}
      `);
      return row ? toRecord(row) : undefined;
    });
  }

  beginRemoval(
    scope: TenantContext,
    attachmentId: string,
  ): Promise<StoredObject | 'sent' | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      // Locked like a turn's link, so the two are decided one after the other.
      const [row] = await tx.execute<{ messageId: string | null }>(sql`
        select a.message_id as "messageId" from app.ai_attachments a
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.id = ${attachmentId}
        for update
      `);
      if (!row) return undefined;
      if (row.messageId !== null) return 'sent';
      const [demoted] = await tx.execute<{ bucket: string; objectKey: string }>(sql`
        update app.ai_attachments a set status = 'pending', extracted_text = null
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.id = ${attachmentId} and a.message_id is null
        returning a.bucket, a.object_key as "objectKey"
      `);
      return demoted ? { bucket: demoted.bucket, objectKey: demoted.objectKey } : undefined;
    });
  }

  removeUnsent(
    scope: TenantContext,
    attachmentId: string,
    options: { pendingOnly?: boolean } = {},
  ): Promise<StoredObject | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx.execute<{ bucket: string; objectKey: string }>(sql`
        delete from app.ai_attachments a
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.id = ${attachmentId} and a.message_id is null
          ${options.pendingOnly ? sql`and a.status = 'pending'` : sql``}
        returning a.bucket, a.object_key as "objectKey"
      `);
      return row ? { bucket: row.bucket, objectKey: row.objectKey } : undefined;
    });
  }

  sweepUnsent(
    scope: TenantContext,
    input: { before: Date; limit: number },
  ): Promise<StoredObject[]> {
    return this.database.withTenantTx(scope, async (tx) => {
      const rows = await tx.execute<{ bucket: string; objectKey: string }>(sql`
        select s.bucket, s.object_key as "objectKey"
        from app.sweep_unsent_ai_attachments(${scope.workspaceId}::uuid,
          ${input.before.toISOString()}::timestamptz, ${input.limit}::integer) s
      `);
      return rows.map((row) => ({ bucket: row.bucket, objectKey: row.objectKey }));
    });
  }

  erasedFiles(scope: TenantContext, input: { limit: number }): Promise<ErasedFile[]> {
    return this.database.withTenantTx(scope, async (tx) => {
      const rows = await tx.execute<{ id: string; bucket: string; objectKey: string }>(sql`
        select e.id, e.bucket, e.object_key as "objectKey"
        from app.erased_ai_attachments(${scope.workspaceId}::uuid, ${input.limit}::integer) e
      `);
      return rows.map((row) => ({
        id: String(row.id),
        bucket: row.bucket,
        objectKey: row.objectKey,
      }));
    });
  }

  async deleteErasedFiles(scope: TenantContext, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx.execute<{ count: number }>(sql`
        select app.delete_erased_ai_attachments(${scope.workspaceId}::uuid, ${uuidArray(ids)}) as count
      `);
      return Number(row?.count ?? 0);
    });
  }

  departedConversations(
    scope: TenantContext,
    input: { before: Date; limit: number },
  ): Promise<DepartedConversation[]> {
    return this.database.withTenantTx(scope, async (tx) => {
      const rows = await tx.execute<{
        conversationId: string;
        bucket: string | null;
        objectKey: string | null;
      }>(sql`
        select d.conversation_id as "conversationId", d.bucket, d.object_key as "objectKey"
        from app.departed_ai_conversations(${scope.workspaceId}::uuid,
          ${input.before.toISOString()}::timestamptz, ${input.limit}::integer) d
      `);
      const byId = new Map<string, StoredObject[]>();
      for (const row of rows) {
        const objects = byId.get(String(row.conversationId)) ?? [];
        if (row.bucket !== null && row.objectKey !== null) {
          objects.push({ bucket: row.bucket, objectKey: row.objectKey });
        }
        byId.set(String(row.conversationId), objects);
      }
      return [...byId].map(([id, objects]) => ({ id, objects }));
    });
  }

  async deleteDepartedConversations(
    scope: TenantContext,
    input: { before: Date; ids: readonly string[] },
  ): Promise<number> {
    if (input.ids.length === 0) return 0;
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx.execute<{ count: number }>(sql`
        select app.delete_departed_ai_conversations(${scope.workspaceId}::uuid,
          ${input.before.toISOString()}::timestamptz, ${uuidArray(input.ids)}) as count
      `);
      return Number(row?.count ?? 0);
    });
  }
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}
