import { contextWorkspaceId, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Scope } from '../tenant-scope.js';

/**
 * The little a chat screen needs to know about its site before asking anything:
 * the name shown in the panel header, the slug its source links are built from,
 * and the lead types the site actually holds (so suggestions stay relevant).
 *
 * Counts and records are deliberately absent: this read is cheap, and every
 * factual answer comes from a tool invocation that rechecks authorization.
 */
export interface AiSiteContext {
  readonly siteId: string;
  readonly slug: string;
  readonly name: string;
  readonly leadTypes: readonly string[];
}

const rowSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  lead_types: z.array(z.string()),
});

type AiSiteDatabase = Pick<DatabaseClient, 'withTenantTx'>;

export interface AiSiteContextStore {
  siteContext(scope: Scope): Promise<AiSiteContext | undefined>;
}

export class DatabaseAiSiteContextStore implements AiSiteContextStore {
  constructor(private readonly database: AiSiteDatabase = { withTenantTx }) {}

  siteContext(scope: Scope): Promise<AiSiteContext | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          w.slug,
          w.name,
          (
            select coalesce(json_agg(t.lead_type order by t.lead_type), '[]'::json)
            from (
              select distinct l.lead_type
              from app.leads l
              where l.workspace_id = ${contextWorkspaceId}
            ) t
          ) as lead_types
        from app.workspaces w
        where w.id = ${contextWorkspaceId}
        limit 1
      `);
      const parsed = rowSchema.safeParse(row);
      if (!parsed.success) return undefined;
      return {
        siteId: scope.workspaceId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        leadTypes: parsed.data.lead_types,
      };
    });
  }
}
