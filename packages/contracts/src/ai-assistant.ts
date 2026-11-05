import { aiAutomationProposalSchema } from './ai-automations';
import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { leadTypeSchema } from './leads';
import { documentChecklistKeySchema } from './domain';

/**
 * The staff AI assistant ("Ask AI"): its capability document, the one chat
 * request the admin may send, and the typed parts of the streamed answer.
 *
 * Reads and signed task, note, email and lead-update proposals. Nothing in this module grants access: every route
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
} as const;

export type AiAssistantLimits = typeof AI_ASSISTANT_LIMITS;

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
 * identity. Actor, site, roles, model and provider settings are never accepted
 * from the body — the route derives them.
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
  })
  .strict();

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
      leadId: z.uuid(),
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
]);
export type AiActionDraft = z.infer<typeof aiActionDraftSchema>;

export const aiActionProposalSchema = z
  .object({
    id: z.uuid(),
    token: z.string().min(1).max(40000),
    expiresAt: isoDateTimeSchema,
    leadUpdateContext: aiLeadUpdateContextSchema.optional(),
    emailContext: z.object({ toAddress: z.email(), fromAddress: z.email() }).strict().optional(),
    siteName: z.string().min(1).max(160),
    leadLabel: z.string().min(1).max(160),
    leadHref: aiSourceSchema.shape.href,
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

export const confirmAiActionRequestSchema = z
  .object({ token: z.string().min(1).max(40000) })
  .strict();
export type ConfirmAiActionRequest = z.infer<typeof confirmAiActionRequestSchema>;
export const confirmAiActionResponseSchema = z.object({
  status: z.literal('saved'),
  actionId: z.uuid(),
  kind: z.enum(['note', 'task', 'email', 'lead_update']),
  recordId: z.uuid(),
  requestId: requestIdSchema,
});
export type ConfirmAiActionResponse = z.infer<typeof confirmAiActionResponseSchema>;

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
  z
    .object({
      type: z.literal('error'),
      code: aiStreamErrorCodeSchema,
      message: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ type: z.literal('follow_up'), followUp: aiFollowUpSchema }).strict(),
  z
    .object({
      type: z.literal('done'),
      /** The answer's history signature (CHAT-2); absent when signing is not configured. */
      signature: z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .optional(),
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
