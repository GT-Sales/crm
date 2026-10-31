import { and, eq, lt, sql } from 'drizzle-orm';
import {
  contextWorkspaceId,
  leads,
  memberships,
  roles,
  serviceCredentials,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';

import type { Scope } from '../tenant-scope.js';
import { INTAKE_CHECK_CONTACT, INTAKE_CHECK_LEAD_TYPE } from './check.js';

/**
 * What the intake check reads, deletes and cleans up on its test site. Every
 * statement runs in one tenant transaction and filters on the transaction's
 * own `app.workspace_id`, never on a passed id alone, so it can only ever
 * touch the site it runs for. Deleting a lead cascades to its draft grants,
 * tasks, timeline, idempotency keys, automation runs, change requests and
 * identities (the referencing tables' foreign keys), so `app_runtime` needs no
 * delete grant on the append-only timeline.
 */

/**
 * The configured site is not the hidden test site: it has a member, a role or
 * a site key, which the test site never has. Thrown before anything is
 * written, so a wrong `INTAKE_CHECK_WORKSPACE_ID` can never touch a real
 * site. Its message is the run's failure code.
 */
export class IntakeCheckSiteNotTestError extends Error {
  readonly code = 'intake_check_site_not_test';
  constructor() {
    super('intake_check_site_not_test');
    this.name = 'IntakeCheckSiteNotTestError';
  }
}

export interface IntakeCheckLead {
  leadType: string;
  status: string;
  stage: string;
}

export interface IntakeCheckStore {
  /**
   * Refuses a site that is not the test site (`IntakeCheckSiteNotTestError`),
   * then deletes the check's own leads on it (type `internet`, the synthetic
   * email) created before `before`, in the same transaction; returns how many.
   */
  deleteLeftovers(scope: Scope, before: Date): Promise<number>;
  readLead(scope: Scope, leadId: string): Promise<IntakeCheckLead | undefined>;
  /** Deletes one lead in one tenant transaction; `remaining` re-counts rows with that id afterwards. */
  deleteLead(scope: Scope, leadId: string): Promise<{ deleted: number; remaining: number }>;
}

type IntakeCheckDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const onThisSite = eq(leads.workspaceId, contextWorkspaceId);

/** Whether the transaction's site has any member, role or site key; the test site has none. */
async function isRealSite(tx: TenantTransaction): Promise<boolean> {
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.workspaceId, contextWorkspaceId))
    .limit(1);
  if (member) return true;
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.workspaceId, contextWorkspaceId))
    .limit(1);
  if (role) return true;
  const [key] = await tx
    .select({ id: serviceCredentials.id })
    .from(serviceCredentials)
    .where(eq(serviceCredentials.workspaceId, contextWorkspaceId))
    .limit(1);
  return key !== undefined;
}

export class DatabaseIntakeCheckStore implements IntakeCheckStore {
  constructor(private readonly database: IntakeCheckDatabase = { withTenantTx }) {}

  async deleteLeftovers(scope: Scope, before: Date): Promise<number> {
    return this.database.withTenantTx(scope, async (tx) => {
      if (await isRealSite(tx)) throw new IntakeCheckSiteNotTestError();
      const deleted = await tx
        .delete(leads)
        .where(
          and(
            onThisSite,
            eq(leads.leadType, INTAKE_CHECK_LEAD_TYPE),
            eq(leads.email, INTAKE_CHECK_CONTACT.email),
            lt(leads.createdAt, before),
          ),
        )
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
