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
  getWorkspaceLeadResponseSchema,
  isLeadStage,
  leadStageLabel,
  leadTypeCatalog,
  listAssignableMembersResponseSchema,
  listWorkspaceLeadsResponseSchema,
  reviewFileRequestSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
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
          stage: 'new',
          contact: { email: 'a@b.co' },
          contactId: null,
          assignedActorId: null,
          externalRef: 'MS-1001',
          source: 'utm:google/cpc',
          attribution: { utmSource: 'google', utmMedium: 'cpc' },
          consentVersion: 'terms-2026-09',
          openTaskCount: 1,
          nextTaskDueAt: NOW,
          deletedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
      access: { contacts: true, manage: false },
      requestId: UUID_C,
    },
  ],
  [
    'listAssignableMembersResponse',
    listAssignableMembersResponseSchema,
    {
      members: [
        {
          membershipId: UUID_A,
          actorId: UUID_B,
          displayName: 'Takib',
          roles: ['orders'],
          isSelf: true,
        },
      ],
      requestId: UUID_C,
    },
  ],
  [
    'getWorkspaceLeadResponse',
    getWorkspaceLeadResponseSchema,
    {
      lead: {
        id: UUID_A,
        workspaceId: UUID_B,
        leadType: 'internet',
        status: 'submitted',
        stage: 'contacted',
        contact: { fullName: 'A B', email: 'a@b.co', phone: '+1 604 555 0100' },
        contactId: UUID_C,
        assignedActorId: UUID_B,
        externalRef: null,
        source: 'direct',
        attribution: {},
        consentVersion: 'cw-internet-contact-2026-10',
        openTaskCount: 0,
        nextTaskDueAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        form,
      },
      activities: [
        { id: UUID_A, actorId: UUID_B, createdAt: NOW, kind: 'note', body: 'Called, no answer.' },
        {
          id: UUID_B,
          actorId: UUID_B,
          createdAt: NOW,
          kind: 'status_change',
          from: 'new',
          to: 'contacted',
        },
        { id: UUID_C, actorId: UUID_B, createdAt: NOW, kind: 'assignment', from: null, to: UUID_B },
        { id: UUID_A, actorId: UUID_B, createdAt: NOW, kind: 'edit', fields: ['phone'] },
        { id: UUID_B, actorId: UUID_B, createdAt: NOW, kind: 'system', event: 'restored' },
      ],
      tasks: [
        {
          id: UUID_C,
          leadId: UUID_A,
          title: 'Call back',
          dueAt: NOW,
          assignedActorId: null,
          status: 'open',
          completedAt: null,
          createdBy: UUID_B,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      access: { contacts: true, manage: true },
      requestId: UUID_C,
    },
  ],
  ['updateWorkspaceLeadRequest', updateWorkspaceLeadRequestSchema, { assignedActorId: null }],
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

  it('refuses a staff lead update or task update that changes nothing', () => {
    expect(updateWorkspaceLeadRequestSchema.safeParse({}).success).toBe(false);
    expect(updateWorkspaceLeadRequestSchema.safeParse({ contact: {} }).success).toBe(false);
    expect(updateLeadTaskRequestSchema.safeParse({}).success).toBe(false);
  });

  it('refuses unknown fields on staff lead updates', () => {
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({ stage: 'won', status: 'submitted' }).success,
    ).toBe(false);
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({ contact: { countryCode: 'CA' } }).success,
    ).toBe(false);
  });
});

describe('lead-type catalogue', () => {
  it("keeps CanadaWide's old admin stages, in its order", () => {
    expect(leadTypeCatalog.internet.stages.map((entry) => entry.key)).toEqual([
      'new',
      'contacted',
      'qualified',
      'existing_shaw',
      'non_serviceable_address',
      'old_due',
      'installed',
      'won',
      'lost',
    ]);
    expect(leadTypeCatalog.mobility.stages.map((entry) => entry.key)).toEqual([
      'new',
      'contacted',
      'qualified',
      'activated',
      'won',
      'lost',
    ]);
  });

  it('starts every type at new and falls back to the slug for unknown labels', () => {
    for (const entry of Object.values(leadTypeCatalog)) {
      expect(entry.stages[0]?.key).toBe('new');
    }
    expect(leadStageLabel('internet', 'existing_shaw')).toBe('Existing Shaw');
    expect(leadStageLabel('internet', 'mystery')).toBe('mystery');
    expect(isLeadStage('mobility', 'activated')).toBe(true);
    expect(isLeadStage('internet', 'activated')).toBe(false);
    expect(isLeadStage('unknown_type', 'new')).toBe(false);
  });
});
