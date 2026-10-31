import { Router, type Request, type Response } from 'express';
import {
  AUTOMATION_MAX_FLOWS,
  activateFlowRequestSchema,
  automationKeySchema,
  createFlowRequestSchema,
  flowListQuerySchema,
  listFlowRunsQuerySchema,
  saveFlowDraftRequestSchema,
  toggleFlowRequestSchema,
  updateFlowDetailsRequestSchema,
  type ApiErrorCode,
  type AutomationKey,
  type FlowDetailResponse,
  type FlowIssue,
  type FlowListResponse,
  type FlowSummary,
} from '@gt-sales/contracts';
import { z } from 'zod';

import {
  parsedActiveDefinition,
  type FlowDetail,
  type FlowStore,
  type FlowStoreOutcome,
  type StoredFlow,
} from '../automations/flow-store.js';
import type { CustomerEmail } from '../email/senders.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { decideAccess, denyReasonOf, type StaffAccessSnapshot } from '../staff/authorization.js';
import type { Scope, WriteScope } from '../tenant-scope.js';
import type { PlanRouteDependencies } from './plans.js';

export interface AutomationRouteDependencies {
  store: FlowStore;
  /** Absent (a deployment built without mail), no site has a sender. */
  customerEmail: Pick<CustomerEmail, 'available'> | undefined;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
  /** Whether the caller may see a lead's name, email and phone. */
  canSeeContacts(access: StaffAccessSnapshot): boolean;
}

/** A flow as the list and every flow answer show it. */
export function flowSummary(flow: StoredFlow, needsAttention: FlowIssue | null): FlowSummary {
  return {
    key: flow.key,
    origin: flow.origin,
    name: flow.name,
    description: flow.description,
    enabled: flow.enabled,
    archived: flow.archived,
    trigger: parsedActiveDefinition(flow)?.trigger ?? null,
    activeVersion: flow.activeVersion?.version ?? null,
    hasDraft: flow.draft !== null,
    lastRunAt: flow.lastRunAt?.toISOString() ?? null,
    runCount: flow.runCount,
    needsAttention,
  };
}

const versionParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/)
  .transform(Number);

/** Which refusal each store outcome is, in the route's words. */
const REFUSALS: Readonly<
  Record<
    Exclude<FlowStoreOutcome<unknown>['status'], 'ok' | 'invalid'>,
    { code: ApiErrorCode; status: number }
  >
> = {
  not_found: { code: 'automation_not_found', status: 404 },
  revision_conflict: { code: 'revision_conflict', status: 409 },
  limit_reached: { code: 'automation_limit_reached', status: 409 },
  no_active_version: { code: 'no_active_version', status: 409 },
  not_builtin: { code: 'automation_not_builtin', status: 409 },
  builtin: { code: 'automation_builtin', status: 409 },
  archived: { code: 'automation_archived', status: 409 },
  needs_lead_manage: { code: 'activation_needs_lead_manage', status: 403 },
};

/**
 * The site's automation flows (phase 8 spec §8), under
 * `/workspaces/:workspaceId/automations`. Reading needs `workspace.read`
 * (lead names in runs only with contact access); every change needs
 * `integration.manage`, and activating a flow that changes leads also needs
 * `lead.manage` (R5). A key in the path is checked after the permission, so a
 * caller who may not act learns nothing about which flows exist.
 */
export function createAutomationRoutes(dependencies: AutomationRouteDependencies): Router {
  const router = Router();
  const { store } = dependencies;
  const base = '/workspaces/:workspaceId/automations';

  function failed(req: Request, res: Response, error: unknown): void {
    dependencies.reportFailure(req, error);
    sendStaffAuthError(res, req.id, 'internal_error', 500);
  }

  function workspaceIdOf(req: Request): string | undefined {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    return workspaceId.success ? workspaceId.data : undefined;
  }

  /** The flow the path names, or the 404 already sent. */
  function keyOf(req: Request, res: Response): AutomationKey | undefined {
    const key = automationKeySchema.safeParse(req.params['key']);
    if (!key.success) {
      sendDomainError(res, req.id, 'automation_not_found', 404);
      return undefined;
    }
    return key.data;
  }

  /** The caller allowed `action` on the site, or the 403 already sent. */
  async function allowed(
    req: Request,
    res: Response,
    workspaceId: string,
    action: 'workspace.read' | 'integration.manage',
  ): Promise<{ scope: WriteScope; access: StaffAccessSnapshot } | undefined> {
    const { actor, decision } = await dependencies.decide(req, workspaceId, action);
    if (!decision.allowed) {
      sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
      return undefined;
    }
    return {
      scope: { workspaceId, actorId: actor.actorId, requestId: req.id },
      access: decision.access,
    };
  }

  const canManage = (access: StaffAccessSnapshot) =>
    decideAccess(access, 'integration.manage').allowed;

  function detailResponse(
    req: Request,
    detail: FlowDetail,
    access: StaffAccessSnapshot,
  ): FlowDetailResponse {
    return {
      automation: flowSummary(detail.flow, detail.needsAttention),
      revision: detail.flow.revision,
      draft: detail.draft,
      active: detail.active,
      versions: detail.versions,
      canManage: canManage(access),
      requestId: req.id,
    };
  }

  /** Answers a store outcome: the flow's page on `ok`, else its refusal. */
  async function answer(
    req: Request,
    res: Response,
    scope: Scope,
    access: StaffAccessSnapshot,
    outcome: FlowStoreOutcome<StoredFlow>,
    successStatus = 200,
  ): Promise<void> {
    if (outcome.status === 'ok') {
      const detail = await store.detail(scope, outcome.value.key);
      if (!detail) throw new Error('a flow just changed could not be read');
      res.status(successStatus).json(detailResponse(req, detail, access));
      return;
    }
    if (outcome.status === 'invalid') {
      const listed: readonly (FlowIssue | string)[] = outcome.issues;
      const problems = listed.filter((issue): issue is string => typeof issue === 'string');
      const issues = listed.filter((issue): issue is FlowIssue => typeof issue !== 'string');
      sendDomainError(
        res,
        req.id,
        'flow_invalid',
        400,
        problems.length > 0 ? { problems } : { issues },
      );
      return;
    }
    const refusal = REFUSALS[outcome.status];
    sendDomainError(res, req.id, refusal.code, refusal.status);
  }

  /**
   * One flow-changing route: the body, the site, `integration.manage`, then
   * the key; `run` makes the change.
   */
  function change<Body>(
    method: 'post' | 'put' | 'patch',
    path: string,
    body: z.ZodType<Body> | undefined,
    run: (input: {
      req: Request;
      scope: WriteScope;
      access: StaffAccessSnapshot;
      key: AutomationKey;
      body: Body | undefined;
    }) => Promise<FlowStoreOutcome<StoredFlow>>,
  ): void {
    router[method](`${base}${path}`, async (req: Request, res: Response) => {
      const workspaceId = workspaceIdOf(req);
      const parsed = body?.safeParse(req.body);
      if (!workspaceId || (parsed !== undefined && !parsed.success)) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      try {
        const caller = await allowed(req, res, workspaceId, 'integration.manage');
        if (!caller) return;
        const key = keyOf(req, res);
        if (!key) return;
        const outcome = await run({
          req,
          scope: caller.scope,
          access: caller.access,
          key,
          body: parsed?.success ? parsed.data : undefined,
        });
        await answer(req, res, caller.scope, caller.access, outcome);
      } catch (error) {
        failed(req, res, error);
      }
    });
  }

  router.get(base, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const query = flowListQuerySchema.safeParse(req.query);
    if (!workspaceId || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'workspace.read');
      if (!caller) return;
      const { scope } = caller;
      const [result, hasSender] = await Promise.all([
        store.list(scope, {
          archived: query.data.archived === '1',
          ...(query.data.before ? { before: query.data.before } : {}),
        }),
        dependencies.customerEmail?.available(scope) ?? false,
      ]);
      const body: FlowListResponse = {
        automations: result.flows.map((flow) =>
          flowSummary(flow, result.needsAttention.get(flow.key) ?? null),
        ),
        nextBefore: result.nextBefore,
        warnings: result.warnings,
        canManage: canManage(caller.access),
        hasSender,
        limit: AUTOMATION_MAX_FLOWS,
        requestId: req.id,
      };
      res.json(body);
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post(base, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = createFlowRequestSchema.safeParse(req.body);
    if (!workspaceId || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'integration.manage');
      if (!caller) return;
      const outcome = await store.create(caller.scope, body.data);
      await answer(req, res, caller.scope, caller.access, outcome, 201);
    } catch (error) {
      failed(req, res, error);
    }
  });

  // Before `/:key`, so the catalogue is never read as a flow key.
  router.get(`${base}/catalog`, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    if (!workspaceId) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'workspace.read');
      if (!caller) return;
      res.json({ ...(await store.catalog(caller.scope)), requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get(`${base}/:key`, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    if (!workspaceId) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'workspace.read');
      if (!caller) return;
      const key = keyOf(req, res);
      if (!key) return;
      const detail = await store.detail(caller.scope, key);
      if (!detail) {
        sendDomainError(res, req.id, 'automation_not_found', 404);
        return;
      }
      res.json(detailResponse(req, detail, caller.access));
    } catch (error) {
      failed(req, res, error);
    }
  });

  change('patch', '/:key', updateFlowDetailsRequestSchema, ({ scope, key, body }) =>
    body ? store.updateDetails(scope, key, body) : Promise.reject(new Error('no body')),
  );

  // The switch keeps phase 4's route and answers the flow's summary only.
  router.put(`${base}/:key`, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = toggleFlowRequestSchema.safeParse(req.body);
    if (!workspaceId || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'integration.manage');
      if (!caller) return;
      const key = keyOf(req, res);
      if (!key) return;
      const outcome = await store.setEnabled(caller.scope, key, body.data.enabled);
      if (outcome.status !== 'ok') {
        await answer(req, res, caller.scope, caller.access, outcome);
        return;
      }
      const detail = await store.detail(caller.scope, key);
      if (!detail) throw new Error('a flow just switched could not be read');
      res.json({
        automation: flowSummary(detail.flow, detail.needsAttention),
        requestId: req.id,
      });
    } catch (error) {
      failed(req, res, error);
    }
  });

  change('put', '/:key/draft', saveFlowDraftRequestSchema, async ({ scope, key, body }) => {
    if (!body) throw new Error('no body');
    const saved = await store.saveDraft(scope, key, body);
    return saved.status === 'ok' ? { status: 'ok', value: saved.value.flow } : saved;
  });

  change('post', '/:key/draft/discard', undefined, ({ scope, key }) =>
    store.discardDraft(scope, key),
  );

  change('post', '/:key/activate', activateFlowRequestSchema, ({ scope, access, key, body }) => {
    if (!body) throw new Error('no body');
    return store.activate(scope, key, {
      ...body,
      mayChangeLeads: decideAccess(access, 'lead.manage').allowed,
    });
  });

  change('post', '/:key/reset', undefined, ({ scope, key }) => store.reset(scope, key));
  change('post', '/:key/archive', undefined, ({ scope, key }) => store.archive(scope, key));
  change('post', '/:key/restore', undefined, ({ scope, key }) => store.restore(scope, key));

  router.get(`${base}/:key/versions/:version`, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const version = versionParamSchema.safeParse(req.params['version']);
    if (!workspaceId || !version.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'workspace.read');
      if (!caller) return;
      const key = keyOf(req, res);
      if (!key) return;
      const stored = await store.getVersion(caller.scope, key, version.data);
      if (!stored) {
        sendDomainError(res, req.id, 'automation_version_not_found', 404);
        return;
      }
      res.json({
        version: {
          version: stored.version,
          status: stored.status,
          activatedAt: stored.activatedAt?.toISOString() ?? null,
          activatedBy: stored.activatedBy,
          definition: stored.definition,
        },
        requestId: req.id,
      });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get(`${base}/:key/runs`, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const query = listFlowRunsQuerySchema.safeParse(req.query);
    if (!workspaceId || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'workspace.read');
      if (!caller) return;
      const key = keyOf(req, res);
      if (!key) return;
      const page = await store.listRuns(caller.scope, key, {
        ...(query.data.before ? { before: query.data.before } : {}),
        includeLeadNames: dependencies.canSeeContacts(caller.access),
      });
      if (!page) {
        sendDomainError(res, req.id, 'automation_not_found', 404);
        return;
      }
      res.json({ runs: page.runs, nextBefore: page.nextBefore, requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get(`${base}/:key/runs/:runId`, async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const runId = z.uuid().safeParse(req.params['runId']);
    if (!workspaceId || !runId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const caller = await allowed(req, res, workspaceId, 'workspace.read');
      if (!caller) return;
      const key = keyOf(req, res);
      if (!key) return;
      const run = await store.getRun(caller.scope, key, runId.data, {
        includeLeadNames: dependencies.canSeeContacts(caller.access),
      });
      if (!run) {
        sendDomainError(res, req.id, 'automation_run_not_found', 404);
        return;
      }
      res.json({ run, requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
