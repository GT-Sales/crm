import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  aiAutomationProposals,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  aiAutomationProposalInputSchema,
  aiAutomationSaveResponseSchema,
  flowDraftSchemaFor,
  checkFlowAgainstSite,
  walkDraftSteps,
  type AiAutomationProposal,
  type AiAutomationProposalInput,
  type AiAutomationDraft,
  type AiAutomationSaveResponse,
  type FlowDraft,
} from '@gt-sales/contracts';
import { DatabaseFlowStore, type FlowStoreOutcome } from '../automations/flow-store.js';
import { loadFlowSite } from '../automations/site.js';
import type { WriteScope, Scope } from '../tenant-scope.js';

const TTL = 10 * 60_000;
export class AutomationAuthoringError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'revision_conflict'
      | 'invalid'
      | 'expired'
      | 'limit_reached'
      | 'archived'
      | 'manual_draft_exists',
  ) {
    super(code);
  }
}
function valueOf<T>(outcome: FlowStoreOutcome<T>): T {
  if (outcome.status !== 'ok')
    throw new AutomationAuthoringError(
      outcome.status === 'revision_conflict'
        ? 'revision_conflict'
        : outcome.status === 'limit_reached'
          ? 'limit_reached'
          : outcome.status === 'archived'
            ? 'archived'
            : 'invalid',
    );
  return outcome.value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function digestOf(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
/**
 * The token's MAC binds the proposal id and digest to the member and site it
 * was made for (v2), so a token is worthless anywhere else even before its
 * row is read. A v1 token (id and digest only) no longer verifies: it lived
 * ten minutes at most.
 */
function mac(payload: string, key: string, scope: Scope) {
  return createHmac('sha256', key)
    .update(`gt-sales/ai-automation/v2:${scope.workspaceId}:${scope.actorId}:${payload}`)
    .digest('base64url');
}
function sign(id: string, digest: string, key: string, scope: Scope) {
  const payload = id + '.' + digest;
  return payload + '.' + mac(payload, key, scope);
}
function verify(token: string, key: string, scope: Scope) {
  const [id, digest, signature, extra] = token.split('.');
  if (!id || !digest || !signature || extra !== undefined)
    throw new AutomationAuthoringError('invalid');
  const expected = Buffer.from(mac(id + '.' + digest, key, scope));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AutomationAuthoringError('invalid');
  return { id, digest };
}
/**
 * Server-made step ids: a step keeps its id when the base flow or, on a
 * revision, the reviewed proposal already had it (AUTH-5), so the changes
 * read "Change X" rather than "Remove X / Add X"; any other id, or a second
 * use of one, is replaced.
 */
function normalizedDefinition(
  definition: FlowDraft,
  existing: FlowDraft | undefined,
  keep: ReadonlySet<string> = new Set(),
): FlowDraft {
  const ids = new Set<string>(keep);
  if (existing) walkDraftSteps(existing.steps, (step) => ids.add(step.id));
  const copy = structuredClone(definition);
  const used = new Set<string>();
  walkDraftSteps(copy.steps, (step) => {
    if (!ids.has(step.id) || used.has(step.id))
      step.id = 's_' + randomUUID().replaceAll('-', '').slice(0, 20);
    used.add(step.id);
  });
  return copy;
}
export function automationChanges(
  before: AiAutomationDraft | undefined,
  after: AiAutomationDraft,
): string[] {
  if (!before) return ['Create a new draft. The flow starts Off.'];
  const changes: string[] = [];
  if (before.name !== after.name) changes.push('Rename flow: ' + before.name + ' → ' + after.name);
  if (before.description !== after.description) changes.push('Change description');
  if (JSON.stringify(before.definition.trigger) !== JSON.stringify(after.definition.trigger))
    changes.push('Change trigger or entry conditions');
  const old = new Map<string, string>();
  const next = new Map<string, string>();
  const labels = new Map<string, string>();
  const kindLabels: Readonly<Record<string, string>> = {
    send_email: 'Email',
    create_task: 'Create task',
    assign_lead: 'Assign lead',
    update_lead: 'Update lead',
    notify_staff: 'Notify staff',
    if_else: 'If/else',
    wait: 'Wait',
  };
  const label = (kind: string) => kindLabels[kind] ?? 'Action';
  walkDraftSteps(before.definition.steps, (s) => labels.set(s.id, label(s.kind)));
  walkDraftSteps(after.definition.steps, (s) => labels.set(s.id, label(s.kind)));
  walkDraftSteps(before.definition.steps, (s) => old.set(s.id, JSON.stringify(s)));
  walkDraftSteps(after.definition.steps, (s) => next.set(s.id, JSON.stringify(s)));
  for (const [id, step] of next)
    changes.push(
      ...(!old.has(id)
        ? ['Add ' + labels.get(id) + ' step']
        : old.get(id) !== step
          ? ['Change ' + labels.get(id) + ' step']
          : []),
    );
  for (const id of old.keys())
    if (!next.has(id)) changes.push('Remove ' + labels.get(id) + ' step');
  if (
    JSON.stringify(before.definition.steps.map((s) => s.id)) !==
    JSON.stringify(after.definition.steps.map((s) => s.id))
  )
    changes.push('Change top-level step order');
  return changes.length ? changes.slice(0, 100) : ['No changes'];
}

/** The proposals one member made on one site: the only rows any statement here may touch. */
function ownProposals(scope: Scope) {
  return and(
    eq(aiAutomationProposals.workspaceId, scope.workspaceId),
    eq(aiAutomationProposals.actorId, scope.actorId),
  );
}

export class AutomationAuthoringStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}
  private flows(tx: TenantTransaction) {
    return new DatabaseFlowStore({ withTenantTx: async (_scope, work) => work(tx) });
  }
  async prepare(
    scope: WriteScope,
    input: AiAutomationProposalInput,
    siteName: string,
    key: string,
    now: Date,
    options: { keepIds?: ReadonlySet<string> } = {},
  ): Promise<AiAutomationProposal> {
    const parsed = aiAutomationProposalInputSchema.parse(input);
    return this.database.withTenantTx(scope, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'ai-automation:' + scope.workspaceId + ':' + scope.actorId}, 0))`,
      );
      // Every statement names its actor and site explicitly. Row-level security
      // enforces the same rule; the predicates keep housekeeping and the cap
      // correct even if that policy is ever widened (for an audit view, say).
      await tx
        .delete(aiAutomationProposals)
        .where(
          and(
            ownProposals(scope),
            lt(aiAutomationProposals.createdAt, new Date(now.getTime() - 24 * 60 * 60_000)),
          ),
        );
      // AUTH-11: saved receipts and expired or superseded proposals are not
      // open drafts, so they do not count toward the cap.
      const rows = await tx
        .select({ id: aiAutomationProposals.id })
        .from(aiAutomationProposals)
        .where(
          and(
            ownProposals(scope),
            isNull(aiAutomationProposals.result),
            gt(aiAutomationProposals.expiresAt, now),
          ),
        )
        .limit(101);
      if (rows.length >= 100) throw new AutomationAuthoringError('limit_reached');
      const flows = this.flows(tx);
      let before: AiAutomationDraft | undefined;
      let origin: 'custom' | 'builtin' = 'custom';
      if (parsed.target) {
        const current = await flows.get(scope, parsed.target.key);
        if (!current) throw new AutomationAuthoringError('not_found');
        if (current.archived) throw new AutomationAuthoringError('archived');
        if (current.revision !== parsed.target.expectedRevision)
          throw new AutomationAuthoringError('revision_conflict');
        if (parsed.target.base === 'active' && current.draft)
          throw new AutomationAuthoringError('manual_draft_exists');
        const base = parsed.target.base === 'draft' ? current.draft : current.activeVersion;
        if (!base) throw new AutomationAuthoringError('invalid');
        origin = current.origin;
        before = {
          name: current.name,
          description: current.description ?? '',
          definition: flowDraftSchemaFor(origin).parse(base.definition),
        };
      }
      const definition = flowDraftSchemaFor(origin).parse(
        normalizedDefinition(parsed.draft.definition, before?.definition, options.keepIds),
      );
      const draft = { ...parsed.draft, definition };
      const payload = { draft, ...(parsed.target ? { target: parsed.target } : {}) };
      const issues = checkFlowAgainstSite(definition, await loadFlowSite(tx, scope.workspaceId));
      const catalog = await flows.catalog(scope);
      const id = randomUUID(),
        digest = digestOf(payload),
        expiresAt = new Date(now.getTime() + TTL);
      await tx.insert(aiAutomationProposals).values({
        id,
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        payload,
        digest,
        expiresAt,
        createdAt: now,
      });
      return {
        id,
        token: sign(id, digest, key, scope),
        expiresAt: expiresAt.toISOString(),
        siteName,
        draft,
        ...(before ? { before } : {}),
        ...(parsed.target ? { target: parsed.target } : {}),
        issues,
        changes: automationChanges(before, draft),
        catalog,
      };
    });
  }
  async revise(
    scope: WriteScope,
    token: string,
    draft: AiAutomationDraft,
    siteName: string,
    key: string,
    now: Date,
  ): Promise<AiAutomationProposal> {
    return this.database.withTenantTx(scope, async (tx) => {
      const child = new AutomationAuthoringStore({
        withTenantTx: async (_scope, work) => work(tx),
      });
      const original = await child.load(scope, token, key, now);
      const keepIds = new Set<string>();
      walkDraftSteps(original.draft.definition.steps, (step) => keepIds.add(step.id));
      const next = await child.prepare(scope, { ...original, draft }, siteName, key, now, {
        keepIds,
      });
      await tx
        .update(aiAutomationProposals)
        .set({ expiresAt: now })
        .where(
          and(ownProposals(scope), eq(aiAutomationProposals.id, verify(token, key, scope).id)),
        );
      return next;
    });
  }
  async load(
    scope: Scope,
    token: string,
    key: string,
    now: Date,
    options: { lock?: boolean } = {},
  ): Promise<AiAutomationProposalInput> {
    const signed = verify(token, key, scope);
    return this.database.withTenantTx(scope, async (tx) => {
      const query = tx
        .select()
        .from(aiAutomationProposals)
        .where(
          and(
            eq(aiAutomationProposals.id, signed.id),
            eq(aiAutomationProposals.workspaceId, scope.workspaceId),
            eq(aiAutomationProposals.actorId, scope.actorId),
          ),
        );
      // AUTH-8: a revision locks the row it supersedes; a simulation only reads.
      const [row] = options.lock === false ? await query : await query.for('update');
      if (!row || row.digest !== signed.digest || row.digest !== digestOf(row.payload))
        throw new AutomationAuthoringError('not_found');
      if (row.expiresAt.getTime() <= now.getTime() || row.result)
        throw new AutomationAuthoringError('expired');
      return aiAutomationProposalInputSchema.parse(row.payload);
    });
  }
  async save(
    scope: WriteScope,
    token: string,
    key: string,
    now: Date,
  ): Promise<AiAutomationSaveResponse> {
    const signed = verify(token, key, scope);
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx
        .select()
        .from(aiAutomationProposals)
        .where(
          and(
            eq(aiAutomationProposals.id, signed.id),
            eq(aiAutomationProposals.workspaceId, scope.workspaceId),
            eq(aiAutomationProposals.actorId, scope.actorId),
          ),
        )
        .for('update');
      if (!row || row.digest !== signed.digest || row.digest !== digestOf(row.payload))
        throw new AutomationAuthoringError('not_found');
      // Saved receipts remain retryable for 24h; expired unsaved proposals cannot execute.
      if (row.createdAt.getTime() + 24 * 60 * 60_000 <= now.getTime())
        throw new AutomationAuthoringError('expired');
      if (row.result) {
        // A receipt this version cannot read is a server fault, not a bad request (AUTH-7).
        const receipt = aiAutomationSaveResponseSchema.safeParse(row.result);
        if (!receipt.success) throw new Error('ai_automation_receipt_invalid');
        return receipt.data;
      }
      if (row.expiresAt.getTime() <= now.getTime()) throw new AutomationAuthoringError('expired');
      const input = aiAutomationProposalInputSchema.parse(row.payload);
      const flows = this.flows(tx);
      let flow;
      if (input.target) {
        flow = await flows.get(scope, input.target.key);
        if (!flow) throw new AutomationAuthoringError('not_found');
        if (flow.revision !== input.target.expectedRevision)
          throw new AutomationAuthoringError('revision_conflict');
      } else
        flow = valueOf(
          await flows.create(scope, {
            name: input.draft.name,
            description: input.draft.description,
          }),
        );
      // Shared store validates origin and site rules, and the outer transaction keeps
      // draft creation, metadata and receipt atomic on failure or disconnect/retry.
      const saved = valueOf(
        await flows.saveDraft(scope, flow.key, {
          expectedRevision: flow.revision,
          definition: input.draft.definition,
        }),
      );
      const updated = valueOf(
        await flows.updateDetails(scope, flow.key, {
          expectedRevision: saved.flow.revision,
          name: input.draft.name,
          description: input.draft.description,
        }),
      );
      const result: AiAutomationSaveResponse = {
        status: 'saved',
        key: updated.key,
        revision: updated.revision,
      };
      await tx
        .update(aiAutomationProposals)
        .set({ result })
        .where(and(ownProposals(scope), eq(aiAutomationProposals.id, row.id)));
      return result;
    });
  }
}
