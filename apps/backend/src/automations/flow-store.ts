import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  auditEvents,
  automationRuns,
  automationStepRuns,
  automationTimers,
  automationVersions,
  automationWaits,
  automations,
  emailTemplates,
  leads,
  memberships,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  AUTOMATION_MAX_FLOWS,
  AUTOMATION_RUN_PAGE,
  BUILT_IN_AUTOMATION_KEYS,
  CUSTOMER_EMAIL_TEMPLATES,
  EMPTY_FLOW_DRAFT,
  FLOW_TASK_VARIABLES,
  PROPERTY_FILL_IN_PREFIX,
  automationKeySchema,
  automationVersionStatusSchema,
  emailTemplateLabel,
  fillInsForTemplate,
  flowHasLeadChangingStep,
  flowDraftSchemaFor,
  isSiteTemplateKey,
  leadTypeCatalog,
  timerDueAt,
  triggerLeadTypes,
  automationReasonSchema,
  automationRunStatusSchema,
  automationStepOutcomeSchema,
  builtInFlowDefinition,
  builtInFlowName,
  checkFlowAgainstSite,
  flowDefinitionSchemaFor,
  flowStepKindSchema,
  flowTriggerKindSchema,
  generateFlowKey,
  isBuiltInAutomationKey,
  overlappingEmailFlows,
  type AutomationKey,
  type ActivateFlowRequest,
  type CreateFlowRequest,
  type FlowCatalogResponse,
  type FlowDefinition,
  type FlowDraft,
  type FlowTrigger,
  type FlowVersionSummary,
  type SaveFlowDraftRequest,
  type FlowIssue,
  type FlowOrigin,
  type FlowOverlapWarning,
  type FlowRun,
  type FlowSite,
  type FlowStepRun,
  type UpdateFlowDetailsRequest,
} from '@gt-sales/contracts';

import { templatePropertyKeys } from '../email/markup.js';
import { loadPlanOptions } from '../plans/options.js';
import { loadPropertyCatalog } from '../properties/catalog.js';
import type { Scope, WriteScope } from '../tenant-scope.js';
import { cancelFlowWork } from './records.js';
import { loadFlowSite } from './site.js';

/**
 * A site's automation flows (phase 8 spec §4, §6, §8): the six built-ins,
 * seeded lazily on the pages that show them (never in a move or a submit, so a
 * site that never opened the page has every rule off), and the custom flows
 * staff make, at most `AUTOMATION_MAX_FLOWS` not archived, built-ins included
 * (R1). Every change is audited with the flow's key and its new state, never a
 * customer detail; draft saves are not (P15). Bulk changes to a flow's waits
 * and timers claim rows `FOR UPDATE SKIP LOCKED` (P7).
 */

export interface StoredFlow {
  id: string;
  key: AutomationKey;
  origin: FlowOrigin;
  name: string;
  description: string | null;
  enabled: boolean;
  archived: boolean;
  revision: number;
  activeVersion: {
    id: string;
    version: number;
    definition: unknown;
    activatedAt: Date;
    activatedBy: string | null;
  } | null;
  draft: { id: string; version: number; definition: unknown } | null;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
}

export type FlowStoreOutcome<T> =
  | { status: 'ok'; value: T }
  | {
      status:
        | 'not_found'
        | 'revision_conflict'
        | 'limit_reached'
        | 'no_active_version'
        | 'not_builtin'
        | 'builtin'
        | 'archived'
        | 'needs_lead_manage';
    }
  | { status: 'invalid'; issues: FlowIssue[] | string[] };

export interface FlowListResult {
  flows: StoredFlow[];
  /** By flow key: the first issue of its active version (or `definition_invalid`). */
  needsAttention: ReadonlyMap<string, FlowIssue>;
  warnings: FlowOverlapWarning[];
  /** The archived list's next page (its last flow's key), or null. */
  nextBefore: AutomationKey | null;
}

/** The archived flows are listed a page at a time: archiving has no limit. */
export const ARCHIVED_FLOW_PAGE = 50;

export interface FlowStore {
  /**
   * Seeds missing built-ins first (`ensureBuiltInFlows`, spec §6); returns the
   * flows not archived, or a page of the archived ones (most recently archived
   * first, before the flow `before`).
   */
  list(ctx: Scope, options: { archived: boolean; before?: string }): Promise<FlowListResult>;
  /** Also seeds. */
  get(ctx: Scope, key: AutomationKey): Promise<StoredFlow | undefined>;
  create(ctx: WriteScope, input: CreateFlowRequest): Promise<FlowStoreOutcome<StoredFlow>>;
  updateDetails(
    ctx: WriteScope,
    key: AutomationKey,
    input: UpdateFlowDetailsRequest,
  ): Promise<FlowStoreOutcome<StoredFlow>>;
  setEnabled(
    ctx: WriteScope,
    key: AutomationKey,
    enabled: boolean,
  ): Promise<FlowStoreOutcome<StoredFlow>>;
  archive(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  restore(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  listRuns(
    ctx: Scope,
    key: AutomationKey,
    options: { before?: string; includeLeadNames: boolean },
  ): Promise<{ runs: FlowRun[]; nextBefore: string | null } | undefined>;
  getRun(
    ctx: Scope,
    key: AutomationKey,
    runId: string,
    options: { includeLeadNames: boolean },
  ): Promise<FlowRun | undefined>;
  /**
   * Saves the whole draft against `expectedRevision`: a new `draft` version
   * (numbered after every other) when there is none, else the draft rewritten.
   * The structure is checked for the flow's own origin (a custom flow never
   * holds the step `main`); site issues are returned as warnings. Not audited.
   */
  saveDraft(
    ctx: WriteScope,
    key: AutomationKey,
    input: SaveFlowDraftRequest,
  ): Promise<FlowStoreOutcome<{ flow: StoredFlow; issues: FlowIssue[] }>>;
  discardDraft(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  /**
   * The draft becomes the active version in one transaction (the old one
   * retired, pending timers recomputed or voided); the flow's switch is
   * untouched. `mayChangeLeads`: the caller also has `lead.manage` (R5).
   */
  activate(
    ctx: WriteScope,
    key: AutomationKey,
    input: ActivateFlowRequest & { mayChangeLeads: boolean },
  ): Promise<FlowStoreOutcome<StoredFlow>>;
  /** Built-ins only: the draft becomes the default definition and the name the label. */
  reset(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  getVersion(
    ctx: Scope,
    key: AutomationKey,
    version: number,
  ): Promise<StoredFlowVersion | undefined>;
  /** Newest first, at most `FLOW_VERSION_LIST_MAX`. */
  versions(ctx: Scope, key: AutomationKey): Promise<FlowVersionSummary[]>;
  catalog(ctx: Scope): Promise<Omit<FlowCatalogResponse, 'requestId'>>;
  /** Everything a flow's page shows (seeds first); undefined when the site has no such flow. */
  detail(ctx: Scope, key: AutomationKey): Promise<FlowDetail | undefined>;
}

export interface StoredFlowVersion {
  version: number;
  status: FlowVersionSummary['status'];
  definition: unknown;
  activatedAt: Date | null;
  activatedBy: string | null;
  createdAt: Date;
}

/**
 * A flow as its page reads it. A stored definition that no longer parses for
 * the flow's origin is served as `definition: null` (with `definition_invalid`
 * as the issue) rather than failing the page (review minor 8).
 */
export interface FlowDetail {
  flow: StoredFlow;
  needsAttention: FlowIssue | null;
  draft: { version: number; definition: FlowDraft | null; issues: FlowIssue[] } | null;
  active: { version: number; definition: FlowDefinition | null } | null;
  versions: FlowVersionSummary[];
}

/** Versions a flow's page lists; older ones stay readable one at a time. */
export const FLOW_VERSION_LIST_MAX = 500;

type FlowDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const AUDIT_ACTOR_LABEL = 'staff actor';

const activeVersion = alias(automationVersions, 'active_version');
const draftVersion = alias(automationVersions, 'draft_version');

const flowColumns = {
  id: automations.id,
  key: automations.key,
  origin: automations.origin,
  name: automations.name,
  description: automations.description,
  enabled: automations.enabled,
  archivedAt: automations.archivedAt,
  revision: automations.revision,
  lastRunAt: automations.lastRunAt,
  runCount: automations.runCount,
  createdAt: automations.createdAt,
  activeId: activeVersion.id,
  activeNumber: activeVersion.version,
  activeDefinition: activeVersion.definition,
  activeAt: activeVersion.activatedAt,
  activeBy: activeVersion.activatedBy,
  draftId: draftVersion.id,
  draftNumber: draftVersion.version,
  draftDefinition: draftVersion.definition,
};

type FlowRow = {
  id: string;
  key: string;
  origin: string;
  name: string | null;
  description: string | null;
  enabled: boolean;
  archivedAt: Date | null;
  revision: number;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
  activeId: string | null;
  activeNumber: number | null;
  activeDefinition: unknown;
  activeAt: Date | null;
  activeBy: string | null;
  draftId: string | null;
  draftNumber: number | null;
  draftDefinition: unknown;
};

const originOf = (origin: string): FlowOrigin => (origin === 'custom' ? 'custom' : 'builtin');

function toStoredFlow(row: FlowRow): StoredFlow {
  const key = automationKeySchema.parse(row.key);
  return {
    id: row.id,
    key,
    origin: originOf(row.origin),
    name: row.name ?? (isBuiltInAutomationKey(key) ? builtInFlowName(key) : key),
    description: row.description,
    enabled: row.enabled,
    archived: row.archivedAt !== null,
    revision: row.revision,
    activeVersion:
      row.activeId !== null && row.activeNumber !== null && row.activeAt !== null
        ? {
            id: row.activeId,
            version: row.activeNumber,
            definition: row.activeDefinition,
            activatedAt: row.activeAt,
            activatedBy: row.activeBy,
          }
        : null,
    draft:
      row.draftId !== null && row.draftNumber !== null
        ? { id: row.draftId, version: row.draftNumber, definition: row.draftDefinition }
        : null,
    lastRunAt: row.lastRunAt,
    runCount: row.runCount,
    createdAt: row.createdAt,
  };
}

/** The flows of the site that `where` picks, with their active version and draft. */
function selectFlows(tx: TenantTransaction, workspaceId: string, where: SQL | undefined) {
  return tx
    .select(flowColumns)
    .from(automations)
    .leftJoin(
      activeVersion,
      and(
        eq(activeVersion.workspaceId, automations.workspaceId),
        eq(activeVersion.id, automations.activeVersionId),
      ),
    )
    .leftJoin(
      draftVersion,
      and(
        eq(draftVersion.workspaceId, automations.workspaceId),
        eq(draftVersion.automationId, automations.id),
        eq(draftVersion.status, 'draft'),
      ),
    )
    .where(and(eq(automations.workspaceId, workspaceId), where));
}

export async function readFlow(
  tx: TenantTransaction,
  workspaceId: string,
  key: string,
): Promise<StoredFlow | undefined> {
  const [row] = await selectFlows(tx, workspaceId, eq(automations.key, key));
  return row ? toStoredFlow(row) : undefined;
}

/** The flow row, locked for this transaction's change; undefined when the site has no such flow. */
async function lockFlow(
  tx: TenantTransaction,
  workspaceId: string,
  key: string,
): Promise<
  | {
      id: string;
      origin: FlowOrigin;
      enabled: boolean;
      archived: boolean;
      revision: number;
      activeVersionId: string | null;
    }
  | undefined
> {
  const [row] = await tx
    .select({
      id: automations.id,
      origin: automations.origin,
      enabled: automations.enabled,
      archivedAt: automations.archivedAt,
      revision: automations.revision,
      activeVersionId: automations.activeVersionId,
    })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), eq(automations.key, key)))
    .for('update');
  if (!row) return undefined;
  return {
    id: row.id,
    origin: originOf(row.origin),
    enabled: row.enabled,
    archived: row.archivedAt !== null,
    revision: row.revision,
    activeVersionId: row.activeVersionId,
  };
}

/** Serialises the 50-flow count of one site (P14). */
async function lockFlowCount(tx: TenantTransaction, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('automations:' || ${workspaceId}::text, 0))`,
  );
}

async function countLiveFlows(tx: TenantTransaction, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), isNull(automations.archivedAt)));
  return row?.count ?? 0;
}

async function audit(
  tx: TenantTransaction,
  ctx: WriteScope,
  input: { action: string; entityId: string; before?: unknown; after: unknown },
): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    actorLabel: AUDIT_ACTOR_LABEL,
    action: input.action,
    entity: 'automation',
    entityId: input.entityId,
    requestId: ctx.requestId,
    before: input.before ?? null,
    after: input.after,
  });
}

/**
 * Seeds the site's built-in flows (spec §6): any missing row is inserted off,
 * named its label, with version 1 active (`activated_by` null); a built-in row
 * with no active version (one the phase 4 backend made in the deploy window)
 * gets one; a null name is filled. Idempotent and safe under concurrency
 * (`on conflict do nothing`, then the rows still missing a version locked).
 * Never called in a move or a submit.
 */
export async function ensureBuiltInFlows(tx: TenantTransaction, scope: Scope): Promise<void> {
  const { workspaceId, actorId } = scope;
  const existing = await tx
    .select({
      key: automations.key,
      name: automations.name,
      activeVersionId: automations.activeVersionId,
    })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), eq(automations.origin, 'builtin')));
  const complete = new Set(
    existing
      .filter((row) => row.name !== null && row.activeVersionId !== null)
      .map((row) => row.key),
  );
  if (BUILT_IN_AUTOMATION_KEYS.every((key) => complete.has(key))) return;

  const present = new Set(existing.map((row) => row.key));
  const missing = BUILT_IN_AUTOMATION_KEYS.filter((key) => !present.has(key));
  if (missing.length > 0) {
    await tx
      .insert(automations)
      .values(
        missing.map((key) => ({
          workspaceId,
          key,
          origin: 'builtin',
          name: builtInFlowName(key),
          enabled: false,
          createdBy: actorId,
          updatedBy: actorId,
        })),
      )
      .onConflictDoNothing({ target: [automations.workspaceId, automations.key] });
  }

  // Locked, so a concurrent seeding waits and then finds the version made.
  const unversioned = await tx
    .select({ id: automations.id, key: automations.key })
    .from(automations)
    .where(
      and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.origin, 'builtin'),
        isNull(automations.activeVersionId),
      ),
    )
    .for('update');
  for (const row of unversioned) {
    if (!isBuiltInAutomationKey(row.key)) continue;
    const version = await nextVersionNumber(tx, workspaceId, row.id);
    const [saved] = await tx
      .insert(automationVersions)
      .values({
        workspaceId,
        automationId: row.id,
        version,
        status: 'active',
        definition: builtInFlowDefinition(row.key),
        createdBy: actorId,
        activatedAt: new Date(),
      })
      .returning({ id: automationVersions.id });
    if (!saved) throw new Error('the built-in version was not inserted');
    await tx
      .update(automations)
      .set({ activeVersionId: saved.id })
      .where(and(eq(automations.workspaceId, workspaceId), eq(automations.id, row.id)));
  }

  for (const key of BUILT_IN_AUTOMATION_KEYS) {
    await tx
      .update(automations)
      .set({ name: builtInFlowName(key) })
      .where(
        and(
          eq(automations.workspaceId, workspaceId),
          eq(automations.key, key),
          isNull(automations.name),
        ),
      );
  }
}

export async function nextVersionNumber(
  tx: TenantTransaction,
  workspaceId: string,
  automationId: string,
): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${automationVersions.version}), 0)::int` })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.workspaceId, workspaceId),
        eq(automationVersions.automationId, automationId),
      ),
    );
  return (row?.max ?? 0) + 1;
}

/** The active definition as it parses for the flow's origin; null when there is none or it no longer parses. */
export function parsedActiveDefinition(flow: StoredFlow): FlowDefinition | null {
  if (!flow.activeVersion) return null;
  const parsed = flowDefinitionSchemaFor(flow.origin).safeParse(flow.activeVersion.definition);
  return parsed.success ? parsed.data : null;
}

const DEFINITION_INVALID: FlowIssue = {
  path: 'definition',
  code: 'definition_invalid',
  ref: 'definition',
};

/** What makes a flow's active version unusable now: its first site issue, `definition_invalid`, or null. */
export function flowAttention(flow: StoredFlow, site: FlowSite): FlowIssue | null {
  if (!flow.activeVersion) return null;
  const definition = parsedActiveDefinition(flow);
  if (!definition) return DEFINITION_INVALID;
  return checkFlowAgainstSite(definition, site)[0] ?? null;
}

/** Built-ins in `BUILT_IN_AUTOMATION_KEYS` order, then custom flows by creation, then id. */
function byFlowOrder(left: StoredFlow, right: StoredFlow): number {
  const rank = (flow: StoredFlow) =>
    isBuiltInAutomationKey(flow.key)
      ? BUILT_IN_AUTOMATION_KEYS.indexOf(flow.key)
      : BUILT_IN_AUTOMATION_KEYS.length;
  return (
    rank(left) - rank(right) ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Runs

type RunRow = {
  id: string;
  leadId: string;
  status: string;
  outcome: string | null;
  reason: string | null;
  detail: string | null;
  triggerKind: string | null;
  version: number | null;
  createdAt: Date;
  finishedAt: Date | null;
};

const reasonOf = (reason: string | null) => {
  const parsed = automationReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : null;
};

/** Steps per run in a response (the contract's cap). */
const MAX_RUN_STEPS = 200;

async function shapeRuns(
  tx: TenantTransaction,
  workspaceId: string,
  rows: readonly RunRow[],
  includeLeadNames: boolean,
): Promise<FlowRun[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const steps = await tx
    .select({
      runId: automationStepRuns.runId,
      stepId: automationStepRuns.stepId,
      stepKind: automationStepRuns.stepKind,
      outcome: automationStepRuns.outcome,
      branch: automationStepRuns.branch,
      reason: automationStepRuns.reason,
      detail: automationStepRuns.detail,
      createdAt: automationStepRuns.createdAt,
    })
    .from(automationStepRuns)
    .where(
      and(eq(automationStepRuns.workspaceId, workspaceId), inArray(automationStepRuns.runId, ids)),
    )
    .orderBy(asc(automationStepRuns.createdAt), asc(automationStepRuns.id));
  const stepsByRun = new Map<string, FlowStepRun[]>();
  for (const step of steps) {
    const kind = flowStepKindSchema.safeParse(step.stepKind);
    const outcome = automationStepOutcomeSchema.safeParse(step.outcome);
    if (!kind.success || !outcome.success) continue;
    const list = stepsByRun.get(step.runId) ?? [];
    stepsByRun.set(step.runId, list);
    if (list.length >= MAX_RUN_STEPS) continue;
    list.push({
      stepId: step.stepId,
      stepKind: kind.data,
      outcome: outcome.data,
      branch: step.branch === 'yes' || step.branch === 'no' ? step.branch : null,
      reason: reasonOf(step.reason),
      detail: step.detail,
      at: step.createdAt.toISOString(),
    });
  }

  const waits = await tx
    .select({ runId: automationWaits.runId, resumeAt: automationWaits.resumeAt })
    .from(automationWaits)
    .where(
      and(
        eq(automationWaits.workspaceId, workspaceId),
        inArray(automationWaits.runId, ids),
        eq(automationWaits.status, 'pending'),
      ),
    );
  const resumeAt = new Map(waits.map((wait) => [wait.runId, wait.resumeAt]));

  // Names are read only when asked for: a lead's name is contact data.
  const names = new Map<string, string | null>();
  if (includeLeadNames) {
    const named = await tx
      .select({ id: leads.id, fullName: leads.fullName })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          inArray(leads.id, [...new Set(rows.map((row) => row.leadId))]),
        ),
      );
    for (const lead of named) names.set(lead.id, lead.fullName);
  }

  return rows.map((row): FlowRun => {
    const reason = reasonOf(row.reason);
    const base = {
      id: row.id,
      leadId: row.leadId,
      leadName: includeLeadNames ? (names.get(row.leadId) ?? null) : null,
      reason,
      detail: row.detail,
      version: row.version,
      startedAt: row.createdAt.toISOString(),
    };
    if (row.outcome !== null) {
      // A phase 4 run: its outcome says what happened, whatever `status` defaulted to.
      const queued = row.outcome === 'queued';
      return {
        ...base,
        status: queued ? 'completed' : 'skipped',
        triggerKind: null,
        finishedAt: (row.finishedAt ?? row.createdAt).toISOString(),
        resumeAt: null,
        legacy: true,
        steps: [
          {
            stepId: 'main',
            stepKind: 'send_email',
            outcome: queued ? 'done' : 'skipped',
            branch: null,
            reason,
            detail: null,
            at: row.createdAt.toISOString(),
          },
        ],
      };
    }
    const status = automationRunStatusSchema.safeParse(row.status);
    const triggerKind = flowTriggerKindSchema.safeParse(row.triggerKind);
    const resume = resumeAt.get(row.id);
    return {
      ...base,
      status: status.success ? status.data : 'failed',
      triggerKind: triggerKind.success ? triggerKind.data : null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      resumeAt: status.success && status.data === 'waiting' && resume ? resume.toISOString() : null,
      legacy: false,
      steps: stepsByRun.get(row.id) ?? [],
    };
  });
}

const runColumns = {
  id: automationRuns.id,
  leadId: automationRuns.leadId,
  status: automationRuns.status,
  outcome: automationRuns.outcome,
  reason: automationRuns.reason,
  detail: automationRuns.detail,
  triggerKind: automationRuns.triggerKind,
  version: automationVersions.version,
  createdAt: automationRuns.createdAt,
  finishedAt: automationRuns.finishedAt,
};

function selectRuns(tx: TenantTransaction, workspaceId: string, where: SQL | undefined) {
  return tx
    .select(runColumns)
    .from(automationRuns)
    .leftJoin(
      automationVersions,
      and(
        eq(automationVersions.workspaceId, automationRuns.workspaceId),
        eq(automationVersions.id, automationRuns.versionId),
      ),
    )
    .where(and(eq(automationRuns.workspaceId, workspaceId), where));
}

/** Whether the site has the flow `key` (a built-in always exists, seeded or not). */
async function flowExists(tx: TenantTransaction, workspaceId: string, key: AutomationKey) {
  if (isBuiltInAutomationKey(key)) return true;
  const [row] = await tx
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.workspaceId, workspaceId), eq(automations.key, key)));
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Drafts, activation and timers

/** Zod's messages, each once (a message is the issue code where one applies). */
function problemsOf(issues: readonly { message: string }[]): string[] {
  return [...new Set(issues.map((issue) => issue.message))];
}

async function readDraftRow(
  tx: TenantTransaction,
  workspaceId: string,
  automationId: string,
): Promise<{ id: string; version: number; definition: unknown } | undefined> {
  const [row] = await tx
    .select({
      id: automationVersions.id,
      version: automationVersions.version,
      definition: automationVersions.definition,
    })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.workspaceId, workspaceId),
        eq(automationVersions.automationId, automationId),
        eq(automationVersions.status, 'draft'),
      ),
    )
    .for('update');
  return row;
}

/** Writes `definition` as the flow's draft: the draft rewritten, or a new one numbered after every version. */
async function writeDraft(
  tx: TenantTransaction,
  ctx: WriteScope,
  automationId: string,
  definition: FlowDraft | FlowDefinition,
): Promise<void> {
  const draft = await readDraftRow(tx, ctx.workspaceId, automationId);
  if (draft) {
    await tx
      .update(automationVersions)
      .set({ definition })
      .where(
        and(
          eq(automationVersions.workspaceId, ctx.workspaceId),
          eq(automationVersions.id, draft.id),
        ),
      );
    return;
  }
  await tx.insert(automationVersions).values({
    workspaceId: ctx.workspaceId,
    automationId,
    version: await nextVersionNumber(tx, ctx.workspaceId, automationId),
    status: 'draft',
    definition,
    createdBy: ctx.actorId,
  });
}

async function bumpRevision(
  tx: TenantTransaction,
  ctx: WriteScope,
  automationId: string,
  extra: { name?: string; activeVersionId?: string } = {},
): Promise<void> {
  await tx
    .update(automations)
    .set({
      ...extra,
      revision: sql`${automations.revision} + 1`,
      updatedBy: ctx.actorId,
      updatedAt: new Date(),
    })
    .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.id, automationId)));
}

const TASK_OCCURRENCE = /^task:[^:]+:(\d{4}-\d{2}-\d{2})$/;

/** Whether a pending timer still belongs to `trigger` for a lead of `leadType`. */
function timerStillMatches(
  trigger: FlowTrigger,
  timer: { triggerKind: string; stage: string | null },
  leadType: string,
): boolean {
  if (trigger.kind !== timer.triggerKind) return false;
  if (trigger.kind === 'time_in_stage') {
    return trigger.leadType === leadType && trigger.stage === timer.stage;
  }
  return triggerLeadTypes(trigger).includes(leadType);
}

/**
 * After an activation, the flow's pending timers follow the new trigger: each
 * gets the due time the new delay gives from its `event_at`, or becomes
 * `void` when the new trigger's kind, type or stage no longer covers it.
 * Claimed `FOR UPDATE SKIP LOCKED` (P7): one a tick holds is left as it is,
 * and the tick re-checks the version active when it fires.
 */
async function recomputeTimers(
  tx: TenantTransaction,
  workspaceId: string,
  automationId: string,
  trigger: FlowTrigger,
): Promise<void> {
  const rows = await tx.execute<{
    id: string;
    trigger_kind: string;
    stage: string | null;
    occurrence: string;
    event_at: string;
    lead_type: string;
  }>(sql`
    select t.id, t.trigger_kind, t.stage, t.occurrence, t.event_at, l.lead_type
    from app.automation_timers t
    join app.leads l on l.workspace_id = t.workspace_id and l.id = t.lead_id
    where t.workspace_id = ${workspaceId} and t.automation_id = ${automationId}
      and t.status = 'pending'
    for update of t skip locked
  `);
  const moved: { id: string; due: string }[] = [];
  const voided: string[] = [];
  for (const row of rows) {
    const due = timerStillMatches(
      trigger,
      { triggerKind: row.trigger_kind, stage: row.stage },
      row.lead_type,
    )
      ? timerDueAt(trigger, {
          eventAt: new Date(row.event_at),
          ...(trigger.kind === 'task_overdue'
            ? { dueDay: TASK_OCCURRENCE.exec(row.occurrence)?.[1] ?? '' }
            : {}),
        })
      : null;
    if (due) moved.push({ id: row.id, due: due.toISOString() });
    else voided.push(row.id);
  }
  if (moved.length > 0) {
    await tx.execute(sql`
      update app.automation_timers t
      set due_at = v.due, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(moved)}::jsonb) as v(id uuid, due timestamptz)
      where t.workspace_id = ${workspaceId} and t.id = v.id
    `);
  }
  if (voided.length > 0) {
    await tx
      .update(automationTimers)
      .set({ status: 'void', updatedAt: new Date() })
      .where(
        and(eq(automationTimers.workspaceId, workspaceId), inArray(automationTimers.id, voided)),
      );
  }
}

async function listVersions(
  tx: TenantTransaction,
  workspaceId: string,
  automationId: string,
): Promise<FlowVersionSummary[]> {
  const rows = await tx
    .select({
      version: automationVersions.version,
      status: automationVersions.status,
      activatedAt: automationVersions.activatedAt,
      activatedBy: automationVersions.activatedBy,
    })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.workspaceId, workspaceId),
        eq(automationVersions.automationId, automationId),
      ),
    )
    .orderBy(desc(automationVersions.version))
    .limit(FLOW_VERSION_LIST_MAX);
  return rows.map((row) => ({
    version: row.version,
    status: automationVersionStatusSchema.parse(row.status),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    activatedBy: row.activatedBy,
  }));
}

/** A property's per-type entries for the types it applies to. */
function propertyUses(catalog: Awaited<ReturnType<typeof loadPropertyCatalog>>, key: string) {
  return Object.keys(leadTypeCatalog).flatMap((leadType) => {
    const entry = catalog.forType(leadType).find((property) => property.key === key);
    return entry ? [{ leadType, entry }] : [];
  });
}

// ---------------------------------------------------------------------------
// The store

export class DatabaseFlowStore implements FlowStore {
  constructor(protected readonly database: FlowDatabase = { withTenantTx }) {}

  list(ctx: Scope, options: { archived: boolean; before?: string }): Promise<FlowListResult> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await ensureBuiltInFlows(tx, ctx);
      let flows: StoredFlow[];
      let nextBefore: AutomationKey | null = null;
      if (options.archived) {
        const page = await this.archivedPage(tx, ctx.workspaceId, options.before);
        flows = page.flows;
        nextBefore = page.nextBefore;
      } else {
        const rows = await selectFlows(tx, ctx.workspaceId, isNull(automations.archivedAt));
        flows = rows.map(toStoredFlow).sort(byFlowOrder);
      }
      const site = await loadFlowSite(tx, ctx.workspaceId);
      const needsAttention = new Map<string, FlowIssue>();
      for (const flow of flows) {
        const issue = flowAttention(flow, site);
        if (issue) needsAttention.set(flow.key, issue);
      }
      const warnings = options.archived
        ? []
        : overlappingEmailFlows(
            flows.map((flow) => ({
              key: flow.key,
              name: flow.name,
              enabled: flow.enabled,
              definition: parsedActiveDefinition(flow),
            })),
          );
      return { flows, needsAttention, warnings, nextBefore };
    });
  }

  private async archivedPage(
    tx: TenantTransaction,
    workspaceId: string,
    before: string | undefined,
  ): Promise<{ flows: StoredFlow[]; nextBefore: AutomationKey | null }> {
    let after: SQL | undefined;
    if (before !== undefined) {
      const [cursor] = await tx
        .select({ id: automations.id })
        .from(automations)
        .where(
          and(
            eq(automations.workspaceId, workspaceId),
            eq(automations.key, before),
            isNotNull(automations.archivedAt),
          ),
        );
      if (!cursor) return { flows: [], nextBefore: null };
      // Compared in SQL: a JavaScript date would lose the microseconds.
      after = sql`(${automations.archivedAt}, ${automations.id}) < (select c.archived_at, c.id from app.automations c where c.workspace_id = ${workspaceId} and c.id = ${cursor.id})`;
    }
    const rows = await selectFlows(tx, workspaceId, and(isNotNull(automations.archivedAt), after))
      .orderBy(desc(automations.archivedAt), desc(automations.id))
      .limit(ARCHIVED_FLOW_PAGE + 1);
    const flows = rows.slice(0, ARCHIVED_FLOW_PAGE).map(toStoredFlow);
    const last = flows.at(-1);
    return {
      flows,
      nextBefore: rows.length > ARCHIVED_FLOW_PAGE && last ? last.key : null,
    };
  }

  get(ctx: Scope, key: AutomationKey): Promise<StoredFlow | undefined> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await ensureBuiltInFlows(tx, ctx);
      return readFlow(tx, ctx.workspaceId, key);
    });
  }

  create(ctx: WriteScope, input: CreateFlowRequest): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      await ensureBuiltInFlows(tx, ctx);
      await lockFlowCount(tx, ctx.workspaceId);
      if ((await countLiveFlows(tx, ctx.workspaceId)) >= AUTOMATION_MAX_FLOWS) {
        return { status: 'limit_reached' };
      }
      let created: { id: string; key: string } | undefined;
      // A clash of two random keys is next to impossible; try again if it happens.
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        [created] = await tx
          .insert(automations)
          .values({
            workspaceId: ctx.workspaceId,
            key: generateFlowKey(),
            origin: 'custom',
            name: input.name,
            description: input.description || null,
            enabled: false,
            createdBy: ctx.actorId,
            updatedBy: ctx.actorId,
          })
          .onConflictDoNothing({ target: [automations.workspaceId, automations.key] })
          .returning({ id: automations.id, key: automations.key });
      }
      if (!created) throw new Error('no free flow key was found');
      await tx.insert(automationVersions).values({
        workspaceId: ctx.workspaceId,
        automationId: created.id,
        version: 1,
        status: 'draft',
        definition: EMPTY_FLOW_DRAFT,
        createdBy: ctx.actorId,
      });
      await audit(tx, ctx, {
        action: 'automation.created',
        entityId: created.id,
        after: { key: created.key, origin: 'custom', version: 1 },
      });
      return this.okFlow(tx, ctx.workspaceId, created.key);
    });
  }

  updateDetails(
    ctx: WriteScope,
    key: AutomationKey,
    input: UpdateFlowDetailsRequest,
  ): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      await ensureBuiltInFlows(tx, ctx);
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      if (locked.revision !== input.expectedRevision) return { status: 'revision_conflict' };
      const current = await readFlow(tx, ctx.workspaceId, key);
      if (!current) return { status: 'not_found' };
      const changes: { name?: string; description?: string | null } = {};
      if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
      if (input.description !== undefined) {
        const description = input.description === '' ? null : input.description;
        if (description !== current.description) changes.description = description;
      }
      const fields = Object.keys(changes);
      if (fields.length === 0) return { status: 'ok', value: current };
      await tx
        .update(automations)
        .set({
          ...changes,
          revision: sql`${automations.revision} + 1`,
          updatedBy: ctx.actorId,
          updatedAt: new Date(),
        })
        .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.id, locked.id)));
      await audit(tx, ctx, {
        action: 'automation.renamed',
        entityId: locked.id,
        after: { key, fields },
      });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  setEnabled(
    ctx: WriteScope,
    key: AutomationKey,
    enabled: boolean,
  ): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      await ensureBuiltInFlows(tx, ctx);
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      if (locked.enabled === enabled) return this.okFlow(tx, ctx.workspaceId, key);
      if (enabled && locked.archived) return { status: 'archived' };
      if (enabled && locked.activeVersionId === null) return { status: 'no_active_version' };
      await tx
        .update(automations)
        .set({ enabled, updatedBy: ctx.actorId, updatedAt: new Date() })
        .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.id, locked.id)));
      if (!enabled) await cancelFlowWork(tx, ctx.workspaceId, locked.id, 'flow_switched_off');
      await audit(tx, ctx, {
        action: 'automation.toggled',
        entityId: locked.id,
        before: { key, enabled: locked.enabled },
        after: { key, enabled },
      });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  archive(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      if (isBuiltInAutomationKey(key)) return { status: 'builtin' };
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      if (locked.origin !== 'custom') return { status: 'builtin' };
      if (locked.archived) return this.okFlow(tx, ctx.workspaceId, key);
      // Switched off first: its waiting runs are cancelled and its timers voided.
      if (locked.enabled) {
        await cancelFlowWork(tx, ctx.workspaceId, locked.id, 'flow_switched_off');
      }
      await tx
        .update(automations)
        .set({
          enabled: false,
          archivedAt: new Date(),
          updatedBy: ctx.actorId,
          updatedAt: new Date(),
        })
        .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.id, locked.id)));
      await audit(tx, ctx, {
        action: 'automation.archived',
        entityId: locked.id,
        before: { key, enabled: locked.enabled, archived: false },
        after: { key, enabled: false, archived: true },
      });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  restore(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      if (isBuiltInAutomationKey(key)) return { status: 'builtin' };
      await ensureBuiltInFlows(tx, ctx);
      await lockFlowCount(tx, ctx.workspaceId);
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      if (locked.origin !== 'custom') return { status: 'builtin' };
      if (!locked.archived) return this.okFlow(tx, ctx.workspaceId, key);
      if ((await countLiveFlows(tx, ctx.workspaceId)) >= AUTOMATION_MAX_FLOWS) {
        return { status: 'limit_reached' };
      }
      await tx
        .update(automations)
        .set({ archivedAt: null, updatedBy: ctx.actorId, updatedAt: new Date() })
        .where(and(eq(automations.workspaceId, ctx.workspaceId), eq(automations.id, locked.id)));
      await audit(tx, ctx, {
        action: 'automation.restored',
        entityId: locked.id,
        before: { key, archived: true },
        after: { key, archived: false, enabled: false },
      });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  listRuns(
    ctx: Scope,
    key: AutomationKey,
    options: { before?: string; includeLeadNames: boolean },
  ): Promise<{ runs: FlowRun[]; nextBefore: string | null } | undefined> {
    return this.database.withTenantTx(ctx, async (tx) => {
      if (!(await flowExists(tx, ctx.workspaceId, key))) return undefined;
      // By key, so a phase 4 run with no `automation_id` still lists.
      let after: SQL | undefined;
      if (options.before !== undefined) {
        const [cursor] = await tx
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.workspaceId, ctx.workspaceId),
              eq(automationRuns.automationKey, key),
              eq(automationRuns.id, options.before),
            ),
          );
        if (!cursor) return { runs: [], nextBefore: null };
        // Compared in SQL: a JavaScript date would lose the microseconds.
        after = sql`(${automationRuns.createdAt}, ${automationRuns.id}) < (select c.created_at, c.id from app.automation_runs c where c.workspace_id = ${ctx.workspaceId} and c.id = ${cursor.id})`;
      }
      const rows = await selectRuns(
        tx,
        ctx.workspaceId,
        and(eq(automationRuns.automationKey, key), after),
      )
        .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
        .limit(AUTOMATION_RUN_PAGE + 1);
      const page = rows.slice(0, AUTOMATION_RUN_PAGE);
      const runs = await shapeRuns(tx, ctx.workspaceId, page, options.includeLeadNames);
      const last = page.at(-1);
      return {
        runs,
        nextBefore: rows.length > AUTOMATION_RUN_PAGE && last ? last.id : null,
      };
    });
  }

  getRun(
    ctx: Scope,
    key: AutomationKey,
    runId: string,
    options: { includeLeadNames: boolean },
  ): Promise<FlowRun | undefined> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const rows = await selectRuns(
        tx,
        ctx.workspaceId,
        and(eq(automationRuns.automationKey, key), eq(automationRuns.id, runId)),
      );
      const [run] = await shapeRuns(tx, ctx.workspaceId, rows, options.includeLeadNames);
      return run;
    });
  }

  saveDraft(
    ctx: WriteScope,
    key: AutomationKey,
    input: SaveFlowDraftRequest,
  ): Promise<FlowStoreOutcome<{ flow: StoredFlow; issues: FlowIssue[] }>> {
    return this.database.withTenantTx(
      ctx,
      async (tx): Promise<FlowStoreOutcome<{ flow: StoredFlow; issues: FlowIssue[] }>> => {
        await ensureBuiltInFlows(tx, ctx);
        const locked = await lockFlow(tx, ctx.workspaceId, key);
        if (!locked) return { status: 'not_found' };
        if (locked.revision !== input.expectedRevision) return { status: 'revision_conflict' };
        if (locked.archived) return { status: 'archived' };
        // The request schema takes `main` (a built-in's draft travels with it);
        // the flow's own origin decides whether it may hold it.
        const parsed = flowDraftSchemaFor(locked.origin).safeParse(input.definition);
        if (!parsed.success) return { status: 'invalid', issues: problemsOf(parsed.error.issues) };
        await writeDraft(tx, ctx, locked.id, parsed.data);
        await bumpRevision(tx, ctx, locked.id);
        const issues = checkFlowAgainstSite(parsed.data, await loadFlowSite(tx, ctx.workspaceId));
        const flow = await readFlow(tx, ctx.workspaceId, key);
        if (!flow) throw new Error('the flow vanished inside its own transaction');
        return { status: 'ok', value: { flow, issues } };
      },
    );
  }

  discardDraft(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      await ensureBuiltInFlows(tx, ctx);
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      const draft = await readDraftRow(tx, ctx.workspaceId, locked.id);
      if (!draft) return this.okFlow(tx, ctx.workspaceId, key);
      await tx
        .update(automationVersions)
        .set({ status: 'discarded' })
        .where(
          and(
            eq(automationVersions.workspaceId, ctx.workspaceId),
            eq(automationVersions.id, draft.id),
          ),
        );
      await bumpRevision(tx, ctx, locked.id);
      await audit(tx, ctx, {
        action: 'automation.draft_discarded',
        entityId: locked.id,
        after: { key, version: draft.version },
      });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  activate(
    ctx: WriteScope,
    key: AutomationKey,
    input: ActivateFlowRequest & { mayChangeLeads: boolean },
  ): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      await ensureBuiltInFlows(tx, ctx);
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      if (locked.revision !== input.expectedRevision) return { status: 'revision_conflict' };
      if (locked.archived) return { status: 'archived' };
      const draft = await readDraftRow(tx, ctx.workspaceId, locked.id);
      if (!draft) return { status: 'invalid', issues: ['no_draft'] };
      const parsed = flowDefinitionSchemaFor(locked.origin).safeParse(draft.definition);
      if (!parsed.success) return { status: 'invalid', issues: problemsOf(parsed.error.issues) };
      const definition = parsed.data;
      const issues = checkFlowAgainstSite(definition, await loadFlowSite(tx, ctx.workspaceId));
      if (issues.length > 0) return { status: 'invalid', issues };
      if (flowHasLeadChangingStep(definition.steps) && !input.mayChangeLeads) {
        return { status: 'needs_lead_manage' };
      }

      const now = new Date();
      if (locked.activeVersionId !== null) {
        await tx
          .update(automationVersions)
          .set({ status: 'retired', retiredAt: now })
          .where(
            and(
              eq(automationVersions.workspaceId, ctx.workspaceId),
              eq(automationVersions.id, locked.activeVersionId),
            ),
          );
      }
      await tx
        .update(automationVersions)
        .set({ status: 'active', activatedBy: ctx.actorId, activatedAt: now })
        .where(
          and(
            eq(automationVersions.workspaceId, ctx.workspaceId),
            eq(automationVersions.id, draft.id),
          ),
        );
      await bumpRevision(tx, ctx, locked.id, { activeVersionId: draft.id });
      await recomputeTimers(tx, ctx.workspaceId, locked.id, definition.trigger);
      await audit(tx, ctx, {
        action: 'automation.activated',
        entityId: locked.id,
        after: { key, version: draft.version },
      });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  reset(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>> {
    return this.database.withTenantTx(ctx, async (tx): Promise<FlowStoreOutcome<StoredFlow>> => {
      await ensureBuiltInFlows(tx, ctx);
      const locked = await lockFlow(tx, ctx.workspaceId, key);
      if (!locked) return { status: 'not_found' };
      if (locked.origin !== 'builtin' || !isBuiltInAutomationKey(key)) {
        return { status: 'not_builtin' };
      }
      await writeDraft(tx, ctx, locked.id, builtInFlowDefinition(key));
      await bumpRevision(tx, ctx, locked.id, { name: builtInFlowName(key) });
      await audit(tx, ctx, { action: 'automation.reset', entityId: locked.id, after: { key } });
      return this.okFlow(tx, ctx.workspaceId, key);
    });
  }

  getVersion(
    ctx: Scope,
    key: AutomationKey,
    version: number,
  ): Promise<StoredFlowVersion | undefined> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const [row] = await tx
        .select({
          version: automationVersions.version,
          status: automationVersions.status,
          definition: automationVersions.definition,
          activatedAt: automationVersions.activatedAt,
          activatedBy: automationVersions.activatedBy,
          createdAt: automationVersions.createdAt,
        })
        .from(automationVersions)
        .innerJoin(
          automations,
          and(
            eq(automations.workspaceId, automationVersions.workspaceId),
            eq(automations.id, automationVersions.automationId),
          ),
        )
        .where(
          and(
            eq(automationVersions.workspaceId, ctx.workspaceId),
            eq(automations.key, key),
            eq(automationVersions.version, version),
          ),
        );
      if (!row) return undefined;
      return { ...row, status: automationVersionStatusSchema.parse(row.status) };
    });
  }

  versions(ctx: Scope, key: AutomationKey): Promise<FlowVersionSummary[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const flow = await readFlow(tx, ctx.workspaceId, key);
      return flow ? listVersions(tx, ctx.workspaceId, flow.id) : [];
    });
  }

  detail(ctx: Scope, key: AutomationKey): Promise<FlowDetail | undefined> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await ensureBuiltInFlows(tx, ctx);
      const flow = await readFlow(tx, ctx.workspaceId, key);
      if (!flow) return undefined;
      const site = await loadFlowSite(tx, ctx.workspaceId);
      let draft: FlowDetail['draft'] = null;
      if (flow.draft) {
        const parsed = flowDraftSchemaFor(flow.origin).safeParse(flow.draft.definition);
        draft = parsed.success
          ? {
              version: flow.draft.version,
              definition: parsed.data,
              issues: checkFlowAgainstSite(parsed.data, site),
            }
          : { version: flow.draft.version, definition: null, issues: [DEFINITION_INVALID] };
      }
      return {
        flow,
        needsAttention: flowAttention(flow, site),
        draft,
        active: flow.activeVersion
          ? { version: flow.activeVersion.version, definition: parsedActiveDefinition(flow) }
          : null,
        versions: await listVersions(tx, ctx.workspaceId, flow.id),
      };
    });
  }

  catalog(ctx: Scope): Promise<Omit<FlowCatalogResponse, 'requestId'>> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const plans = await loadPlanOptions(tx);
      const catalog = await loadPropertyCatalog(tx, 'lead', { plans });

      const siteMade = await tx
        .select({
          key: emailTemplates.key,
          name: emailTemplates.name,
          subject: emailTemplates.subject,
          body: emailTemplates.body,
        })
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.workspaceId, ctx.workspaceId),
            sql`${emailTemplates.key} like 'tpl\\_%'`,
            // Archived templates are not offered (and have no limit, so they are never listed here).
            isNull(emailTemplates.archivedAt),
          ),
        )
        .orderBy(sql`lower(${emailTemplates.name})`, asc(emailTemplates.key));
      const templates: FlowCatalogResponse['templates'] = [
        // A flow cannot send the tracking code (P11).
        ...CUSTOMER_EMAIL_TEMPLATES.filter((template) => template !== 'tracking_code').map(
          (template) => ({
            key: template,
            name: emailTemplateLabel(template),
            builtIn: true,
            archived: false,
            fillIns: [...fillInsForTemplate(template)],
          }),
        ),
        ...siteMade.flatMap((row) =>
          isSiteTemplateKey(row.key)
            ? [
                {
                  key: row.key,
                  name: emailTemplateLabel(row.key, row.name),
                  builtIn: false,
                  archived: false,
                  fillIns: [
                    ...fillInsForTemplate(row.key),
                    ...templatePropertyKeys(row.subject, row.body).map(
                      (property) => `${PROPERTY_FILL_IN_PREFIX}${property}` as const,
                    ),
                  ],
                },
              ]
            : [],
        ),
      ];

      const members = await tx
        .select({ actorId: memberships.userId, displayName: memberships.displayName })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, ctx.workspaceId),
            eq(memberships.membershipType, 'staff'),
            eq(memberships.status, 'active'),
          ),
        )
        .orderBy(asc(memberships.createdAt));

      const properties: FlowCatalogResponse['properties'] = catalog.all.flatMap((property) => {
        if (property.sensitive || property.hidden) return [];
        const uses = propertyUses(catalog, property.key);
        if (uses.length === 0) return [];
        const options = property.options
          ?.filter((option) => !option.hidden)
          .map((option) => ({ value: option.value, label: option.label }));
        return [
          {
            key: property.key,
            label: property.label,
            kind: property.kind,
            ...(options ? { options } : {}),
            leadTypes: uses.map((use) => use.leadType),
            condition: uses.some((use) =>
              catalog.filterable(use.leadType).some((entry) => entry.key === property.key),
            ),
            update: uses.some(
              (use) =>
                use.entry.editable &&
                !use.entry.sensitive &&
                (use.entry.storage === 'custom' || use.entry.storage === 'form'),
            ),
            taskVariable: true,
            emailVariable: uses.every((use) => !use.entry.staffOnly),
          },
        ];
      });

      return {
        leadTypes: Object.entries(leadTypeCatalog).map(([leadType, entry]) => ({
          key: leadType,
          label: entry.label,
          stages: entry.stages.map((stage) => ({ key: stage.key, label: stage.label })),
        })),
        templates,
        members: members.flatMap((row) =>
          row.actorId === null ? [] : [{ actorId: row.actorId, displayName: row.displayName }],
        ),
        plans: plans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          leadType: plan.leadType,
          active: plan.active,
        })),
        properties,
        taskVariables: [...FLOW_TASK_VARIABLES],
      };
    });
  }

  /** The flow as stored after a change, as an `ok` outcome. */
  protected async okFlow(
    tx: TenantTransaction,
    workspaceId: string,
    key: string,
  ): Promise<FlowStoreOutcome<StoredFlow>> {
    const flow = await readFlow(tx, workspaceId, key);
    if (!flow) throw new Error('the flow vanished inside its own transaction');
    return { status: 'ok', value: flow };
  }
}
