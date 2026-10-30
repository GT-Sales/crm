import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys, type TenantTransaction } from '@gt-sales/db';

/**
 * How long a website submission's key replays its first outcome, measured from
 * the key row's `created_at`. Far longer than any client retry (seconds to
 * minutes); a key reused after it is claimed afresh for a new submission.
 */
export const IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The one scope website lead submission keys live in (`idempotency_keys_scope_check`). */
const LEAD_SUBMISSION_SCOPE = 'lead_submission';

type CanonicalJson =
  null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

/** JSON with object keys sorted at every depth and `undefined` members dropped. */
function canonicalize(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_request_fingerprint');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const result: { [key: string]: CanonicalJson } = {};
    for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (child !== undefined) result[key] = canonicalize(child);
    }
    return result;
  }
  throw new Error('invalid_request_fingerprint');
}

/** `sha256:<hex>` over the canonical JSON of a request body: key order never matters. */
export function requestFingerprint(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The only form an idempotency key is stored or compared in; the raw key is never kept. */
export function idempotencyKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export interface IdempotencyInput {
  keyHash: string;
  fingerprint: string;
}

/**
 * `claimed`: this request owns the key (`id` is its row) and must complete it in
 * the same transaction; `replay`: the key already produced `leadId` with the
 * same body; `conflict`: the key was used with another body; `in_progress`: a
 * committed claim was never completed.
 */
export type IdempotencyClaim =
  | { kind: 'claimed'; id: string }
  | { kind: 'replay'; leadId: string }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

/** Why a keyed website create was refused; thrown so its transaction writes nothing. */
export class IdempotencyError extends Error {
  constructor(readonly code: 'idempotency_conflict' | 'idempotency_in_progress') {
    super(`lead submission refused: ${code}`);
    this.name = 'IdempotencyError';
  }
}

const keyRow = (workspaceId: string, keyHash: string) =>
  and(
    eq(idempotencyKeys.workspaceId, workspaceId),
    eq(idempotencyKeys.scope, LEAD_SUBMISSION_SCOPE),
    eq(idempotencyKeys.keyHash, keyHash),
  );

/**
 * Claims a lead submission key inside the lead's own transaction. A concurrent
 * request with the same key blocks on the unique `(workspace_id, scope,
 * key_hash)` index until the first commits (or rolls back, when this insert
 * wins instead), then reads the committed row under a lock.
 */
export async function claimIdempotencyKey(
  tx: TenantTransaction,
  input: IdempotencyInput & { workspaceId: string; now: Date },
): Promise<IdempotencyClaim> {
  const [inserted] = await tx
    .insert(idempotencyKeys)
    .values({
      workspaceId: input.workspaceId,
      scope: LEAD_SUBMISSION_SCOPE,
      keyHash: input.keyHash,
      requestFingerprint: input.fingerprint,
      createdAt: input.now,
    })
    .onConflictDoNothing({
      target: [idempotencyKeys.workspaceId, idempotencyKeys.scope, idempotencyKeys.keyHash],
    })
    .returning({ id: idempotencyKeys.id });
  if (inserted) return { kind: 'claimed', id: inserted.id };

  const [row] = await tx
    .select()
    .from(idempotencyKeys)
    .where(keyRow(input.workspaceId, input.keyHash))
    .limit(1)
    .for('update');
  if (!row) throw new Error('idempotency_claim_missing');

  if (input.now.getTime() - row.createdAt.getTime() > IDEMPOTENCY_REPLAY_WINDOW_MS) {
    // Past the window the key starts over, in place, for this request.
    await tx
      .update(idempotencyKeys)
      .set({
        requestFingerprint: input.fingerprint,
        status: 'pending',
        leadId: null,
        completedAt: null,
        createdAt: input.now,
      })
      .where(
        and(eq(idempotencyKeys.workspaceId, input.workspaceId), eq(idempotencyKeys.id, row.id)),
      );
    return { kind: 'claimed', id: row.id };
  }
  if (row.requestFingerprint !== input.fingerprint) return { kind: 'conflict' };
  if (row.status === 'completed' && row.leadId !== null) {
    return { kind: 'replay', leadId: row.leadId };
  }
  return { kind: 'in_progress' };
}

/** Records the lead a claimed key produced; run after the lead is written, in its transaction. */
export async function completeIdempotencyKey(
  tx: TenantTransaction,
  input: { workspaceId: string; id: string; leadId: string; now: Date },
): Promise<void> {
  const [row] = await tx
    .update(idempotencyKeys)
    .set({ status: 'completed', leadId: input.leadId, completedAt: input.now })
    .where(
      and(
        eq(idempotencyKeys.workspaceId, input.workspaceId),
        eq(idempotencyKeys.id, input.id),
        eq(idempotencyKeys.status, 'pending'),
      ),
    )
    .returning({ id: idempotencyKeys.id });
  if (!row) throw new Error('idempotency_claim_missing');
}
