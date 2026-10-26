/**
 * @gt-sales/contracts — Zod request/response schemas, the canonical error
 * envelope, the OpenAPI generator, and the one typed API client consumed by
 * both the admin and the websites. No provider secrets or SDK clients.
 */

// Shared scalars, error-envelope pieces, versioned form helper
export {
  countryCodeSchema,
  currencyCodeSchema,
  domainErrorCodeSchema,
  emailSchema,
  errorDetailsSchema,
  isoDateTimeSchema,
  moneySchema,
  pageInfoSchema,
  requestIdSchema,
  schemaVersionSchema,
  versionedFormSchema,
  type CountryCode,
  type CurrencyCode,
  type DomainErrorCode,
  type Email,
  type ErrorDetails,
  type IsoDateTime,
  type Money,
  type PageInfo,
  type RequestId,
  type SchemaVersion,
  type VersionedForm,
} from './common';

// API-surface vocabularies
export {
  MAX_DOCUMENT_BYTES,
  documentChecklistKeySchema,
  documentMediaTypeSchema,
  documentParentTypeSchema,
  type DocumentChecklistKey,
  type DocumentMediaType,
  type DocumentParentType,
} from './domain';

export { healthResponseSchema, type HealthResponse } from './health';

export {
  adminJobSchema,
  adminJobStatusSchema,
  listWorkspaceJobsResponseSchema,
  resolveUncertainJobRequestSchema,
  resolveUncertainJobResponseSchema,
  retryWorkspaceJobResponseSchema,
  type AdminJob,
  type AdminJobStatus,
  type ListWorkspaceJobsResponse,
  type ResolveUncertainJobRequest,
  type ResolveUncertainJobResponse,
  type RetryWorkspaceJobResponse,
} from './jobs';

export {
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  apiErrorSchema,
  authErrorCodeSchema,
  inviteStaffRequestSchema,
  inviteStaffResponseSchema,
  membershipStatusSchema,
  revokeStaffResponseSchema,
  staffAuthErrorCodeSchema,
  staffPermissionNameSchema,
  staffRoleNameSchema,
  staffWorkspaceAccessResponseSchema,
  staffWorkspaceSchema,
  staffWorkspacesResponseSchema,
  type ApiError,
  type ApiErrorCode,
  type ApiErrorResponse,
  type AuthErrorCode,
  type InviteStaffRequest,
  type InviteStaffResponse,
  type RevokeStaffResponse,
  type StaffAuthErrorCode,
  type StaffWorkspace,
  type StaffWorkspaceAccessResponse,
  type StaffWorkspacesResponse,
} from './staff-auth';

export {
  assignableMemberSchema,
  listAssignableMembersResponseSchema,
  type AssignableMember,
  type ListAssignableMembersResponse,
} from './members';

export {
  createServiceCredentialRequestSchema,
  createServiceCredentialResponseSchema,
  listServiceCredentialsResponseSchema,
  revokeServiceCredentialResponseSchema,
  serviceCredentialSummarySchema,
  websiteAuthErrorCodeSchema,
  websiteScopeSchema,
  type CreateServiceCredentialRequest,
  type CreateServiceCredentialResponse,
  type ListServiceCredentialsResponse,
  type RevokeServiceCredentialResponse,
  type ServiceCredentialSummary,
  type WebsiteAuthErrorCode,
} from './website-auth';

// Request families
export {
  attributionSchema,
  consentVersionSchema,
  createLeadRequestSchema,
  createLeadResponseSchema,
  draftGrantSchema,
  leadContactSchema,
  leadExternalRefSchema,
  leadFormSchema,
  leadStatusSchema,
  leadSummarySchema,
  leadTypeSchema,
  rawAttributionSchema,
  leadDraftSchema,
  readLeadResponseSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  type Attribution,
  type ConsentVersion,
  type CreateLeadRequest,
  type CreateLeadResponse,
  type DraftGrant,
  type LeadContact,
  type LeadExternalRef,
  type LeadForm,
  type LeadStatus,
  type LeadSummary,
  type LeadType,
  type RawAttribution,
  type LeadDraft,
  type ReadLeadResponse,
  type UpdateLeadRequest,
  type UpdateLeadResponse,
} from './leads';

export {
  internetLeadPayloadSchema,
  mobilityLeadPayloadSchema,
  type InternetLeadPayload,
  type MobilityLeadPayload,
} from './lead-types';

export {
  leadListItemSchema,
  listWorkspaceLeadsQuerySchema,
  listWorkspaceLeadsResponseSchema,
  type LeadListItem,
  type ListWorkspaceLeadsQuery,
  type ListWorkspaceLeadsResponse,
} from './workspace-leads';

export {
  createUploadIntentRequestSchema,
  createUploadIntentResponseSchema,
  finalizeUploadRequestSchema,
  finalizeUploadResponseSchema,
  type CreateUploadIntentRequest,
  type CreateUploadIntentResponse,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
} from './uploads';

export {
  createDownloadLinkResponseSchema,
  fileReviewDecisionSchema,
  fileReviewEventSchema,
  fileStatusSchema,
  fileSummarySchema,
  listWorkspaceFilesResponseSchema,
  reviewFileRequestSchema,
  reviewFileResponseSchema,
  staffFileSchema,
  type CreateDownloadLinkResponse,
  type FileReviewDecision,
  type FileReviewEvent,
  type FileStatus,
  type FileSummary,
  type ListWorkspaceFilesResponse,
  type ReviewFileRequest,
  type ReviewFileResponse,
  type StaffFile,
} from './files';

export {
  createExportRequestSchema,
  createExportResponseSchema,
  exportJobSchema,
  exportJobStatusSchema,
  exportKindSchema,
  type CreateExportRequest,
  type CreateExportResponse,
  type ExportJob,
  type ExportJobStatus,
  type ExportKind,
} from './exports';

// Endpoint registry, OpenAPI generation, typed client
export {
  endpoints,
  type EndpointAuth,
  type EndpointDef,
  type EndpointHeader,
  type HttpMethod,
} from './endpoints';

export { buildOpenApiDocument, type BuildOpenApiOptions } from './openapi';

export {
  BackendError,
  createBackendClient,
  type BackendClient,
  type BackendClientOptions,
} from './client';

export {
  websiteBotActions,
  websiteBotTokenSchema,
  type WebsiteBotAction,
  type WebsiteBotProof,
} from './website-bot';
