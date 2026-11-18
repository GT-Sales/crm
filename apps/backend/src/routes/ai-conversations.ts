import {
  AI_CHAT_LIMITS,
  aiAttachmentLinkResponseSchema,
  aiConversationResponseSchema,
  aiUsageQuerySchema,
  aiUsageResponseSchema,
  createAiAttachmentIntentRequestSchema,
  createAiAttachmentIntentResponseSchema,
  deleteAiAttachmentResponseSchema,
  deleteAiConversationResponseSchema,
  finalizeAiAttachmentRequestSchema,
  finalizeAiAttachmentResponseSchema,
  getAiConversationResponseSchema,
  listAiConversationsQuerySchema,
  listAiConversationsResponseSchema,
  parseAiConversationCursor,
  renameAiConversationRequestSchema,
} from '@gt-sales/contracts';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { AiAttachmentService } from '../ai/attachments.js';
import type { AiConversationStore } from '../ai/conversation-store.js';
import type { VerifiedStaffSession } from '../auth/session.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { decideAccess, denyReasonOf } from '../staff/authorization.js';
import type { Scope } from '../tenant-scope.js';
import {
  aiChatAvailability,
  chatStoreFailure,
  decideAiAccess,
  type AiAssistantRouteDependencies,
} from './ai-assistant.js';

/**
 * Ask AI as a saved chat: the member's conversation list and conversations,
 * the files they attach, and the owner's usage view (docs/design/ai-chat.md).
 *
 * Every conversation and attachment route is guarded exactly like
 * `ai/capabilities`: the verified session names the actor, a live membership
 * read and `decideAiAccess` decide, and the assistant must be on for the
 * site. A member whose assistant access was taken away cannot read the
 * conversations they had either (403, as the chat answers them). Another
 * member's conversation is `conversation_not_found` (404), another member's
 * file `file_not_found` (404): never a 403 that would say it exists. Before
 * migrations 0034–0035 are applied these routes answer 503. Every answer is
 * `no-store` (the assistant router's own middleware).
 */

/** The action that guards Settings → Team member management (owner only, no permission grants it). */
export const AI_USAGE_ACTION = 'staff.remove' as const;

function session(req: { staffSession?: VerifiedStaffSession }): VerifiedStaffSession | undefined {
  return req.staffSession;
}

interface Guarded {
  readonly scope: Scope;
  readonly conversations: AiConversationStore;
  readonly attachments: AiAttachmentService | undefined;
}

export function createAiConversationRoutes(dependencies: AiAssistantRouteDependencies): Router {
  const router = Router();

  /** The capabilities guard, then the saved chat's own availability; answers and returns undefined on refusal. */
  async function guard(
    req: Request,
    res: Response,
    feature: 'conversations' | 'attachments',
  ): Promise<Guarded | undefined> {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = session(req);
    if (!workspaceId.success || !actor) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return undefined;
    }
    const access = await dependencies.loadAccess(actor.actorId, workspaceId.data);
    const decision = decideAiAccess(access);
    if (!decision.allowed) {
      sendStaffAuthError(
        res,
        req.id,
        decision.reason === 'assistant_not_permitted' ? 'permission_denied' : decision.reason,
        403,
      );
      return undefined;
    }
    if (!dependencies.config.enabled || !dependencies.config.workspaceIds.has(workspaceId.data)) {
      sendDomainError(res, req.id, 'ai_unavailable', 503);
      return undefined;
    }
    const scope = { workspaceId: workspaceId.data, actorId: actor.actorId };
    const availability = await aiChatAvailability(dependencies.chat, scope);
    const conversations = dependencies.chat?.conversations;
    if (feature === 'attachments' && !availability.attachments) {
      sendDomainError(res, req.id, 'attachments_unavailable', 503);
      return undefined;
    }
    if (!availability.conversations || !conversations) {
      sendDomainError(res, req.id, 'ai_unavailable', 503);
      return undefined;
    }
    return { scope, conversations, attachments: dependencies.chat?.attachments };
  }

  function failed(req: Request, res: Response, error: unknown): void {
    dependencies.reportFailure(req, chatStoreFailure('ai_chat_route_failed', error));
    if (!res.headersSent) sendStaffAuthError(res, req.id, 'internal_error', 500);
  }

  const conversationIdOf = (req: Request) => z.uuid().safeParse(req.params['conversationId']);
  const attachmentIdOf = (req: Request) => z.uuid().safeParse(req.params['attachmentId']);

  router.get('/workspaces/:workspaceId/ai/conversations', async (req, res) => {
    try {
      const query = listAiConversationsQuerySchema.safeParse(req.query);
      if (!query.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const cursor =
        query.data.cursor === undefined ? undefined : parseAiConversationCursor(query.data.cursor);
      if (query.data.cursor !== undefined && cursor === undefined) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'conversations');
      if (!guarded) return;
      const page = await guarded.conversations.list(guarded.scope, {
        limit: query.data.limit ?? AI_CHAT_LIMITS.conversationPageSize,
        ...(cursor === undefined ? {} : { cursor }),
        ...(query.data.q === undefined ? {} : { q: query.data.q }),
      });
      res.json(listAiConversationsResponseSchema.parse({ ...page, requestId: req.id }));
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get('/workspaces/:workspaceId/ai/conversations/:conversationId', async (req, res) => {
    try {
      const conversationId = conversationIdOf(req);
      if (!conversationId.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'conversations');
      if (!guarded) return;
      const found = await guarded.conversations.get(guarded.scope, conversationId.data);
      if (!found) {
        sendDomainError(res, req.id, 'conversation_not_found', 404);
        return;
      }
      res.json(getAiConversationResponseSchema.parse({ ...found, requestId: req.id }));
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.patch('/workspaces/:workspaceId/ai/conversations/:conversationId', async (req, res) => {
    try {
      const conversationId = conversationIdOf(req);
      const body = renameAiConversationRequestSchema.safeParse(req.body);
      if (!conversationId.success || !body.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'conversations');
      if (!guarded) return;
      const conversation = await guarded.conversations.rename(
        guarded.scope,
        conversationId.data,
        body.data.title,
      );
      if (!conversation) {
        sendDomainError(res, req.id, 'conversation_not_found', 404);
        return;
      }
      res.json(aiConversationResponseSchema.parse({ conversation, requestId: req.id }));
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.delete('/workspaces/:workspaceId/ai/conversations/:conversationId', async (req, res) => {
    try {
      const conversationId = conversationIdOf(req);
      if (!conversationId.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'conversations');
      if (!guarded) return;
      // The files' objects go FIRST and the rows only once every one of them
      // is gone: a failed object delete leaves the conversation as it was and
      // answers a retryable 503, so no object is ever left with no row that
      // the member's retry (or the sweep) could find it by. A file a turn
      // adds meanwhile is seen by the delete's own check and taken in the
      // next round. Deleting an object already gone (a second, concurrent
      // delete) counts as done; that delete then finds no row and is a 404.
      let outcome: 'deleted' | 'changed' | 'not_found' | 'failed' = 'changed';
      for (let round = 0; round < 3 && outcome === 'changed'; round += 1) {
        const listed = await guarded.conversations.listObjects(guarded.scope, conversationId.data);
        if (!listed) {
          outcome = 'not_found';
          break;
        }
        if (listed.objects.length > 0) {
          const removed = guarded.attachments
            ? await guarded.attachments.deleteObjects(guarded.scope, listed.objects)
            : { deleted: 0, failed: listed.objects.length };
          if (removed.failed > 0) {
            outcome = 'failed';
            break;
          }
        }
        outcome = await guarded.conversations.delete(
          guarded.scope,
          conversationId.data,
          listed.objects,
        );
      }
      if (outcome === 'not_found') {
        sendDomainError(res, req.id, 'conversation_not_found', 404);
        return;
      }
      if (outcome !== 'deleted') {
        dependencies.reportFailure(req, new Error('ai_attachment_delete_failed'));
        res.setHeader('retry-after', '5');
        sendStaffAuthError(res, req.id, 'internal_error', 503);
        return;
      }
      res.json(
        deleteAiConversationResponseSchema.parse({
          conversationId: conversationId.data,
          requestId: req.id,
        }),
      );
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post('/workspaces/:workspaceId/ai/attachments/intents', async (req, res) => {
    try {
      const body = createAiAttachmentIntentRequestSchema.safeParse(req.body);
      if (!body.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'attachments');
      if (!guarded?.attachments) return;
      // A per-member hourly budget in the shared limiter; a limiter that
      // cannot be reached refuses the upload rather than letting it through.
      let limit: Awaited<ReturnType<AiAssistantRouteDependencies['rateLimit']>>;
      try {
        limit = await dependencies.rateLimit({
          bucketKey: `ai_upload:${guarded.scope.actorId}:${guarded.scope.workspaceId}`,
          windowSeconds: 3600,
          maxCount: AI_CHAT_LIMITS.uploadsPerActorPerHour,
        });
      } catch (error) {
        dependencies.reportFailure(req, error);
        sendDomainError(res, req.id, 'attachments_unavailable', 503);
        return;
      }
      if (!limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        sendDomainError(res, req.id, 'ai_rate_limited', 429);
        return;
      }
      const outcome = await guarded.attachments.createIntent(guarded.scope, body.data);
      if (outcome.status === 'rejected') {
        sendDomainError(res, req.id, 'attachment_rejected', 400, { reason: outcome.reason });
        return;
      }
      res.status(201).json(
        createAiAttachmentIntentResponseSchema.parse({
          uploadId: outcome.uploadId,
          url: outcome.url,
          method: 'PUT',
          headers: outcome.headers,
          expiresAt: outcome.expiresAt.toISOString(),
          requestId: req.id,
        }),
      );
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post(
    '/workspaces/:workspaceId/ai/attachments/:attachmentId/finalize',
    async (req, res) => {
      try {
        const attachmentId = attachmentIdOf(req);
        const body = finalizeAiAttachmentRequestSchema.safeParse(req.body);
        if (!attachmentId.success || !body.success) {
          sendStaffAuthError(res, req.id, 'invalid_request', 400);
          return;
        }
        const guarded = await guard(req, res, 'attachments');
        if (!guarded?.attachments) return;
        const outcome = await guarded.attachments.finalize(
          guarded.scope,
          attachmentId.data,
          body.data.checksumSha256,
        );
        if (outcome.status === 'not_found') {
          sendDomainError(res, req.id, 'file_not_found', 404);
          return;
        }
        if (outcome.status === 'rejected') {
          sendDomainError(res, req.id, 'attachment_rejected', 400, { reason: outcome.reason });
          return;
        }
        res.json(
          finalizeAiAttachmentResponseSchema.parse({
            attachment: outcome.attachment,
            requestId: req.id,
          }),
        );
      } catch (error) {
        failed(req, res, error);
      }
    },
  );

  router.delete('/workspaces/:workspaceId/ai/attachments/:attachmentId', async (req, res) => {
    try {
      const attachmentId = attachmentIdOf(req);
      if (!attachmentId.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'attachments');
      if (!guarded?.attachments) return;
      const outcome = await guarded.attachments.remove(guarded.scope, attachmentId.data);
      if (outcome === 'not_found') {
        sendDomainError(res, req.id, 'file_not_found', 404);
        return;
      }
      if (outcome === 'sent') {
        // A sent file goes only with its conversation.
        sendDomainError(res, req.id, 'conflict', 409, { reason: 'attachment_sent' });
        return;
      }
      if (outcome === 'retry') {
        // Its object could not be deleted: the row stays (unsendable) for a retry.
        dependencies.reportFailure(req, new Error('ai_attachment_delete_failed'));
        res.setHeader('retry-after', '5');
        sendStaffAuthError(res, req.id, 'internal_error', 503);
        return;
      }
      res.json(
        deleteAiAttachmentResponseSchema.parse({
          attachmentId: attachmentId.data,
          requestId: req.id,
        }),
      );
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get('/workspaces/:workspaceId/ai/attachments/:attachmentId/link', async (req, res) => {
    try {
      const attachmentId = attachmentIdOf(req);
      if (!attachmentId.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const guarded = await guard(req, res, 'attachments');
      if (!guarded?.attachments) return;
      const link = await guarded.attachments.link(guarded.scope, attachmentId.data);
      if (link.status === 'not_found') {
        sendDomainError(res, req.id, 'file_not_found', 404);
        return;
      }
      res.json(
        aiAttachmentLinkResponseSchema.parse({
          url: link.url,
          expiresAt: link.expiresAt.toISOString(),
          requestId: req.id,
        }),
      );
    } catch (error) {
      failed(req, res, error);
    }
  });

  /**
   * The owner's usage view: counts per member, never content. Guarded by the
   * Team page's member-management action, not by the assistant's own access,
   * and readable while Ask AI is switched off: it is the history of what was
   * used.
   */
  router.get('/workspaces/:workspaceId/ai/usage', async (req, res) => {
    try {
      const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
      const actor = session(req);
      const query = aiUsageQuerySchema.safeParse(req.query);
      if (!workspaceId.success || !actor || !query.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const access = await dependencies.loadAccess(actor.actorId, workspaceId.data);
      const decision = decideAccess(access, AI_USAGE_ACTION);
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const usage = dependencies.chat?.usage;
      if (!usage) {
        sendDomainError(res, req.id, 'ai_unavailable', 503);
        return;
      }
      const period = query.data.period ?? 30;
      const result = await usage.usage(
        { workspaceId: workspaceId.data, actorId: actor.actorId },
        period,
      );
      res.json(aiUsageResponseSchema.parse({ period, ...result, requestId: req.id }));
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
