import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import { AssistantProviderError } from '../ai/engine.js';
import { Router, type Response } from 'express';
import {
  AI_ASSISTANT_LIMITS,
  aiCapabilitiesResponseSchema,
  aiChatRequestSchema,
  aiStreamPartSchema,
  type AiCapabilitiesResponse,
  type AiChatRequest,
  type AiStreamPart,
} from '@gt-sales/contracts';
import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';
import { z } from 'zod';

import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import {
  decideAccess,
  denyReasonOf,
  type AuthorizationDenyReason,
  type StaffAccessSnapshot,
} from '../staff/authorization.js';
import type { VerifiedStaffSession } from '../auth/session.js';
import type { AiAssistantConfig } from '../ai/config.js';
import type { AssistantEngine } from '../ai/engine.js';
import { logAiTurn } from '../ai/logging.js';
import { TurnBudget } from '../ai/limits.js';
import { buildSystemPrompt, AI_PROMPT_VERSION } from '../ai/prompt.js';
import { ReplayGuard } from '../ai/replay-guard.js';
import { serializedBytes } from '../ai/projections.js';
import type { AiReadService } from '../ai/read-service.js';
import type { AiSiteContextStore } from '../ai/site-context.js';
import { SourceRegistry } from '../ai/sources.js';
import {
  AssistantAccessRevokedError,
  TOOL_NAMES,
  createAssistantTools,
  type AssistantToolset,
  type ToolName,
} from '../ai/tools.js';
import { businessDayLabel, AI_BUSINESS_TIME_ZONE } from '../ai/windows.js';
import type { ReportStore } from '../reports/store.js';
import type { Scope } from '../tenant-scope.js';
import type { PlanRouteDependencies } from './plans.js';

/**
 * The staff AI assistant's HTTP surface. Version 1 is read-only and answers two
 * questions — "is this available for me here?" and "answer this" — with all
 * authority derived on the server: the session names the actor, the route names
 * the site, and a live membership read decides both, again before every tool and
 * once more before the answer is released.
 */

/** The actions that, together with `workspace.read`, let a member use the assistant. */
const DETAIL_ACTIONS = ['lead.manage', 'order.manage', 'financial.read'] as const;

export type AiAccessRefusal = {
  readonly allowed: false;
  readonly reason: AuthorizationDenyReason | 'assistant_not_permitted';
};

export type AiAccessGrant = { readonly allowed: true; readonly access: StaffAccessSnapshot };

/**
 * The assistant's own access policy, expressed with the existing decision
 * function rather than a second role table: an active site membership, plus at
 * least one action that already reveals lead detail. A viewer, content or
 * partner member keeps the dashboard; the assistant is not an aggregate-only
 * side door for them.
 */
export function decideAiAccess(
  access: StaffAccessSnapshot | undefined,
): AiAccessGrant | AiAccessRefusal {
  const read = decideAccess(access, 'workspace.read');
  if (!read.allowed) return { allowed: false, reason: denyReasonOf(read) };
  const detail = DETAIL_ACTIONS.some((action) => decideAccess(access, action).allowed);
  if (!detail) return { allowed: false, reason: 'assistant_not_permitted' };
  return { allowed: true, access: read.access };
}

/** Progress labels: fixed words per tool, never the model's own narration. */
const PROGRESS_LABELS: Record<ToolName, string> = {
  getSiteOverview: 'Checking lead counts',
  findLeads: 'Searching leads',
  getLeadSummary: 'Reading the lead',
  listOpenTasks: 'Checking follow-ups',
  getSourcePerformance: 'Reading the source report',
};

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

/** Narrows a model-supplied tool name to one this route actually offers. */
function isToolName(value: string): value is ToolName {
  return TOOL_NAME_SET.has(value);
}

export interface AiAssistantRouteDependencies {
  config: AiAssistantConfig;
  /** The actor's live membership in the site; the same read the staff router uses. */
  loadAccess(actorId: string, workspaceId: string): Promise<StaffAccessSnapshot | undefined>;
  siteContext: AiSiteContextStore;
  /** The projection-aware reads behind the tools. */
  reads: AiReadService;
  /** The existing source report, reused unchanged for the source tool. */
  reports: ReportStore;
  /** Absent when the deployment is not configured: the chat then answers unavailable. */
  engine?: AssistantEngine;
  /** The distributed limiter; a failure to reach it refuses the request. */
  rateLimit(input: RateLimitInput): Promise<RateLimitResult>;
  now?: () => Date;
  reportFailure: PlanRouteDependencies['reportFailure'];
}

function session(req: { staffSession?: VerifiedStaffSession }): VerifiedStaffSession | undefined {
  return req.staffSession;
}

function sendRefusal(res: Response, requestId: string, reason: AiAccessRefusal['reason']): void {
  if (reason === 'assistant_not_permitted') {
    sendStaffAuthError(res, requestId, 'permission_denied', 403);
    return;
  }
  sendStaffAuthError(res, requestId, reason, 403);
}

function capabilityDocument(
  site: { siteId: string; slug: string; name: string; leadTypes: readonly string[] },
  requestId: string,
  unavailable?: AiCapabilitiesResponse['reason'],
): AiCapabilitiesResponse {
  return aiCapabilitiesResponseSchema.parse({
    available: unavailable === undefined,
    ...(unavailable === undefined ? {} : { reason: unavailable }),
    site: { id: site.siteId, slug: site.slug, name: site.name },
    leadTypes: [...site.leadTypes],
    limits: {
      maxMessageChars: AI_ASSISTANT_LIMITS.maxMessageChars,
      maxHistoryMessages: AI_ASSISTANT_LIMITS.maxHistoryMessages,
      maxConversationChars: AI_ASSISTANT_LIMITS.maxConversationChars,
    },
    requestId,
  });
}

/**
 * Request-size guards the schema cannot express: total conversation characters
 * and the serialized byte ceiling of the whole body (the global JSON limit stays
 * 64 KiB and is not widened).
 */
function withinRequestLimits(body: AiChatRequest): boolean {
  const characters =
    Array.from(body.message).length +
    body.history.reduce((total, message) => total + Array.from(message.text).length, 0);
  return (
    characters <= AI_ASSISTANT_LIMITS.maxConversationChars &&
    serializedBytes(body) <= AI_ASSISTANT_LIMITS.maxRequestBytes
  );
}

/**
 * In-flight answer streams, so a graceful shutdown can cancel them instead of
 * holding sockets until the platform kills the process. Aborting a turn here is
 * the same signal a browser disconnect sends: the model call stops and the
 * response ends.
 */
const activeTurns = new Set<AbortController>();

/** Aborts every in-flight assistant turn; called by the shutdown handler. */
export function abortActiveAssistantTurns(): void {
  for (const controller of activeTurns) controller.abort();
}

/** Ends waiting promptly; database statements retain their own server deadline. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AssistantProviderError('cancelled');
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AssistantProviderError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createAiAssistantRoutes(dependencies: AiAssistantRouteDependencies): Router {
  const router = Router();
  const now = () => (dependencies.now ?? (() => new Date()))();
  // One guard per router (one per process): a duplicate request id inside a
  // minute is refused rather than spending a second turn's budget.
  const replay = new ReplayGuard();

  // Nothing the assistant answers may be cached — refusals included.
  router.use((req, res, next) => {
    if (req.path.includes('/ai/')) res.setHeader('cache-control', 'no-store');
    next();
  });

  async function refuseDisabled(res: Response, requestId: string): Promise<void> {
    sendDomainError(res, requestId, 'ai_unavailable', 503);
  }

  router.get('/workspaces/:workspaceId/ai/capabilities', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = session(req);
    if (!workspaceId.success || !actor) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const access = await dependencies.loadAccess(actor.actorId, workspaceId.data);
      const decision = decideAiAccess(access);
      if (!decision.allowed) {
        sendRefusal(res, req.id, decision.reason);
        return;
      }

      const site = await dependencies.siteContext.siteContext({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
      });
      if (!site) {
        sendStaffAuthError(res, req.id, 'workspace_not_found', 404);
        return;
      }

      if (!dependencies.config.enabled) {
        res.setHeader('cache-control', 'no-store');
        res.json(capabilityDocument(site, req.id, dependencies.config.reason ?? 'disabled'));
        return;
      }
      if (!dependencies.config.workspaceIds.has(workspaceId.data)) {
        res.setHeader('cache-control', 'no-store');
        res.json(capabilityDocument(site, req.id, 'site_not_enabled'));
        return;
      }

      res.setHeader('cache-control', 'no-store');
      res.json(capabilityDocument(site, req.id));
    } catch (error) {
      dependencies.reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/ai/chat', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = session(req);
    const parsed = aiChatRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !actor || !parsed.success || !withinRequestLimits(parsed.data)) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    const body = parsed.data;
    const startedAt = Date.now();
    const controller = new AbortController();
    activeTurns.add(controller);
    let timedOut = false;
    let clientGone = false;
    let revoked = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AI_ASSISTANT_LIMITS.requestTimeoutMs);
    const onClose = () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    };
    res.on('close', onClose);
    const wait = <T>(work: Promise<T>) => abortable(work, controller.signal);

    try {
      const access = await wait(dependencies.loadAccess(actor.actorId, workspaceId.data));
      const decision = decideAiAccess(access);
      if (!decision.allowed) {
        sendRefusal(res, req.id, decision.reason);
        return;
      }
      if (!dependencies.config.enabled || !dependencies.engine) {
        await refuseDisabled(res, req.id);
        return;
      }
      if (!dependencies.config.workspaceIds.has(workspaceId.data)) {
        await refuseDisabled(res, req.id);
        return;
      }

      const site = await wait(
        dependencies.siteContext.siteContext({
          workspaceId: workspaceId.data,
          actorId: actor.actorId,
        }),
      );
      if (!site) {
        sendStaffAuthError(res, req.id, 'workspace_not_found', 404);
        return;
      }

      // Distributed budgets first: per actor and per site. A limiter that cannot
      // be reached refuses the request rather than letting usage go unbounded.
      let actorLimit: RateLimitResult;
      let siteLimit: RateLimitResult;
      try {
        actorLimit = await wait(
          dependencies.rateLimit({
            bucketKey: `ai_actor:${actor.actorId}:${workspaceId.data}`,
            windowSeconds: 60,
            maxCount: AI_ASSISTANT_LIMITS.perActorPerMinute,
          }),
        );
        siteLimit = await wait(
          dependencies.rateLimit({
            bucketKey: `ai_site:${workspaceId.data}`,
            windowSeconds: 60,
            maxCount: AI_ASSISTANT_LIMITS.perSitePerMinute,
          }),
        );
      } catch (error) {
        dependencies.reportFailure(req, error);
        await refuseDisabled(res, req.id);
        return;
      }
      if (!actorLimit.allowed || !siteLimit.allowed) {
        const retryAfter = Math.max(actorLimit.retryAfterSeconds, siteLimit.retryAfterSeconds);
        res.setHeader('retry-after', String(retryAfter));
        sendDomainError(res, req.id, 'ai_rate_limited', 429);
        return;
      }

      // A duplicate client request id inside a minute is the same question
      // twice: refuse it instead of spending a second turn.
      if (!replay.claim(`${actor.actorId}:${workspaceId.data}:${body.requestId}`)) {
        sendDomainError(res, req.id, 'conflict', 409);
        return;
      }

      const turnStarted = now();
      const scope: Scope = { workspaceId: workspaceId.data, actorId: actor.actorId };
      const budget = new TurnBudget();
      const sources = new SourceRegistry({
        workspaceSlug: site.slug,
        asOf: turnStarted,
      });

      let toolset: AssistantToolset;
      try {
        toolset = createAssistantTools({
          scope,
          site,
          now: turnStarted,
          budget,
          sources,
          reads: dependencies.reads,
          reports: dependencies.reports,
          loadAccess: () => wait(dependencies.loadAccess(actor.actorId, workspaceId.data)),
          signal: controller.signal,
          onAccessRevoked: () => {
            revoked = true;
            controller.abort();
          },
        });
      } catch (error) {
        dependencies.reportFailure(req, error);
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }

      const engine = dependencies.engine;
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          const writePart = (part: AiStreamPart) => {
            writer.write({
              type: 'data-assistant',
              data: aiStreamPartSchema.parse(part),
              transient: true,
            });
          };
          writePart({ type: 'progress', label: 'Getting ready' });

          const leadHint =
            body.context === undefined
              ? undefined
              : await wait(dependencies.reads.leadHint(scope, body.context.leadId)).catch(
                  () => undefined,
                );
          const system = buildSystemPrompt({
            siteName: site.name,
            leadTypes: site.leadTypes,
            today: businessDayLabel(turnStarted, AI_BUSINESS_TIME_ZONE),
            timeZone: AI_BUSINESS_TIME_ZONE,
            ...(leadHint === undefined
              ? {}
              : {
                  openLead: {
                    leadId: leadHint.leadId,
                    reference: leadHint.reference,
                    name: leadHint.name,
                    stageLabel: leadHint.stage,
                    leadType: leadHint.leadType,
                  },
                }),
          });
          const messages = [
            ...body.history.map((message) => ({ role: message.role, text: message.text })),
            { role: 'user' as const, text: body.message },
          ];

          let outcome: 'completed' | 'cancelled' | 'failed' | 'access_lost' = 'completed';
          let outputTokens: number | undefined;
          let finished = false;

          try {
            for await (const event of engine.stream({
              system,
              messages,
              tools: toolset.definitions,
              signal: controller.signal,
              executeTool: (name, input) =>
                isToolName(name)
                  ? toolset.execute(name, input)
                  : Promise.reject(new Error('unknown assistant tool')),
            })) {
              if (controller.signal.aborted) break;
              switch (event.type) {
                case 'text':
                  writePart({ type: 'text', text: event.text });
                  break;
                case 'tool-start':
                  writePart({
                    type: 'progress',
                    label: isToolName(event.toolName)
                      ? PROGRESS_LABELS[event.toolName]
                      : 'Checking the CRM',
                  });
                  break;
                case 'finish':
                  finished = true;
                  outputTokens = event.outputTokens;
                  break;
                default:
                  break;
              }
            }

            if (revoked) {
              outcome = 'access_lost';
              writePart({
                type: 'error',
                code: 'access_lost',
                message: 'Your access to this site changed. Close Ask AI and sign in again.',
              });
              return;
            }
            if (timedOut) {
              outcome = 'failed';
              writePart({
                type: 'error',
                code: 'timeout',
                message: 'That took too long. Try a narrower question.',
              });
              return;
            }

            if (!controller.signal.aborted) {
              // A dropped engine stream is a failed turn, even if it already
              // yielded some text. Only an explicit finish can release sources
              // and the successful terminal frame.
              if (!finished) throw new AssistantProviderError();
              // Access is rechecked before any answer is released: a role removed
              // while the model was writing must not receive the rest of the turn.
              const finalAccess = await wait(
                dependencies.loadAccess(actor.actorId, workspaceId.data),
              );
              if (!decideAiAccess(finalAccess).allowed) {
                outcome = 'access_lost';
                writePart({
                  type: 'error',
                  code: 'access_lost',
                  message: 'Your access to this site changed. Close Ask AI and sign in again.',
                });
                return;
              }
              const cards = sources.list();
              if (cards.length > 0) writePart({ type: 'sources', sources: cards });
              writePart({ type: 'done' });
            }
          } catch (error) {
            if (revoked || error instanceof AssistantAccessRevokedError) {
              outcome = 'access_lost';
              writePart({
                type: 'error',
                code: 'access_lost',
                message: 'Your access to this site changed. Close Ask AI and sign in again.',
              });
            } else if (timedOut) {
              outcome = 'failed';
              writePart({
                type: 'error',
                code: 'timeout',
                message: 'That took too long. Try a narrower question.',
              });
            } else if (clientGone || controller.signal.aborted) {
              outcome = 'cancelled';
            } else {
              outcome = 'failed';
              // The tracker gets a fixed code, not the provider's own error body.
              dependencies.reportFailure(req, new Error('assistant_provider_error'));
              writePart({
                type: 'error',
                code: error instanceof AssistantProviderError ? error.code : 'provider_unavailable',
                message: 'Ask AI could not answer just now. Nothing was changed.',
              });
            }
          } finally {
            activeTurns.delete(controller);
            clearTimeout(timer);
            logAiTurn({
              requestId: req.id,
              workspaceId: workspaceId.data,
              actorId: actor.actorId,
              engine: engine.kind,
              modelId: dependencies.config.modelId,
              promptVersion: AI_PROMPT_VERSION,
              outcome,
              durationMs: Date.now() - startedAt,
              ...(outputTokens === undefined ? {} : { outputTokens }),
              ...budget.usage,
            });
          }
        },
        onError: () => 'Ask AI could not answer just now.',
      });
      try {
        await pipeUIMessageStreamToResponse({
          response: res,
          stream,
          headers: { 'cache-control': 'no-store' },
        });
      } finally {
        controller.abort();
        activeTurns.delete(controller);
        clearTimeout(timer);
        res.off('close', onClose);
      }
    } catch {
      dependencies.reportFailure(req, new Error('assistant_request_failed'));
      if (!res.headersSent) sendStaffAuthError(res, req.id, 'internal_error', 503);
      else if (!res.writableEnded) res.end();
    } finally {
      controller.abort();
      activeTurns.delete(controller);
      clearTimeout(timer);
      res.off('close', onClose);
    }
  });

  return router;
}
