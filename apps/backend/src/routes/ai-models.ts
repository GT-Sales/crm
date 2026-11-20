import {
  AI_MODEL_LIMITS,
  aiModelSettingsResponseSchema,
  updateAiModelSettingsRequestSchema,
  updateAiModelSettingsResponseSchema,
  type AiCatalogueModel,
  type AiModelChoice,
} from '@gt-sales/contracts';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { AiCatalogueResult } from '../ai/model-catalogue.js';
import type { StoredAiModelSettings } from '../ai/model-settings-store.js';
import type { VerifiedStaffSession } from '../auth/session.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { decideAccess, denyReasonOf } from '../staff/authorization.js';
import type { Scope } from '../tenant-scope.js';
import type { AiAssistantRouteDependencies } from './ai-assistant.js';
import { AI_USAGE_ACTION } from './ai-conversations.js';

/**
 * Settings → AI models: the owner reads the Gateway catalogue and the site's
 * saved list, and saves the models members may choose and the default
 * (docs/RUNBOOKS/ai-assistant.md, "Switching models"). Both routes are guarded
 * by the AI usage page's action (`AI_USAGE_ACTION`, owner only) through
 * `decideAccess`, and both answer while Ask AI is switched off for the site,
 * so an owner can prepare the list before switching it on. The browser never
 * sends a label or a price: on save each id is looked up in the catalogue read
 * for that save, and its name there becomes its label. Every answer is
 * `no-store` (the assistant router's own middleware).
 */

function session(req: { staffSession?: VerifiedStaffSession }): VerifiedStaffSession | undefined {
  return req.staffSession;
}

function savedDocument(saved: StoredAiModelSettings) {
  return {
    allowedModels: saved.allowedModels.map((model) => ({ id: model.id, label: model.label })),
    defaultModel: saved.defaultModel,
    updatedAt: saved.updatedAt.toISOString(),
  };
}

export function createAiModelRoutes(dependencies: AiAssistantRouteDependencies): Router {
  const router = Router();
  const path = '/workspaces/:workspaceId/ai/model-settings';

  /** The owner's guard; answers and returns undefined on refusal. */
  async function guard(req: Request, res: Response): Promise<Scope | undefined> {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = session(req);
    if (!workspaceId.success || !actor) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return undefined;
    }
    const access = await dependencies.loadAccess(actor.actorId, workspaceId.data);
    const decision = decideAccess(access, AI_USAGE_ACTION);
    if (!decision.allowed) {
      sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
      return undefined;
    }
    return { workspaceId: workspaceId.data, actorId: actor.actorId };
  }

  /** The catalogue, when this deployment can read it at all (Ask AI configured with its key). */
  async function catalogue(fresh: boolean): Promise<AiCatalogueResult> {
    const source = dependencies.models?.catalogue;
    if (!dependencies.config.enabled || !source) return { status: 'unavailable' };
    return source.models({ fresh });
  }

  function failed(req: Request, res: Response, error: unknown): void {
    dependencies.reportFailure(req, error);
    if (!res.headersSent) sendStaffAuthError(res, req.id, 'internal_error', 500);
  }

  router.get(path, async (req, res) => {
    try {
      const scope = await guard(req, res);
      if (!scope) return;
      const { config } = dependencies;
      const settings = dependencies.models?.settings;
      const storage = settings ? await settings.available(scope) : false;
      const saved = storage && settings ? await settings.get(scope) : undefined;
      const listed = await catalogue(false);
      res.json(
        aiModelSettingsResponseSchema.parse({
          assistant: {
            enabled: config.enabled && config.workspaceIds.has(scope.workspaceId),
            configuredModel: config.modelId ?? null,
            highEffortModel: config.highEffort?.ownModel ? config.highEffort.modelId : null,
          },
          storage,
          providers: [...(config.providers ?? [])],
          saved: saved ? savedDocument(saved) : null,
          catalogue:
            listed.status === 'ok'
              ? { available: true, models: [...listed.models] }
              : { available: false, models: [] },
          maxAllowed: AI_MODEL_LIMITS.maxAllowed,
          requestId: req.id,
        }),
      );
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.put(path, async (req, res) => {
    try {
      const body = updateAiModelSettingsRequestSchema.safeParse(req.body);
      if (!body.success) {
        // The guard first, so a refusal never says more than a 403 would.
        const scope = await guard(req, res);
        if (scope) sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const scope = await guard(req, res);
      if (!scope) return;
      const settings = dependencies.models?.settings;
      if (!dependencies.config.enabled || !dependencies.models?.catalogue) {
        sendDomainError(res, req.id, 'ai_unavailable', 503);
        return;
      }
      if (!settings || !(await settings.available(scope))) {
        sendDomainError(res, req.id, 'ai_models_unavailable', 503, { reason: 'storage' });
        return;
      }
      // Every id against the catalogue of this moment, never a cached one.
      const listed = await catalogue(true);
      if (listed.status !== 'ok') {
        sendDomainError(res, req.id, 'ai_models_unavailable', 503, { reason: 'catalogue' });
        return;
      }
      const byId = new Map<string, AiCatalogueModel>(
        listed.models.map((model) => [model.id, model]),
      );
      const allowedModels: AiModelChoice[] = [];
      for (const id of body.data.allowedModels) {
        const found = byId.get(id);
        if (!found) {
          sendDomainError(res, req.id, 'invalid_request', 400, {
            reason: 'model_unavailable',
            modelId: id,
          });
          return;
        }
        allowedModels.push({ id, label: found.name });
      }
      const outcome = await settings.save(
        { ...scope, requestId: req.id },
        { allowedModels, defaultModel: body.data.defaultModel },
      );
      if (outcome.status === 'unavailable') {
        sendDomainError(res, req.id, 'ai_models_unavailable', 503, { reason: 'storage' });
        return;
      }
      res.json(
        updateAiModelSettingsResponseSchema.parse({
          saved: savedDocument(outcome.settings),
          requestId: req.id,
        }),
      );
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
