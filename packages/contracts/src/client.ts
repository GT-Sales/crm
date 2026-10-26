import { websiteBotTokenSchema, type WebsiteBotProof } from './website-bot';
import type { z } from 'zod';

import {
  createDownloadLinkResponseSchema,
  reviewFileRequestSchema,
  reviewFileResponseSchema,
  type CreateDownloadLinkResponse,
  type ReviewFileRequest,
  type ReviewFileResponse,
} from './files';
import { healthResponseSchema, type HealthResponse } from './health';
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
  createLeadRequestSchema,
  createLeadResponseSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  readLeadResponseSchema,
  type ReadLeadResponse,
  type CreateLeadRequest,
  type CreateLeadResponse,
  type UpdateLeadRequest,
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
  listWorkspaceTasksResponseSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
  updateWorkspaceLeadResponseSchema,
  type CreateLeadNoteRequest,
  type CreateLeadNoteResponse,
  type CreateLeadTaskRequest,
  type GetWorkspaceLeadResponse,
  type LeadTaskResponse,
  type LeadTrashResponse,
  type ListWorkspaceTasksQuery,
  type ListWorkspaceTasksResponse,
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
  leadBoardResponseSchema,
  leadsSummaryResponseSchema,
  listWorkspaceLeadsResponseSchema,
  type LeadBoardQuery,
  type LeadBoardResponse,
  type LeadsSummaryResponse,
  type ListWorkspaceLeadsQuery,
  type ListWorkspaceLeadsResponse,
} from './workspace-leads';

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
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

export interface BackendClient {
  health(): Promise<HealthResponse>;
  leads: {
    read(leadId: string, options: { draftGrant: string }): Promise<ReadLeadResponse>;
    create(body: CreateLeadRequest, proof?: WebsiteBotProof): Promise<CreateLeadResponse>;
    update(
      leadId: string,
      body: UpdateLeadRequest,
      options: { draftGrant: string } & WebsiteBotProof,
    ): Promise<UpdateLeadResponse>;
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
      query?: ListWorkspaceLeadsQuery,
    ): Promise<ListWorkspaceLeadsResponse>;
    leadsSummary(workspaceId: string): Promise<LeadsSummaryResponse>;
    leadBoard(workspaceId: string, query: LeadBoardQuery): Promise<LeadBoardResponse>;
    getLead(workspaceId: string, leadId: string): Promise<GetWorkspaceLeadResponse>;
    updateLead(
      workspaceId: string,
      leadId: string,
      body: UpdateWorkspaceLeadRequest,
    ): Promise<UpdateWorkspaceLeadResponse>;
    trashLead(workspaceId: string, leadId: string): Promise<LeadTrashResponse>;
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
    fileDownloadLink(workspaceId: string, fileId: string): Promise<CreateDownloadLinkResponse>;
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
      create: (body, proof) =>
        call({
          method: 'POST',
          path: '/api/v1/website/leads',
          body: createLeadRequestSchema.parse(body),
          headers: proofHeader(proof),
          responseSchema: createLeadResponseSchema,
        }),
      update: (leadId, body, opts) =>
        call({
          method: 'PATCH',
          path: `/api/v1/website/leads/${encode(leadId)}`,
          body: updateLeadRequestSchema.parse(body),
          headers: { 'x-draft-grant': opts.draftGrant, ...proofHeader(opts) },
          responseSchema: updateLeadResponseSchema,
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
            page: query?.page,
            pageSize: query?.pageSize,
          },
          responseSchema: listWorkspaceLeadsResponseSchema,
        }),
      leadsSummary: (workspaceId) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/summary`,
          responseSchema: leadsSummaryResponseSchema,
        }),
      leadBoard: (workspaceId, query) =>
        call({
          method: 'GET',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/leads/board`,
          query: {
            type: query.type,
            assignee: query.assignee,
            q: query.q,
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
            page: query?.page,
            pageSize: query?.pageSize,
          },
          responseSchema: listWorkspaceTasksResponseSchema,
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
      fileDownloadLink: (workspaceId, fileId) =>
        call({
          method: 'POST',
          path: `/api/v1/staff/workspaces/${encode(workspaceId)}/files/${encode(fileId)}/download-link`,
          responseSchema: createDownloadLinkResponseSchema,
        }),
    },
  };
}
