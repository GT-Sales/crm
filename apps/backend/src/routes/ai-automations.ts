import { Router } from 'express';
import { z } from 'zod';
import {
  aiAutomationTokenRequestSchema,
  aiAutomationReviseRequestSchema,
  aiAutomationSimulateRequestSchema,
  aiAutomationProposalSchema,
  aiAutomationSaveResponseSchema,
  aiAutomationSimulationSchema,
} from '@gt-sales/contracts';
import type { AiAssistantRouteDependencies } from './ai-assistant.js';
import { decideAiAccess } from './ai-assistant.js';
import { decideAccess } from '../staff/authorization.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { AutomationAuthoringError } from '../ai/automation-authoring.js';
import { simulateAutomation } from '../ai/automation-simulation.js';

export function createAiAutomationRoutes(
  deps: Pick<
    AiAssistantRouteDependencies,
    | 'config'
    | 'loadAccess'
    | 'siteContext'
    | 'rateLimit'
    | 'now'
    | 'reportFailure'
    | 'automationAuthoring'
  >,
) {
  const router = Router();
  for (const operation of ['save', 'revise', 'simulate'] as const) {
    router.post(`/workspaces/:workspaceId/ai/automations/${operation}`, async (req, res) => {
      const workspace = z.uuid().safeParse(req.params['workspaceId']);
      const actor = req.staffSession;
      if (!workspace.success || !actor) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      try {
        const access = await deps.loadAccess(actor.actorId, workspace.data);
        if (
          !decideAiAccess(access).allowed ||
          !decideAccess(access, 'integration.manage').allowed
        ) {
          sendStaffAuthError(res, req.id, 'permission_denied', 403);
          return;
        }
        const config = deps.config;
        if (
          !config.enabled ||
          !config.signingKey ||
          !config.workspaceIds.has(workspace.data) ||
          !config.automationWorkspaceIds?.has(workspace.data) ||
          !deps.automationAuthoring
        ) {
          sendDomainError(res, req.id, 'ai_unavailable', 503);
          return;
        }
        const limiter = await deps.rateLimit({
          bucketKey: `ai_automation:${workspace.data}:${actor.actorId}`,
          maxCount: 30,
          windowSeconds: 60,
        });
        if (!limiter.allowed) {
          sendDomainError(res, req.id, 'rate_limited', 429);
          return;
        }
        const scope = { workspaceId: workspace.data, actorId: actor.actorId, requestId: req.id };
        const now = deps.now?.() ?? new Date();
        const store = deps.automationAuthoring;
        if (operation === 'save') {
          const body = aiAutomationTokenRequestSchema.parse(req.body);
          res.json(
            aiAutomationSaveResponseSchema.parse(
              await store.save(scope, body.token, config.signingKey, now),
            ),
          );
        } else if (operation === 'revise') {
          const body = aiAutomationReviseRequestSchema.parse(req.body);
          const site = await deps.siteContext.siteContext(scope);
          if (!site) {
            sendDomainError(res, req.id, 'ai_unavailable', 503);
            return;
          }
          res.json(
            aiAutomationProposalSchema.parse(
              await store.revise(scope, body.token, body.draft, site.name, config.signingKey, now),
            ),
          );
        } else {
          const body = aiAutomationSimulateRequestSchema.parse(req.body);
          res.json(
            aiAutomationSimulationSchema.parse(
              await simulateAutomation({
                scope,
                token: body.token,
                key: config.signingKey,
                now,
                store,
                scenario: body.scenario,
              }),
            ),
          );
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          sendDomainError(res, req.id, 'invalid_request', 400);
          return;
        }
        if (error instanceof AutomationAuthoringError) {
          if (error.code === 'revision_conflict' || error.code === 'manual_draft_exists') {
            sendDomainError(res, req.id, 'revision_conflict', 409);
            return;
          }
          sendDomainError(res, req.id, 'invalid_request', 400, { reason: error.code });
          return;
        }
        deps.reportFailure(req, error);
        sendStaffAuthError(res, req.id, 'internal_error', 500);
      }
    });
  }
  return router;
}
