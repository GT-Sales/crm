import { sql } from 'drizzle-orm';
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
}

/** Unsent files are swept a day after they were created. */
export const AI_ATTACHMENT_UNSENT_TTL_MS = 24 * 60 * 60_000;

/** Rows one sweep call removes for one site at most (the function's own cap is 1000). */
export const AI_ATTACHMENT_SWEEP_BATCH = 200;

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
      const [row] = await tx.execute<Record<string, unknown>>(sql`
        select ${COLUMNS} from app.ai_attachments a
        where a.workspace_id = ${scope.workspaceId} and a.actor_id = ${scope.actorId}
          and a.id = ${attachmentId}
      `);
      return row ? toRecord(row) : undefined;
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
}
