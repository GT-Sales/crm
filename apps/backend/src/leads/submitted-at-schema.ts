import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';

/**
 * Whether the database has `app.leads.submitted_at` (migration 0046, issue
 * #94). The migration must be applied before the deploy, because creating a
 * lead inserts every column (docs/RUNBOOKS/database.md); this probe keeps the
 * reads and the stamp working against a database that lacks the column, as
 * the tests' older schemas do: a submission then stamps nothing and order
 * tracking dates every order by its creation. Like
 * `task-schema.ts` it asks the catalogue and caches the answer: present stays
 * present (migrations are never rolled back), absent is asked again after
 * five minutes.
 */
export const SUBMITTED_AT_RECHECK_MS = 5 * 60_000;
let state: { ready: boolean; at: number } | undefined;

export async function submittedAtReady(tx: Pick<TenantTransaction, 'execute'>): Promise<boolean> {
  const now = Date.now();
  if (state && (state.ready || now - state.at < SUBMITTED_AT_RECHECK_MS)) return state.ready;
  const [row] = await tx.execute<{ ready: boolean }>(sql`
    select exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass('app.leads') and a.attname = 'submitted_at'
        and not a.attisdropped
    ) as ready
  `);
  state = { ready: row?.ready === true, at: now };
  return state.ready;
}
