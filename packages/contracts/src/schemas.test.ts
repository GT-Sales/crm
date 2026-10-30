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
  domainErrorCodeSchema,
  emailSkippedSchema,
  finalizeUploadRequestSchema,
  finalizeUploadResponseSchema,
  getWorkspaceLeadResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  identityLeadTypes,
  initialLeadStage,
  isLeadStage,
  isValidDateOfBirth,
  isValidSin,
  leadActivitySchema,
  leadDocumentSchema,
  leadIdentitySchema,
  leadStageLabel,
  leadTypeCatalog,
  listAssignableMembersResponseSchema,
  listWorkspaceLeadsResponseSchema,
  queueCustomerEmailRequestSchema,
  reviewFileRequestSchema,
  submitLeadIdentityRequestSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
  updateWorkspaceLeadResponseSchema,
  versionedFormSchema,
  endpoints,
  leadViewSchema,
  leadsSummaryResponseSchema,
  normalizeLeadView,
  websiteBotActions,
  websiteScopeSchema,
  changeDecisionEmailSkippedSchema,
  leadAccessSchema,
  resolveChangeRequestRequestSchema,
  staffChangeRequestSchema,
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
      lead: {
        id: UUID_A,
        workspaceId: UUID_B,
        status: 'incomplete',
        externalRef: 'MS-153',
        updatedAt: NOW,
      },
      draftGrant: { token: 'grant', expiresAt: NOW },
      requestId: UUID_C,
    },
  ],
  [
    'createLeadResponse+replayed',
    createLeadResponseSchema,
    {
      lead: {
        id: UUID_A,
        workspaceId: UUID_B,
        status: 'submitted',
        externalRef: null,
        updatedAt: NOW,
      },
      draftGrant: null,
      replayed: true,
      requestId: UUID_C,
    },
  ],
  ['updateLeadRequest', updateLeadRequestSchema, { contact: { fullName: 'A B' } }],
  [
    'updateLeadResponse',
    updateLeadResponseSchema,
    {
      lead: {
        id: UUID_A,
        workspaceId: UUID_B,
        status: 'incomplete',
        externalRef: null,
        updatedAt: NOW,
      },
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
        {
          id: UUID_C,
          actorId: UUID_B,
          createdAt: NOW,
          kind: 'document',
          fileId: UUID_A,
          documentType: 'passport',
          decision: 'approved',
        },
        {
          id: UUID_A,
          actorId: UUID_B,
          createdAt: NOW,
          kind: 'system',
          event: 'documents_override',
          missing: ['passport', 'study_permit'],
          reason: 'Checked the passport in person',
        },
        {
          id: UUID_B,
          actorId: UUID_B,
          createdAt: NOW,
          kind: 'system',
          event: 'customer_emailed',
          template: 'dispatched',
          automation: 'sim_order_dispatched',
          templateVersion: 2,
        },
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
          review: { decision: 'approved', at: NOW },
        },
      ],
      allowedMoves: ['won', 'lost'],
      changeRequest: {
        id: UUID_C,
        requestNo: 2,
        status: 'pending',
        fields: { phone: '+1 604 555 0199' },
        documents: [],
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      access: {
        contacts: true,
        manage: true,
        revealSensitive: true,
        downloadDocuments: true,
        reviewDocuments: true,
        overrideDocuments: false,
      },
      requestId: UUID_C,
    },
  ],
  ['updateWorkspaceLeadRequest', updateWorkspaceLeadRequestSchema, { assignedActorId: null }],
  [
    'updateWorkspaceLeadRequest+override',
    updateWorkspaceLeadRequestSchema,
    { stage: 'activated', documentsOverrideReason: 'Checked the passport in person' },
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
      allowedMoves: _allowedMoves,
      changeRequest: _changeRequest,
      ...older
    } = getWorkspaceLeadResponseSchema.parse(roundTrip[2]);
    const parsed = getWorkspaceLeadResponseSchema.parse(older);
    expect(parsed.related).toEqual([]);
    expect(parsed.identities).toEqual([]);
    expect(parsed.documents).toEqual([]);
    expect(parsed.allowedMoves).toEqual([]);
    expect(parsed.changeRequest).toBeNull();
  });
});

describe('a customer’s change request, as staff decide it', () => {
  const request = {
    id: UUID_A,
    requestNo: 4,
    status: 'pending',
    fields: { phone: '+1 647 555 0123', planId: UUID_B },
    documents: [{ fileId: UUID_C, documentType: 'passport' }],
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('carries the requested values, the sent files and its version', () => {
    expect(staffChangeRequestSchema.parse(request)).toEqual(request);
    expect(staffChangeRequestSchema.safeParse({ ...request, version: 0 }).success).toBe(false);
    expect(staffChangeRequestSchema.safeParse({ ...request, status: 'cancelled' }).success).toBe(
      false,
    );
  });

  it('is decided with the version staff saw', () => {
    expect(resolveChangeRequestRequestSchema.parse({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
    });
    expect(resolveChangeRequestRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(
      resolveChangeRequestRequestSchema.safeParse({ expectedVersion: 2, note: 'x' }).success,
    ).toBe(false);
  });

  it('says when the decision email was skipped and why', () => {
    expect(
      changeDecisionEmailSkippedSchema.parse({
        template: 'change_approved',
        reason: 'missing_fill_in',
        missing: ['tracking link'],
      }),
    ).toMatchObject({ reason: 'missing_fill_in' });
    expect(
      changeDecisionEmailSkippedSchema.safeParse({ template: 'dispatched', reason: 'no_sender' })
        .success,
    ).toBe(false);
  });

  it('lets a lead page say whether the caller decides changes', () => {
    expect(leadAccessSchema.parse({ contacts: true, manage: true, decideChanges: true })).toEqual({
      contacts: true,
      manage: true,
      decideChanges: true,
    });
  });
});

describe('phase 4 stage moves and idempotent intake', () => {
  const lead = {
    id: UUID_A,
    workspaceId: UUID_B,
    leadType: 'sim_order',
    status: 'submitted',
    stage: 'new',
    contact: {},
    contactId: null,
    assignedActorId: null,
    externalRef: null,
    source: 'direct',
    attribution: {},
    consentVersion: null,
    openTaskCount: 0,
    nextTaskDueAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    form: null,
  };

  it('asks for an override reason only together with a stage', () => {
    const reason = 'Checked the passport in person';
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({
        stage: 'activated',
        documentsOverrideReason: reason,
      }).success,
    ).toBe(true);
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({ documentsOverrideReason: reason }).success,
    ).toBe(false);
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({
        assignedActorId: null,
        documentsOverrideReason: reason,
      }).success,
    ).toBe(false);
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({
        stage: 'activated',
        documentsOverrideReason: 'a'.repeat(2001),
      }).success,
    ).toBe(false);
    // A blank reason parses; the store answers document_override_reason_required.
    expect(
      updateWorkspaceLeadRequestSchema.safeParse({
        stage: 'activated',
        documentsOverrideReason: '  ',
      }).success,
    ).toBe(true);
  });

  it('answers a stage move with the next moves and the mails it skipped', () => {
    const skipped = {
      automation: 'sim_order_dispatched',
      template: 'dispatched',
      reason: 'missing_fill_in',
      missing: ['courier', 'tracking number'],
    };
    const response = {
      lead,
      activities: [],
      allowedMoves: ['activated', 'cancelled'],
      emailSkipped: [skipped],
      requestId: UUID_C,
    };
    expect(updateWorkspaceLeadResponseSchema.parse(response)).toEqual(response);
    const { emailSkipped: _emailSkipped, ...withoutSkipped } = response;
    expect(updateWorkspaceLeadResponseSchema.safeParse(withoutSkipped).success).toBe(true);
    const { allowedMoves: _allowedMoves, ...withoutMoves } = response;
    expect(updateWorkspaceLeadResponseSchema.safeParse(withoutMoves).success).toBe(false);
    expect(
      updateWorkspaceLeadResponseSchema.safeParse({
        ...response,
        emailSkipped: Array.from({ length: 7 }, () => skipped),
      }).success,
    ).toBe(false);
  });

  it('describes a skipped mail by its rule, template and reason', () => {
    const skipped = {
      automation: 'order_received',
      template: 'order_received',
      reason: 'no_sender',
    };
    expect(emailSkippedSchema.parse(skipped)).toEqual(skipped);
    const { automation: _automation, ...withoutAutomation } = skipped;
    expect(emailSkippedSchema.safeParse(withoutAutomation).success).toBe(false);
    expect(emailSkippedSchema.safeParse({ ...skipped, reason: 'other' }).success).toBe(false);
    expect(emailSkippedSchema.safeParse({ ...skipped, missing: ['nope'] }).success).toBe(false);
  });

  it('accepts an idempotency key of 8 to 200 safe characters and nothing else', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
    expect(idempotencyKeySchema.safeParse('cp_9f2c:retry.1').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('a b c d e f').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('a'.repeat(200)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse('a'.repeat(201)).success).toBe(false);
  });

  it("carries the lead's own reference (an order number) or null, never omitted", () => {
    const lead = { id: UUID_A, workspaceId: UUID_B, status: 'incomplete', updatedAt: NOW };
    const response = (externalRef?: unknown) => ({
      lead: externalRef === undefined ? lead : { ...lead, externalRef },
      draftGrant: null,
      requestId: UUID_C,
    });
    expect(createLeadResponseSchema.parse(response('MS-153')).lead.externalRef).toBe('MS-153');
    expect(createLeadResponseSchema.parse(response(null)).lead.externalRef).toBeNull();
    expect(createLeadResponseSchema.safeParse(response()).success).toBe(false);
    expect(createLeadResponseSchema.safeParse(response('')).success).toBe(false);
    expect(updateLeadResponseSchema.safeParse({ lead, requestId: UUID_C }).success).toBe(false);
  });

  it('marks a replayed create or update, and only with true', () => {
    const summary = {
      id: UUID_A,
      workspaceId: UUID_B,
      status: 'submitted',
      externalRef: 'MS-153',
      updatedAt: NOW,
    };
    expect(
      updateLeadResponseSchema.parse({ lead: summary, replayed: true, requestId: UUID_C }).replayed,
    ).toBe(true);
    expect(
      updateLeadResponseSchema.safeParse({ lead: summary, replayed: false, requestId: UUID_C })
        .success,
    ).toBe(false);
  });
});

describe('phase 4 timeline entries and documents', () => {
  const base = { id: UUID_A, actorId: UUID_B, createdAt: NOW };

  it('records a document review by its file and type, never its note', () => {
    const entry = {
      ...base,
      kind: 'document',
      fileId: UUID_C,
      documentType: 'passport',
      decision: 'rejected',
    };
    expect(leadActivitySchema.parse(entry)).toEqual(entry);
    expect(leadActivitySchema.safeParse({ ...entry, decision: 'pending' }).success).toBe(false);
    expect(leadActivitySchema.parse({ ...entry, note: 'blurry' })).not.toHaveProperty('note');
  });

  it('records a documents override with what was missing and why', () => {
    const entry = {
      ...base,
      kind: 'system',
      event: 'documents_override',
      missing: ['passport'],
      reason: 'Seen in person',
    };
    expect(leadActivitySchema.parse(entry)).toEqual(entry);
  });

  it('records a change decision by request number, id, field keys and document types', () => {
    const entry = {
      ...base,
      kind: 'system',
      event: 'change_approved',
      requestNo: 4,
      changeRequestId: UUID_B,
      fields: ['phone', 'arrivalDate'],
      documents: ['passport'],
    };
    expect(leadActivitySchema.parse(entry)).toEqual(entry);
    expect(leadActivitySchema.safeParse({ ...entry, changeRequestId: 'cr-4' }).success).toBe(false);
  });

  it('records which rule and template version sent a customer email', () => {
    const entry = {
      ...base,
      kind: 'system',
      event: 'customer_emailed',
      template: 'dispatched',
      automation: 'sim_order_dispatched',
      templateVersion: 0,
    };
    expect(leadActivitySchema.parse(entry)).toEqual(entry);
    expect(leadActivitySchema.safeParse({ ...entry, automation: 'custom_x' }).success).toBe(false);
    expect(leadActivitySchema.safeParse({ ...entry, templateVersion: -1 }).success).toBe(false);
  });

  it('reads a document without a review as not reviewed', () => {
    const document = {
      id: UUID_A,
      documentType: 'passport',
      contentType: 'application/pdf',
      sizeBytes: 1200,
      revision: 1,
      createdAt: NOW,
    };
    expect(leadDocumentSchema.parse(document)).toEqual({ ...document, review: null });
    expect(
      leadDocumentSchema.safeParse({ ...document, review: { decision: 'maybe', at: NOW } }).success,
    ).toBe(false);
  });

  it('lets staff queue only the SIM number mail by hand', () => {
    expect(queueCustomerEmailRequestSchema.parse({ template: 'sim_number_ready' })).toEqual({
      template: 'sim_number_ready',
    });
    expect(queueCustomerEmailRequestSchema.safeParse({ template: 'dispatched' }).success).toBe(
      false,
    );
  });

  it('knows the phase 4 error codes', () => {
    for (const code of [
      'illegal_stage_move',
      'activation_details_required',
      'documents_override_not_allowed',
      'idempotency_in_progress',
      'invalid_fill_in',
      'invalid_email_markup',
      'automation_not_found',
      'dispatch_details_required',
      'documents_incomplete',
      'document_override_reason_required',
      'idempotency_conflict',
    ]) {
      expect(domainErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });
});

describe('customer tracking vocabulary', () => {
  it('knows the change request refusal, the tracking scope and the two bot actions', () => {
    expect(domainErrorCodeSchema.safeParse('change_request_not_allowed').success).toBe(true);
    expect(websiteScopeSchema.options).toEqual(['leads:write', 'uploads:customer', 'tracking']);
    expect(websiteBotActions).toContain('tracking-request');
    expect(websiteBotActions).toContain('tracking-verify');
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
