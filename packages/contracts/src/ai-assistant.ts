import { aiAutomationProposalSchema } from './ai-automations';
import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { leadTypeSchema } from './leads';
import { documentChecklistKeySchema } from './domain';
import {
  leadTaskStatusSchema,
  queueCustomerEmailRequestSchema,
  updateWorkspaceLeadRequestSchema,
} from './lead-work';
import { aiModelChoiceSchema, aiModelIdSchema, AI_MODEL_LIMITS } from './ai-models';
import { automationKeySchema } from './automation-keys';
import { leadFormEditSchema } from './lead-fields';
import { leadOrderEditSchema } from './plans';

/**
 * The staff AI assistant ("Ask AI"): its capability document, the one chat
 * request the admin may send, and the typed parts of the streamed answer.
 *
 * Reads and signed task, note, email, lead-update and task-move proposals. Nothing in this module grants access: every route
 * re-derives the caller's membership, every tool re-reads authorization, and
 * this file only fixes the wire shapes so the admin, the backend and the
 * generated OpenAPI document cannot drift apart.
 */

/**
 * Version-1 application limits. These are product constants, not environment
 * knobs: the backend enforces every one of them, and the capability document
 * repeats the ones the composer needs so the UI cannot offer more than the
 * server accepts.
 */
export const AI_ASSISTANT_LIMITS = {
  /** One message, in Unicode characters. */
  maxMessageChars: 4_000,
  /** Prior turns the browser may send back (each side of a turn counts once). */
  maxHistoryMessages: 12,
  /** `message` plus every history entry, in Unicode characters. */
  maxConversationChars: 16_000,
  /** Whole serialized request body, in UTF-8 bytes. The global JSON limit stays 64 KiB. */
  maxRequestBytes: 48 * 1024,
  /** Model generations per turn, including the answer step. */
  maxModelSteps: 5,
  /** Tool calls per turn, parallel calls included. */
  maxToolCalls: 6,
  /** Distinct lead summaries per turn. */
  maxLeadSummaries: 3,
  /** Rows returned across every tool in one turn (nested items included). */
  maxRecordsPerTurn: 50,
  /** One tool result, serialized. */
  maxToolResultBytes: 6 * 1024,
  /** Every tool result of one turn, serialized. */
  maxToolDataBytes: 24 * 1024,
  /** Output tokens of one model generation. */
  maxOutputTokens: 1_200,
  /** Output tokens of one generation when automation authoring is on: a draft is long JSON (CHAT-8). */
  maxAuthoringOutputTokens: 4_800,
  /** The whole turn, tools and model included. */
  requestTimeoutMs: 60_000,
  /** One database tool's statement deadline. */
  toolQueryTimeoutMs: 5_000,
  /** Chat requests per actor per site in a fixed one-minute window (CHAT-10). */
  perActorPerMinute: 10,
  /** Chat requests per site in a fixed one-minute window. */
  perSitePerMinute: 60,
  /** Chat requests per site in a UTC day: the runaway stop beside the Gateway budget. */
  perSitePerDay: 500,
  /*
   * High effort (`effort: 'high'`, for harder questions). Each replaces its
   * Normal counterpart on a High turn only; a Normal turn never reads them.
   * The per-result and per-turn data bytes, the record limit and every
   * permission check are the same at both levels: High may think longer, it
   * may not read more broadly.
   */
  /** Model generations of a High turn, the answer step included (Normal: `maxModelSteps`). */
  maxModelStepsHigh: 8,
  /** Tool calls of a High turn, parallel calls included (Normal: `maxToolCalls`). */
  maxToolCallsHigh: 10,
  /** Answer tokens of one High generation (Normal: `maxOutputTokens`). */
  maxOutputTokensHigh: 4_000,
  /**
   * Added to a High generation's output limit only when reasoning is requested
   * (`AI_HIGH_EFFORT_REASONING`): some providers count reasoning tokens inside
   * the output limit, so the answer keeps its own `maxOutputTokensHigh`.
   */
  maxReasoningTokensHigh: 8_000,
  /** A whole High turn, tools and model included (Normal: `requestTimeoutMs`). */
  requestTimeoutMsHigh: 180_000,
  /** Distinct lead summaries of a High turn (Normal: `maxLeadSummaries`). */
  maxLeadSummariesHigh: 5,
  /** High requests per actor per site in a fixed one-hour window, on top of the Normal limits. */
  highPerActorPerHour: 20,
  /** High requests per site in a UTC day, on top of the Normal limits. */
  highPerSitePerDay: 100,
} as const;

export type AiAssistantLimits = typeof AI_ASSISTANT_LIMITS;

/**
 * How hard the model works on one question. `normal` is the assistant as it
 * always was; `high` gives a harder question a larger budget, the deployment's
 * High model when one is set and, when configured, model reasoning. Absent on
 * a request means `normal`.
 */
export const AI_EFFORTS = ['normal', 'high'] as const;
export const aiEffortSchema = z.enum(AI_EFFORTS);
export type AiEffort = z.infer<typeof aiEffortSchema>;

/**
 * Limits of the saved chat (stored conversations and attached files). Product
 * constants like `AI_ASSISTANT_LIMITS`: the backend enforces every one, the
 * database checks repeat the storage bounds, and the capability document
 * repeats the ones the composer needs. History replayed from the store still
 * obeys `AI_ASSISTANT_LIMITS.maxHistoryMessages` and `maxConversationChars`.
 */
export const AI_CHAT_LIMITS = {
  /** Stored messages per conversation (each side of a turn counts once); then `conversation_full`. */
  maxConversationMessages: 200,
  /** One stored message's text, in characters: a longer answer is clipped before it is saved. */
  maxStoredMessageChars: 20_000,
  /** A conversation's title, in characters, on one line. */
  maxTitleChars: 120,
  /** Conversations per page of the list (the most `limit` may ask for). */
  conversationPageSize: 30,
  /** Files attached to one message. */
  maxAttachmentsPerMessage: 4,
  /** One image, in bytes. */
  maxImageBytes: 5 * 1024 * 1024,
  /** One PDF, in bytes. */
  maxPdfBytes: 10 * 1024 * 1024,
  /** One text file, in bytes. */
  maxTextFileBytes: 512 * 1024,
  /** A text file's decoded text that is kept and sent to the model, in characters. */
  maxExtractedTextChars: 20_000,
  /** A stored file's name once sanitized, in characters (the browser may send up to 255). */
  maxFileNameChars: 200,
  /** Files sent to the model in one turn: the new message's first, then earlier ones in the replayed history. */
  maxAttachmentsPerTurnContext: 6,
  /** Bytes of those files in one turn, whichever of the two limits comes first. */
  maxAttachmentBytesPerTurn: 15 * 1024 * 1024,
  /** Upload intents per actor per site in a fixed one-hour window. */
  uploadsPerActorPerHour: 40,
  /**
   * Attachment bytes sent to the model per actor per site in a UTC day,
   * earlier messages' files resent with each turn included (audit B7). Past
   * it a turn still runs, its files named to the model as not available, and
   * the stream's `notice` part says so. Charged in whole
   * `attachmentBudgetUnitBytes`, through the shared limiter.
   */
  attachmentBytesPerActorPerDay: 300 * 1024 * 1024,
  /** The step the daily attachment budget is charged in: a turn's file bytes, rounded up. */
  attachmentBudgetUnitBytes: 1024 * 1024,
  /**
   * Stored conversations per actor per site (audit B7). A new chat past it is
   * refused with `409 conversation_limit_reached` until the member deletes old ones.
   */
  maxConversationsPerActor: 500,
} as const;

export type AiChatLimits = typeof AI_CHAT_LIMITS;

/** What an attached file is, decided by its bytes on the server, never by its name. */
export const aiAttachmentKindSchema = z.enum(['image', 'pdf', 'text']);
export type AiAttachmentKind = z.infer<typeof aiAttachmentKindSchema>;

/** The accepted media types of each kind. */
export const AI_ATTACHMENT_MEDIA_TYPES = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
  pdf: ['application/pdf'],
  text: ['text/plain', 'text/csv', 'text/markdown'],
} as const satisfies Record<AiAttachmentKind, readonly string[]>;

export const aiAttachmentMediaTypeSchema = z.enum([
  ...AI_ATTACHMENT_MEDIA_TYPES.image,
  ...AI_ATTACHMENT_MEDIA_TYPES.pdf,
  ...AI_ATTACHMENT_MEDIA_TYPES.text,
]);
export type AiAttachmentMediaType = z.infer<typeof aiAttachmentMediaTypeSchema>;

/** The kind an accepted media type belongs to. */
export function aiAttachmentKindOf(mediaType: AiAttachmentMediaType): AiAttachmentKind {
  switch (mediaType) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
      return 'image';
    case 'application/pdf':
      return 'pdf';
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
      return 'text';
  }
}

/** The most bytes one file of `kind` may hold. */
export function aiAttachmentMaxBytes(kind: AiAttachmentKind): number {
  switch (kind) {
    case 'image':
      return AI_CHAT_LIMITS.maxImageBytes;
    case 'pdf':
      return AI_CHAT_LIMITS.maxPdfBytes;
    case 'text':
      return AI_CHAT_LIMITS.maxTextFileBytes;
  }
}

/** True when `text` holds a control character (a line break, a tab, NUL, DEL, C1). */
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/**
 * A conversation's title as stored and answered: one line of 1 to
 * `maxTitleChars` characters. The backend makes the first one from the
 * opening message (its first 60 characters, on one line, trimmed).
 */
export const aiConversationTitleSchema = z
  .string()
  .min(1)
  .max(AI_CHAT_LIMITS.maxTitleChars)
  .refine((title) => !hasControlCharacter(title), 'single-line title');

/**
 * Why the assistant is not available. `disabled` is the owner's switch,
 * `not_configured` a deployment missing its key or model, `site_not_enabled`
 * a site outside the allowlist. The reason is safe to show and never carries a
 * configuration value.
 */
export const aiUnavailableReasonSchema = z.enum(['disabled', 'not_configured', 'site_not_enabled']);

export type AiUnavailableReason = z.infer<typeof aiUnavailableReasonSchema>;

/** The periods the read tools support; resolved in `America/Toronto`. */
export const aiPeriodSchema = z.enum([
  'today',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'all_time',
]);

export type AiPeriod = z.infer<typeof aiPeriodSchema>;

/** The lead types a site actually has, so the UI suggests only relevant questions. */
export const aiCapabilitiesResponseSchema = z.object({
  automationAuthoring: z.boolean().optional(),
  available: z.boolean(),
  actions: z
    .array(z.enum(['task', 'note', 'email', 'lead_update']))
    .max(4)
    .optional(),
  /**
   * The task cards beyond a lead's follow-up, beside `actions` rather than in
   * it because an older admin's `actions` enum would refuse the whole
   * document: `plain_task` (a task with no lead; once migration 0038 is
   * applied) and `task_update` (a task moved between its stages). Absent from
   * an older backend.
   */
  taskActions: z
    .array(z.enum(['plain_task', 'task_update']))
    .max(2)
    .optional(),
  /**
   * Every card kind this member may confirm here (`AI_CARD_KINDS`), from the
   * one table the prepare tools, revise and confirm use. Its presence also
   * says the backend sends `action_cards` and takes `wide` on a revision.
   * Absent from an older backend.
   */
  cardActions: z.array(z.string().min(1).max(40)).max(20).optional(),
  reason: aiUnavailableReasonSchema.optional(),
  site: z.object({
    id: z.uuid(),
    slug: z.string().min(1).max(80),
    name: z.string().min(1).max(160),
  }),
  leadTypes: z.array(leadTypeSchema).max(32),
  limits: z.object({
    maxMessageChars: z.int().positive(),
    maxHistoryMessages: z.int().positive(),
    maxConversationChars: z.int().positive(),
  }),
  /**
   * True when this backend stores conversations (the full page, the list and
   * `conversationId` on the chat). Absent from an older backend: the admin
   * then keeps the memory-only panel.
   */
  conversations: z.boolean().optional(),
  /**
   * The files a member may attach, from the deployment's `AI_ATTACHMENT_KINDS`
   * (and only when storage is configured). Absent, or with no `kinds`, means
   * the composer offers no attach control. `accept` is the file picker's list
   * (media types and file extensions).
   */
  attachments: z
    .object({
      kinds: z.array(aiAttachmentKindSchema).max(3),
      accept: z
        .array(
          z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9.+/-]+$/, 'media type or extension'),
        )
        .max(20),
      maxPerMessage: z.int().positive().max(AI_CHAT_LIMITS.maxAttachmentsPerMessage),
      maxImageBytes: z.int().positive(),
      maxPdfBytes: z.int().positive(),
      maxTextFileBytes: z.int().positive(),
    })
    .optional(),
  /**
   * The effort levels this site offers right now (`AI_HIGH_EFFORT_ENABLED`).
   * Absent from an older backend and from one where High is off: the composer
   * then shows no effort control and sends no `effort`.
   */
  efforts: z.array(aiEffortSchema).max(AI_EFFORTS.length).optional(),
  /**
   * The models a member may choose for a question (Settings → AI models), the
   * site's default first. Present only once migration 0040 is applied and the
   * site has saved more than one model: absent, the composer shows no model
   * picker and sends no `model` (an older backend never sends it).
   */
  models: z.array(aiModelChoiceSchema).min(2).max(AI_MODEL_LIMITS.maxAllowed).optional(),
  /** The id among `models` that serves a question sent without `model`; only beside `models`. */
  defaultModel: aiModelIdSchema.optional(),
  requestId: requestIdSchema,
});

export type AiCapabilitiesResponse = z.infer<typeof aiCapabilitiesResponseSchema>;

/**
 * One earlier turn, as text only: the model never receives stored tool data.
 * An assistant turn carries the `signature` its `done` part gave it (CHAT-2):
 * the server only replays answers it wrote, so a client cannot put words in
 * the model's mouth.
 */
export const aiHistoryMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z
      .string()
      .min(1)
      .max(AI_ASSISTANT_LIMITS.maxMessageChars * 2)
      .refine(
        (text) => Array.from(text).length <= AI_ASSISTANT_LIMITS.maxMessageChars,
        'message character limit',
      ),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict();

/**
 * The text an answer is replayed as in history: a follow-up question and its
 * choices first, then the answer, clipped to the message limit. Both ends
 * build it here, so the text the server signs is the text the client sends.
 */
export function aiAssistantHistoryText(answer: {
  text: string;
  followUp?: { question: string; choices: readonly string[] } | undefined;
}): string {
  const text = answer.followUp
    ? `${answer.followUp.question} Options: ${answer.followUp.choices.join('; ')}\n${answer.text}`
    : answer.text;
  const characters = Array.from(text);
  return characters.length <= AI_ASSISTANT_LIMITS.maxMessageChars
    ? text
    : characters.slice(0, AI_ASSISTANT_LIMITS.maxMessageChars).join('');
}

export type AiHistoryMessage = z.infer<typeof aiHistoryMessageSchema>;

/**
 * The admin's chat request. `requestId` correlates the stream; it is not an
 * identity. Actor, site, roles and provider settings are never accepted from
 * the body — the route derives them; `model` is only a pick among the site's
 * allowed models, which the route checks against the list the owner saved.
 *
 * Without `conversationId` it is the original request, unchanged: the browser
 * sends the signed `history` and nothing is stored. With `conversationId` (a
 * UUID the browser generates for a new chat) the server keeps the
 * conversation: `history` must be empty because the server replays its own
 * store, the conversation is created by its first message (`newConversation:
 * true`), and an id that is unknown or someone else's answers
 * `conversation_not_found`. `attachmentIds` are the
 * member's own ready, unsent files for this message, and only for a stored
 * conversation. The cross-field rules are part of the schema, so the route's
 * parse refuses a breach as `invalid_request`.
 */
export const aiChatRequestSchema = z
  .object({
    requestId: z.uuid(),
    message: z
      .string()
      .trim()
      .min(1)
      .max(AI_ASSISTANT_LIMITS.maxMessageChars * 2)
      .refine(
        (text) => Array.from(text).length <= AI_ASSISTANT_LIMITS.maxMessageChars,
        'message character limit',
      ),
    history: z.array(aiHistoryMessageSchema).max(AI_ASSISTANT_LIMITS.maxHistoryMessages),
    context: z.object({ leadId: z.uuid() }).strict().optional(),
    conversationId: z.uuid().optional(),
    attachmentIds: z.array(z.uuid()).max(AI_CHAT_LIMITS.maxAttachmentsPerMessage).optional(),
    /**
     * The effort level of this question; absent means `normal`. The admin sends
     * it only as `high`, and only when capabilities list `high` (an older
     * backend's strict request refuses the key). `high` on a site that does
     * not offer it is `invalid_request` (`details.reason: 'effort_unavailable'`).
     */
    effort: aiEffortSchema.optional(),
    /**
     * The model the member chose for this question, one of capabilities'
     * `models`. The admin sends it only when capabilities list `models` (an
     * older backend's strict request refuses the key), and not for the
     * default. It serves the question at either effort level. An id that is
     * not in the site's saved list now is `invalid_request`
     * (`details.reason: 'model_unavailable'`). Absent, the site's default
     * serves it (the deployment's `AI_GATEWAY_MODEL` until one is saved).
     */
    model: aiModelIdSchema.optional(),
    /**
     * True on the first message of a chat the browser made (its id is the
     * browser's): the server creates the conversation under that id, or, for
     * a retried first message whose conversation already exists, goes on in
     * it. Absent or false, the conversation must already be this member's,
     * else `conversation_not_found`, so a question asked in a tab whose
     * conversation was deleted elsewhere never brings it back. Only beside
     * `conversationId`.
     */
    newConversation: z.boolean().optional(),
    /**
     * True from an admin that shows every card kind in full (`action_cards`).
     * The admin sends it only when the capabilities list `cardActions` (an
     * older backend's strict request refuses the key). Absent, the turn is
     * offered only the card kinds an older admin shows (note, task, email,
     * lead update, task move) and prepares no card it could not show.
     */
    wide: z.literal(true).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.conversationId !== undefined && request.history.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['history'],
        message: 'a stored conversation replays its own history',
      });
    }
    if (request.newConversation !== undefined && request.conversationId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['newConversation'],
        message: 'a new conversation needs its id',
      });
    }
    if (request.attachmentIds !== undefined && request.conversationId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['attachmentIds'],
        message: 'attachments need a stored conversation',
      });
    }
    if (
      request.attachmentIds !== undefined &&
      new Set(request.attachmentIds.map((id) => id.toLowerCase())).size !==
        request.attachmentIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['attachmentIds'],
        message: 'each file once',
      });
    }
  });

export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

/**
 * One backend-created source card. `href` is always a site-relative admin path
 * built from verified identifiers, so a card can never point off-site.
 */
export const aiSourceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'source reference'),
  kind: z.enum(['lead', 'report', 'tasks', 'overview']),
  label: z.string().min(1).max(120),
  href: z
    .string()
    .min(1)
    .max(400)
    .regex(/^\/(?!\/)/, 'site-relative path')
    .refine(
      (href) =>
        !href.includes('\\') &&
        !Array.from(href).some((character) => character.charCodeAt(0) <= 32),
      'safe path',
    ),
  asOf: isoDateTimeSchema,
  scope: z.string().min(1).max(300),
});

export type AiSource = z.infer<typeof aiSourceSchema>;

/** What blocks an AI-prepared stage move until it is completed on the lead page. */
export const aiStageMoveNeedSchema = z.enum([
  'dispatch_details',
  'activation_details',
  'documents',
]);
export type AiStageMoveNeed = z.infer<typeof aiStageMoveNeedSchema>;

/** A proposed write is data for a confirmation card, never a model-executed write. */
export const aiLeadUpdateContextSchema = z
  .object({
    version: z.string().min(1).max(100),
    before: z.string().max(200).nullable(),
    beforeLabel: z.string().max(200),
    choices: z
      .array(
        z
          .object({
            value: z.string().max(100).nullable(),
            label: z.string().max(160),
            /**
             * What a stage move still needs before it can be saved, from the
             * same gates staff pass: a courier on the lead (`dispatch_details`),
             * an activation date (`activation_details`) or approved documents
             * (`documents`, with `missingDocuments`). Absent when nothing is
             * missing. A preview, not a promise: confirmation rechecks.
             */
            needs: aiStageMoveNeedSchema.optional(),
            missingDocuments: z.array(documentChecklistKeySchema).max(16).optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/**
 * A task move's context, read when the card is prepared: the task's title, its
 * stage then (`before`), its lead (null for a plain task) and `version`, the
 * task's update time, which confirmation compares so a task changed since is
 * refused as stale (409 `conflict`) rather than moved over someone's change.
 */
export const aiTaskUpdateContextSchema = z
  .object({
    version: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    before: leadTaskStatusSchema,
    leadId: z.uuid().nullable(),
  })
  .strict();
export type AiTaskUpdateContext = z.infer<typeof aiTaskUpdateContextSchema>;

export const aiActionDraftSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('note'),
      leadId: z.uuid(),
      body: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task'),
      /** The lead the task follows up; absent for a plain task (no lead). */
      leadId: z.uuid().optional(),
      title: z.string().trim().min(1).max(200),
      dueDate: z.iso.date().nullable(),
      assignee: z.enum(['me', 'none']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('email'),
      leadId: z.uuid(),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(150)
        .refine((value) => !/[\r\n]/.test(value), 'Single-line subject'),
      body: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lead_update'),
      leadId: z.uuid(),
      field: z.enum(['stage', 'assignedActorId', 'fullName', 'phone']),
      value: z.string().trim().min(1).max(160).nullable(),
    })
    .strict(),
  /** Moves one task, a lead's or a plain one, to one of its stages (the Tasks board's columns). */
  z
    .object({
      kind: z.literal('task_update'),
      taskId: z.uuid(),
      status: leadTaskStatusSchema,
    })
    .strict(),
]);
export type AiActionDraft = z.infer<typeof aiActionDraftSchema>;

export const aiActionProposalSchema = z
  .object({
    id: z.uuid(),
    token: z.string().min(1).max(40000),
    expiresAt: isoDateTimeSchema,
    leadUpdateContext: aiLeadUpdateContextSchema.optional(),
    taskUpdateContext: aiTaskUpdateContextSchema.optional(),
    emailContext: z.object({ toAddress: z.email(), fromAddress: z.email() }).strict().optional(),
    siteName: z.string().min(1).max(160),
    /** The card's lead, as a label and a link; both absent for a card about no lead (a plain task). */
    leadLabel: z.string().min(1).max(160).optional(),
    leadHref: aiSourceSchema.shape.href.optional(),
    draft: aiActionDraftSchema,
  })
  .strict();
export type AiActionProposal = z.infer<typeof aiActionProposalSchema>;

export const reviseAiActionRequestSchema = z
  .object({ token: z.string().min(1).max(40000), draft: aiActionDraftSchema })
  .strict();
export type ReviseAiActionRequest = z.infer<typeof reviseAiActionRequestSchema>;
export const aiFollowUpSchema = z
  .object({
    question: z.string().trim().min(1).max(300),
    choices: z.array(z.string().trim().min(1).max(200)).min(2).max(5),
  })
  .strict();
export type AiFollowUp = z.infer<typeof aiFollowUpSchema>;

/**
 * Audit B8: the follow-up choices the model may offer, which the person can
 * send with one click. Shorter than the wire's own bound (`aiFollowUpSchema`,
 * kept as it was so an older backend's stored choices still read): the
 * backend refuses a longer choice or more choices at the tool's input, so the
 * model must ask again within them.
 */
export const AI_FOLLOW_UP_LIMITS = {
  /** One choice, in characters. */
  maxChoiceChars: 80,
  /** Choices in one question. */
  maxChoices: 5,
} as const;

/** The model's `askFollowUp` input: `aiFollowUpSchema` within `AI_FOLLOW_UP_LIMITS`. */
export const aiFollowUpToolInputSchema = z
  .object({
    question: aiFollowUpSchema.shape.question,
    choices: z
      .array(z.string().trim().min(1).max(AI_FOLLOW_UP_LIMITS.maxChoiceChars))
      .min(2)
      .max(AI_FOLLOW_UP_LIMITS.maxChoices),
  })
  .strict();

export const confirmAiActionRequestSchema = z
  .object({ token: z.string().min(1).max(40000) })
  .strict();
export type ConfirmAiActionRequest = z.infer<typeof confirmAiActionRequestSchema>;
export const confirmAiActionResponseSchema = z.object({
  status: z.literal('saved'),
  actionId: z.uuid(),
  kind: z.enum(['note', 'task', 'email', 'lead_update', 'task_update']),
  recordId: z.uuid(),
  requestId: requestIdSchema,
});
export type ConfirmAiActionResponse = z.infer<typeof confirmAiActionResponseSchema>;

/*
 * Wider cards (docs/design/ai-actions.md, "Wider cards"). Everything below is
 * additive on the wire: the `actions` stream part, `aiActionDraftSchema` and
 * `aiActionProposalSchema` above keep the shapes an older admin parses, and a
 * backend that has these cards sends every card a second time, in full, in
 * the `action_cards` part an older admin ignores.
 */

/** Daily caps on what one member confirms through Ask AI, per site (C7). Fail closed. */
export const AI_CARD_LIMITS = {
  /** Confirmed AI changes of any kind per member per site per UTC day (mail included). */
  changesPerMemberPerDay: 200,
  /** Confirmed AI-prepared customer mail (written or template) per member per site per UTC day. */
  mailPerMemberPerDay: 50,
  /** Fields one lead edit card may change (stage, order details, form fields and custom values together). */
  maxLeadEditFields: 12,
  /** A text value on a lead edit card, in characters. */
  maxLeadEditTextChars: 1_000,
  /** Other leads a mention warning names. */
  maxMentionNames: 10,
} as const;

/** Every card kind; `actions` and `taskActions` in the capabilities keep their older lists. */
export const AI_CARD_KINDS = [
  'note',
  'task',
  'email',
  'lead_update',
  'task_update',
  'lead_edit',
  'template_email',
  'lead_archive',
  'automation_off',
] as const;
export const aiCardKindSchema = z.enum(AI_CARD_KINDS);
export type AiCardKind = z.infer<typeof aiCardKindSchema>;

/** A task's assignee on a card: the asking member (`me`), nobody (`none`) or an active member's id. */
export const aiTaskAssigneeSchema = z.union([z.enum(['me', 'none']), z.uuid()]);
export type AiTaskAssignee = z.infer<typeof aiTaskAssigneeSchema>;

/** The dispatch and activation details a stage move's card can carry. */
export const AI_ORDER_DETAIL_FIELDS = [
  'courier',
  'trackingNumber',
  'dispatchedAt',
  'activatedAt',
  'activationNumber',
  'activationAccount',
] as const;
export const aiOrderDetailFieldSchema = z.enum(AI_ORDER_DETAIL_FIELDS);
export type AiOrderDetailField = z.infer<typeof aiOrderDetailFieldSchema>;

const leadEditValueSchema = z.union([
  z.string().max(AI_CARD_LIMITS.maxLeadEditTextChars),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * What a lead edit card changes: a subset of the staff `PATCH` body
 * (`updateWorkspaceLeadRequestSchema`), never contact details and never a
 * documents override. Confirmation parses it again with the staff route's
 * own schema.
 */
export const aiLeadEditChangesSchema = z
  .object({
    stage: updateWorkspaceLeadRequestSchema.shape.stage,
    order: leadOrderEditSchema.optional(),
    form: leadFormEditSchema
      .refine((values) =>
        Object.values(values).every(
          (value) =>
            typeof value !== 'string' || value.length <= AI_CARD_LIMITS.maxLeadEditTextChars,
        ),
      )
      .optional(),
    customValues: z
      .record(
        updateWorkspaceLeadRequestSchema.shape.customValues.unwrap().keyType,
        leadEditValueSchema,
      )
      .optional(),
  })
  .strict()
  .refine(
    (changes) =>
      changes.stage !== undefined ||
      changes.order !== undefined ||
      changes.form !== undefined ||
      changes.customValues !== undefined,
    { message: 'nothing to change' },
  )
  .refine(
    (changes) =>
      (changes.stage === undefined ? 0 : 1) +
        Object.keys(changes.order ?? {}).length +
        Object.keys(changes.form ?? {}).length +
        Object.keys(changes.customValues ?? {}).length <=
      AI_CARD_LIMITS.maxLeadEditFields,
    { message: 'too many fields for one card' },
  );
export type AiLeadEditChanges = z.infer<typeof aiLeadEditChangesSchema>;

/** The templates a card may send: exactly those the staff route sends by hand. */
export const aiTemplateEmailKeySchema = queueCustomerEmailRequestSchema.options[0].shape.template;

/**
 * Every card's draft. The `note`, `email` and `lead_update` drafts are the
 * older ones; `task` takes any active member as assignee; `task_update`
 * changes any of status, title, due date and assignee.
 */
export const aiCardDraftSchema = z.discriminatedUnion('kind', [
  aiActionDraftSchema.options[0],
  z
    .object({
      kind: z.literal('task'),
      leadId: z.uuid().optional(),
      title: z.string().trim().min(1).max(200),
      dueDate: z.iso.date().nullable(),
      assignee: aiTaskAssigneeSchema,
    })
    .strict(),
  aiActionDraftSchema.options[2],
  aiActionDraftSchema.options[3],
  z
    .object({
      kind: z.literal('task_update'),
      taskId: z.uuid(),
      status: leadTaskStatusSchema.optional(),
      title: z.string().trim().min(1).max(200).optional(),
      dueDate: z.iso.date().nullable().optional(),
      assignee: aiTaskAssigneeSchema.optional(),
    })
    .strict()
    .refine(
      (draft) =>
        draft.status !== undefined ||
        draft.title !== undefined ||
        draft.dueDate !== undefined ||
        draft.assignee !== undefined,
      { message: 'nothing to change' },
    ),
  /** Stage, order details, form fields and custom values of one lead, in one signed diff. */
  z
    .object({ kind: z.literal('lead_edit'), leadId: z.uuid(), changes: aiLeadEditChangesSchema })
    .strict(),
  /** One of the site's templates, rendered on the server, to the lead's customer. */
  z
    .object({
      kind: z.literal('template_email'),
      leadId: z.uuid(),
      template: aiTemplateEmailKeySchema,
    })
    .strict(),
  /** Archive one lead (`archived: true`) or restore it. */
  z.object({ kind: z.literal('lead_archive'), leadId: z.uuid(), archived: z.boolean() }).strict(),
  /** Switch one automation flow off. There is no card that switches one on. */
  z.object({ kind: z.literal('automation_off'), automationKey: automationKeySchema }).strict(),
]);
export type AiCardDraft = z.infer<typeof aiCardDraftSchema>;

/** One changed field of a lead edit card, as the person reads it: current and proposed, in words. */
export const aiLeadEditRowSchema = z
  .object({
    /** `stage`, `order.<field>`, `form.<key>` or `custom.<key>`. */
    key: z.string().min(1).max(100),
    label: z.string().min(1).max(160),
    before: z.string().max(AI_CARD_LIMITS.maxLeadEditTextChars).nullable(),
    after: z.string().max(AI_CARD_LIMITS.maxLeadEditTextChars).nullable(),
  })
  .strict();

/**
 * A lead edit card's context, read when it is prepared and shown only in the
 * browser: each changed field's current and proposed value, the dispatch or
 * activation details the person may fill in or correct on the card
 * (`inputs`, with the current values in `rows`), and what a stage move still
 * needs before Confirm (`needs`).
 */
export const aiLeadEditContextSchema = z
  .object({
    rows: z.array(aiLeadEditRowSchema).max(40),
    inputs: z
      .array(
        z
          .object({
            field: aiOrderDetailFieldSchema,
            label: z.string().min(1).max(80),
            kind: z.enum(['text', 'date']),
            required: z.boolean(),
            current: z.string().max(200).nullable(),
          })
          .strict(),
      )
      .max(AI_ORDER_DETAIL_FIELDS.length),
    needs: aiStageMoveNeedSchema.optional(),
  })
  .strict();
export type AiLeadEditContext = z.infer<typeof aiLeadEditContextSchema>;

/** A template email card's server-rendered preview: what the customer receives. */
export const aiTemplateEmailContextSchema = z
  .object({
    templateName: z.string().min(1).max(80),
    version: z.int().min(0),
    subject: z.string().min(1).max(300),
    text: z.string().min(1).max(20_000),
  })
  .strict();

/** The flow a switch-off card names, as it was when the card was prepared. */
export const aiAutomationOffContextSchema = z
  .object({ name: z.string().min(1).max(80), revision: z.int().min(0) })
  .strict();

/** A choice of assignee for a task card: `me`, `none` or a member id, with its label. */
export const aiAssigneeChoiceSchema = z
  .object({ value: aiTaskAssigneeSchema, label: z.string().min(1).max(160) })
  .strict();

/** What a task edit card changes besides the status, before and after, in words. */
export const aiTaskEditContextSchema = z
  .object({
    dueDate: z.iso.date().nullable(),
    assigneeLabel: z.string().min(1).max(160),
  })
  .strict();

/**
 * One card in full. The older proposal's fields with the wider draft, and,
 * all optional and server-computed:
 * - `sideEffects`: what Confirm sets off besides the change itself (flows
 *   that fire and the mail they send, an unfinished checkout submitted,
 *   waiting runs and timers cancelled), every entry shown in full;
 * - `mentions`: the names and references of other leads read in the same
 *   turn that the email or note mentions; with `acknowledgementRequired`
 *   the confirmation is refused unless the person ticks that they checked it;
 * - the context of the new kinds, and assignee choices for task cards.
 */
export const aiActionCardSchema = z.object({
  ...aiActionProposalSchema.shape,
  draft: aiCardDraftSchema,
  sideEffects: z.array(z.string().min(1).max(300)).max(20).optional(),
  mentions: z.array(z.string().min(1).max(160)).max(AI_CARD_LIMITS.maxMentionNames).optional(),
  acknowledgementRequired: z.boolean().optional(),
  leadEditContext: aiLeadEditContextSchema.optional(),
  templateEmailContext: aiTemplateEmailContextSchema.optional(),
  automationOffContext: aiAutomationOffContextSchema.optional(),
  assigneeChoices: z.array(aiAssigneeChoiceSchema).max(101).optional(),
  taskEditContext: aiTaskEditContextSchema.optional(),
});
export type AiActionCard = z.infer<typeof aiActionCardSchema>;

/**
 * `POST …/ai/actions/revise` for a newer admin: the wider draft, and `wide`
 * (sent only when the capabilities list `cardActions`) to receive the card in
 * full rather than in the older proposal's shape.
 */
export const reviseAiCardRequestSchema = z
  .object({
    token: z.string().min(1).max(40000),
    draft: aiCardDraftSchema,
    wide: z.literal(true).optional(),
  })
  .strict();
export type ReviseAiCardRequest = z.infer<typeof reviseAiCardRequestSchema>;

/**
 * `POST …/ai/actions/confirm`: the token, and `acknowledged` once the person
 * ticked that they checked a card whose `acknowledgementRequired` is set.
 */
export const confirmAiCardRequestSchema = z
  .object({ token: z.string().min(1).max(40000), acknowledged: z.literal(true).optional() })
  .strict();
export type ConfirmAiCardRequest = z.infer<typeof confirmAiCardRequestSchema>;

export const confirmAiCardResponseSchema = confirmAiActionResponseSchema.extend({
  kind: aiCardKindSchema,
});
export type ConfirmAiCardResponse = z.infer<typeof confirmAiCardResponseSchema>;

/** Why a streamed answer ended without one. Safe to show; never a provider body. */
export const aiStreamErrorCodeSchema = z.enum([
  'provider_unavailable',
  'rate_limited',
  'timeout',
  'cancelled',
  'access_lost',
  'budget_exceeded',
  'tool_unavailable',
  'internal_error',
]);

export type AiStreamErrorCode = z.infer<typeof aiStreamErrorCodeSchema>;

/**
 * The typed parts of the server-sent event stream, one JSON object per frame.
 * Unknown parts are ignored by the client; raw tool arguments, tool results,
 * model reasoning and provider errors never appear here.
 */
export const aiStreamPartSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('automation_proposals'),
      proposals: z.array(aiAutomationProposalSchema).max(3),
    })
    .strict(),
  z.object({ type: z.literal('progress'), label: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8_000) }).strict(),
  z.object({ type: z.literal('sources'), sources: z.array(aiSourceSchema).max(20) }).strict(),
  z
    .object({ type: z.literal('actions'), actions: z.array(aiActionProposalSchema).max(3) })
    .strict(),
  /**
   * Every card of the turn in full (`aiActionCardSchema`), sent before the
   * `actions` part. An older admin ignores this part and reads `actions`,
   * which carries only the cards it can show, in their older shape; a newer
   * admin keeps each card from here and skips its copy in `actions`.
   */
  z.object({ type: z.literal('action_cards'), cards: z.array(aiActionCardSchema).max(3) }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: aiStreamErrorCodeSchema,
      message: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ type: z.literal('follow_up'), followUp: aiFollowUpSchema }).strict(),
  /**
   * Something the person should know about how this answer was made, by a
   * fixed code the admin words itself. `attachment_budget_spent`: the
   * member's daily attachment budget is used up, so this turn's files were
   * not sent (audit B7). An older admin drops the part.
   */
  z.object({ type: z.literal('notice'), code: z.enum(['attachment_budget_spent']) }).strict(),
  /**
   * Stored conversations only, sent once right after the member's message is
   * saved and before any answer: the conversation it belongs to, the saved
   * message's id, the title, and whether this message created the
   * conversation. Never sent for a request without `conversationId`.
   */
  z
    .object({
      type: z.literal('conversation'),
      conversationId: z.uuid(),
      userMessageId: z.uuid(),
      title: aiConversationTitleSchema,
      created: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('done'),
      /** The answer's history signature (CHAT-2); absent when signing is not configured. */
      signature: z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .optional(),
      /**
       * The saved answer's id, for a stored conversation whose answer was
       * saved. Never sent for a request without `conversationId`: a `done` part
       * an older admin does not know (this part is strict) would be dropped.
       */
      messageId: z.uuid().optional(),
    })
    .strict(),
]);

export type AiStreamPart = z.infer<typeof aiStreamPartSchema>;

/** The event name the stream uses for every part; kept here so both ends agree. */
export const AI_STREAM_EVENT = 'part';

/** AI SDK v7 UI-message protocol custom data part; payload stays backend-owned. */
export const aiWirePartSchema = z
  .object({
    type: z.literal('data-assistant'),
    data: aiStreamPartSchema,
    transient: z.literal(true),
  })
  .strict();
