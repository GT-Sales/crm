import { createAiAutomationRoutes } from './ai-automations.js';
import {
  createAutomationTools,
  AUTOMATION_READ_TOOL_NAMES,
  AUTOMATION_TOOL_NAMES,
} from '../ai/automation-tools.js';
import type { AutomationAuthoringStore } from '../ai/automation-authoring.js';
import type { FlowStore } from '../automations/flow-store.js';
import { AISDKError, tool, createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import { randomUUID } from 'node:crypto';

import { AssistantProviderError, type EngineAttachment, type EngineMessage } from '../ai/engine.js';
import type { AiChatSchemaProbe } from '../ai/chat-schema.js';
import { aiAttachmentAccept, type AiAttachmentService } from '../ai/attachments.js';
import {
  sharedAttachmentByteBudget,
  type AttachmentBudgetLease,
  type AttachmentByteBudget,
} from '../ai/attachment-budget.js';
import {
  conversationTitleFrom,
  type AiConversationStore,
  type AiReplayMessage,
  type AiTurnAttachment,
} from '../ai/conversation-store.js';
import type { AiUsageStore } from '../ai/usage-store.js';
import { createAiConversationRoutes } from './ai-conversations.js';
import { createCrmGuideTool, runCrmGuide } from '../ai/crm-guide.js';
import {
  aiActionRootId,
  createActionProposalTools,
  taskRefusalReason,
  taskToolInputOf,
  verifyAiAction,
} from '../ai/actions.js';
import { signAssistantTurn, trustedHistory } from '../ai/history.js';
import type { LeadWorkStore } from '../leads/work-store.js';
import type { AiTurnStore } from '../ai/turn-store.js';
import { Router, type Request, type Response } from 'express';
import {
  reviseAiActionRequestSchema,
  aiFollowUpToolInputSchema,
  aiAutomationProposalSchema,
  aiActionProposalSchema,
  aiAssistantHistoryText,
  type AiFollowUp,
  type AiActionDraft,
  AI_ASSISTANT_LIMITS,
  AI_EFFORTS,
  aiCapabilitiesResponseSchema,
  confirmAiActionRequestSchema,
  confirmAiActionResponseSchema,
  aiChatRequestSchema,
  aiStreamPartSchema,
  AI_CHAT_LIMITS,
  type AiAttachmentKind,
  type AiSource,
  type AiCapabilitiesResponse,
  type AiChatRequest,
  type AiEffort,
  type AiStreamPart,
  leadStageLabel,
  leadTypeLabel,
} from '@gt-sales/contracts';
import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';
import { z } from 'zod';

import { sendDomainError } from '../http/domain-errors.js';
import { sendLeadUpdateRefusal } from '../http/lead-update-errors.js';
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
import { logAiTurn, type AiTurnLog } from '../ai/logging.js';
import { chargeDailyAttachmentBytes, TurnBudget, turnLimits } from '../ai/limits.js';
import { buildSystemPrompt, openLeadDataBlock, AI_PROMPT_VERSION } from '../ai/prompt.js';
import { serializedBytes } from '../ai/projections.js';
import type { AiReadService } from '../ai/read-service.js';
import type { AiSiteContextStore } from '../ai/site-context.js';
import { SourceRegistry } from '../ai/sources.js';
import {
  WIDE_READ_TOOL_NAMES,
  createWideReadTools,
  type WideReadStores,
  type WideReadToolName,
} from '../ai/read-tools.js';
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
 * The staff AI assistant's HTTP surface: reads, signed drafts, and explicit confirmation. Answers two
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
  getInboxCounts: 'Checking the inbox counters',
};

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);
const WIDE_READ_NAME_SET: ReadonlySet<string> = new Set(WIDE_READ_TOOL_NAMES);

/** Narrows a model-supplied tool name to one of the smaller reads. */
function isWideReadName(value: string): value is WideReadToolName {
  return WIDE_READ_NAME_SET.has(value);
}

/** Narrows a model-supplied tool name to one this route actually offers. */
function isToolName(value: string): value is ToolName {
  return TOOL_NAME_SET.has(value);
}

export interface AiAssistantRouteDependencies {
  automationAuthoring?: AutomationAuthoringStore;
  flows?: FlowStore;
  work?: Pick<
    LeadWorkStore,
    | 'addNote'
    | 'createTask'
    | 'createPlainTask'
    | 'plainTasksReady'
    | 'previewAiTaskUpdate'
    | 'confirmAiTaskUpdate'
    | 'queueAiEmail'
    | 'previewAiEmail'
    | 'previewAiLeadUpdate'
    | 'confirmAiLeadUpdate'
    | 'aiCardOf'
  >;
  listAssignees?: (scope: Scope) => Promise<{ actorId: string; displayName: string | null }[]>;
  config: AiAssistantConfig;
  /** The actor's live membership in the site; the same read the staff router uses. */
  loadAccess(actorId: string, workspaceId: string): Promise<StaffAccessSnapshot | undefined>;
  siteContext: AiSiteContextStore;
  /** The projection-aware reads behind the tools. */
  reads: AiReadService;
  /** The existing source report, reused unchanged for the source tool. */
  reports: ReportStore;
  /**
   * The stores behind Ask AI's smaller reads (plans, properties, analytics,
   * documents queue, mail, jobs, members, email settings), each the one its
   * staff route uses. A read whose store is absent is not offered.
   */
  wideReads?: WideReadStores;
  /** Absent when the deployment is not configured: the chat then answers unavailable. */
  engine?: AssistantEngine;
  /** The distributed limiter; a failure to reach it refuses the request. */
  rateLimit(input: RateLimitInput): Promise<RateLimitResult>;
  /** Where each turn's usage is recorded; absent in tests that do not check it. */
  turns?: AiTurnStore;
  /**
   * Ask AI as a saved chat (docs/design/ai-chat.md). Absent, or with a
   * schema not yet migrated, the assistant is memory-only exactly as before:
   * capabilities claim no `conversations`, and a chat naming a conversation
   * and the conversation and attachment routes answer 503. The usage view
   * needs only its store (it reads `ai_turns`, which exists before 0034).
   */
  chat?: AiChatDependencies;
  now?: () => Date;
  reportFailure: PlanRouteDependencies['reportFailure'];
}

export interface AiChatDependencies {
  /** The member's own conversations and messages. */
  conversations?: AiConversationStore;
  /** Uploads, verification, links and the sweep; absent when storage is not configured. */
  attachments?: AiAttachmentService;
  /** The owner's usage view. */
  usage?: AiUsageStore;
  /** Whether migrations 0034–0036 are applied; never claims conversations without it. */
  schema: AiChatSchemaProbe;
  /** The bound on attachment bytes held for the model; the process-wide one by default. */
  memoryBudget?: AttachmentByteBudget;
}

/** What the saved chat can do for this site right now. */
export interface AiChatAvailability {
  readonly conversations: boolean;
  readonly attachments: boolean;
}

/** Off unless the store is wired and the database holds its tables; a failed check is "off". */
export async function aiChatAvailability(
  chat: AiChatDependencies | undefined,
  scope: Scope,
): Promise<AiChatAvailability> {
  if (!chat?.conversations) return { conversations: false, attachments: false };
  const state = await chat.schema.state(scope).catch(() => undefined);
  const conversations = state?.conversations === true;
  return {
    conversations,
    attachments: conversations && (chat.attachments?.kinds.length ?? 0) > 0,
  };
}

/**
 * Audit B8: how a clicked follow-up choice reaches the model, so it is never
 * mistaken for words the person typed. The choice is the model's own text,
 * bounded by `AI_FOLLOW_UP_LIMITS`.
 */
export function selectedChoiceText(choice: string): string {
  return `[The person picked this option from the choices you offered earlier in this chat; it is your wording, not a new request from them]\n${choice}`;
}

/**
 * A failure of the saved chat's storage, for the error tracker: a fixed code
 * and the SQLSTATE when there is one, never the error itself, whose detail
 * could repeat a failing row (a message's text, a title or a file name).
 */
export function chatStoreFailure(code: string, error: unknown): Error {
  for (let current: unknown = error, depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code))
      return new Error(`${code}:${current.code}`);
    current = 'cause' in current ? current.cause : undefined;
  }
  return new Error(code);
}

/** A stored conversation's turn, from the member's saved message to the answer's id. */
interface StoredTurn {
  readonly conversationId: string;
  readonly title: string;
  readonly created: boolean;
  readonly userMessageId: string;
  /** Chosen now, so `done.messageId` can name the answer that is stored when the turn ends. */
  readonly answerId: string;
  readonly attachments: readonly AiTurnAttachment[];
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
  canAct = false,
  automationAuthoring = false,
  chat?: { availability: AiChatAvailability; kinds: readonly AiAttachmentKind[] },
  highEffort = false,
  plainTasks = false,
): AiCapabilitiesResponse {
  return aiCapabilitiesResponseSchema.parse({
    available: unavailable === undefined,
    // Only where High is on: absent, the composer shows no effort control
    // (and an older admin, which does not know the field, strips it).
    ...(highEffort && unavailable === undefined ? { efforts: [...AI_EFFORTS] } : {}),
    ...(automationAuthoring ? { automationAuthoring: true } : {}),
    ...(chat?.availability.conversations ? { conversations: true } : {}),
    ...(chat?.availability.attachments && chat.kinds.length > 0
      ? {
          attachments: {
            kinds: [...chat.kinds],
            accept: aiAttachmentAccept(chat.kinds),
            maxPerMessage: AI_CHAT_LIMITS.maxAttachmentsPerMessage,
            maxImageBytes: AI_CHAT_LIMITS.maxImageBytes,
            maxPdfBytes: AI_CHAT_LIMITS.maxPdfBytes,
            maxTextFileBytes: AI_CHAT_LIMITS.maxTextFileBytes,
          },
        }
      : {}),
    actions: canAct && unavailable === undefined ? ['task', 'note', 'email', 'lead_update'] : [],
    // Beside `actions`, never in it: an older admin's enum there knows four kinds.
    ...(canAct && unavailable === undefined
      ? { taskActions: plainTasks ? ['plain_task', 'task_update'] : ['task_update'] }
      : {}),
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

/** Members a lead-update preview may list: the contract's 100 choices, Unassigned included. */
const AI_ASSIGNEE_CHOICES_MAX = 99;

/** Confirm and revise requests per member per site per minute (CHAT-9). */
const AI_CARD_REQUESTS_PER_MINUTE = 30;

/** CHAT-12: what the panel says while an action or automation tool runs. */
const CARD_PROGRESS_LABELS: Readonly<Record<string, string>> = {
  prepareNote: 'Preparing a note for review',
  prepareTask: 'Preparing a task for review',
  prepareTaskUpdate: 'Preparing a task move for review',
  prepareEmail: 'Preparing an email for review',
  getLeadUpdateOptions: 'Checking the lead’s choices',
  prepareLeadUpdate: 'Preparing a lead change for review',
  listAutomations: 'Reading the automations',
  getAutomation: 'Reading the automation',
  getAutomationCatalog: 'Checking what automations can use',
  getAutomationRuns: 'Reading recent runs',
  proposeAutomationCreate: 'Drafting an automation for review',
  proposeAutomationEdit: 'Drafting automation changes for review',
  askFollowUp: 'Preparing a question',
  getCrmGuide: 'Looking up the CRM guide',
};

/** The longest text part the stream sends; a longer provider chunk is split. */
const AI_TEXT_PART_CHARS = 8_000;

/** How long a chat request id stays claimed in the shared limiter. */
export const AI_REPLAY_WINDOW_SECONDS = 3600;

/**
 * What the error tracker receives for a failed assistant request. A provider
 * error is reported by a fixed code (its body could carry prompt text); any
 * other failure (a database, schema or programming error) is reported as
 * itself, so it stays diagnosable. The tracker scrubs the message either way.
 */
export function reportableAssistantError(error: unknown, code: string): unknown {
  if (error instanceof AssistantProviderError || AISDKError.isInstance(error)) {
    return new Error(code);
  }
  return error;
}

export function createAiAssistantRoutes(dependencies: AiAssistantRouteDependencies): Router {
  const router = Router();

  /**
   * CHAT-9: confirm and revise get a per-member budget like the chat's, so an
   * office behind one address does not share the staff limiter's. True when
   * the request was refused (the limiter said no, or could not be reached).
   */
  async function cardLimitRefused(
    req: Request,
    res: Response,
    workspaceId: string,
    actorId: string,
  ): Promise<boolean> {
    let limit: RateLimitResult;
    try {
      limit = await dependencies.rateLimit({
        bucketKey: `ai_card:${actorId}:${workspaceId}`,
        windowSeconds: 60,
        maxCount: AI_CARD_REQUESTS_PER_MINUTE,
      });
    } catch (error) {
      dependencies.reportFailure(req, error);
      sendDomainError(res, req.id, 'ai_unavailable', 503);
      return true;
    }
    if (limit.allowed) return false;
    res.setHeader('retry-after', String(limit.retryAfterSeconds));
    sendDomainError(res, req.id, 'ai_rate_limited', 429);
    return true;
  }
  const previewEmail = dependencies.work?.previewAiEmail?.bind(dependencies.work);
  const previewTaskUpdate = dependencies.work?.previewAiTaskUpdate?.bind(dependencies.work);
  /** Whether a task may have no lead here yet (migration 0038); a failed check is "no". */
  const plainTasksReady = async (scope: Scope): Promise<boolean> =>
    dependencies.work?.createPlainTask !== undefined &&
    (await dependencies.work.plainTasksReady?.(scope).catch(() => false)) === true;
  const leadUpdatePreview = async (
    scope: Scope,
    leadId: string,
    field: import('../leads/work-store.js').AiLeadUpdateDraft['field'],
    options: { search?: string; limit?: number } = {},
  ) => {
    const preview = await dependencies.work?.previewAiLeadUpdate?.({ ...scope, leadId, field });
    if (!preview) return undefined;
    if (field === 'assignedActorId') {
      // ACT-4: every active member, labelled; the model's list is narrowed by
      // a name search and capped, but a card may name any of them, and the
      // current assignee is never called "Former" while still a member.
      const all = ((await dependencies.listAssignees?.(scope)) ?? []).map((member) => ({
        value: member.actorId,
        label: member.displayName || (member.actorId === scope.actorId ? 'You' : 'Unnamed member'),
      }));
      const needle = options.search?.normalize('NFKC').trim().toLowerCase();
      const matching = needle
        ? all.filter((choice) => choice.label.normalize('NFKC').toLowerCase().includes(needle))
        : all;
      const limit = Math.min(options.limit ?? AI_ASSIGNEE_CHOICES_MAX, AI_ASSIGNEE_CHOICES_MAX);
      preview.choices = [{ value: null, label: 'Unassigned' }, ...matching.slice(0, limit)];
      preview.beforeLabel =
        preview.before === null
          ? 'Unassigned'
          : (all.find((choice) => choice.value === preview.before)?.label ?? 'Former member');
    }
    return preview;
  };
  const now = () => (dependencies.now ?? (() => new Date()))();
  // One guard per router (one per process): a duplicate request id inside a
  // minute is refused rather than spending a second turn's budget.

  // Nothing the assistant answers may be cached — refusals included.
  router.use((req, res, next) => {
    if (req.path.includes('/ai/')) res.setHeader('cache-control', 'no-store');
    next();
  });

  router.use(createAiAutomationRoutes(dependencies));
  router.use(createAiConversationRoutes(dependencies));

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

      const availability = await aiChatAvailability(dependencies.chat, {
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
      });
      const canAct = Boolean(
        dependencies.work &&
        dependencies.config.signingKey &&
        decideAccess(access, 'lead.manage').allowed,
      );
      const plainTasks =
        canAct &&
        (await plainTasksReady({ workspaceId: workspaceId.data, actorId: actor.actorId }));
      res.setHeader('cache-control', 'no-store');
      res.json(
        capabilityDocument(
          site,
          req.id,
          undefined,
          canAct,
          Boolean(
            dependencies.automationAuthoring &&
            dependencies.flows &&
            dependencies.config.automationWorkspaceIds?.has(workspaceId.data) &&
            decideAccess(access, 'integration.manage').allowed,
          ),
          { availability, kinds: dependencies.chat?.attachments?.kinds ?? [] },
          dependencies.config.highEffort !== undefined,
          plainTasks,
        ),
      );
    } catch (error) {
      dependencies.reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/ai/actions/revise', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = session(req);
    const body = reviseAiActionRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !actor || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const access = await dependencies.loadAccess(actor.actorId, workspaceId.data);
      if (
        !decideAccess(access, 'workspace.read').allowed ||
        !decideAccess(access, 'lead.manage').allowed
      ) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      const config = dependencies.config;
      if (!config.enabled || !config.signingKey || !config.workspaceIds.has(workspaceId.data)) {
        sendDomainError(res, req.id, 'ai_unavailable', 503);
        return;
      }
      if (await cardLimitRefused(req, res, workspaceId.data, actor.actorId)) return;
      const scope = { workspaceId: workspaceId.data, actorId: actor.actorId };
      const original = verifyAiAction(body.data.token, config.signingKey, scope, now());
      // A revision keeps the card's kind and what it is about: the same lead
      // (none for a plain task, which stays plain), the same task, the same field.
      const subject = (draft: AiActionDraft) =>
        draft.kind === 'task_update' ? `task:${draft.taskId}` : `lead:${draft.leadId ?? ''}`;
      if (
        !original ||
        original.draft.kind !== body.data.draft.kind ||
        subject(original.draft) !== subject(body.data.draft) ||
        (original.draft.kind === 'lead_update' &&
          body.data.draft.kind === 'lead_update' &&
          original.draft.field !== body.data.draft.field)
      ) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const site = await dependencies.siteContext.siteContext(scope);
      if (!site) {
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      const tools = createActionProposalTools({
        scope,
        site,
        key: config.signingKey,
        // The new card is a version of the same draft: it saves under one id.
        rootId: aiActionRootId(original),
        leadUpdatePreview: (leadId, field) => leadUpdatePreview(scope, leadId, field),
        ...(previewTaskUpdate
          ? { taskUpdatePreview: (taskId: string) => previewTaskUpdate({ ...scope, taskId }) }
          : {}),
        plainTasks: await plainTasksReady(scope),
        reads: dependencies.reads,
        emailPreview: previewEmail
          ? (leadId) => previewEmail({ ...scope, leadId, requestId: req.id })
          : undefined,
        loadAccess: () => dependencies.loadAccess(actor.actorId, scope.workspaceId),
        now,
        budget: new TurnBudget(),
      });
      const revised = body.data.draft;
      let result: string;
      if (revised.kind === 'task')
        result = await tools.execute('prepareTask', taskToolInputOf(revised));
      else {
        const { kind, ...draft } = revised;
        result = await tools.execute(
          kind === 'note'
            ? 'prepareNote'
            : kind === 'email'
              ? 'prepareEmail'
              : kind === 'task_update'
                ? 'prepareTaskUpdate'
                : 'prepareLeadUpdate',
          draft,
        );
      }
      const proposal = tools.proposals[0];
      if (!proposal) {
        // A card about a task that is not a lead's follow-up (a move, a plain
        // task) is refused for the task's own reason; a lead's card, as ever,
        // because its lead is no longer available.
        if (
          revised.kind === 'task_update' ||
          (revised.kind === 'task' && revised.leadId === undefined)
        ) {
          const reason = taskRefusalReason(result);
          if (reason === 'task_not_found') sendDomainError(res, req.id, 'task_not_found', 404);
          else if (reason === 'plain_tasks_unavailable')
            sendDomainError(res, req.id, 'plain_tasks_unavailable', 503);
          else sendDomainError(res, req.id, 'conflict', 409, { reason });
          return;
        }
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      const finalAccess = await dependencies.loadAccess(actor.actorId, scope.workspaceId);
      if (
        !decideAccess(finalAccess, 'workspace.read').allowed ||
        !decideAccess(finalAccess, 'lead.manage').allowed
      ) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      res.json(proposal);
    } catch (error) {
      dependencies.reportFailure(req, reportableAssistantError(error, 'assistant_revision_failed'));
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/ai/actions/confirm', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = session(req);
    const body = confirmAiActionRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !actor || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const access = await dependencies.loadAccess(actor.actorId, workspaceId.data);
      if (
        !decideAccess(access, 'workspace.read').allowed ||
        !decideAccess(access, 'lead.manage').allowed
      ) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      const config = dependencies.config;
      if (
        !config.enabled ||
        !config.signingKey ||
        !config.workspaceIds.has(workspaceId.data) ||
        !dependencies.work
      ) {
        sendDomainError(res, req.id, 'ai_unavailable', 503);
        return;
      }
      if (await cardLimitRefused(req, res, workspaceId.data, actor.actorId)) return;
      const scope = { workspaceId: workspaceId.data, actorId: actor.actorId };
      const action = verifyAiAction(body.data.token, config.signingKey, scope, now());
      if (!action) {
        sendDomainError(res, req.id, 'invalid_request', 400);
        return;
      }
      // Every version of one draft saves under its first card's id, so the
      // draft saves once; the saved record says which card did it.
      const rootId = aiActionRootId(action);
      const work = dependencies.work;
      /** True (and answered) when another version of this draft was already saved. */
      const superseded = async (): Promise<boolean> => {
        const savedBy = await work.aiCardOf?.({ ...scope, rootId });
        if (!savedBy || savedBy === action.id) return false;
        sendDomainError(res, req.id, 'conflict', 409, { reason: 'superseded' });
        return true;
      };
      if (action.draft.kind === 'lead_update') {
        if (!dependencies.work.confirmAiLeadUpdate || action.leadUpdateBefore === undefined) {
          sendDomainError(res, req.id, 'ai_unavailable', 503);
          return;
        }
        const outcome = await dependencies.work.confirmAiLeadUpdate({
          ...scope,
          requestId: req.id,
          draft: action.draft,
          creationId: rootId,
          aiCardId: action.id,
          before: action.leadUpdateBefore,
        });
        if (outcome.status === 'refused') {
          // The same answer a staff edit gets: which detail or documents the
          // move still needs, or which moves are allowed — never "conflict".
          sendLeadUpdateRefusal(res, req.id, outcome.refusal);
          return;
        }
        if (outcome.status === 'invalid') {
          sendDomainError(res, req.id, 'validation_error', 400, { field: action.draft.field });
          return;
        }
        if (outcome.status !== 'saved') {
          sendDomainError(
            res,
            req.id,
            outcome.status === 'not_found'
              ? 'lead_not_found'
              : outcome.status === 'trashed'
                ? 'lead_trashed'
                : 'conflict',
            outcome.status === 'not_found' ? 404 : 409,
          );
          return;
        }
        if (await superseded()) return;
        res.json(
          confirmAiActionResponseSchema.parse({
            status: 'saved',
            actionId: action.id,
            kind: 'lead_update',
            recordId: outcome.recordId,
            requestId: req.id,
          }),
        );
        return;
      }
      if (action.draft.kind === 'email') {
        if (!dependencies.work.queueAiEmail || !action.emailContext) {
          sendDomainError(res, req.id, 'ai_unavailable', 503);
          return;
        }
        const outcome = await dependencies.work.queueAiEmail({
          ...scope,
          requestId: req.id,
          leadId: action.draft.leadId,
          creationId: rootId,
          aiCardId: action.id,
          draft: action.draft,
          emailContext: action.emailContext,
        });
        if (outcome.status !== 'queued') {
          sendDomainError(
            res,
            req.id,
            outcome.status === 'not_found'
              ? 'lead_not_found'
              : outcome.status === 'trashed'
                ? 'lead_trashed'
                : outcome.status === 'changed'
                  ? 'conflict'
                  : 'feature_not_ready',
            outcome.status === 'not_found' ? 404 : 409,
          );
          return;
        }
        if (await superseded()) return;
        res.json(
          confirmAiActionResponseSchema.parse({
            status: 'saved',
            actionId: action.id,
            kind: 'email',
            recordId: outcome.recordId,
            requestId: req.id,
          }),
        );
        return;
      }
      if (action.draft.kind === 'task_update') {
        if (
          !dependencies.work.confirmAiTaskUpdate ||
          action.taskUpdateVersion === undefined ||
          action.taskUpdateBefore === undefined
        ) {
          sendDomainError(res, req.id, 'ai_unavailable', 503);
          return;
        }
        // The same change a staff PATCH makes, unless the task changed since the card.
        const outcome = await dependencies.work.confirmAiTaskUpdate({
          ...scope,
          requestId: req.id,
          taskId: action.draft.taskId,
          status: action.draft.status,
          version: action.taskUpdateVersion,
          before: action.taskUpdateBefore,
          creationId: rootId,
          aiCardId: action.id,
        });
        if (outcome.status !== 'saved') {
          sendDomainError(
            res,
            req.id,
            outcome.status === 'not_found'
              ? 'task_not_found'
              : outcome.status === 'trashed'
                ? 'lead_trashed'
                : 'conflict',
            outcome.status === 'not_found' ? 404 : 409,
          );
          return;
        }
        if (await superseded()) return;
        res.json(
          confirmAiActionResponseSchema.parse({
            status: 'saved',
            actionId: action.id,
            kind: 'task_update',
            recordId: outcome.recordId,
            requestId: req.id,
          }),
        );
        return;
      }
      const taskFields = (draft: Extract<AiActionDraft, { kind: 'task' }>) => ({
        title: draft.title,
        dueAt: draft.dueDate === null ? null : `${draft.dueDate}T12:00:00.000Z`,
        assignedActorId: draft.assignee === 'me' ? actor.actorId : null,
      });
      if (action.draft.kind === 'task' && action.draft.leadId === undefined) {
        // A plain task, through the staff route's own store path.
        const outcome = dependencies.work.createPlainTask
          ? await dependencies.work.createPlainTask({
              ...scope,
              requestId: req.id,
              creationId: rootId,
              aiCardId: action.id,
              ...taskFields(action.draft),
            })
          : ({ status: 'unavailable' } as const);
        if (outcome.status !== 'saved') {
          if (outcome.status === 'unavailable')
            sendDomainError(res, req.id, 'plain_tasks_unavailable', 503);
          else sendDomainError(res, req.id, 'assignee_not_found', 409);
          return;
        }
        if (await superseded()) return;
        res.json(
          confirmAiActionResponseSchema.parse({
            status: 'saved',
            actionId: action.id,
            kind: 'task',
            recordId: outcome.task.id,
            requestId: req.id,
          }),
        );
        return;
      }
      const input = {
        ...scope,
        requestId: req.id,
        leadId: action.draft.leadId ?? '',
        creationId: rootId,
        aiCardId: action.id,
      };
      const outcome =
        action.draft.kind === 'note'
          ? await dependencies.work.addNote({ ...input, body: action.draft.body })
          : await dependencies.work.createTask({ ...input, ...taskFields(action.draft) });
      if (outcome.status === 'not_found') {
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      if (outcome.status === 'trashed') {
        sendDomainError(res, req.id, 'lead_trashed', 409);
        return;
      }
      if (outcome.status === 'assignee_not_found') {
        sendDomainError(res, req.id, 'assignee_not_found', 409);
        return;
      }
      if (await superseded()) return;
      res.json(
        confirmAiActionResponseSchema.parse({
          status: 'saved',
          actionId: action.id,
          kind: action.draft.kind,
          recordId:
            outcome.status === 'created'
              ? outcome.activity.id
              : outcome.status === 'saved'
                ? outcome.task.id
                : undefined,
          requestId: req.id,
        }),
      );
    } catch (error) {
      dependencies.reportFailure(req, reportableAssistantError(error, 'assistant_action_failed'));
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
    // Absent is Normal: the turn exactly as it always was.
    const effort: AiEffort = body.effort ?? 'normal';
    const high = effort === 'high';
    const limits = turnLimits(effort);
    const startedAt = Date.now();
    const controller = new AbortController();
    activeTurns.add(controller);
    let timedOut = false;
    let clientGone = false;
    let revoked = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.timeoutMs);
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
      // The member chose High: a site that does not offer it says so, before
      // any work, rather than quietly answering at Normal.
      const highEffort = dependencies.config.highEffort;
      if (high && highEffort === undefined) {
        sendDomainError(res, req.id, 'invalid_request', 400, { reason: 'effort_unavailable' });
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
      let siteDayLimit: RateLimitResult;
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
        // A daily ceiling per site stops a runaway site inside the CRM, beside
        // the Gateway's own spend budget.
        siteDayLimit = await wait(
          dependencies.rateLimit({
            bucketKey: `ai_site_day:${workspaceId.data}`,
            windowSeconds: 86_400,
            maxCount: AI_ASSISTANT_LIMITS.perSitePerDay,
          }),
        );
      } catch (error) {
        dependencies.reportFailure(req, error);
        await refuseDisabled(res, req.id);
        return;
      }
      if (!actorLimit.allowed || !siteLimit.allowed || !siteDayLimit.allowed) {
        const retryAfter = Math.max(
          actorLimit.retryAfterSeconds,
          siteLimit.retryAfterSeconds,
          siteDayLimit.retryAfterSeconds,
        );
        res.setHeader('retry-after', String(retryAfter));
        sendDomainError(res, req.id, 'ai_rate_limited', 429);
        return;
      }
      // High costs more: its own hourly and daily limits on top of the ones
      // above, through the same limiter, failing closed the same way. A Normal
      // turn never touches these buckets. The member's own limit is asked
      // first and refuses alone: the limiter counts every call, so a member
      // past their hour must not also use up the site's day for everyone.
      if (high) {
        const refuseHigh = (retryAfter: number) => {
          res.setHeader('retry-after', String(retryAfter));
          sendDomainError(res, req.id, 'ai_rate_limited', 429, {
            reason: 'high_effort',
            retryAfterSeconds: retryAfter,
          });
        };
        try {
          const highActorLimit = await wait(
            dependencies.rateLimit({
              bucketKey: `ai_high_actor:${actor.actorId}:${workspaceId.data}`,
              windowSeconds: 3_600,
              maxCount: AI_ASSISTANT_LIMITS.highPerActorPerHour,
            }),
          );
          if (!highActorLimit.allowed) {
            refuseHigh(highActorLimit.retryAfterSeconds);
            return;
          }
          const highSiteDayLimit = await wait(
            dependencies.rateLimit({
              bucketKey: `ai_high_site_day:${workspaceId.data}`,
              windowSeconds: 86_400,
              maxCount: AI_ASSISTANT_LIMITS.highPerSitePerDay,
            }),
          );
          if (!highSiteDayLimit.allowed) {
            refuseHigh(highSiteDayLimit.retryAfterSeconds);
            return;
          }
        } catch (error) {
          dependencies.reportFailure(req, error);
          await refuseDisabled(res, req.id);
          return;
        }
      }

      // A duplicate client request id is the same question twice (two tabs, a
      // retried fetch): refuse it instead of spending a second turn. The claim
      // lives in the shared limiter so every replica sees it. Request ids are
      // fresh UUIDs, so an hour-long window costs nothing legitimate.
      let replayClaim: RateLimitResult;
      try {
        replayClaim = await wait(
          dependencies.rateLimit({
            bucketKey: `ai_replay:${actor.actorId}:${workspaceId.data}:${body.requestId}`,
            windowSeconds: AI_REPLAY_WINDOW_SECONDS,
            maxCount: 1,
          }),
        );
      } catch (error) {
        dependencies.reportFailure(req, error);
        await refuseDisabled(res, req.id);
        return;
      }
      if (!replayClaim.allowed) {
        sendDomainError(res, req.id, 'conflict', 409);
        return;
      }

      const turnStarted = now();
      const scope: Scope = { workspaceId: workspaceId.data, actorId: actor.actorId };
      const budget = new TurnBudget(effort);
      const plainTasks = await wait(plainTasksReady(scope));
      const actionTools =
        dependencies.work &&
        dependencies.config.signingKey &&
        decideAccess(access, 'lead.manage').allowed
          ? createActionProposalTools({
              scope,
              site,
              key: dependencies.config.signingKey,
              leadUpdatePreview: (leadId, field, options) =>
                wait(leadUpdatePreview(scope, leadId, field, options)),
              ...(previewTaskUpdate
                ? {
                    taskUpdatePreview: (taskId: string) =>
                      wait(previewTaskUpdate({ ...scope, taskId })),
                  }
                : {}),
              plainTasks,
              reads: dependencies.reads,
              emailPreview: previewEmail
                ? (leadId) => wait(previewEmail({ ...scope, leadId, requestId: req.id }))
                : undefined,
              loadAccess: () => wait(dependencies.loadAccess(actor.actorId, workspaceId.data)),
              now,
              budget,
            })
          : undefined;
      const sources = new SourceRegistry({
        workspaceSlug: site.slug,
        asOf: turnStarted,
      });
      // A run's lead by reference and name (active, unrestricted leads only).
      const leadLabels = dependencies.reads.leadLabels?.bind(dependencies.reads);
      const automationTools =
        dependencies.automationAuthoring &&
        dependencies.flows &&
        dependencies.config.signingKey &&
        dependencies.config.automationWorkspaceIds?.has(scope.workspaceId) &&
        decideAccess(access, 'integration.manage').allowed
          ? createAutomationTools({
              scope,
              site,
              key: dependencies.config.signingKey,
              flows: dependencies.flows,
              store: dependencies.automationAuthoring,
              ...(leadLabels === undefined
                ? {}
                : { leadLabels: (ids: readonly string[]) => wait(leadLabels(scope, ids)) }),
              sources,
              loadAccess: () => wait(dependencies.loadAccess(actor.actorId, workspaceId.data)),
              now,
              budget,
            })
          : undefined;

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
      // The smaller reads this member's access allows now; each call checks again.
      const wideReadTools = createWideReadTools(
        {
          scope,
          site,
          requestId: req.id,
          now: turnStarted,
          budget,
          sources,
          reads: dependencies.reads,
          stores: dependencies.wideReads ?? {},
          loadAccess: () => wait(dependencies.loadAccess(actor.actorId, workspaceId.data)),
          signal: controller.signal,
          onAccessRevoked: () => {
            revoked = true;
            controller.abort();
          },
        },
        decision.access,
      );
      // Every AI user reads the site's automations as the staff routes allow
      // with workspace.read (A1–A4); authoring stays where it was gated above.
      const automationReads =
        automationTools === undefined && dependencies.flows
          ? createAutomationTools({
              scope,
              site,
              authoring: false,
              flows: dependencies.flows,
              ...(leadLabels === undefined
                ? {}
                : { leadLabels: (ids: readonly string[]) => wait(leadLabels(scope, ids)) }),
              sources,
              loadAccess: () => wait(dependencies.loadAccess(actor.actorId, workspaceId.data)),
              now,
              budget,
            })
          : undefined;
      const isAutomationRead = (name: string) =>
        automationReads !== undefined &&
        AUTOMATION_READ_TOOL_NAMES.some((toolName) => toolName === name);
      const executeRead = (name: string, input: unknown) =>
        isWideReadName(name)
          ? wideReadTools.execute(name, input)
          : isToolName(name)
            ? toolset.execute(name, input)
            : (automationReads?.execute(name, input) ??
              Promise.reject(new Error('unknown assistant tool')));

      // A stored conversation (docs/design/ai-chat.md): the conversation is
      // created or loaded, this message's files linked and the member's
      // message stored, in one transaction, before the first frame, so every
      // refusal is still an ordinary JSON error.
      let stored: StoredTurn | undefined;
      let effortColumn = false;
      const chat = dependencies.chat;
      if (body.conversationId !== undefined) {
        const availability = await wait(aiChatAvailability(chat, scope));
        const conversations = chat?.conversations;
        if (!availability.conversations || !conversations) {
          await refuseDisabled(res, req.id);
          return;
        }
        const attachmentIds = body.attachmentIds ?? [];
        if (attachmentIds.length > 0 && !availability.attachments) {
          sendDomainError(res, req.id, 'attachments_unavailable', 503);
          return;
        }
        // Both rows of the turn keep its level once 0037 holds the column.
        effortColumn = await wait(chat?.schema.state(scope) ?? Promise.resolve(undefined)).then(
          (state) => state?.effort === true,
          (error: unknown) => {
            if (error instanceof AssistantProviderError) throw error;
            return false;
          },
        );
        let begun: Awaited<ReturnType<AiConversationStore['beginTurn']>>;
        try {
          // Not raced against the abort: the transaction commits either way
          // (its statements carry their own timeout), so the turn waits for it
          // and, if it was stopped meanwhile, stores the stopped answer below.
          begun = await conversations.beginTurn(scope, {
            conversationId: body.conversationId,
            create: body.newConversation === true,
            title: conversationTitleFrom(body.message),
            requestId: body.requestId,
            text: body.message,
            attachmentIds,
            ...(effortColumn ? { effort } : {}),
          });
        } catch (error) {
          dependencies.reportFailure(req, chatStoreFailure('ai_turn_store_failed', error));
          if (!res.headersSent && !clientGone)
            sendStaffAuthError(res, req.id, 'internal_error', 500);
          return;
        }
        if (begun.status === 'started' && controller.signal.aborted) {
          // The member's question is stored; so is the answer that never came,
          // so a reload shows the turn as stopped (or timed out) and its files
          // are not left looking unanswered.
          await conversations
            .appendAnswer(scope, {
              conversationId: begun.conversation.id,
              messageId: randomUUID(),
              requestId: body.requestId,
              text: '',
              outcome: timedOut ? 'failed' : 'cancelled',
              ...(timedOut ? { errorCode: 'timeout' } : {}),
              sources: [],
              expiredDrafts: 0,
              ...(effortColumn ? { effort } : {}),
            })
            .catch((error: unknown) => {
              dependencies.reportFailure(req, chatStoreFailure('ai_answer_store_failed', error));
            });
          if (!res.headersSent && !clientGone) await refuseDisabled(res, req.id);
          return;
        }
        switch (begun.status) {
          case 'not_found':
            sendDomainError(res, req.id, 'conversation_not_found', 404);
            return;
          case 'full':
            sendDomainError(res, req.id, 'conversation_full', 409);
            return;
          case 'too_many_conversations':
            sendDomainError(res, req.id, 'conversation_limit_reached', 409, {
              limit: AI_CHAT_LIMITS.maxConversationsPerActor,
            });
            return;
          case 'invalid_attachments':
            sendStaffAuthError(res, req.id, 'invalid_request', 400);
            return;
          case 'duplicate':
            // The same question twice, past the replay claim: one stored row.
            sendDomainError(res, req.id, 'conflict', 409);
            return;
          case 'started':
            stored = {
              conversationId: begun.conversation.id,
              title: begun.conversation.title,
              created: begun.created,
              userMessageId: begun.userMessageId,
              answerId: randomUUID(),
              attachments: begun.attachments,
            };
        }
      }
      const storedTurn = stored;
      const memoryBudget = chat?.memoryBudget ?? sharedAttachmentByteBudget;
      let attachmentLease: AttachmentBudgetLease | undefined;
      /** The member's daily attachment budget refused this turn's files (audit B7). */
      let attachmentBudgetSpent = false;

      /**
       * The model's messages for a stored turn: the replayed history, then the
       * new message, each member's message with its files while this turn's
       * file limits allow (the new message's first, then the most recent
       * earlier ones). A file past the limits, of a kind now switched off, or
       * without storage is named as unavailable instead. Bytes are read per
       * turn, bounded by each row's own size, and never logged or kept.
       */
      const storedTurnMessages = async (
        turn: StoredTurn,
        message: string,
      ): Promise<EngineMessage[]> => {
        let text = message;
        const conversations = chat?.conversations;
        if (!conversations) throw new Error('conversation store missing');
        const history: readonly AiReplayMessage[] = await wait(
          conversations.history(scope, {
            conversationId: turn.conversationId,
            beforeMessageId: turn.userMessageId,
            reservedChars: Array.from(body.message).length,
          }),
        );
        // Audit B8: a message that is exactly one of the choices an earlier
        // answer offered reached here by a click (or reads the same): the
        // model is told it is an option it offered, not new words from the
        // person. The stored question keeps the plain text.
        const chosen = body.message.trim();
        if (
          text.endsWith(body.message) &&
          history.some(
            (message) => message.role === 'assistant' && message.followUpChoices?.includes(chosen),
          )
        ) {
          text = `${text.slice(0, text.length - body.message.length)}${selectedChoiceText(chosen)}`;
        }
        const service = chat?.attachments;
        const kinds = service?.kinds ?? [];
        const candidates = [
          ...turn.attachments,
          ...[...history].reverse().flatMap((message) => message.attachments),
        ];
        const included = new Set<string>();
        let bytes = 0;
        for (const file of candidates) {
          if (!kinds.includes(file.kind) || (file.kind !== 'text' && !service)) continue;
          // Until either limit: the first file that does not fit ends the list.
          if (
            included.size >= AI_CHAT_LIMITS.maxAttachmentsPerTurnContext ||
            bytes + file.byteSize > AI_CHAT_LIMITS.maxAttachmentBytesPerTurn
          )
            break;
          included.add(file.id);
          bytes += file.byteSize;
        }
        // Audit B7: the files chosen above are charged to the member's daily
        // budget on bytes sent to the model. Spent, or a limiter that cannot
        // be reached, sends every file of the turn as not available: the turn
        // still runs, and the stream says why (`notice`) when it was spent.
        if (bytes > 0) {
          const charged = await chargeDailyAttachmentBytes(dependencies.rateLimit, scope, bytes);
          if (charged !== 'allowed') {
            included.clear();
            if (charged === 'spent') attachmentBudgetSpent = true;
            else dependencies.reportFailure(req, new Error('ai_attachment_budget_unavailable'));
          }
        }
        // The process-wide bound on bytes held for the model: this turn takes
        // its share at once or sends its images and PDFs as not available,
        // rather than queueing behind other turns. Released in the turn's
        // `finally`, however it ends.
        const binary = candidates.filter((file) => included.has(file.id) && file.kind !== 'text');
        const share = binary.reduce((total, file) => total + file.byteSize, 0);
        if (share > 0) {
          const lease = memoryBudget.tryAcquire(share);
          if (lease) attachmentLease = lease;
          else for (const file of binary) included.delete(file.id);
        }
        const toEngine = async (
          files: readonly AiTurnAttachment[],
        ): Promise<EngineAttachment[]> => {
          const out: EngineAttachment[] = [];
          for (const file of files) {
            if (!included.has(file.id)) {
              out.push({ kind: 'omitted', fileName: file.fileName });
            } else if (file.kind === 'text') {
              out.push({ kind: 'text', fileName: file.fileName, text: file.extractedText ?? '' });
            } else if (service) {
              let data: Uint8Array;
              try {
                data = await wait(service.readForModel(scope, file));
              } catch (error) {
                if (error instanceof AssistantProviderError) throw error;
                // Gone meanwhile (its conversation is being deleted) or unreadable:
                // the turn goes on without it, and says so.
                out.push({ kind: 'omitted', fileName: file.fileName });
                continue;
              }
              if (file.mediaType === 'application/pdf') {
                out.push({ kind: 'pdf', mediaType: file.mediaType, fileName: file.fileName, data });
              } else if (
                file.mediaType === 'image/png' ||
                file.mediaType === 'image/jpeg' ||
                file.mediaType === 'image/webp'
              ) {
                out.push({
                  kind: 'image',
                  mediaType: file.mediaType,
                  fileName: file.fileName,
                  data,
                });
              }
            }
          }
          return out;
        };
        const messages: EngineMessage[] = [];
        for (const message of history) {
          const attachments = await toEngine(message.attachments);
          messages.push({
            role: message.role,
            text: message.text,
            ...(attachments.length > 0 ? { attachments } : {}),
          });
        }
        const attachments = await toEngine(turn.attachments);
        messages.push({
          role: 'user',
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        return messages;
      };

      const engine = dependencies.engine;
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          // The answer as the client will hold it, for its history signature.
          let answered = '';
          // What this turn actually sent, for a stored conversation's answer row.
          let sentSources: AiSource[] = [];
          let sentFollowUp: AiFollowUp | undefined;
          let releasedDrafts = 0;
          let sentErrorCode: import('@gt-sales/contracts').AiStreamErrorCode | undefined;
          const writePart = (part: AiStreamPart) => {
            if (part.type === 'sources') sentSources = part.sources;
            if (part.type === 'follow_up') sentFollowUp = part.followUp;
            if (part.type === 'actions') releasedDrafts += part.actions.length;
            if (part.type === 'automation_proposals') releasedDrafts += part.proposals.length;
            if (part.type === 'error') sentErrorCode = part.code;
            if (part.type === 'text') {
              answered += part.text;
              // CHAT-11: a provider chunk over the part limit goes out in pieces.
              const characters = Array.from(part.text);
              for (let at = 0; at < characters.length; at += AI_TEXT_PART_CHARS) {
                writer.write({
                  type: 'data-assistant',
                  data: aiStreamPartSchema.parse({
                    type: 'text',
                    text: characters.slice(at, at + AI_TEXT_PART_CHARS).join(''),
                  }),
                  transient: true,
                });
              }
              return;
            }
            writer.write({
              type: 'data-assistant',
              data: aiStreamPartSchema.parse(part),
              transient: true,
            });
          };
          // CHAT-2: the finished answer is signed so the next turn can replay it.
          const writeDone = () => {
            const key = dependencies.config.signingKey;
            writePart({
              type: 'done',
              ...(key === undefined
                ? {}
                : {
                    signature: signAssistantTurn(
                      key,
                      scope,
                      aiAssistantHistoryText({ text: answered, followUp }),
                    ),
                  }),
              // Only for a request that named a conversation: `done` is strict,
              // so an older admin would drop one carrying a key it does not know.
              ...(storedTurn ? { messageId: storedTurn.answerId } : {}),
            });
          };
          writePart({ type: 'progress', label: 'Getting ready' });
          if (storedTurn) {
            writePart({
              type: 'conversation',
              conversationId: storedTurn.conversationId,
              userMessageId: storedTurn.userMessageId,
              title: storedTurn.title,
              created: storedTurn.created,
            });
          }

          const leadHint =
            body.context === undefined
              ? undefined
              : await wait(dependencies.reads.leadHint(scope, body.context.leadId)).catch(
                  () => undefined,
                );
          let followUp: AiFollowUp | undefined;
          const guide = async (raw: unknown) => {
            if (!budget.reserveToolCall()) return 'Question limit reached';
            const question = aiFollowUpToolInputSchema.parse(raw);
            if (
              automationTools &&
              /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\buuid\b|staff id/i.test(
                [question.question, ...question.choices].join(' '),
              )
            )
              return 'Do not ask for internal IDs. Use currentMember/me for the signed-in person, or ask for staff names from getAutomationCatalog.';
            followUp = question;
            return 'Question and choices ready. Wait for the person to answer; do not assume a choice.';
          };
          const guidedTool = tool({
            description:
              'Ask one short clarification with 2-5 meaningful choices when the lead, action content, due date or email intent is missing or ambiguous. Each choice is a short answer of at most 80 characters, never a new request. Never invent an answer. The person can also type freely.',
            // Audit B8: choices within AI_FOLLOW_UP_LIMITS; a longer one is refused here.
            inputSchema: aiFollowUpToolInputSchema,
            execute: guide,
          });
          const system = buildSystemPrompt({
            siteName: site.name,
            leadTypes: site.leadTypes,
            today: businessDayLabel(turnStarted, AI_BUSINESS_TIME_ZONE),
            timeZone: AI_BUSINESS_TIME_ZONE,
            automationsAvailable: automationTools !== undefined,
            automationReadsAvailable: automationReads !== undefined,
            actionsAvailable:
              actionTools !== undefined && decideAccess(access, 'lead.manage').allowed,
            plainTasksAvailable: plainTasks,
            // Only the verified id and the catalogue's labels reach the system
            // prompt; the customer-typed name and reference travel as data in
            // the person's own message below.
            ...(leadHint === undefined
              ? {}
              : {
                  openLead: {
                    leadId: leadHint.leadId,
                    leadTypeLabel: leadTypeLabel(leadHint.leadType),
                    stageLabel: leadStageLabel(leadHint.leadType, leadHint.stage),
                  },
                }),
          });
          const openLeadData = leadHint === undefined ? undefined : openLeadDataBlock(leadHint);
          const userText =
            openLeadData === undefined ? body.message : `${openLeadData}\n\n${body.message}`;

          let recoveredDraft = false;
          let failureCode: import('@gt-sales/contracts').AiStreamErrorCode | undefined;
          let outcome: 'completed' | 'cancelled' | 'failed' | 'access_lost' = 'completed';
          let inputTokens: number | undefined;
          let outputTokens: number | undefined;
          let finished = false;

          try {
            // A stored conversation replays its own store (trusted: written by
            // this server, no signature needed); otherwise CHAT-2: only whole
            // turns whose answer this server signed are replayed.
            const messages: EngineMessage[] = storedTurn
              ? await storedTurnMessages(storedTurn, userText).then((built) => {
                  if (attachmentBudgetSpent)
                    writePart({ type: 'notice', code: 'attachment_budget_spent' });
                  return built;
                })
              : [
                  ...trustedHistory(body.history, dependencies.config.signingKey, scope).messages,
                  { role: 'user' as const, text: userText },
                ];
            for await (const event of engine.stream({
              system,
              messages,
              automationAuthoring: automationTools !== undefined,
              // CHAT-4: a turn that ends on a prepared card's tool call is done.
              hasPreparedDraft: () =>
                (automationTools?.proposals.length ?? 0) > 0 ||
                (actionTools?.proposals.length ?? 0) > 0,
              tools: {
                ...toolset.definitions,
                ...wideReadTools.definitions,
                ...automationReads?.definitions,
                ...actionTools?.definitions,
                ...automationTools?.definitions,
                askFollowUp: guidedTool,
                getCrmGuide: createCrmGuideTool(budget),
              },
              signal: controller.signal,
              // Only a High turn names its level, so a Normal turn's input is as it was.
              ...(high ? { effort } : {}),
              executeTool: (name, input) =>
                isToolName(name) || isWideReadName(name) || isAutomationRead(name)
                  ? executeRead(name, input)
                  : actionTools &&
                      (name === 'prepareNote' ||
                        name === 'prepareTask' ||
                        name === 'prepareTaskUpdate' ||
                        name === 'prepareEmail' ||
                        name === 'prepareLeadUpdate' ||
                        name === 'getLeadUpdateOptions')
                    ? actionTools.execute(name, input)
                    : automationTools && AUTOMATION_TOOL_NAMES.some((toolName) => toolName === name)
                      ? automationTools.execute(name, input)
                      : name === 'askFollowUp'
                        ? guide(input)
                        : name === 'getCrmGuide'
                          ? Promise.resolve(runCrmGuide(budget, input))
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
                      : (CARD_PROGRESS_LABELS[event.toolName] ?? 'Checking the CRM'),
                  });
                  break;
                case 'reasoning':
                  // The model is reasoning (a step's first reasoning part): the
                  // member sees it is working, never what it thinks. A Normal
                  // turn's stream is unchanged, whatever its model does.
                  if (high) writePart({ type: 'progress', label: 'Thinking' });
                  break;
                case 'finish':
                  finished = true;
                  inputTokens = event.inputTokens;
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

            // Aborted without an exception (the engine yielded once more after
            // the client left, or the process is shutting down): a stopped
            // turn, never a completed one.
            if (controller.signal.aborted) {
              outcome = 'cancelled';
              return;
            }
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
            if (
              actionTools &&
              actionTools.proposals.length > 0 &&
              decideAccess(finalAccess, 'lead.manage').allowed
            )
              writePart({ type: 'actions', actions: actionTools.proposals });
            if (
              automationTools?.proposals.length &&
              decideAccess(finalAccess, 'integration.manage').allowed
            )
              writePart({ type: 'automation_proposals', proposals: automationTools.proposals });
            if (followUp) writePart({ type: 'follow_up', followUp });
            writeDone();
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
              failureCode = error instanceof AssistantProviderError ? error.code : 'internal_error';
              // CHAT-4: cards already prepared (signed drafts that save nothing
              // until confirmed) are released with a note, not lost with the turn.
              const readyAutomations = aiAutomationProposalSchema
                .array()
                .max(3)
                .safeParse(automationTools?.proposals ?? []);
              const readyActions = aiActionProposalSchema
                .array()
                .max(3)
                .safeParse(actionTools?.proposals ?? []);
              const automations = readyAutomations.success ? readyAutomations.data : [];
              const actions = readyActions.success ? readyActions.data : [];
              if (automations.length > 0 || actions.length > 0) {
                try {
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
                  const releaseActions =
                    actions.length > 0 && decideAccess(finalAccess, 'lead.manage').allowed;
                  const releaseAutomations =
                    automations.length > 0 &&
                    decideAccess(finalAccess, 'integration.manage').allowed;
                  if (releaseActions || releaseAutomations) {
                    writePart({
                      type: 'text',
                      text: '\n\nThe explanation could not finish, but a draft is ready for your review. Nothing has been saved.',
                    });
                    if (releaseActions) writePart({ type: 'actions', actions });
                    if (releaseAutomations)
                      writePart({ type: 'automation_proposals', proposals: automations });
                    writeDone();
                    recoveredDraft = true;
                    outcome = 'completed';
                  }
                } catch {
                  // A failed access check or invalid stream must not release a card.
                }
              }
              if (!recoveredDraft) {
                outcome = 'failed';
                // A provider failure is reported by a fixed code, never its body.
                dependencies.reportFailure(
                  req,
                  reportableAssistantError(error, 'assistant_provider_error'),
                );
                writePart({
                  type: 'error',
                  code:
                    error instanceof AssistantProviderError ? error.code : 'provider_unavailable',
                  message: 'Ask AI could not answer just now. Nothing was changed.',
                });
              }
            }
          } finally {
            activeTurns.delete(controller);
            clearTimeout(timer);
            attachmentLease?.release();
            const turnRecord: AiTurnLog = {
              requestId: req.id,
              workspaceId: workspaceId.data,
              actorId: actor.actorId,
              engine: engine.kind,
              // The model that served the turn: High's own when it has one.
              modelId: high ? highEffort?.modelId : dependencies.config.modelId,
              effort,
              promptVersion: AI_PROMPT_VERSION,
              outcome,
              durationMs: Date.now() - startedAt,
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
              ...budget.usage,
              ...(failureCode ? { failureCode } : {}),
              ...(recoveredDraft ? { recoveredDraft: true } : {}),
            };
            logAiTurn(turnRecord);
            // The usage record never fails the turn: a write error is reported
            // and the log line above still carries the same fields.
            if (dependencies.turns) {
              await dependencies.turns.record(turnRecord).catch((error: unknown) => {
                dependencies.reportFailure(req, error);
              });
            }
            // A stored conversation keeps the answer however the turn ended,
            // as it was streamed (a stopped answer included, so a reload shows
            // it). Access lost keeps nothing of what was said: the row is
            // stored empty. A failed write is reported by code and changes
            // nothing the client already received.
            if (storedTurn && chat?.conversations) {
              const lost = outcome === 'access_lost';
              await chat.conversations
                .appendAnswer(scope, {
                  conversationId: storedTurn.conversationId,
                  messageId: storedTurn.answerId,
                  requestId: body.requestId,
                  text: lost ? '' : answered,
                  outcome,
                  ...(outcome === 'failed'
                    ? { errorCode: sentErrorCode ?? failureCode ?? 'internal_error' }
                    : {}),
                  sources: lost ? [] : sentSources,
                  ...(lost || sentFollowUp === undefined ? {} : { followUp: sentFollowUp }),
                  expiredDrafts: lost ? 0 : releasedDrafts,
                  ...(effortColumn ? { effort } : {}),
                })
                .catch((error: unknown) => {
                  dependencies.reportFailure(
                    req,
                    chatStoreFailure('ai_answer_store_failed', error),
                  );
                });
            }
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
    } catch (error) {
      dependencies.reportFailure(req, reportableAssistantError(error, 'assistant_request_failed'));
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
