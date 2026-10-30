import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import { z } from 'zod';

/**
 * A site's running numbers (`app.site_counters`). `sim_order_ref` numbers new
 * SIM orders `MS-<n>` (`simOrderRef`). Must match the table's counter check
 * in `packages/db/src/schema.ts`.
 */
export type SiteCounter = 'sim_order_ref';

const issuedSchema = z.array(z.object({ last_value: z.number().int().min(1) })).length(1);

/**
 * The next number of `counter` for the site, in the caller's transaction
 * (row-locked until commit, so concurrent orders wait and never share a
 * number; a rolled-back caller gives its number back). Unseeded, it starts
 * after the site's highest `MS-<n>` among its SIM orders, so the first new
 * order follows the imported ones; the switch-day seed only ever raises it.
 */
export async function nextSiteNumber(
  tx: TenantTransaction,
  workspaceId: string,
  counter: SiteCounter,
): Promise<number> {
  const rows = await tx.execute(sql`
    insert into app.site_counters (workspace_id, counter, last_value)
    values (${workspaceId}, ${counter}, (
      select coalesce(max((substring(l.external_ref from '^MS-([0-9]{1,9})$'))::int), 0) + 1
      from app.leads l where l.workspace_id = ${workspaceId} and l.lead_type = 'sim_order'))
    on conflict (workspace_id, counter)
      do update set last_value = app.site_counters.last_value + 1, updated_at = now()
    returning last_value
  `);
  const [issued] = issuedSchema.parse([...rows]);
  if (!issued) throw new Error('site counter returned no row');
  return issued.last_value;
}
