import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';

/**
 * Whether the database takes a **plain task** (a task with no lead): migration
 * 0038 makes `app.lead_tasks.lead_id` nullable.
 *
 * Migrations are applied by hand, after the deploy (docs/RUNBOOKS/database.md),
 * so this backend may run against a database where the column is still
 * `NOT NULL`. Until then the plain-task route answers
 * `503 plain_tasks_unavailable`, Ask AI's task tool asks for a lead as it did
 * before, and every other task read and write works unchanged. Like
 * `ai/chat-schema.ts` this asks the catalogue, never the migration journal
 * (which the runtime role cannot read), and caches the answer the same way: a
 * ready schema stays ready (migrations are never rolled back), a missing one is
 * asked again after `recheckMs`.
 */
export interface PlainTaskSchemaProbe {
  /** True once `lead_id` takes null; asked inside the caller's own transaction. */
  ready(tx: Pick<TenantTransaction, 'execute'>): Promise<boolean>;
  /** True when a ready answer is already cached, so a caller can skip opening a transaction. */
  knownReady?(): boolean;
}

/** How long a not-yet-ready answer is kept before the catalogue is asked again. */
export const PLAIN_TASK_SCHEMA_RECHECK_MS = 5 * 60_000;

export class DatabasePlainTaskSchemaProbe implements PlainTaskSchemaProbe {
  private cached: { ready: boolean; at: number } | undefined;

  constructor(private readonly options: { recheckMs?: number; now?: () => number } = {}) {}

  knownReady(): boolean {
    return this.cached?.ready === true;
  }

  async ready(tx: Pick<TenantTransaction, 'execute'>): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cached;
    if (
      cached &&
      (cached.ready || now - cached.at < (this.options.recheckMs ?? PLAIN_TASK_SCHEMA_RECHECK_MS))
    )
      return cached.ready;
    const [row] = await tx.execute<{ ready: boolean }>(sql`
      select exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = to_regclass('app.lead_tasks')
          and a.attname = 'lead_id' and not a.attisdropped and not a.attnotnull
      ) as ready
    `);
    const ready = row?.ready === true;
    this.cached = { ready, at: (this.options.now ?? Date.now)() };
    return ready;
  }
}

/** A fixed answer, for tests and wiring that already know the schema. */
export function fixedPlainTaskSchema(ready = true): PlainTaskSchemaProbe {
  return { ready: async () => ready };
}

/** A database that still has `lead_id NOT NULL` refused the insert (SQLSTATE 23502). */
export function isNotNullViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === '23502') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
