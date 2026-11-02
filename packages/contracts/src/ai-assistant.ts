import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { leadTypeSchema } from './leads';

/**
 * The staff AI assistant ("Ask AI"): its capability document, the one chat
 * request the admin may send, and the typed parts of the streamed answer.
 *
 * Version 1 is read-only. Nothing in this module grants access: every route
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
  /** The whole turn, tools and model included. */
  requestTimeoutMs: 60_000,
  /** One database tool's statement deadline. */
  toolQueryTimeoutMs: 5_000,
  /** Chat requests per actor per site in a rolling minute. */
  perActorPerMinute: 10,
  /** Chat requests per site in a rolling minute. */
  perSitePerMinute: 60,
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
  available: z.boolean(),
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

/** One earlier turn, as text only: the model never receives stored tool data. */
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
  })
  .strict();

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
  z.object({ type: z.literal('progress'), label: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8_000) }).strict(),
  z.object({ type: z.literal('sources'), sources: z.array(aiSourceSchema).max(20) }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: aiStreamErrorCodeSchema,
      message: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ type: z.literal('done') }).strict(),
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
