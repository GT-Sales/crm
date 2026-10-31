import { and, eq, lt, sql } from 'drizzle-orm';
import { contextWorkspaceId, leads, withTenantTx, type DatabaseClient } from '@gt-sales/db';

import type { Scope } from '../tenant-scope.js';

/**
 * What the intake check reads, deletes and cleans up on its test site. Every
 * statement runs in one tenant transaction and filters on the transaction's
 * own `app.workspace_id`, never on a passed id alone, so it can only ever
 * touch the site it runs for. Deleting a lead cascades to its draft grants,
 * tasks, timeline, idempotency keys, automation runs, change requests and
 * identities (the referencing tables' foreign keys), so `app_runtime` needs no
 * delete grant on the append-only timeline.
 */

export interface IntakeCheckLead {
  leadType: string;
  status: string;
  stage: string;
}

export interface IntakeCheckStore {
  /** Deletes the site's leads created before `before`; returns how many. */
  deleteLeftovers(scope: Scope, before: Date): Promise<number>;
  readLead(scope: Scope, leadId: string): Promise<IntakeCheckLead | undefined>;
  /** Deletes one lead in one tenant transaction; `remaining` re-counts rows with that id afterwards. */
  deleteLead(scope: Scope, leadId: string): Promise<{ deleted: number; remaining: number }>;
}

type IntakeCheckDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const onThisSite = eq(leads.workspaceId, contextWorkspaceId);

export class DatabaseIntakeCheckStore implements IntakeCheckStore {
  constructor(private readonly database: IntakeCheckDatabase = { withTenantTx }) {}

  async deleteLeftovers(scope: Scope, before: Date): Promise<number> {
    return this.database.withTenantTx(scope, async (tx) => {
      const deleted = await tx
        .delete(leads)
        .where(and(onThisSite, lt(leads.createdAt, before)))
        .returning({ id: leads.id });
      return deleted.length;
    });
  }

  async readLead(scope: Scope, leadId: string): Promise<IntakeCheckLead | undefined> {
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx
        .select({ leadType: leads.leadType, status: leads.status, stage: leads.stage })
        .from(leads)
        .where(and(onThisSite, eq(leads.id, leadId)))
        .limit(1);
      return row;
    });
  }

  async deleteLead(scope: Scope, leadId: string): Promise<{ deleted: number; remaining: number }> {
    return this.database.withTenantTx(scope, async (tx) => {
      const deleted = await tx
        .delete(leads)
        .where(and(onThisSite, eq(leads.id, leadId)))
        .returning({ id: leads.id });
      const [left] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(onThisSite, eq(leads.id, leadId)));
      return { deleted: deleted.length, remaining: left?.n ?? 0 };
    });
  }
}
