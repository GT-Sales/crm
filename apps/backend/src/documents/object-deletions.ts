import { sql, type SQL } from 'drizzle-orm';
import { fileObjectDeletions, withTenantTx, type TenantTransaction } from '@gt-sales/db';
import type { R2DocumentStore } from '@gt-sales/adapters';

/**
 * The durable record of document objects waiting to be deleted from storage
 * (#82, #108; table `app.file_object_deletions`, migration 0045).
 *
 * Every path that makes an object disposable writes its entry in its own
 * transaction: a file tombstoned (staff, a change request's rejection or
 * replacement, abandoned-draft erasure), a finalize's staging copy once the
 * verified candidate is attached, a rejected or expired upload. The
 * scheduler's `document_cleanup` sweep then deletes due entries in bounded
 * batches, outside any transaction, and marks an entry completed only once
 * storage answered that the object is gone (a 404 counts). A failure keeps
 * the entry with a backed-off `not_before`, so a storage outage or a restart
 * between commit and delete leaves recoverable work, and retrying a deletion
 * that already happened is a harmless no-op.
 *
 * **A referenced object is never deleted.** Before an entry is handed to
 * storage, in the claim's transaction, the sweep checks that no file of the
 * site still points at the key: as its served object (any status but
 * `deleted`), as the candidate of an upload being verified or attached, as
 * the staging object of an upload in progress, or as a kept revision of a
 * file not deleted. A referenced entry is completed `kept_referenced` and its
 * object stays. After the check no new reference can appear: staging and
 * candidate keys are fresh random tokens issued once (`keys.ts`), a file never
 * moves back from `available`, `rejected` or `deleted` to a state that points
 * at an older key, and the one deterministic key, an imported document's
 * (`importedObjectKey`), is refused by the import once it has an entry
 * (`isRetiredObjectKey`). Only the document keys this backend issues
 * (`staging/<site>/…`, `candidate/<site>/…`) are ever enqueued, so the sweep
 * cannot reach an Ask AI attachment or a website's own object.
 */

/** How long a "not applied yet" answer is kept before the catalogue is asked again. */
export const DELETION_RECORD_RECHECK_MS = 5 * 60_000;
let recordState: { ready: boolean; at: number } | undefined;

/**
 * Whether migration 0045's table exists. Migrations are applied by hand after
 * the deploy (docs/RUNBOOKS/database.md), so until then nothing is recorded
 * and the cleanup deletes an expired upload's objects once, as before. Like
 * `leads/task-schema.ts` it asks the catalogue and caches the answer: ready
 * stays ready, not ready is asked again after five minutes.
 */
export async function deletionRecordReady(
  tx: Pick<TenantTransaction, 'execute'>,
): Promise<boolean> {
  const now = Date.now();
  if (recordState && (recordState.ready || now - recordState.at < DELETION_RECORD_RECHECK_MS)) {
    return recordState.ready;
  }
  const [row] = await tx.execute<{ ready: boolean }>(
    sql`select to_regclass('app.file_object_deletions') is not null as ready`,
  );
  recordState = { ready: row?.ready === true, at: now };
  return recordState.ready;
}

export type ObjectDeletionReason =
  'staging_after_attach' | 'upload_rejected' | 'upload_expired' | 'file_deleted' | 'backfill';

export interface ObjectDeletionEntry {
  bucket: string;
  objectKey: string;
  fileId?: string | null;
  reason: ObjectDeletionReason;
  /** Not attempted before; a staging copy waits until its upload link has expired. */
  notBefore?: Date;
}

/** A staging copy is deleted only this long after its upload link expired, so no late PUT recreates it. */
export const STAGING_DELETE_MARGIN_MS = 5 * 60 * 1000;
/** Entries one sweep deletes per site, and leftovers one sweep enqueues per site. */
export const OBJECT_DELETION_BATCH = 100;
export const OBJECT_DELETION_BACKFILL_BATCH = 200;
/** An entry that has failed this often is "stuck": counted, and the owner is alerted. */
export const OBJECT_DELETION_STUCK_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** The wait after the `attempts`-th try: 5 minutes, doubling, at most a day. */
export function objectDeletionBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A key this backend issued for a document of this site (`keys.ts`); anything else is never deleted here. */
export function isDocumentObjectKey(workspaceId: string, key: string): boolean {
  const match = new RegExp(`^(?:staging|candidate)/(${UUID})/[A-Za-z0-9-]+$`, 'i').exec(key);
  return match?.[1]?.toLowerCase() === workspaceId.toLowerCase();
}

/** The keys of a file row worth deleting with it, without repeats. */
export function fileObjectKeys(row: {
  stagingKey: string | null;
  candidateKey: string | null;
  objectKey: string | null;
}): string[] {
  return [
    ...new Set(
      [row.stagingKey, row.candidateKey, row.objectKey].filter(
        (key): key is string => typeof key === 'string' && key !== '',
      ),
    ),
  ];
}

/**
 * Records objects to delete, in the caller's transaction. A repeat of an
 * object already waiting keeps one entry (the later `not_before` wins, so a
 * staging copy still waits out its link). An entry completed `kept_referenced`
 * is reopened: the file that still used the key then may be gone now. One
 * completed `deleted` stays as it is: its object is gone and its key retired.
 * Keys this backend did not issue are left out.
 */
export async function enqueueObjectDeletions(
  tx: TenantTransaction,
  workspaceId: string,
  entries: readonly ObjectDeletionEntry[],
  now: Date = new Date(),
): Promise<number> {
  const unique = new Map<string, ObjectDeletionEntry>();
  for (const entry of entries) {
    if (!isDocumentObjectKey(workspaceId, entry.objectKey)) continue;
    unique.set(`${entry.bucket}\u0000${entry.objectKey}`, entry);
  }
  if (unique.size === 0) return 0;
  if (!(await deletionRecordReady(tx))) return 0;
  await tx
    .insert(fileObjectDeletions)
    .values(
      [...unique.values()].map((entry) => ({
        workspaceId,
        bucket: entry.bucket,
        objectKey: entry.objectKey,
        fileId: entry.fileId ?? null,
        reason: entry.reason,
        notBefore: entry.notBefore ?? now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        fileObjectDeletions.workspaceId,
        fileObjectDeletions.bucket,
        fileObjectDeletions.objectKey,
      ],
      setWhere: sql`${fileObjectDeletions.outcome} is distinct from 'deleted'`,
      set: {
        reason: sql`excluded.reason`,
        notBefore: sql`greatest(excluded.not_before, ${fileObjectDeletions.notBefore})`,
        attempts: sql`case when ${fileObjectDeletions.completedAt} is null then ${fileObjectDeletions.attempts} else 0 end`,
        lastError: sql`case when ${fileObjectDeletions.completedAt} is null then ${fileObjectDeletions.lastError} else null end`,
        completedAt: null,
        outcome: null,
        updatedAt: now,
      },
    });
  return unique.size;
}

/**
 * Whether an object key has ever had a deletion entry: such a key is retired
 * and no new file may point at it (the guarantee the sweep's check rests on).
 */
export async function isRetiredObjectKey(
  tx: TenantTransaction,
  workspaceId: string,
  bucket: string,
  objectKey: string,
): Promise<boolean> {
  if (!(await deletionRecordReady(tx))) return false;
  const [row] = await tx.execute<{ retired: boolean }>(sql`
    select exists (
      select 1 from app.file_object_deletions d
      where d.workspace_id = ${workspaceId} and d.bucket = ${bucket} and d.object_key = ${objectKey}
    ) as retired
  `);
  return row?.retired === true;
}

export interface ClaimedObjectDeletion {
  id: string;
  bucket: string;
  objectKey: string;
  /** Tries so far, this one included. */
  attempts: number;
}

export interface ObjectDeletionQueue {
  /** Whether the record exists yet (migration 0045); without it the sweep falls back. */
  ready(input: { workspaceId: string; actorId: string }): Promise<boolean>;
  /**
   * Due entries, at most `limit`, claimed for one try: each is checked against
   * the site's live files (a referenced one is completed `kept_referenced` and
   * not returned), its attempts counted and its next try backed off, all in one
   * transaction that commits before storage is called. A crash after the claim
   * leaves the entry to the next sweep after its backoff.
   */
  claimDue(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
    limit: number;
  }): Promise<{ claimed: ClaimedObjectDeletion[]; keptReferenced: number }>;
  /** Storage answered the objects are gone. */
  markDeleted(input: {
    workspaceId: string;
    actorId: string;
    ids: readonly string[];
    now: Date;
  }): Promise<void>;
  /** One try failed; the entry stays for its next try. Codes only. */
  markFailed(input: {
    workspaceId: string;
    actorId: string;
    id: string;
    code: string;
    now: Date;
  }): Promise<void>;
  /**
   * The backfill: up to `limit` objects of earlier files that were never
   * enqueued (the staging copy of a finalized upload, every key of a file
   * already deleted, the keys of a rejected upload), enqueued now. Bounded per
   * run and resumable: an object with any entry, pending or completed, is
   * never picked again, so repeated runs work through the leftovers once.
   */
  enqueueLeftovers(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
    limit: number;
  }): Promise<number>;
  /** Entries still pending after `OBJECT_DELETION_STUCK_ATTEMPTS` tries. */
  countStuck(input: { workspaceId: string; actorId: string }): Promise<number>;
}

type QueueDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

/**
 * Whether any live file of the site points at `key` (see the module comment):
 * the condition, shared by the claim, under which an object is never deleted.
 */
function referencedSql(workspaceId: string, key: SQL): SQL {
  return sql`(
    exists (
      select 1 from app.files f
      where f.workspace_id = ${workspaceId}
        and (
          (f.object_key = ${key} and f.status <> 'deleted')
          or (f.candidate_key = ${key} and f.status in ('verifying', 'available'))
          or (f.staging_key = ${key} and f.status in ('uploading', 'verifying'))
        )
    )
    or exists (
      select 1 from app.file_revisions r
      join app.files f on f.workspace_id = r.workspace_id and f.id = r.file_id
      where r.workspace_id = ${workspaceId} and r.object_key = ${key} and f.status <> 'deleted'
    )
  )`;
}

export class DatabaseObjectDeletionQueue implements ObjectDeletionQueue {
  constructor(private readonly database: QueueDatabase = { withTenantTx }) {}

  ready(input: { workspaceId: string; actorId: string }): Promise<boolean> {
    return this.database.withTenantTx(input, (tx) => deletionRecordReady(tx));
  }

  claimDue(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
    limit: number;
  }): Promise<{ claimed: ClaimedObjectDeletion[]; keptReferenced: number }> {
    return this.database.withTenantTx(input, async (tx) => {
      const now = input.now.toISOString();
      const due = await tx.execute<{
        id: string;
        bucket: string;
        objectKey: string;
        attempts: number;
        referenced: boolean;
      }>(sql`
        select d.id, d.bucket, d.object_key as "objectKey", d.attempts,
          ${referencedSql(input.workspaceId, sql`d.object_key`)} as referenced
        from app.file_object_deletions d
        where d.workspace_id = ${input.workspaceId} and d.completed_at is null
          and d.not_before <= ${now}::timestamptz
        order by d.not_before, d.id
        limit ${input.limit}
        for update of d skip locked
      `);
      const kept = due.filter((row) => row.referenced).map((row) => row.id);
      if (kept.length > 0) {
        await tx.execute(sql`
          update app.file_object_deletions
          set completed_at = ${now}::timestamptz, outcome = 'kept_referenced', updated_at = ${now}::timestamptz
          where workspace_id = ${input.workspaceId} and id = any(${`{${kept.join(',')}}`}::uuid[])
        `);
      }
      const claimed: ClaimedObjectDeletion[] = [];
      for (const row of due) {
        if (row.referenced) continue;
        const attempts = Number(row.attempts) + 1;
        const next = new Date(input.now.getTime() + objectDeletionBackoffMs(attempts));
        await tx.execute(sql`
          update app.file_object_deletions
          set attempts = ${attempts}, not_before = ${next.toISOString()}::timestamptz,
            updated_at = ${now}::timestamptz
          where workspace_id = ${input.workspaceId} and id = ${row.id}
        `);
        claimed.push({ id: row.id, bucket: row.bucket, objectKey: row.objectKey, attempts });
      }
      return { claimed, keptReferenced: kept.length };
    });
  }

  async markDeleted(input: {
    workspaceId: string;
    actorId: string;
    ids: readonly string[];
    now: Date;
  }): Promise<void> {
    if (input.ids.length === 0) return;
    await this.database.withTenantTx(input, async (tx) => {
      const now = input.now.toISOString();
      // Only a still-pending entry: one reopened meanwhile by a new tombstone is
      // reopened for a reason, and its next try deletes again (a no-op if gone).
      await tx.execute(sql`
        update app.file_object_deletions
        set completed_at = ${now}::timestamptz, outcome = 'deleted', last_error = null,
          updated_at = ${now}::timestamptz
        where workspace_id = ${input.workspaceId}
          and id = any(${`{${input.ids.join(',')}}`}::uuid[]) and completed_at is null
      `);
    });
  }

  async markFailed(input: {
    workspaceId: string;
    actorId: string;
    id: string;
    code: string;
    now: Date;
  }): Promise<void> {
    await this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`
        update app.file_object_deletions
        set last_error = ${input.code}, updated_at = ${input.now.toISOString()}::timestamptz
        where workspace_id = ${input.workspaceId} and id = ${input.id} and completed_at is null
      `);
    });
  }

  enqueueLeftovers(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
    limit: number;
  }): Promise<number> {
    return this.database.withTenantTx(input, async (tx) => {
      // Candidate keys of earlier files, oldest first, each object once: the
      // staging copy of a finalized upload (never its served object, which an
      // import shares), and every key of a rejected or deleted file. The
      // sweep's own check still guards each one before anything is deleted.
      const rows = await tx.execute<{
        fileId: string;
        bucket: string;
        key: string;
        expiresAt: string | Date;
      }>(sql`
        select k.file_id as "fileId", k.bucket, k.key, k.expires_at as "expiresAt"
        from (
          select f.id as file_id, f.bucket, f.staging_key as key, f.created_at, f.expires_at
          from app.files f
          where f.workspace_id = ${input.workspaceId} and f.status = 'available'
            and f.staging_key is distinct from f.object_key
          union all
          select f.id, f.bucket, unnest(array[f.staging_key, f.candidate_key, f.object_key]),
            f.created_at, f.expires_at
          from app.files f
          where f.workspace_id = ${input.workspaceId} and f.status in ('rejected', 'deleted')
        ) k
        where k.key is not null
          and k.key ~ ${`^(staging|candidate)/${input.workspaceId}/[A-Za-z0-9-]+$`}
          and not exists (
            select 1 from app.file_object_deletions d
            where d.workspace_id = ${input.workspaceId} and d.bucket = k.bucket and d.object_key = k.key
          )
        order by k.created_at, k.file_id
        limit ${input.limit}
      `);
      if (rows.length === 0) return 0;
      // Do nothing on a conflict: a key a live path enqueued meanwhile keeps its entry.
      const values = rows.map((row) => ({
        workspaceId: input.workspaceId,
        bucket: row.bucket,
        objectKey: row.key,
        fileId: row.fileId,
        reason: 'backfill' as const,
        // A staging copy still waits out its upload link, as on the live path.
        notBefore: new Date(
          Math.max(
            input.now.getTime(),
            new Date(row.expiresAt).getTime() + STAGING_DELETE_MARGIN_MS,
          ),
        ),
        createdAt: input.now,
        updatedAt: input.now,
      }));
      const inserted = await tx
        .insert(fileObjectDeletions)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: fileObjectDeletions.id });
      return inserted.length;
    });
  }

  countStuck(input: { workspaceId: string; actorId: string }): Promise<number> {
    return this.database.withTenantTx(input, async (tx) => {
      const [row] = await tx.execute<{ stuck: number }>(sql`
        select count(*)::int as stuck from app.file_object_deletions
        where workspace_id = ${input.workspaceId} and completed_at is null
          and attempts >= ${OBJECT_DELETION_STUCK_ATTEMPTS}
      `);
      return Number(row?.stuck ?? 0);
    });
  }
}

export interface ObjectDeletionSweepResult {
  /** Older leftovers enqueued by this run's backfill batch. */
  backfilled: number;
  deleted: number;
  failed: number;
  keptReferenced: number;
  /** Entries still pending after many tries, for the alert. */
  stuck: number;
}

/** A storage failure's code: an error's name when it is a plain code, else a fixed word. Never its message. */
function failureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)) return error.message;
  if (error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)) return error.name;
  return 'unknown';
}

/**
 * One site's pass: a backfill batch, then the due entries in batches until a
 * batch comes back short or `maxBatches` are done. Storage calls run between
 * the claim and the completion, never inside a transaction. A failure is
 * logged by site, count and code only (no key), and the entry waits for its
 * next try.
 */
export async function sweepObjectDeletions(input: {
  queue: ObjectDeletionQueue;
  objects: Pick<R2DocumentStore, 'deleteObject'>;
  workspaceId: string;
  actorId: string;
  now: Date;
  batchSize?: number;
  maxBatches?: number;
  backfillBatch?: number;
}): Promise<ObjectDeletionSweepResult> {
  const scope = { workspaceId: input.workspaceId, actorId: input.actorId };
  const batchSize = input.batchSize ?? OBJECT_DELETION_BATCH;
  const maxBatches = input.maxBatches ?? 5;
  const backfilled = await input.queue.enqueueLeftovers({
    ...scope,
    now: input.now,
    limit: input.backfillBatch ?? OBJECT_DELETION_BACKFILL_BATCH,
  });
  const result = { backfilled, deleted: 0, failed: 0, keptReferenced: 0, stuck: 0 };
  const codes = new Map<string, number>();
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { claimed, keptReferenced } = await input.queue.claimDue({
      ...scope,
      now: input.now,
      limit: batchSize,
    });
    result.keptReferenced += keptReferenced;
    const done: string[] = [];
    for (const entry of claimed) {
      try {
        await input.objects.deleteObject({
          workspaceId: input.workspaceId,
          bucket: entry.bucket,
          objectKey: entry.objectKey,
        });
        done.push(entry.id);
      } catch (error) {
        const code = failureCode(error);
        codes.set(code, (codes.get(code) ?? 0) + 1);
        result.failed += 1;
        await input.queue.markFailed({ ...scope, id: entry.id, code, now: input.now });
      }
    }
    await input.queue.markDeleted({ ...scope, ids: done, now: input.now });
    result.deleted += done.length;
    if (claimed.length + keptReferenced < batchSize) break;
  }
  for (const [code, count] of codes) {
    console.warn(
      JSON.stringify({
        event: 'document_object_delete_failed',
        workspaceId: input.workspaceId,
        code,
        count,
      }),
    );
  }
  result.stuck = await input.queue.countStuck(scope);
  return result;
}
