import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';

/**
 * Whether the database has `app.leads.submitted_at` (migration 0046, issue
 * #94). Migrations are applied by hand after the deploy
 * (docs/RUNBOOKS/database.md), so until then a submission stamps nothing and
 * order tracking dates every order by its creation, as before. Like
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

/** Test seam: forget the cached answer. */
export function resetSubmittedAtProbeForTests(): void {
  state = undefined;
}
