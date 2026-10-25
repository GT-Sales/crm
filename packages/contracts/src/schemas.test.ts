import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  apiErrorResponseSchema,
  apiErrorSchema,
  createDownloadLinkResponseSchema,
  createExportRequestSchema,
  createExportResponseSchema,
  createLeadRequestSchema,
  createLeadResponseSchema,
  createUploadIntentRequestSchema,
  createUploadIntentResponseSchema,
  finalizeUploadRequestSchema,
  finalizeUploadResponseSchema,
  listAssignableMembersResponseSchema,
  listWorkspaceLeadsResponseSchema,
  reviewFileRequestSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  versionedFormSchema,
} from './index';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';
const UUID_C = '00000000-0000-4000-8000-000000000003';
const NOW = '2026-09-14T00:00:00.000Z';

const form = { schemaVersion: 1, payload: { plan: 'rogers-basic' } };

/** [name, schema, a valid value]. Each must parse and round-trip through JSON unchanged. */
const cases: ReadonlyArray<readonly [string, z.ZodType, unknown]> = [
  ['apiError', apiErrorSchema, { code: 'validation_error', message: 'bad', requestId: UUID_C }],
  [
    'apiError+details',
    apiErrorSchema,
    { code: 'version_conflict', message: 'stale', requestId: UUID_C, details: { expected: 3 } },
  ],
  [
    'apiErrorResponse',
    apiErrorResponseSchema,
    { error: { code: 'not_found', message: 'x', requestId: UUID_C } },
  ],
  [
    'versionedForm',
    versionedFormSchema(z.object({ plan: z.string().min(1) })),
    { schemaVersion: 1, payload: { plan: 'rogers-basic' } },
  ],
  [
    'createLeadRequest',
    createLeadRequestSchema,
    { leadType: 'sim_order', contact: { email: 'a@b.co' }, form, consentVersion: 'terms-2026-09' },
  ],
  [
    'createLeadResponse',
    createLeadResponseSchema,
    {
      lead: { id: UUID_A, workspaceId: UUID_B, status: 'incomplete', updatedAt: NOW },
      draftGrant: { token: 'grant', expiresAt: NOW },
      requestId: UUID_C,
    },
  ],
  ['updateLeadRequest', updateLeadRequestSchema, { contact: { fullName: 'A B' } }],
  [
    'updateLeadResponse',
    updateLeadResponseSchema,
    {
      lead: { id: UUID_A, workspaceId: UUID_B, status: 'incomplete', updatedAt: NOW },
      requestId: UUID_C,
    },
  ],
  [
    'listWorkspaceLeadsResponse',
    listWorkspaceLeadsResponseSchema,
    {
      leads: [
        {
          id: UUID_A,
          workspaceId: UUID_B,
          leadType: 'sim_order',
          status: 'incomplete',
          contact: { email: 'a@b.co' },
          contactId: null,
          assignedActorId: null,
          externalRef: 'MS-1001',
          source: 'utm:google/cpc',
          attribution: { utmSource: 'google', utmMedium: 'cpc' },
          consentVersion: 'terms-2026-09',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
      requestId: UUID_C,
    },
  ],
  [
    'listAssignableMembersResponse',
    listAssignableMembersResponseSchema,
    {
      members: [{ membershipId: UUID_A, roles: ['orders'], isSelf: true }],
      requestId: UUID_C,
    },
  ],
  [
    'createUploadIntentRequest',
    createUploadIntentRequestSchema,
    {
      parentType: 'lead',
      parentId: UUID_A,
      documentType: 'passport',
      fileName: 'passport.pdf',
      contentType: 'application/pdf',
      sizeBytes: 12345,
    },
  ],
  [
    'createUploadIntentResponse',
    createUploadIntentResponseSchema,
    {
      uploadId: UUID_A,
      url: 'https://storage.example.com/put',
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      expiresAt: NOW,
      requestId: UUID_C,
    },
  ],
  ['finalizeUploadRequest', finalizeUploadRequestSchema, { checksumSha256: 'a'.repeat(64) }],
  [
    'finalizeUploadResponse',
    finalizeUploadResponseSchema,
    {
      file: {
        id: UUID_A,
        workspaceId: UUID_B,
        parentType: 'lead',
        parentId: UUID_C,
        documentType: 'passport',
        contentType: 'image/png',
        sizeBytes: 999,
        status: 'available',
        checksumSha256: 'b'.repeat(64),
        createdAt: NOW,
      },
      requestId: UUID_C,
    },
  ],
  [
    'createDownloadLinkResponse',
    createDownloadLinkResponseSchema,
    { url: 'https://storage.example.com/get?sig=1', expiresAt: NOW, requestId: UUID_C },
  ],
  ['reviewFileRequest', reviewFileRequestSchema, { decision: 'approved', note: 'clear scan' }],
  ['createExportRequest', createExportRequestSchema, { kind: 'audit' }],
  [
    'createExportResponse',
    createExportResponseSchema,
    {
      job: { id: UUID_A, workspaceId: UUID_B, kind: 'audit', status: 'queued', createdAt: NOW },
      requestId: UUID_C,
    },
  ],
];

describe('contract schemas round-trip', () => {
  for (const [name, schema, value] of cases) {
    it(`${name} parses and round-trips`, () => {
      const parsed = schema.parse(value);
      expect(parsed).toEqual(value);
      // A parsed value re-serialised and re-parsed is stable.
      expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(value);
    });
  }
});

describe('contract schemas reject invalid input', () => {
  it('rejects an unknown file review decision', () => {
    expect(reviewFileRequestSchema.safeParse({ decision: 'teleport' }).success).toBe(false);
  });

  it('rejects a disallowed upload media type', () => {
    expect(
      createUploadIntentRequestSchema.safeParse({
        parentType: 'lead',
        parentId: UUID_A,
        documentType: 'passport',
        fileName: 'evil.exe',
        contentType: 'application/x-msdownload',
        sizeBytes: 10,
      }).success,
    ).toBe(false);
  });

  it('rejects an upload larger than the 10 MB limit', () => {
    expect(
      createUploadIntentRequestSchema.safeParse({
        parentType: 'lead',
        parentId: UUID_A,
        documentType: 'passport',
        fileName: 'big.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });

  it('accepts an optional error details object and omits it when absent', () => {
    expect(
      apiErrorSchema.parse({ code: 'not_found', message: 'x', requestId: UUID_C }).details,
    ).toBeUndefined();
  });
});
