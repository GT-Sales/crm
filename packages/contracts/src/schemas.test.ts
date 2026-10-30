import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MAX_IDENTITY_FILE_BYTES,
  apiErrorResponseSchema,
  apiErrorSchema,
  createDownloadLinkResponseSchema,
  createExportRequestSchema,
  createExportResponseSchema,
  createIdentityUploadRequestSchema,
  createLeadRequestSchema,
  createLeadResponseSchema,
  createUploadIntentRequestSchema,
  createUploadIntentResponseSchema,
  finalizeUploadRequestSchema,
  finalizeUploadResponseSchema,
  getWorkspaceLeadResponseSchema,
  identityLeadTypes,
  initialLeadStage,
  isLeadStage,
  isValidDateOfBirth,
  isValidSin,
  leadIdentitySchema,
  leadStageLabel,
  leadTypeCatalog,
  listAssignableMembersResponseSchema,
  listWorkspaceLeadsResponseSchema,
  reviewFileRequestSchema,
  submitLeadIdentityRequestSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
  versionedFormSchema,
  endpoints,
  leadViewSchema,
  leadsSummaryResponseSchema,
  normalizeLeadView,
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
      related: [
        {
          id: UUID_B,
          leadType: 'mobility',
          status: 'submitted',
          stage: 'new',
          deletedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      identities: [
        {
          id: UUID_C,
          idType: 'sin',
          sinMasked: '*** *** 286',
          dateOfBirth: '1990-01-31',
          fileId: null,
          createdAt: NOW,
        },
      ],
      documents: [
        {
          id: UUID_A,
          documentType: 'passport',
          contentType: 'application/pdf',
          sizeBytes: 1200,
          revision: 1,
          createdAt: NOW,
        },
      ],
      access: { contacts: true, manage: true, revealSensitive: true, downloadDocuments: true },
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

  it('reads a lead page from a backend without related requests as having none', () => {
    const roundTrip = cases.find(([name]) => name === 'getWorkspaceLeadResponse');
    if (!roundTrip || typeof roundTrip[2] !== 'object' || roundTrip[2] === null) {
      throw new Error('the lead page fixture is missing');
    }
    const {
      related: _related,
      identities: _identities,
      documents: _documents,
      ...older
    } = getWorkspaceLeadResponseSchema.parse(roundTrip[2]);
    const parsed = getWorkspaceLeadResponseSchema.parse(older);
    expect(parsed.related).toEqual([]);
    expect(parsed.identities).toEqual([]);
    expect(parsed.documents).toEqual([]);
  });
});

describe('the credit-check identity', () => {
  // Made-up numbers that pass the Luhn check, never a real person's.
  it('takes a SIN only with a valid check digit, a real past birth date and consent', () => {
    const sin = {
      idType: 'sin',
      sin: '046454286',
      dateOfBirth: '1990-01-31',
      creditCheckConsent: true,
    };
    expect(submitLeadIdentityRequestSchema.safeParse(sin).success).toBe(true);
    for (const wrong of [
      { ...sin, sin: '046454287' },
      { ...sin, sin: '046 454 286' },
      { ...sin, dateOfBirth: '1990-02-30' },
      { ...sin, dateOfBirth: '1899-12-31' },
      { ...sin, dateOfBirth: '2999-01-01' },
      { ...sin, creditCheckConsent: false },
      { ...sin, uploadId: UUID_A },
    ]) {
      expect(submitLeadIdentityRequestSchema.safeParse(wrong).success).toBe(false);
    }
    expect(isValidSin('130692544')).toBe(true);
    expect(isValidDateOfBirth('2026-10-27', new Date('2026-10-27T12:00:00Z'))).toBe(true);
    expect(isValidDateOfBirth('2026-10-28', new Date('2026-10-27T12:00:00Z'))).toBe(false);
  });

  it('takes a licence as its finished upload, never with a SIN', () => {
    const licence = {
      idType: 'drivers_licence',
      uploadId: UUID_A,
      checksumSha256: 'a'.repeat(64),
      creditCheckConsent: true,
    };
    expect(submitLeadIdentityRequestSchema.safeParse(licence).success).toBe(true);
    expect(
      submitLeadIdentityRequestSchema.safeParse({ ...licence, sin: '046454286' }).success,
    ).toBe(false);
    expect(
      createIdentityUploadRequestSchema.safeParse({ contentType: 'image/webp', sizeBytes: 1 })
        .success,
    ).toBe(true);
    expect(
      createIdentityUploadRequestSchema.safeParse({
        contentType: 'image/jpeg',
        sizeBytes: MAX_IDENTITY_FILE_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it('shows staff a SIN only masked to its last three digits', () => {
    const identity = {
      id: UUID_A,
      idType: 'sin',
      sinMasked: '*** *** 286',
      dateOfBirth: '1990-01-31',
      fileId: null,
      createdAt: NOW,
    };
    expect(leadIdentitySchema.safeParse(identity).success).toBe(true);
    expect(leadIdentitySchema.safeParse({ ...identity, sinMasked: '046454286' }).success).toBe(
      false,
    );
  });

  it('marks the mobility order as the one that takes an identity', () => {
    expect(identityLeadTypes).toEqual(['mobility']);
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

  it('starts each type at its first stage and falls back to the slug for unknown labels', () => {
    for (const [leadType, entry] of Object.entries(leadTypeCatalog)) {
      // A SIM order begins as Get Canada Sim's unfinished checkout.
      expect(entry.stages[0]?.key).toBe(leadType === 'sim_order' ? 'incomplete' : 'new');
    }
    // Get Canada Sim's order statuses in its admin's order, without the
    // money states (`invoiced`, `paid`), which are order details now.
    expect(leadTypeCatalog.sim_order.stages.map((entry) => entry.key)).toEqual([
      'incomplete',
      'pending',
      'verified',
      'on_hold',
      'delivered',
      'activated',
      'completed',
      'cancelled',
    ]);
    expect(leadTypeCatalog.sim_order.stages.map((entry) => entry.label)).toEqual([
      'Incomplete',
      'Pending',
      'Verified',
      'On hold',
      'Delivered',
      'Activated',
      'Completed',
      'Cancelled',
    ]);
    expect(leadStageLabel('sim_order', 'on_hold')).toBe('On hold');
    expect(isLeadStage('sim_order', 'paid')).toBe(false);
    expect(isLeadStage('sim_order', 'invoiced')).toBe(false);
    expect(initialLeadStage('sim_order')).toBe('incomplete');
    expect(leadStageLabel('internet', 'existing_shaw')).toBe('Existing Shaw');
    expect(leadStageLabel('internet', 'mystery')).toBe('mystery');
    expect(isLeadStage('mobility', 'activated')).toBe(true);
    expect(isLeadStage('internet', 'activated')).toBe(false);
    expect(isLeadStage('unknown_type', 'new')).toBe(false);
  });
});

describe('archive aliases', () => {
  it('accepts archived and the legacy trash view and normalizes them', () => {
    for (const view of ['active', 'archived', 'trash']) {
      expect(leadViewSchema.safeParse(view).success).toBe(true);
    }
    expect(leadViewSchema.safeParse('deleted').success).toBe(false);
    expect(normalizeLeadView(undefined)).toBe('active');
    expect(normalizeLeadView('active')).toBe('active');
    expect(normalizeLeadView('archived')).toBe('archived');
    expect(normalizeLeadView('trash')).toBe('archived');
  });

  it('counts the archive in the summary and keeps trash as the deprecated twin', () => {
    const base = { types: [], access: { contacts: true, manage: true }, requestId: UUID_C };
    expect(leadsSummaryResponseSchema.safeParse({ ...base, archived: 2, trash: 2 }).success).toBe(
      true,
    );
    expect(leadsSummaryResponseSchema.safeParse({ ...base, trash: 2 }).success).toBe(false);
  });

  it('registers archiveWorkspaceLead and the deprecated trashWorkspaceLead with one response', () => {
    const archive = endpoints.find((entry) => entry.operationId === 'archiveWorkspaceLead');
    const trash = endpoints.find((entry) => entry.operationId === 'trashWorkspaceLead');
    expect(archive?.method).toBe('POST');
    expect(archive?.path).toBe('/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/archive');
    expect(trash?.path).toBe('/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/trash');
    expect(trash?.summary).toContain('Deprecated alias');
    expect(archive?.response).toBe(trash?.response);
  });
});
