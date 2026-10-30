import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  automationRuns,
  automations,
  leads,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import { z } from 'zod';
import {
  BUILT_IN_AUTOMATION_KEYS,
  automationKeySchema,
  type AutomationKey,
} from '@gt-sales/contracts';

import type { Scope, WriteScope } from '../tenant-scope.js';

/**
 * A site's state of the built-in automation rules (spec §15) and the log of
 * their runs. The rules themselves live in code (contracts
 * `BUILT_IN_AUTOMATIONS`); a site has a row in `app.automations` only once an
 * owner has switched a rule on or off, and a site with no row for a rule has
 * it off and never run. A run is recorded inside the transaction of the move
 * or submit that fired it. Audit events carry the rule key and the new state,
 * nothing about a customer.
 */

export interface StoredAutomation {
  key: AutomationKey;
  enabled: boolean;
  lastRunAt: Date | null;
  runCount: number;
}

const runOutcomeSchema = z.enum(['queued', 'skipped']);
const runReasonSchema = z.enum(['no_sender', 'no_customer_email', 'missing_fill_in']);

export interface StoredAutomationRun {
  id: string;
  leadId: string;
  leadName: string | null;
  outcome: z.infer<typeof runOutcomeSchema>;
  reason: z.infer<typeof runReasonSchema> | null;
  createdAt: Date;
}

export interface RecordAutomationRunInput {
  workspaceId: string;
  key: AutomationKey;
  leadId: string;
  outcome: z.infer<typeof runOutcomeSchema>;
  reason?: z.infer<typeof runReasonSchema>;
  /** The outbox job a queued run created. */
  jobId?: string;
}

export interface AutomationStore {
  /** The six built-ins in BUILT_IN_AUTOMATION_KEYS order; no row = off, never run. */
  list(ctx: Scope): Promise<StoredAutomation[]>;
  /** Upsert; audit `automation.toggled` only when the state changes. */
  setEnabled(ctx: WriteScope, key: AutomationKey, enabled: boolean): Promise<StoredAutomation>;
  /** Inside the caller's transaction (a move or a submit). */
  recordRun(tx: TenantTransaction, input: RecordAutomationRunInput): Promise<void>;
  /** Newest first, at most `limit` (default and maximum 50); leadName only when includeLeadNames. */
  listRuns(
    ctx: Scope,
    key: AutomationKey,
    options: { limit?: number; includeLeadNames: boolean },
  ): Promise<StoredAutomationRun[]>;
}

type AutomationDatabase = Pick<DatabaseClient, 'withTenantTx'>;
type AutomationRecord = typeof automations.$inferSelect;

const AUDIT_ACTOR_LABEL = 'staff actor';
const RUN_LIST_LIMIT = 50;

const toStored = (record: AutomationRecord): StoredAutomation => ({
  key: automationKeySchema.parse(record.key),
  enabled: record.enabled,
  lastRunAt: record.lastRunAt,
  runCount: record.runCount,
});

const off = (key: AutomationKey): StoredAutomation => ({
  key,
  enabled: false,
  lastRunAt: null,
  runCount: 0,
});

export class DatabaseAutomationStore implements AutomationStore {
  constructor(private readonly database: AutomationDatabase = { withTenantTx }) {}

  list(ctx: Scope): Promise<StoredAutomation[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const records = await tx
        .select()
        .from(automations)
        .where(eq(automations.workspaceId, ctx.workspaceId));
      const byKey = new Map(records.map((record) => [record.key, record]));
      return BUILT_IN_AUTOMATION_KEYS.map((key) => {
        const record = byKey.get(key);
        return record ? toStored(record) : off(key);
      });
    });
  }

  setEnabled(ctx: WriteScope, key: AutomationKey, enabled: boolean): Promise<StoredAutomation> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const [existing] = await tx
        .select()
        .from(automations)
        .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.key, key)))
        .for('update');
      if (existing?.enabled === enabled) return toStored(existing);

      const [saved] = await tx
        .insert(automations)
        .values({ workspaceId: ctx.workspaceId, key, enabled, updatedBy: ctx.actorId })
        .onConflictDoUpdate({
          target: [automations.workspaceId, automations.key],
          set: { enabled, updatedBy: ctx.actorId, updatedAt: sql`now()` },
        })
        .returning();
      if (!saved) throw new Error('automation upsert returned no row');

      // A site with no row had the rule off, so switching it off is no change.
      if ((existing?.enabled ?? false) !== enabled) {
        await tx.insert(auditEvents).values({
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          actorLabel: AUDIT_ACTOR_LABEL,
          action: 'automation.toggled',
          entity: 'automation',
          entityId: saved.id,
          requestId: ctx.requestId,
          before: { key, enabled: existing?.enabled ?? false },
          after: { key, enabled },
        });
      }
      return toStored(saved);
    });
  }

  async recordRun(tx: TenantTransaction, input: RecordAutomationRunInput): Promise<void> {
    await tx.insert(automationRuns).values({
      workspaceId: input.workspaceId,
      automationKey: input.key,
      leadId: input.leadId,
      outcome: input.outcome,
      reason: input.reason ?? null,
      jobId: input.jobId ?? null,
    });
    if (input.outcome === 'queued') {
      await tx
        .update(automations)
        .set({ runCount: sql`${automations.runCount} + 1`, lastRunAt: sql`now()` })
        .where(and(eq(automations.workspaceId, input.workspaceId), eq(automations.key, input.key)));
    }
  }

  listRuns(
    ctx: Scope,
    key: AutomationKey,
    options: { limit?: number; includeLeadNames: boolean },
  ): Promise<StoredAutomationRun[]> {
    const limit = Math.min(Math.max(options.limit ?? RUN_LIST_LIMIT, 1), RUN_LIST_LIMIT);
    return this.database.withTenantTx(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.workspaceId, ctx.workspaceId),
            eq(automationRuns.automationKey, key),
          ),
        )
        .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
        .limit(limit);

      // Names are read only when asked for: a lead's name is contact data.
      const names = new Map<string, string | null>();
      if (options.includeLeadNames && rows.length > 0) {
        const named = await tx
          .select({ id: leads.id, fullName: leads.fullName })
          .from(leads)
          .where(
            and(
              eq(leads.workspaceId, ctx.workspaceId),
              inArray(leads.id, [...new Set(rows.map((row) => row.leadId))]),
            ),
          );
        for (const lead of named) names.set(lead.id, lead.fullName);
      }

      return rows.map((row) => ({
        id: row.id,
        leadId: row.leadId,
        leadName: names.get(row.leadId) ?? null,
        outcome: runOutcomeSchema.parse(row.outcome),
        reason: row.reason === null ? null : runReasonSchema.parse(row.reason),
        createdAt: row.createdAt,
      }));
    });
  }
}

/** The keys among `keys` whose row is enabled for this site, read in the caller's transaction. */
export async function enabledAutomationKeys(
  tx: TenantTransaction,
  workspaceId: string,
  keys: readonly AutomationKey[],
): Promise<ReadonlySet<AutomationKey>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ key: automations.key })
    .from(automations)
    .where(
      and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.enabled, true),
        inArray(automations.key, [...keys]),
      ),
    );
  return new Set(rows.map((row) => automationKeySchema.parse(row.key)));
}
