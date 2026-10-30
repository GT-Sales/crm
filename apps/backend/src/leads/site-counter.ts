import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import { z } from 'zod';

/**
 * A site's running numbers (`app.site_counters`). `sim_order_ref` numbers new
 * SIM orders `MS-<n>` (`simOrderRef`); `change_request_no` numbers customer
 * change requests (ruling T5). Must match the table's counter check in
 * `packages/db/src/schema.ts`.
 */
export type SiteCounter = 'sim_order_ref' | 'change_request_no';

const issuedSchema = z.array(z.object({ last_value: z.number().int().min(1) })).length(1);

/**
 * Where an unseeded counter starts: after the site's highest `MS-<n>` among
 * its SIM orders, or after the highest `requestNo` the import wrote on its
 * timeline (`change_requested` system entries), so the first new number
 * follows the imported ones.
 */
function firstValue(workspaceId: string, counter: SiteCounter) {
  switch (counter) {
    case 'sim_order_ref':
      return sql`(
        select coalesce(max((substring(l.external_ref from '^MS-([0-9]{1,9})$'))::int), 0) + 1
        from app.leads l where l.workspace_id = ${workspaceId} and l.lead_type = 'sim_order')`;
    case 'change_request_no':
      return sql`(
        select coalesce(max((substring(a.data ->> 'requestNo' from '^([0-9]{1,9})$'))::int), 0) + 1
        from app.lead_activities a
        where a.workspace_id = ${workspaceId} and a.kind = 'system'
          and a.data ->> 'event' = 'change_requested')`;
  }
}

/**
 * The next number of `counter` for the site, in the caller's transaction
 * (row-locked until commit, so concurrent callers wait and never share a
 * number; a rolled-back caller gives its number back). Unseeded, it starts
 * after the imported numbers (`firstValue`); the switch-day seed only ever
 * raises it.
 */
export async function nextSiteNumber(
  tx: TenantTransaction,
  workspaceId: string,
  counter: SiteCounter,
): Promise<number> {
  const rows = await tx.execute(sql`
    insert into app.site_counters (workspace_id, counter, last_value)
    values (${workspaceId}, ${counter}, ${firstValue(workspaceId, counter)})
    on conflict (workspace_id, counter)
      do update set last_value = app.site_counters.last_value + 1, updated_at = now()
    returning last_value
  `);
  const [issued] = issuedSchema.parse([...rows]);
  if (!issued) throw new Error('site counter returned no row');
  return issued.last_value;
}
