import { sql } from 'drizzle-orm';
import { withTenantTx } from '@gt-sales/db';

/**
 * REL-19: deletes old operational rows through the bounded SECURITY DEFINER
 * function from migration 0026 (windows in docs/OPEN_INPUTS.md). Off unless
 * OPERATIONAL_RETENTION_ENABLED=1: the owner turns it on only after the first
 * verified backup, because these deletes cannot be undone.
 */
export function operationalRetentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['OPERATIONAL_RETENTION_ENABLED'] === '1';
}

export interface PrunedTable {
  tableName: string;
  deleted: number;
}

type RetentionDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

export class DatabaseOperationalPruner {
  constructor(private readonly database: RetentionDatabase = { withTenantTx }) {}

  async prune(input: { workspaceId: string; actorId: string; now: Date }): Promise<PrunedTable[]> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const rows = await tx.execute<{ tableName: string; deleted: number }>(sql`
          select table_name as "tableName", deleted
          from app.prune_operational_rows(${input.workspaceId}::uuid, ${input.now.toISOString()}::timestamptz)
        `);
        return rows.map((row) => ({ tableName: row.tableName, deleted: Number(row.deleted) }));
      },
    );
  }
}
