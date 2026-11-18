import { describe, expect, it } from 'vitest';

import { AI_CHAT_LIMITS } from './ai-assistant';
import {
  aiAttachmentLinkResponseSchema,
  aiAttachmentRejectReasonSchema,
  aiConversationCursorSchema,
  aiConversationResponseSchema,
  aiStoredMessageSchema,
  aiUsageQuerySchema,
  aiUsageResponseSchema,
  createAiAttachmentIntentRequestSchema,
  createAiAttachmentIntentResponseSchema,
  deleteAiAttachmentResponseSchema,
  deleteAiConversationResponseSchema,
  finalizeAiAttachmentRequestSchema,
  finalizeAiAttachmentResponseSchema,
  formatAiConversationCursor,
  getAiConversationResponseSchema,
  listAiConversationsQuerySchema,
  listAiConversationsResponseSchema,
  parseAiConversationCursor,
  renameAiConversationRequestSchema,
} from './ai-conversations';
import { domainErrorCodeSchema } from './common';
import { endpoints } from './endpoints';
import { createDownloadLinkResponseSchema } from './files';
import { createUploadIntentResponseSchema } from './uploads';

const ID = '60000000-0000-4000-8000-0000000000a1';
const OTHER = '60000000-0000-4000-8000-0000000000a2';
const REQUEST_ID = '50000000-0000-4000-8000-0000000000a1';
const NOW = '2026-11-18T12:00:00.000Z';
const CURSOR = `1794999600123456.${ID}`;

const conversation = {
  id: ID,
  title: 'SIM orders this week',
  createdAt: NOW,
  updatedAt: NOW,
  lastMessageAt: NOW,
};
const attachment = {
  id: OTHER,
  kind: 'image',
  mediaType: 'image/png',
  fileName: 'letter.png',
  byteSize: 2048,
};
const question = {
  id: ID,
  role: 'user',
  text: 'What does this letter ask for?',
  outcome: 'completed',
  sources: [],
  expiredDrafts: 0,
  createdAt: NOW,
  attachments: [attachment],
};
const answer = {
  id: OTHER,
  role: 'assistant',
  text: '',
  outcome: 'failed',
  errorCode: 'provider_unavailable',
  sources: [
    {
      id: 'lead_1',
      kind: 'lead',
      label: 'MS-153',
      href: `/w/getcanadasim/leads/${ID}`,
      asOf: NOW,
      scope: 'today',
    },
  ],
  followUp: { question: 'Which lead?', choices: ['MS-153', 'MS-154'] },
  expiredDrafts: 2,
  createdAt: NOW,
  attachments: [],
};

describe('the conversation list', () => {
  it('pages with a keyset cursor and an optional title search', () => {
    expect(listAiConversationsQuerySchema.parse({})).toEqual({});
    expect(
      listAiConversationsQuerySchema.parse({ cursor: CURSOR, limit: '30', q: ' sim ' }),
    ).toEqual({ cursor: CURSOR, limit: 30, q: 'sim' });
    for (const query of [
      { limit: '0' },
      { limit: String(AI_CHAT_LIMITS.conversationPageSize + 1) },
      { limit: '2.5' },
      { q: '   ' },
      { q: 'a'.repeat(121) },
      { cursor: 'abc' },
      { page: '2' },
    ]) {
      expect(listAiConversationsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(
        false,
      );
    }
  });

  it('answers a page of conversations and a next cursor only when there is more', () => {
    const page = { conversations: [conversation], nextCursor: CURSOR, requestId: REQUEST_ID };
    expect(listAiConversationsResponseSchema.parse(page)).toEqual(page);
    const last = { conversations: [], requestId: REQUEST_ID };
    expect(listAiConversationsResponseSchema.parse(last)).toEqual(last);
    expect(
      listAiConversationsResponseSchema.safeParse({
        ...page,
        conversations: Array.from({ length: 31 }, () => conversation),
      }).success,
    ).toBe(false);
  });
});

describe('the keyset cursor', () => {
  it('is microseconds since the epoch, a dot and a lower-case id, and round-trips', () => {
    expect(formatAiConversationCursor({ micros: '1794999600123456', id: ID.toUpperCase() })).toBe(
      CURSOR,
    );
    expect(parseAiConversationCursor(CURSOR)).toEqual({ micros: '1794999600123456', id: ID });
    expect(aiConversationCursorSchema.safeParse(`0.${ID}`).success).toBe(true);
  });

  it('refuses anything else', () => {
    for (const cursor of [
      '',
      ID,
      `01.${ID}`,
      `-1.${ID}`,
      `1.5.${ID}`,
      `123456789012345678.${ID}`,
      `1794999600123456.${ID.toUpperCase()}`,
      `1794999600123456.${ID}x`,
      `2026-11-18T12:00:00Z.${ID}`,
    ]) {
      expect(aiConversationCursorSchema.safeParse(cursor).success, cursor).toBe(false);
      expect(parseAiConversationCursor(cursor)).toBeUndefined();
    }
    expect(() => formatAiConversationCursor({ micros: '1.5', id: ID })).toThrow();
  });
});

describe('a conversation and its messages', () => {
  it('answers the conversation with every message, files as summaries only', () => {
    const detail = { conversation, messages: [question, answer], requestId: REQUEST_ID };
    expect(getAiConversationResponseSchema.parse(detail)).toEqual(detail);
  });

  it('reads an error code added later as a plain code, but never free text', () => {
    expect(
      aiStoredMessageSchema.safeParse({ ...answer, errorCode: 'a_code_from_later' }).success,
    ).toBe(true);
    for (const errorCode of ['ECONNRESET', 'Provider said no', '', 'a'.repeat(61)]) {
      expect(aiStoredMessageSchema.safeParse({ ...answer, errorCode }).success, errorCode).toBe(
        false,
      );
    }
  });

  it('bounds a stored message', () => {
    expect(aiStoredMessageSchema.safeParse({ ...answer, text: '😀'.repeat(20_000) }).success).toBe(
      true,
    );
    for (const bad of [
      { ...answer, text: '😀'.repeat(20_001) },
      { ...answer, role: 'system' },
      { ...answer, outcome: 'pending' },
      { ...answer, expiredDrafts: -1 },
      { ...question, attachments: Array.from({ length: 5 }, () => attachment) },
      { ...question, attachments: [{ ...attachment, kind: 'audio' }] },
      { ...question, attachments: [{ ...attachment, fileName: 'a'.repeat(201) }] },
      { ...question, attachments: [{ ...attachment, byteSize: 0 }] },
    ]) {
      expect(aiStoredMessageSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      getAiConversationResponseSchema.safeParse({
        conversation,
        messages: Array.from(
          { length: AI_CHAT_LIMITS.maxConversationMessages + 1 },
          () => question,
        ),
        requestId: REQUEST_ID,
      }).success,
    ).toBe(false);
  });
});

describe('rename and delete', () => {
  it('renames to a trimmed title of 1 to 120 characters on one line', () => {
    expect(renameAiConversationRequestSchema.parse({ title: '  New name  ' })).toEqual({
      title: 'New name',
    });
    expect(renameAiConversationRequestSchema.safeParse({ title: 'a'.repeat(120) }).success).toBe(
      true,
    );
    for (const body of [
      { title: '' },
      { title: '   ' },
      { title: 'a'.repeat(121) },
      { title: 'two\nlines' },
      { title: 'tab\there' },
      { title: 'Name', actorId: ID },
      {},
    ]) {
      expect(renameAiConversationRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
    expect(aiConversationResponseSchema.parse({ conversation, requestId: REQUEST_ID })).toEqual({
      conversation,
      requestId: REQUEST_ID,
    });
  });

  it('answers a delete with the id, like every other DELETE', () => {
    expect(
      deleteAiConversationResponseSchema.parse({ conversationId: ID, requestId: REQUEST_ID }),
    ).toEqual({ conversationId: ID, requestId: REQUEST_ID });
    expect(
      deleteAiAttachmentResponseSchema.parse({ attachmentId: ID, requestId: REQUEST_ID }),
    ).toEqual({ attachmentId: ID, requestId: REQUEST_ID });
  });
});

describe('attachments', () => {
  const intent = { fileName: 'letter.pdf', mediaType: 'application/pdf', byteSize: 1024 };

  it('asks for an upload with a claimed name, accepted type and size', () => {
    expect(createAiAttachmentIntentRequestSchema.parse(intent)).toEqual(intent);
    expect(
      createAiAttachmentIntentRequestSchema.safeParse({
        ...intent,
        byteSize: AI_CHAT_LIMITS.maxPdfBytes,
      }).success,
    ).toBe(true);
    for (const body of [
      { ...intent, mediaType: 'image/gif' },
      { ...intent, mediaType: '' },
      { ...intent, byteSize: 0 },
      { ...intent, byteSize: AI_CHAT_LIMITS.maxPdfBytes + 1 },
      { ...intent, byteSize: 1.5 },
      { ...intent, fileName: '' },
      { ...intent, fileName: 'a'.repeat(256) },
      { ...intent, conversationId: ID },
      { ...intent, leadId: ID },
    ]) {
      expect(
        createAiAttachmentIntentRequestSchema.safeParse(body).success,
        JSON.stringify(body),
      ).toBe(false);
    }
  });

  it('answers with the documents upload target and finalizes with its checksum', () => {
    // The very same schemas, so one browser upload helper serves both features.
    expect(createAiAttachmentIntentResponseSchema).toBe(createUploadIntentResponseSchema);
    expect(aiAttachmentLinkResponseSchema).toBe(createDownloadLinkResponseSchema);
    const target = {
      uploadId: ID,
      url: 'https://storage.example.com/put?sig=1',
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      expiresAt: NOW,
      requestId: REQUEST_ID,
    };
    expect(createAiAttachmentIntentResponseSchema.parse(target)).toEqual(target);

    expect(finalizeAiAttachmentRequestSchema.parse({ checksumSha256: 'a'.repeat(64) })).toEqual({
      checksumSha256: 'a'.repeat(64),
    });
    for (const body of [
      {},
      { checksumSha256: 'A'.repeat(64) },
      { checksumSha256: 'a'.repeat(63) },
      { checksumSha256: 'a'.repeat(64), mediaType: 'image/png' },
    ]) {
      expect(finalizeAiAttachmentRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(finalizeAiAttachmentResponseSchema.parse({ attachment, requestId: REQUEST_ID })).toEqual(
      { attachment, requestId: REQUEST_ID },
    );
    expect(
      aiAttachmentLinkResponseSchema.parse({
        url: 'https://storage.example.com/get?sig=1',
        expiresAt: NOW,
        requestId: REQUEST_ID,
      }),
    ).toMatchObject({ expiresAt: NOW });
  });

  it('names the four safe reasons a file is refused', () => {
    expect(aiAttachmentRejectReasonSchema.options).toEqual(['type', 'size', 'empty', 'unreadable']);
  });
});

describe('usage', () => {
  const usage = {
    period: 30,
    totals: { turns: 3, inputTokens: 1200, outputTokens: 300 },
    members: [
      {
        actorId: ID,
        displayName: 'Sam',
        turns: 3,
        inputTokens: 1200,
        outputTokens: 300,
        lastUsedAt: NOW,
      },
      {
        actorId: OTHER,
        displayName: null,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastUsedAt: NOW,
      },
    ],
    requestId: REQUEST_ID,
  };

  it('takes a period of 7, 30 or 90 days', () => {
    expect(aiUsageQuerySchema.parse({})).toEqual({});
    for (const period of ['7', '30', '90']) {
      expect(aiUsageQuerySchema.parse({ period })).toEqual({ period: Number(period) });
    }
    for (const query of [{ period: '14' }, { period: 'week' }, { period: '0' }, { days: '7' }]) {
      expect(aiUsageQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('answers counts per member and never content', () => {
    expect(aiUsageResponseSchema.parse(usage)).toEqual(usage);
    for (const bad of [
      { ...usage, period: 14 },
      { ...usage, totals: { ...usage.totals, inputTokens: -1 } },
      { ...usage, members: [{ ...usage.members[0], turns: 1.5 }] },
    ]) {
      expect(aiUsageResponseSchema.safeParse(bad).success).toBe(false);
    }
    // Unknown keys are stripped on a response, so a question can never pass through.
    const parsed = aiUsageResponseSchema.parse({
      ...usage,
      members: [{ ...usage.members[0], lastQuestion: 'leaked?' }],
    });
    expect(parsed.members[0]).not.toHaveProperty('lastQuestion');
  });
});

describe('registry and error codes', () => {
  it('registers every saved-chat endpoint under the staff AI path', () => {
    const base = '/api/v1/staff/workspaces/{workspaceId}/ai';
    const expected = [
      ['listAiConversations', 'GET', `${base}/conversations`, 200],
      ['getAiConversation', 'GET', `${base}/conversations/{conversationId}`, 200],
      ['renameAiConversation', 'PATCH', `${base}/conversations/{conversationId}`, 200],
      ['deleteAiConversation', 'DELETE', `${base}/conversations/{conversationId}`, 200],
      ['createAiAttachmentIntent', 'POST', `${base}/attachments/intents`, 201],
      ['finalizeAiAttachment', 'POST', `${base}/attachments/{attachmentId}/finalize`, 200],
      ['deleteAiAttachment', 'DELETE', `${base}/attachments/{attachmentId}`, 200],
      ['getAiAttachmentLink', 'GET', `${base}/attachments/{attachmentId}/link`, 200],
      ['getAiUsage', 'GET', `${base}/usage`, 200],
    ] as const;
    for (const [operationId, method, path, status] of expected) {
      const entry = endpoints.find((candidate) => candidate.operationId === operationId);
      expect(entry, operationId).toMatchObject({
        method,
        path,
        successStatus: status,
        auth: 'staff',
      });
      expect(entry?.response, operationId).toBeDefined();
    }
  });

  it('knows the four saved-chat error codes', () => {
    for (const code of [
      'conversation_not_found',
      'conversation_full',
      'attachment_rejected',
      'attachments_unavailable',
    ]) {
      expect(domainErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });
});
