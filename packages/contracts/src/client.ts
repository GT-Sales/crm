import { websiteBotTokenSchema, type WebsiteBotProof } from './website-bot';
import type { z } from 'zod';
import type { ErrorDetails } from './common';

import {
  createDownloadLinkRequestSchema,
  createDownloadLinkResponseSchema,
  reviewFileRequestSchema,
  reviewFileResponseSchema,
  type CreateDownloadLinkRequest,
  type CreateDownloadLinkResponse,
  type ReviewFileRequest,
  type ReviewFileResponse,
} from './files';
import { healthResponseSchema, type HealthResponse } from './health';
import {
  createIdentityUploadRequestSchema,
  revealLeadIdentityResponseSchema,
  submitLeadIdentityRequestSchema,
  submitLeadIdentityResponseSchema,
  type CreateIdentityUploadRequest,
  type RevealLeadIdentityResponse,
  type SubmitLeadIdentityRequest,
  type SubmitLeadIdentityResponse,
} from './lead-identity';
import {
  listWorkspaceJobsResponseSchema,
  resolveUncertainJobRequestSchema,
  resolveUncertainJobResponseSchema,
  retryWorkspaceJobResponseSchema,
  type ListWorkspaceJobsResponse,
  type ResolveUncertainJobRequest,
  type ResolveUncertainJobResponse,
  type RetryWorkspaceJobResponse,
} from './jobs';
import {
  automationResponseSchema,
  listAutomationRunsResponseSchema,
  listAutomationsResponseSchema,
  updateAutomationRequestSchema,
  type AutomationKey,
  type AutomationResponse,
  type ListAutomationRunsResponse,
  type ListAutomationsResponse,
  type UpdateAutomationRequest,
} from './automations';
import {
  emailSettingsResponseSchema,
  emailTemplateResponseSchema,
  listEmailTemplatesResponseSchema,
  previewEmailTemplateRequestSchema,
  previewEmailTemplateResponseSchema,
  sendTestEmailResponseSchema,
  updateEmailSettingsRequestSchema,
  updateEmailTemplateRequestSchema,
  type CustomerEmailTemplate,
  type EmailSettingsResponse,
  type EmailTemplateResponse,
  type ListEmailTemplatesResponse,
  type PreviewEmailTemplateRequest,
  type PreviewEmailTemplateResponse,
  type SendTestEmailResponse,
  type UpdateEmailSettingsRequestInput,
  type UpdateEmailTemplateRequest,
} from './customer-email';
import {
  IDEMPOTENCY_KEY_HEADER,
  createLeadRequestSchema,
  createLeadResponseSchema,
  idempotencyKeySchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  readLeadResponseSchema,
  type ReadLeadResponse,
  type CreateLeadRequestInput,
  type CreateLeadResponse,
  type UpdateLeadRequestInput,
  type UpdateLeadResponse,
} from './leads';
import {
  createExportRequestSchema,
  createExportResponseSchema,
  type CreateExportRequest,
  type CreateExportResponse,
} from './exports';
import {
  createLeadNoteRequestSchema,
  createLeadNoteResponseSchema,
  createLeadTaskRequestSchema,
  getWorkspaceLeadResponseSchema,
  leadTaskResponseSchema,
  leadTrashResponseSchema,
  queueCustomerEmailRequestSchema,
  queueCustomerEmailResponseSchema,
  listWorkspaceTasksResponseSchema,
  markLeadOpenedResponseSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
  updateWorkspaceLeadResponseSchema,
  resolveChangeRequestRequestSchema,
  resolveChangeRequestResponseSchema,
  type ResolveChangeRequestRequest,
  type ResolveChangeRequestResponse,
  type CreateLeadNoteRequest,
  type CreateLeadNoteResponse,
  type CreateLeadTaskRequest,
  type GetWorkspaceLeadResponse,
  type LeadTaskResponse,
  type LeadTrashResponse,
  type QueueCustomerEmailRequest,
  type QueueCustomerEmailResponse,
  type ListWorkspaceTasksQuery,
  type ListWorkspaceTasksResponse,
  type MarkLeadOpenedResponse,
  type UpdateLeadTaskRequest,
  type UpdateWorkspaceLeadRequest,
  type UpdateWorkspaceLeadResponse,
} from './lead-work';
import {
  listAssignableMembersResponseSchema,
  updateStaffProfileRequestSchema,
  updateStaffProfileResponseSchema,
  type ListAssignableMembersResponse,
  type UpdateStaffProfileRequest,
  type UpdateStaffProfileResponse,
} from './members';
import {
  apiErrorResponseSchema,
  inviteStaffRequestSchema,
  inviteStaffResponseSchema,
  revokeStaffResponseSchema,
  staffWorkspaceAccessResponseSchema,
  staffWorkspacesResponseSchema,
  type ApiErrorCode,
  type InviteStaffRequest,
  type InviteStaffResponse,
  type RevokeStaffResponse,
  type StaffWorkspaceAccessResponse,
  type StaffWorkspacesResponse,
} from './staff-auth';
import {
  createCustomPropertySchema,
  updatePropertySchema,
  type UpdateProperty,
} from './properties';
import {
  deletePropertyResponseSchema,
  propertyLayoutResponseSchema,
  propertyModelResponseSchema,
  propertyResponseSchema,
  savePropertyLayoutRequestSchema,
  type DeletePropertyResponse,
  type PropertyObjectQueryInput,
  type PropertyLayoutResponse,
  type PropertyModelResponse,
  type PropertyResponse,
  type SavePropertyLayoutRequest,
} from './property-layouts';
import {
  createPlanRequestSchema,
  listPlansResponseSchema,
  listWebsitePlansResponseSchema,
  planResponseSchema,
  updatePlanRequestSchema,
  type CreatePlanRequestInput,
  type ListPlansQueryInput,
  type ListPlansResponse,
  type ListWebsitePlansQuery,
  type ListWebsitePlansResponse,
  type PlanResponse,
  type UpdatePlanRequest,
} from './plans';
import {
  createSavedViewRequestSchema,
  deleteSavedViewResponseSchema,
  listSavedViewsResponseSchema,
  savedViewResponseSchema,
  updateSavedViewRequestSchema,
  type CreateSavedViewRequestInput,
  type DeleteSavedViewResponse,
  type ListSavedViewsQuery,
  type ListSavedViewsResponse,
  type SavedViewResponse,
  type UpdateSavedViewRequest,
} from './saved-views';
import {
  createUploadIntentRequestSchema,
  createUploadIntentResponseSchema,
  finalizeUploadRequestSchema,
  finalizeUploadResponseSchema,
  type CreateUploadIntentRequest,
  type CreateUploadIntentResponse,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
} from './uploads';
import {
  createServiceCredentialRequestSchema,
  createServiceCredentialResponseSchema,
  listServiceCredentialsResponseSchema,
  revokeServiceCredentialResponseSchema,
  type CreateServiceCredentialRequest,
  type CreateServiceCredentialResponse,
  type ListServiceCredentialsResponse,
  type RevokeServiceCredentialResponse,
} from './website-auth';
import {
  sourceReportResponseSchema,
  type SourceReportQuery,
  type SourceReportResponse,
} from './reports';
import {
  leadBoardResponseSchema,
  leadsSummaryResponseSchema,
  leadStatsResponseSchema,
  listWorkspaceLeadsResponseSchema,
  type LeadBoardQuery,
  type LeadBoardQueryInput,
  type LeadBoardResponse,
  type LeadsSummaryQuery,
  type LeadsSummaryResponse,
  type LeadStatsQuery,
  type LeadStatsResponse,
  type ListWorkspaceLeadsQuery,
  type ListWorkspaceLeadsQueryInput,
  type ListWorkspaceLeadsResponse,
} from './workspace-leads';
import {
  createTrackedChangeRequestSchema,
  trackedChangeResponseSchema,
  trackingCodeRequestSchema,
  trackingCodeResponseSchema,
  trackingOrdersResponseSchema,
  trackingUploadIntentRequestSchema,
  trackingVerifyRequestSchema,
  trackingVerifyResponseSchema,
  type CreateTrackedChangeRequest,
  type TrackedChangeResponse,
  type TrackingCodeRequest,
  type TrackingCodeResponse,
  type TrackingOrdersResponse,
  type TrackingUploadIntentRequest,
  type TrackingVerifyRequest,
  type TrackingVerifyResponse,
} from './tracking';

/**
 * The one typed backend client, consumed by both the admin (staff session as the
 * credential) and the websites (service credential). Every method's request
 * and response types are `z.infer` of the same schemas the backend validates
 * against and the OpenAPI document is generated from, so a schema change breaks
 * both consumers at build time. Responses are validated at runtime, so a
 * backend that drifts from the contract fails loudly rather than silently.
 *
 * Transport is secure by default and safe for server-side website use: fixed
 * `/api/v1` paths only, bearer credential, no redirects, no caching, a request
 * timeout, a generated `x-request-id`, and no response-body leakage in thrown
 * errors.
 */

/** Thrown for any non-2xx response. Carries the contract error code, HTTP status and request id. */
export class BackendError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'internal_error',
    readonly status: number,
    readonly requestId: string,
    /** The envelope's `details` (for example `{ leadCount }` on `property_in_use`), when the backend sent any. */
    readonly details?: ErrorDetails,
  ) {
    super(code);
    this.name = 'BackendError';
  }
}

export interface BackendClientOptions {
  /** Backend origin, e.g. `https://api.example.com`. Paths are always `/api/v1/*`. */
  readonly baseUrl: string;
  /** Bearer credential: a staff Supabase access token, or a website service credential. */
  readonly credential: string;
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** Server-owned visitor digest; never a raw browser forwarding header. */
  readonly websiteVisitorId?: () => string | undefined | Promise<string | undefined>;
}

type HeaderMap = Record<string, string | undefined>;
type QueryMap = Record<string, string | number | undefined>;

interface CallConfig<TResponse> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly responseSchema: z.ZodType<TResponse>;
  readonly body?: unknown;
  readonly query?: QueryMap;
  readonly headers?: HeaderMap;
  readonly signal?: AbortSignal;
}

function assertApiPath(url: URL, origin: string): void {
  if (
    url.origin !== origin ||
    !url.pathname.startsWith('/api/v1/') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Invalid backend API path.');
  }
}

/**
 * Sent as the `Idempotency-Key` header, so a retried submission returns the
 * lead already created. A malformed key throws synchronously, before any request.
 */
export interface IdempotencyOption {
  readonly idempotencyKey?: string;
}

/** The grant `tracking.verify` returned, sent as `X-Customer-Grant`. */
export interface CustomerGrantOption {
  readonly customerGrant: string;
}

export interface BackendClient {
  health(): Promise<HealthResponse>;
  leads: {
    read(leadId: string, options: { draftGrant: string }): Promise<ReadLeadResponse>;
    create(
      body: CreateLeadRequestInput,
      options?: WebsiteBotProof & IdempotencyOption,
    ): Promise<CreateLeadResponse>;
    update(
      leadId: string,
      body: UpdateLeadRequestInput,
      options: { draftGrant: string } & WebsiteBotProof & IdempotencyOption,
    ): Promise<UpdateLeadResponse>;
    /** The ID step: a signed PUT for the customer's licence photo. */
    createIdentityUpload(
      leadId: string,
      body: CreateIdentityUploadRequest,
      proof?: WebsiteBotProof,
    ): Promise<CreateUploadIntentResponse>;
    /** The ID step: the finished licence upload, or a SIN with the date of birth. */
    submitIdentity(
      leadId: string,
      body: SubmitLeadIdentityRequest,
      proof?: WebsiteBotProof,
    ): Promise<SubmitLeadIdentityResponse>;
  };
  plans: {
    /** The site's active plans, as its storefront shows them. */
    list(query?: ListWebsitePlansQuery): Promise<ListWebsitePlansResponse>;
  };
  uploads: {
    createIntent(
      body: CreateUploadIntentRequest,
      options: { draftGrant: string } & WebsiteBotProof,
    ): Promise<CreateUploadIntentResponse>;
    finalize(
      uploadId: string,
      body: FinalizeUploadRequest,
      options: { draftGrant: string } & WebsiteBotProof,
    ): Promise<FinalizeUploadResponse>;
  };
  files: {
    createDownloadLink(
      fileId: string,
      options: { draftGrant: string } & WebsiteBotProof,
    ): Promise<CreateDownloadLinkResponse>;
  };
  /** Customer order tracking: the code, then calls carrying the customer's grant. */
  tracking: {
    requestCode(body: TrackingCodeRequest, proof?: WebsiteBotProof): Promise<TrackingCodeResponse>;
    verify(body: TrackingVerifyRequest, proof?: WebsiteBotProof): Promise<TrackingVerifyResponse>;
    orders(options: CustomerGrantOption): Promise<TrackingOrdersResponse>;
    requestChange(
      reference: string,
      body: CreateTrackedChangeRequest,
      options: CustomerGrantOption & WebsiteBotProof,
    ): Promise<TrackedChangeResponse>;
    createUpload(
      reference: string,
      body: TrackingUploadIntentRequest,
      options: CustomerGrantOption & WebsiteBotProof,
    ): Promise<CreateUploadIntentResponse>;
    finalizeUpload(
      reference: string,
      uploadId: string,
      body: FinalizeUploadRequest,
      options: CustomerGrantOption & WebsiteBotProof,
    ): Promise<TrackedChangeResponse>;
  };
  staff: {
    listWorkspaces(): Promise<StaffWorkspacesResponse>;
    updateProfile(body: UpdateStaffProfileRequest): Promise<UpdateStaffProfileResponse>;
    workspaceAccess(workspaceId: string): Promise<StaffWorkspaceAccessResponse>;
    invite(workspaceId: string, body: InviteStaffRequest): Promise<InviteStaffResponse>;
    revokeMembership(workspaceId: string, membershipId: string): Promise<RevokeStaffResponse>;
    listMembers(workspaceId: string): Promise<ListAssignableMembersResponse>;
    listServiceCredentials(workspaceId: string): Promise<ListServiceCredentialsResponse>;
    createServiceCredential(
      workspaceId: string,
      body: CreateServiceCredentialRequest,
    ): Promise<CreateServiceCredentialResponse>;
    revokeServiceCredential(
      workspaceId: string,
      credentialId: string,
    ): Promise<RevokeServiceCredentialResponse>;
    listLeads(
      workspaceId: string,
      query?: ListWorkspaceLeadsQuery | ListWorkspaceLeadsQueryInput,
    ): Promise<ListWorkspaceLeadsResponse>;
    leadsSummary(workspaceId: string, query?: LeadsSummaryQuery): Promise<LeadsSummaryResponse>;
    leadStats(workspaceId: string, query: LeadStatsQuery): Promise<LeadStatsResponse>;
    sourceReport(workspaceId: string, query: SourceReportQuery): Promise<SourceReportResponse>;
    leadBoard(
      workspaceId: string,
      query: LeadBoardQuery | LeadBoardQueryInput,
    ): Promise<LeadBoardResponse>;
    getLead(workspaceId: string, leadId: string): Promise<GetWorkspaceLeadResponse>;
    updateLead(
      workspaceId: string,
      leadId: string,
      body: UpdateWorkspaceLeadRequest,
    ): Promise<UpdateWorkspaceLeadResponse>;
    archiveLead(workspaceId: string, leadId: string): Promise<LeadTrashResponse>;
    /** @deprecated Use `archiveLead`. */
    trashLead(workspaceId: string, leadId: string): Promise<LeadTrashResponse>;
    markLeadOpened(workspaceId: string, leadId: string): Promise<MarkLeadOpenedResponse>;
    emailLeadCustomer(
      workspaceId: string,
      leadId: string,
      body: QueueCustomerEmailRequest,
    ): Promise<QueueCustomerEmailResponse>;
    restoreLead(workspaceId: string, leadId: string): Promise<LeadTrashResponse>;
    createLeadNote(
      workspaceId: string,
      leadId: string,
      body: CreateLeadNoteRequest,
    ): Promise<CreateLeadNoteResponse>;
    createLeadTask(
      workspaceId: string,
      leadId: string,
      body: CreateLeadTaskRequest,
    ): Promise<LeadTaskResponse>;
    updateTask(
      workspaceId: string,
      taskId: string,
      body: UpdateLeadTaskRequest,
    ): Promise<LeadTaskResponse>;
    listTasks(
      workspaceId: string,
      query?: ListWorkspaceTasksQuery,
    ): Promise<ListWorkspaceTasksResponse>;
    /** `query.object` picks lead (the default) or plan properties on these five. */
    getPropertyModel(
      workspaceId: string,
      query?: PropertyObjectQueryInput,
    ): Promise<PropertyModelResponse>;
    createProperty(
      workspaceId: string,
      body: z.input<typeof createCustomPropertySchema>,
      query?: PropertyObjectQueryInput,
    ): Promise<PropertyResponse>;
    updateProperty(
      workspaceId: string,
      key: string,
      body: UpdateProperty,
      query?: PropertyObjectQueryInput,
    ): Promise<PropertyResponse>;
    deleteProperty(
      workspaceId: string,
      key: string,
      query?: PropertyObjectQueryInput,
    ): Promise<DeletePropertyResponse>;
    /** For plans pass `leadType` `''`: the plan record has one layout. */
    savePropertyLayout(
      workspaceId: string,
      leadType: string,
      body: SavePropertyLayoutRequest,
      query?: PropertyObjectQueryInput,
    ): Promise<PropertyLayoutResponse>;
    /** The caller's own saved views; no one else's are ever returned. */
    listSavedViews(
      workspaceId: string,
      query?: Partial<ListSavedViewsQuery>,
    ): Promise<ListSavedViewsResponse>;
    createSavedView(
      workspaceId: string,
      body: CreateSavedViewRequestInput,
    ): Promise<SavedViewResponse>;
    updateSavedView(
      workspaceId: string,
      viewId: string,
      body: UpdateSavedViewRequest,
    ): Promise<SavedViewResponse>;
    deleteSavedView(workspaceId: string, viewId: string): Promise<DeleteSavedViewResponse>;
    listPlans(workspaceId: string, query?: ListPlansQueryInput): Promise<ListPlansResponse>;
    createPlan(workspaceId: string, body: CreatePlanRequestInput): Promise<PlanResponse>;
    updatePlan(workspaceId: string, planId: string, body: UpdatePlanRequest): Promise<PlanResponse>;
    getEmailSettings(workspaceId: string): Promise<EmailSettingsResponse>;
    updateEmailSettings(
      workspaceId: string,
      body: UpdateEmailSettingsRequestInput,
    ): Promise<EmailSettingsResponse>;
    listEmailTemplates(workspaceId: string): Promise<ListEmailTemplatesResponse>;
    updateEmailTemplate(
      workspaceId: string,
      key: CustomerEmailTemplate,
      body: UpdateEmailTemplateRequest,
    ): Promise<EmailTemplateResponse>;
    previewEmailTemplate(
      workspaceId: string,
      key: CustomerEmailTemplate,
      body: PreviewEmailTemplateRequest,
    ): Promise<PreviewEmailTemplateResponse>;
    sendTestEmail(workspaceId: string, key: CustomerEmailTemplate): Promise<SendTestEmailResponse>;
    listAutomations(workspaceId: string): Promise<ListAutomationsResponse>;
    updateAutomation(
      workspaceId: string,
      key: AutomationKey,
      body: UpdateAutomationRequest,
    ): Promise<AutomationResponse>;
    listAutomationRuns(
      workspaceId: string,
      key: AutomationKey,
    ): Promise<ListAutomationRunsResponse>;
    listJobs(workspaceId: string): Promise<ListWorkspaceJobsResponse>;
    retryJob(workspaceId: string, jobId: string): Promise<RetryWorkspaceJobResponse>;
    resolveUncertainJob(
      workspaceId: string,
      jobId: string,
      body: ResolveUncertainJobRequest,
    ): Promise<ResolveUncertainJobResponse>;
    createExport(workspaceId: string, body: CreateExportRequest): Promise<CreateExportResponse>;
    reviewFile(
      workspaceId: string,
      fileId: string,
      body: ReviewFileRequest,
    ): Promise<ReviewFileResponse>;
    /** A download, or with `disposition: 'inline'` a link to view the file in a tab of its own. */
    fileDownloadLink(
      workspaceId: string,
      fileId: string,
      body?: CreateDownloadLinkRequest,
    ): Promise<CreateDownloadLinkResponse>;
    /** An owner opening a lead's sealed SIN; audited, never cached. */
    revealLeadIdentity(
      workspaceId: string,
      leadId: string,
      identityId: string,
    ): Promise<RevealLeadIdentityResponse>;
    /** Apply the customer's pending change request (`expectedVersion` as loaded). */
    approveChangeRequest(
      workspaceId: string,
      leadId: string,
      changeRequestId: string,
      body: ResolveChangeRequestRequest,
    ): Promise<ResolveChangeRequestResponse>;
    /** Turn down the customer's pending change request. */
    rejectChangeRequest(
      workspaceId: string,
      leadId: string,
      changeRequestId: string,
      body: ResolveChangeRequestRequest,
    ): Promise<ResolveChangeRequestResponse>;
  };
}

const encode = encodeURIComponent;

export function createBackendClient(options: BackendClientOptions): BackendClient {
  const origin = new URL(options.baseUrl).origin;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call<TResponse>(config: CallConfig<TResponse>): Promise<TResponse> {
    const url = new URL(config.path, origin);
    assertApiPath(url, origin);
    for (const [key, value] of Object.entries(config.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const requestId = globalThis.crypto.randomUUID();
    const headers = new Headers({
      authorization: `Bearer ${options.credential}`,
      accept: 'application/json',
      'x-request-id': requestId,
    });
    if (config.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const visitor = await options.websiteVisitorId?.();
    if (visitor !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(visitor)) throw new Error('Invalid website visitor assertion.');
      headers.set('x-website-visitor-id', visitor);
    }
    const response = await doFetch(url, {
      method: config.method,
      headers,
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
      cache: 'no-store',
      redirect: 'error',
      signal: config.signal ?? AbortSignal.timeout(timeoutMs),
    });

    // An edge 502/504, an unknown path (Express's HTML 404) or an empty body is
    // not JSON. That is still an HTTP answer, so it becomes a BackendError with
    // the real status rather than a SyntaxError. Transport failures and
    // timeouts deliberately stay non-BackendErrors: callers treat those as
    // "outcome unknown" and retry with the same idempotency key.
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(payload);
      if (parsed.success) {
        throw new BackendError(
          parsed.data.error.code,
          response.status,
          parsed.data.error.requestId,
          parsed.data.error.details,
        );
      }
      throw new BackendError('internal_error', response.status, requestId);
    }
    if (payload === undefined) throw new BackendError('internal_error', response.status, requestId);
    return config.responseSchema.parse(payload);
  }

  function proofHeader(proof?: WebsiteBotProof): HeaderMap {
    return {
      'x-turnstile-token':
        proof?.turnstileToken === undefined
          ? undefined
          : websiteBotTokenSchema.parse(proof.turnstileToken),
    };
  }

  function idempotencyHeader(option?: IdempotencyOption): HeaderMap {
    return {
      [IDEMPOTENCY_KEY_HEADER]:
        option?.idempotencyKey === undefined
          ? undefined
          : idempotencyKeySchema.parse(option.idempotencyKey),
    };
  }

  return {
    health: () =>
      call({ method: 'GET', path: '/api/v1/health', responseSchema: healthResponseSchema }),

    leads: {
      read: (leadId, opts) =>
        call({
          method: 'GET',
          path: `/api/v1/website/leads/${encode(leadId)}`,
          headers: { 'x-draft-grant': opts.draftGrant },
          responseSchema: readLeadResponseSchema,
        }),
      create: (body, opts) =>
        call({
          method: 'POST',
          path: '/api/v1/website/leads',
          body: createLeadRequestSchema.parse(body),
          headers: { ...proofHeader(opts), ...idempotencyHeader(opts) },
          responseSchema: createLeadResponseSchema,
        }),
      update: (leadId, body, opts) =>
        call({
          method: 'PATCH',
          path: `/api/v1/website/leads/${encode(leadId)}`,
          body: updateLeadRequestSchema.parse(body),
          headers: {
            'x-draft-grant': opts.draftGrant,
            ...proofHeader(opts),
            ...idempotencyHeader(opts),
          },
          responseSchema: updateLeadResponseSchema,
        }),
      createIdentityUpload: (leadId, body, proof) =>
        call({
          method: 'POST',
          path: `/api/v1/website/leads/${encode(leadId)}/identity/uploads`,
          body: createIdentityUploadRequestSchema.parse(body),
          headers: proofHeader(proof),
          responseSchema: createUploadIntentResponseSchema,
        }),
      submitIdentity: (leadId, body, proof) =>
        call({
          method: 'POST',
          path: `/api/v1/website/leads/${encode(leadId)}/identity`,
          body: submitLeadIdentityRequestSchema.parse(body),
          headers: proofHeader(proof),
          responseSchema: submitLeadIdentityResponseSchema,
        }),
    },

    plans: {
      list: (query) =>
        call({
          method: 'GET',
          path: '/api/v1/website/plans',
          query: { leadType: query?.leadType },
          responseSchema: listWebsitePlansResponseSchema,
        }),
    },

    uploads: {
      createIntent: (body, opts) =>
        call({
          method: 'POST',
          path: '/api/v1/website/uploads/intents',
          body: createUploadIntentRequestSchema.parse(body),
          headers: { 'x-draft-grant': opts.draftGrant, ...proofHeader(opts) },
          responseSchema: createUploadIntentResponseSchema,
        }),
      finalize: (uploadId, body, opts) =>
        call({
          method: 'POST',
          path: `/api/v1/website/uploads/${encode(uploadId)}/finalize`,
          body: finalizeUploadRequestSchema.parse(body),
          headers: { 'x-draft-grant': opts.draftGrant, ...proofHeader(opts) },
          responseSchema: finalizeUploadResponseSchema,
        }),
    },

    files: {
      createDownloadLink: (fileId, opts) =>
        call({
          method: 'POST',
          path: `/api/v1/website/files/${encode(fileId)}/download-link`,
          headers: { 'x-draft-grant': opts.draftGrant, ...proofHeader(opts) },
          responseSchema: createDownloadLinkResponseSchema,
        }),
    },

    tracking: {
      requestCode: (body, proof) =>
        call({
          method: 'POST',
          path: '/api/v1/website/tracking/code',
          body: trackingCodeRequestSchema.parse(body),
          headers: proofHeader(proof),
          responseSchema: trackingCodeResponseSchema,
        }),
      verify: (body, proof) =>
        call({
          method: 'POST',
          path: '/api/v1/website/tracking/verify',
          body: trackingVerifyRequestSchema.parse(body),
          headers: proofHeader(proof),
          responseSchema: trackingVerifyResponseSchema,
        }),
      orders: (opts) =>
        call({
          method: 'GET',
          path: '/api/v1/website/tracking/orders',
          headers: { 'x-customer-grant': opts.customerGrant },
          responseSchema: trackingOrdersResponseSchema,
        }),
      requestChange: (reference, body, opts) =>
        call({
          method: 'POST',
          path: `/api/v1/website/tracking/orders/${encode(reference)}/changes`,
          body: createTrackedChangeRequestSchema.parse(body),
          headers: { 'x-customer-grant': opts.customerGrant, ...proofHeader(opts) },
          responseSchema: trackedChangeResponseSchema,
        }),
      createUpload: (reference, body, opts) =>
        call({
          method: 'POST',
          path: `/api/v1/website/tracking/orders/${encode(reference)}/uploads/intents`,
          body: trackingUploadIntentRequestSchema.parse(body),
          headers: { 'x-customer-grant': opts.customerGrant, ...proofHeader(opts) },
          responseSchema: createUploadIntentResponseSchema,
        }),
      finalizeUpload: (reference, uploadId, body, opts) =>
        call({
          method: 'POST',
          path: `/api/v1/website/tracking/orders/${encode(reference)}/uploads/${encode(
            uploadId,
          )}/finalize`,
          body: finalizeUploadRequestSchema.parse(body),
          headers: { 'x-customer-grant': opts.customerGrant, ...proofHeader(opts) },
          responseSchema: trackedChangeResponseSchema,
        }),
    },

    staff: {
      listWorkspaces: () =>
        call({
          method: 'GET',
          path: '/api/v1/staff/workspaces',
          responseSchema: staffWorkspacesResponseSchema,
        }),
      updateProfile: (body) =>
        call({
          method: 'PATCH',
          path: '/api/v1/staff/profile',
          body: updateStaffProfileRequestSchema.parse(body),
          responseSchema: updateStaffProfileResponseSchema,
        }),
      workspaceAccess: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/access`,
          responseSchema: staffWorkspaceAccessResponseSchema,
        }),
      invite: (workspaceId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/invitations`,
          body: inviteStaffRequestSchema.parse(body),
          responseSchema: inviteStaffResponseSchema,
        }),
      revokeMembership: (workspaceId, membershipId) =>
        call({
          method: 'DELETE',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/memberships/${encode(membershipId)}`,
          responseSchema: revokeStaffResponseSchema,
        }),
      listMembers: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/members`,
          responseSchema: listAssignableMembersResponseSchema,
        }),
      listServiceCredentials: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/service-credentials`,
          responseSchema: listServiceCredentialsResponseSchema,
        }),
      createServiceCredential: (workspaceId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/service-credentials`,
          body: createServiceCredentialRequestSchema.parse(body),
          responseSchema: createServiceCredentialResponseSchema,
        }),
      revokeServiceCredential: (workspaceId, credentialId) =>
        call({
          method: 'DELETE',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/service-credentials/${encode(credentialId)}`,
          responseSchema: revokeServiceCredentialResponseSchema,
        }),
      listLeads: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads`,
          query: {
            status: query?.status,
            type: query?.type,
            stage: query?.stage,
            assignee: query?.assignee,
            q: query?.q,
            view: query?.view,
            dueBy: query?.dueBy,
            where:
              typeof query?.where === 'string'
                ? query.where
                : query?.where && query.where.length > 0
                  ? JSON.stringify(query.where)
                  : undefined,
            sort: query?.sort,
            columns:
              typeof query?.columns === 'string'
                ? query.columns
                : query?.columns && query.columns.length > 0
                  ? query.columns.join(',')
                  : undefined,
            page: query?.page,
            pageSize: query?.pageSize,
          },
          responseSchema: listWorkspaceLeadsResponseSchema,
        }),
      leadsSummary: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/summary`,
          query: { dueBy: query?.dueBy },
          responseSchema: leadsSummaryResponseSchema,
        }),
      leadStats: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/stats`,
          query: { leadType: query.leadType, days: query.days },
          responseSchema: leadStatsResponseSchema,
        }),
      sourceReport: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/reports/sources`,
          query: { leadType: query.leadType, days: query.days },
          responseSchema: sourceReportResponseSchema,
        }),
      leadBoard: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/board`,
          query: {
            type: query.type,
            assignee: query.assignee,
            q: query.q,
            where:
              typeof query.where === 'string'
                ? query.where
                : query.where && query.where.length > 0
                  ? JSON.stringify(query.where)
                  : undefined,
            perStage: query.perStage,
          },
          responseSchema: leadBoardResponseSchema,
        }),
      getLead: (workspaceId, leadId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}`,
          responseSchema: getWorkspaceLeadResponseSchema,
        }),
      updateLead: (workspaceId, leadId, body) =>
        call({
          method: 'PATCH',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}`,
          body: updateWorkspaceLeadRequestSchema.parse(body),
          responseSchema: updateWorkspaceLeadResponseSchema,
        }),
      markLeadOpened: (workspaceId, leadId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/opened`,
          responseSchema: markLeadOpenedResponseSchema,
        }),
      emailLeadCustomer: (workspaceId, leadId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/customer-emails`,
          body: queueCustomerEmailRequestSchema.parse(body),
          responseSchema: queueCustomerEmailResponseSchema,
        }),
      archiveLead: (workspaceId, leadId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/archive`,
          responseSchema: leadTrashResponseSchema,
        }),
      trashLead: (workspaceId, leadId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/trash`,
          responseSchema: leadTrashResponseSchema,
        }),
      restoreLead: (workspaceId, leadId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/restore`,
          responseSchema: leadTrashResponseSchema,
        }),
      createLeadNote: (workspaceId, leadId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/notes`,
          body: createLeadNoteRequestSchema.parse(body),
          responseSchema: createLeadNoteResponseSchema,
        }),
      createLeadTask: (workspaceId, leadId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(leadId)}/tasks`,
          body: createLeadTaskRequestSchema.parse(body),
          responseSchema: leadTaskResponseSchema,
        }),
      updateTask: (workspaceId, taskId, body) =>
        call({
          method: 'PATCH',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/tasks/${encode(taskId)}`,
          body: updateLeadTaskRequestSchema.parse(body),
          responseSchema: leadTaskResponseSchema,
        }),
      listTasks: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/tasks`,
          query: {
            assignee: query?.assignee,
            status: query?.status,
            dueBy: query?.dueBy,
            page: query?.page,
            pageSize: query?.pageSize,
          },
          responseSchema: listWorkspaceTasksResponseSchema,
        }),
      getPropertyModel: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/properties`,
          query: { object: query?.object },
          responseSchema: propertyModelResponseSchema,
        }),
      createProperty: (workspaceId, body, query) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/properties`,
          query: { object: query?.object },
          body: createCustomPropertySchema.parse(body),
          responseSchema: propertyResponseSchema,
        }),
      updateProperty: (workspaceId, key, body, query) =>
        call({
          method: 'PATCH',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/properties/${encode(key)}`,
          query: { object: query?.object },
          body: updatePropertySchema.parse(body),
          responseSchema: propertyResponseSchema,
        }),
      deleteProperty: (workspaceId, key, query) =>
        call({
          method: 'DELETE',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/properties/${encode(key)}`,
          query: { object: query?.object },
          responseSchema: deletePropertyResponseSchema,
        }),
      savePropertyLayout: (workspaceId, leadType, body, query) =>
        call({
          method: 'PATCH',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/properties/layouts/${encode(leadType)}`,
          query: { object: query?.object },
          body: savePropertyLayoutRequestSchema.parse(body),
          responseSchema: propertyLayoutResponseSchema,
        }),
      listSavedViews: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/views`,
          query: { object: query?.object },
          responseSchema: listSavedViewsResponseSchema,
        }),
      createSavedView: (workspaceId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/views`,
          body: createSavedViewRequestSchema.parse(body),
          responseSchema: savedViewResponseSchema,
        }),
      updateSavedView: (workspaceId, viewId, body) =>
        call({
          method: 'PATCH',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/views/${encode(viewId)}`,
          body: updateSavedViewRequestSchema.parse(body),
          responseSchema: savedViewResponseSchema,
        }),
      deleteSavedView: (workspaceId, viewId) =>
        call({
          method: 'DELETE',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/views/${encode(viewId)}`,
          responseSchema: deleteSavedViewResponseSchema,
        }),
      listPlans: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/plans`,
          query: { leadType: query?.leadType, includeInactive: query?.includeInactive },
          responseSchema: listPlansResponseSchema,
        }),
      createPlan: (workspaceId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/plans`,
          body: createPlanRequestSchema.parse(body),
          responseSchema: planResponseSchema,
        }),
      updatePlan: (workspaceId, planId, body) =>
        call({
          method: 'PATCH',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/plans/${encode(planId)}`,
          body: updatePlanRequestSchema.parse(body),
          responseSchema: planResponseSchema,
        }),
      getEmailSettings: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/email/settings`,
          responseSchema: emailSettingsResponseSchema,
        }),
      updateEmailSettings: (workspaceId, body) =>
        call({
          method: 'PUT',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/email/settings`,
          body: updateEmailSettingsRequestSchema.parse(body),
          responseSchema: emailSettingsResponseSchema,
        }),
      listEmailTemplates: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/email/templates`,
          responseSchema: listEmailTemplatesResponseSchema,
        }),
      updateEmailTemplate: (workspaceId, key, body) =>
        call({
          method: 'PUT',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/email/templates/${encode(key)}`,
          body: updateEmailTemplateRequestSchema.parse(body),
          responseSchema: emailTemplateResponseSchema,
        }),
      previewEmailTemplate: (workspaceId, key, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/email/templates/${encode(key)}/preview`,
          body: previewEmailTemplateRequestSchema.parse(body),
          responseSchema: previewEmailTemplateResponseSchema,
        }),
      sendTestEmail: (workspaceId, key) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/email/templates/${encode(key)}/test`,
          responseSchema: sendTestEmailResponseSchema,
        }),
      listAutomations: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/automations`,
          responseSchema: listAutomationsResponseSchema,
        }),
      updateAutomation: (workspaceId, key, body) =>
        call({
          method: 'PUT',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/automations/${encode(key)}`,
          body: updateAutomationRequestSchema.parse(body),
          responseSchema: automationResponseSchema,
        }),
      listAutomationRuns: (workspaceId, key) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/automations/${encode(key)}/runs`,
          responseSchema: listAutomationRunsResponseSchema,
        }),
      listJobs: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/jobs`,
          responseSchema: listWorkspaceJobsResponseSchema,
        }),
      retryJob: (workspaceId, jobId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/jobs/${encode(jobId)}/retry`,
          responseSchema: retryWorkspaceJobResponseSchema,
        }),
      resolveUncertainJob: (workspaceId, jobId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/jobs/${encode(jobId)}/resolve`,
          body: resolveUncertainJobRequestSchema.parse(body),
          responseSchema: resolveUncertainJobResponseSchema,
        }),
      createExport: (workspaceId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/exports`,
          body: createExportRequestSchema.parse(body),
          responseSchema: createExportResponseSchema,
        }),
      reviewFile: (workspaceId, fileId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/files/${encode(fileId)}/review`,
          body: reviewFileRequestSchema.parse(body),
          responseSchema: reviewFileResponseSchema,
        }),
      fileDownloadLink: (workspaceId, fileId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/files/${encode(fileId)}/download-link`,
          body: createDownloadLinkRequestSchema.parse(body ?? {}),
          responseSchema: createDownloadLinkResponseSchema,
        }),
      revealLeadIdentity: (workspaceId, leadId, identityId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(
            leadId,
          )}/identities/${encode(identityId)}/reveal`,
          responseSchema: revealLeadIdentityResponseSchema,
        }),
      approveChangeRequest: (workspaceId, leadId, changeRequestId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(
            leadId,
          )}/change-requests/${encode(changeRequestId)}/approve`,
          body: resolveChangeRequestRequestSchema.parse(body),
          responseSchema: resolveChangeRequestResponseSchema,
        }),
      rejectChangeRequest: (workspaceId, leadId, changeRequestId, body) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/${encode(
            leadId,
          )}/change-requests/${encode(changeRequestId)}/reject`,
          body: resolveChangeRequestRequestSchema.parse(body),
          responseSchema: resolveChangeRequestResponseSchema,
        }),
    },
  };
}
