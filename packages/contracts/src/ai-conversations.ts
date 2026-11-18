import { z } from 'zod';

import {
  AI_CHAT_LIMITS,
  aiAttachmentKindSchema,
  aiAttachmentMediaTypeSchema,
  aiConversationTitleSchema,
  aiFollowUpSchema,
  aiSourceSchema,
} from './ai-assistant';
import { isoDateTimeSchema, requestIdSchema } from './common';
import { createDownloadLinkResponseSchema } from './files';
import { createUploadIntentResponseSchema, finalizeUploadRequestSchema } from './uploads';

/**
 * Ask AI as a saved chat: a member's stored conversations, the files they
 * attach to a message, and the owner's usage view. Every conversation and file
 * is private to the member who made it on one site (the database's owner
 * policy, not only the routes): another member, the site owner included, gets
 * `conversation_not_found` for its id, never a 403 that would reveal it
 * exists. The usage view is the one read across members and carries counts
 * only, never content. Every route is guarded like `ai/capabilities` and
 * answers `cache-control: no-store`.
 */

/** Why a file was refused, sent as `details.reason` on `attachment_rejected` (safe to show). */
export const aiAttachmentRejectReasonSchema = z.enum(['type', 'size', 'empty', 'unreadable']);
export type AiAttachmentRejectReason = z.infer<typeof aiAttachmentRejectReasonSchema>;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The list's keyset cursor: `<µs>.<id>`, the last row's `last_message_at` in
 * whole microseconds since the Unix epoch (Postgres keeps microseconds, a JS
 * `Date` only milliseconds, so the cursor never goes through one) and its id
 * in lower case. Made by the backend (`formatAiConversationCursor`), passed
 * back unchanged by the admin; the next page is the rows strictly older in
 * `(last_message_at desc, id desc)` order.
 */
export const aiConversationCursorSchema = z
  .string()
  .max(60)
  .regex(new RegExp(`^(0|[1-9][0-9]{0,16})\\.${UUID_PATTERN}$`), 'conversation cursor');
export type AiConversationCursor = z.infer<typeof aiConversationCursorSchema>;

/** The cursor of a row; `micros` is the decimal integer of microseconds since the epoch. */
export function formatAiConversationCursor(row: { micros: string; id: string }): string {
  return aiConversationCursorSchema.parse(`${row.micros}.${row.id.toLowerCase()}`);
}

/** The row a cursor names, or undefined for anything else. */
export function parseAiConversationCursor(
  cursor: string,
): { micros: string; id: string } | undefined {
  if (!aiConversationCursorSchema.safeParse(cursor).success) return undefined;
  const dot = cursor.indexOf('.');
  return { micros: cursor.slice(0, dot), id: cursor.slice(dot + 1) };
}

/** One stored conversation, as the list and the detail show it. */
export const aiConversationSchema = z.object({
  id: z.uuid(),
  title: aiConversationTitleSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lastMessageAt: isoDateTimeSchema,
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

/**
 * `GET …/ai/conversations`: the caller's conversations on this site, newest
 * message first. `q` matches the title (case-insensitive, its `%`, `_` and
 * `\` taken literally); `limit` defaults to `conversationPageSize`.
 */
export const listAiConversationsQuerySchema = z
  .object({
    cursor: aiConversationCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(AI_CHAT_LIMITS.conversationPageSize).optional(),
    q: z.string().trim().min(1).max(AI_CHAT_LIMITS.maxTitleChars).optional(),
  })
  .strict();
export type ListAiConversationsQuery = z.infer<typeof listAiConversationsQuerySchema>;
export type ListAiConversationsQueryInput = z.input<typeof listAiConversationsQuerySchema>;

/** A page of the list; `nextCursor` is present exactly when an older page exists. */
export const listAiConversationsResponseSchema = z.object({
  conversations: z.array(aiConversationSchema).max(AI_CHAT_LIMITS.conversationPageSize),
  nextCursor: aiConversationCursorSchema.optional(),
  requestId: requestIdSchema,
});
export type ListAiConversationsResponse = z.infer<typeof listAiConversationsResponseSchema>;

/** A stored file as a message shows it: never its storage key, checksum or text. */
export const aiAttachmentSummarySchema = z.object({
  id: z.uuid(),
  kind: aiAttachmentKindSchema,
  mediaType: aiAttachmentMediaTypeSchema,
  fileName: z.string().min(1).max(AI_CHAT_LIMITS.maxFileNameChars),
  byteSize: z.int().positive(),
});
export type AiAttachmentSummary = z.infer<typeof aiAttachmentSummarySchema>;

/** How a stored answer ended; a question is always `completed`. The words of `ai_turns.outcome`. */
export const aiMessageOutcomeSchema = z.enum(['completed', 'failed', 'cancelled', 'access_lost']);
export type AiMessageOutcome = z.infer<typeof aiMessageOutcomeSchema>;

/**
 * One stored message. An answer keeps the text that was actually streamed (it
 * may be empty for a turn that failed first), its sources and follow-up, how
 * it ended and, when it failed, the stream's error code. The action cards and
 * automation drafts it carried are not stored (their signed tokens are
 * short-lived); `expiredDrafts` counts them so the admin can say they are no
 * longer available. `errorCode` is one of `aiStreamErrorCodeSchema`'s codes
 * when written; it is read as a plain code so one added later never fails an
 * older admin's read of the whole conversation.
 */
export const aiStoredMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z
    .string()
    .max(AI_CHAT_LIMITS.maxStoredMessageChars * 2)
    .refine(
      (text) => Array.from(text).length <= AI_CHAT_LIMITS.maxStoredMessageChars,
      'stored message character limit',
    ),
  outcome: aiMessageOutcomeSchema,
  errorCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,59}$/)
    .optional(),
  sources: z.array(aiSourceSchema).max(20),
  followUp: aiFollowUpSchema.optional(),
  expiredDrafts: z.int().nonnegative().max(100),
  createdAt: isoDateTimeSchema,
  attachments: z.array(aiAttachmentSummarySchema).max(AI_CHAT_LIMITS.maxAttachmentsPerMessage),
});
export type AiStoredMessage = z.infer<typeof aiStoredMessageSchema>;

/** `GET …/ai/conversations/:conversationId`: the conversation and every message, oldest first. */
export const getAiConversationResponseSchema = z.object({
  conversation: aiConversationSchema,
  messages: z.array(aiStoredMessageSchema).max(AI_CHAT_LIMITS.maxConversationMessages),
  requestId: requestIdSchema,
});
export type GetAiConversationResponse = z.infer<typeof getAiConversationResponseSchema>;

/** `PATCH …/ai/conversations/:conversationId`: a new title, trimmed, one line. */
export const renameAiConversationRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(AI_CHAT_LIMITS.maxTitleChars)
      .pipe(aiConversationTitleSchema),
  })
  .strict();
export type RenameAiConversationRequest = z.infer<typeof renameAiConversationRequestSchema>;

/** The renamed conversation. */
export const aiConversationResponseSchema = z.object({
  conversation: aiConversationSchema,
  requestId: requestIdSchema,
});
export type AiConversationResponse = z.infer<typeof aiConversationResponseSchema>;

/**
 * `DELETE …/ai/conversations/:conversationId`: the conversation, its messages
 * and its files are gone for good (the stored objects are removed after the
 * commit). Answers 200 with the id, like every other DELETE of the API.
 */
export const deleteAiConversationResponseSchema = z.object({
  conversationId: z.uuid(),
  requestId: requestIdSchema,
});
export type DeleteAiConversationResponse = z.infer<typeof deleteAiConversationResponseSchema>;

/**
 * `POST …/ai/attachments/intents`: the browser's claim about one file. The
 * claim only picks the kind's size limit and the upload's content type; the
 * real type is decided at finalize from the file's bytes. A browser that
 * reports no type (common for `.md` and `.csv`) is mapped from the extension
 * by the admin before it asks. `byteSize` is bounded here by the largest kind;
 * the limit of the claimed kind is the backend's `attachment_rejected`
 * (`size`). The stored name is sanitized to `maxFileNameChars`.
 */
export const createAiAttachmentIntentRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mediaType: aiAttachmentMediaTypeSchema,
    byteSize: z.int().positive().max(AI_CHAT_LIMITS.maxPdfBytes),
  })
  .strict();
export type CreateAiAttachmentIntentRequest = z.infer<typeof createAiAttachmentIntentRequestSchema>;

/**
 * The signed PUT the browser uploads the file to: the documents feature's
 * upload target, unchanged, so one browser upload helper serves both.
 * `uploadId` is the attachment's id (the id finalize, delete, link and
 * `attachmentIds` take).
 */
export const createAiAttachmentIntentResponseSchema = createUploadIntentResponseSchema;
export type CreateAiAttachmentIntentResponse = z.infer<
  typeof createAiAttachmentIntentResponseSchema
>;

/**
 * `POST …/ai/attachments/:attachmentId/finalize`: the SHA-256 of the bytes the
 * browser uploaded, as the documents finalize sends it. The backend copies the
 * upload where the browser cannot change it and checks size, magic bytes (and
 * for text a strict UTF-8 decode with no NUL) and this checksum.
 */
export const finalizeAiAttachmentRequestSchema = finalizeUploadRequestSchema.strict();
export type FinalizeAiAttachmentRequest = z.infer<typeof finalizeAiAttachmentRequestSchema>;

/** The verified file, ready to be sent with a message. */
export const finalizeAiAttachmentResponseSchema = z.object({
  attachment: aiAttachmentSummarySchema,
  requestId: requestIdSchema,
});
export type FinalizeAiAttachmentResponse = z.infer<typeof finalizeAiAttachmentResponseSchema>;

/** `DELETE …/ai/attachments/:attachmentId`: an unsent file, row and object. */
export const deleteAiAttachmentResponseSchema = z.object({
  attachmentId: z.uuid(),
  requestId: requestIdSchema,
});
export type DeleteAiAttachmentResponse = z.infer<typeof deleteAiAttachmentResponseSchema>;

/**
 * `GET …/ai/attachments/:attachmentId/link`: a short-lived signed link to the
 * member's own file, served as its verified type with nosniff (the staff
 * document download link's shape).
 */
export const aiAttachmentLinkResponseSchema = createDownloadLinkResponseSchema;
export type AiAttachmentLinkResponse = z.infer<typeof aiAttachmentLinkResponseSchema>;

/** The usage periods, in days: `ai_turns` rows are pruned after 90. */
export const AI_USAGE_PERIODS = [7, 30, 90] as const;
export const aiUsagePeriodSchema = z.literal([...AI_USAGE_PERIODS]);
export type AiUsagePeriod = z.infer<typeof aiUsagePeriodSchema>;

/** `GET …/ai/usage`: owner only; `period` defaults to 30. */
export const aiUsageQuerySchema = z
  .object({ period: z.coerce.number().pipe(aiUsagePeriodSchema).optional() })
  .strict();
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;
export type AiUsageQueryInput = z.input<typeof aiUsageQuerySchema>;

const usageCount = z.int().nonnegative();

/** Turns and tokens, summed from `ai_turns`. */
export const aiUsageTotalsSchema = z.object({
  turns: usageCount,
  inputTokens: usageCount,
  outputTokens: usageCount,
});
export type AiUsageTotals = z.infer<typeof aiUsageTotalsSchema>;

/** One member's usage in the period: counts only, never a question or an answer. */
export const aiUsageMemberSchema = aiUsageTotalsSchema.extend({
  actorId: z.uuid(),
  /** Their own display name on this site; null when unset or no longer a member. */
  displayName: z.string().min(1).max(80).nullable(),
  lastUsedAt: isoDateTimeSchema,
});
export type AiUsageMember = z.infer<typeof aiUsageMemberSchema>;

/** The site's Ask AI usage over the period: totals and one row per member who used it. */
export const aiUsageResponseSchema = z.object({
  period: aiUsagePeriodSchema,
  totals: aiUsageTotalsSchema,
  members: z.array(aiUsageMemberSchema).max(1000),
  requestId: requestIdSchema,
});
export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;
