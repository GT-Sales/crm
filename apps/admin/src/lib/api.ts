import {
  BackendError,
  createBackendClient,
  type CreateDownloadLinkResponse,
  type CreateLeadNoteResponse,
  type CreateLeadTaskRequest,
  type GetWorkspaceLeadResponse,
  type LeadBoardQuery,
  type LeadBoardResponse,
  type LeadsSummaryQuery,
  type LeadsSummaryResponse,
  type LeadStatsQuery,
  type LeadStatsResponse,
  type LeadTaskResponse,
  type LeadTrashResponse,
  type MarkLeadOpenedResponse,
  type CustomerEmailTemplate,
  type QueueCustomerEmailResponse,
  type ListWorkspaceTasksQuery,
  type ListWorkspaceTasksResponse,
  type UpdateLeadTaskRequest,
  type UpdateStaffProfileResponse,
  type UpdateWorkspaceLeadRequest,
  type UpdateWorkspaceLeadResponse,
  type CreateServiceCredentialRequest,
  type CreateServiceCredentialResponse,
  type HealthResponse,
  type InviteStaffRequest,
  type InviteStaffResponse,
  type ListAssignableMembersResponse,
  type ListServiceCredentialsResponse,
  type ListWorkspaceJobsResponse,
  type ListWorkspaceLeadsQuery,
  type ListWorkspaceLeadsResponse,
  type ResolveUncertainJobResponse,
  type RetryWorkspaceJobResponse,
  type RevealLeadIdentityResponse,
  type ReviewFileRequest,
  type ReviewFileResponse,
  type RevokeServiceCredentialResponse,
  type RevokeStaffResponse,
  type StaffWorkspaceAccessResponse,
  type StaffWorkspacesResponse,
} from '@gt-sales/contracts';

const API_BASE_URL =
  process.env['NEXT_PUBLIC_API_BASE_URL'] ?? process.env['API_BASE_URL'] ?? 'http://localhost:4000';

/**
 * Admin's staff-facing calls. Every request goes through the one typed client
 * in `@gt-sales/contracts` (createBackendClient), so the admin and the
 * websites share request/response types, response validation and transport
 * hardening. The staff Supabase access token is the client's bearer credential.
 */
export { BackendError };

function client(accessToken: string) {
  return createBackendClient({ baseUrl: API_BASE_URL, credential: accessToken });
}

/** Public liveness check; no session required. */
export async function getHealth(): Promise<HealthResponse> {
  return createBackendClient({ baseUrl: API_BASE_URL, credential: '' }).health();
}

export async function getStaffWorkspaces(accessToken: string): Promise<StaffWorkspacesResponse> {
  return client(accessToken).staff.listWorkspaces();
}

export async function getStaffWorkspaceAccess(
  accessToken: string,
  workspaceId: string,
): Promise<StaffWorkspaceAccessResponse> {
  return client(accessToken).staff.workspaceAccess(workspaceId);
}

export async function inviteStaff(
  accessToken: string,
  workspaceId: string,
  input: InviteStaffRequest,
): Promise<InviteStaffResponse> {
  return client(accessToken).staff.invite(workspaceId, input);
}

export async function revokeStaff(
  accessToken: string,
  workspaceId: string,
  membershipId: string,
): Promise<RevokeStaffResponse> {
  return client(accessToken).staff.revokeMembership(workspaceId, membershipId);
}

export async function listWorkspaceMembers(
  accessToken: string,
  workspaceId: string,
): Promise<ListAssignableMembersResponse> {
  return client(accessToken).staff.listMembers(workspaceId);
}

export async function listServiceCredentials(
  accessToken: string,
  workspaceId: string,
): Promise<ListServiceCredentialsResponse> {
  return client(accessToken).staff.listServiceCredentials(workspaceId);
}

export async function createServiceCredential(
  accessToken: string,
  workspaceId: string,
  input: CreateServiceCredentialRequest,
): Promise<CreateServiceCredentialResponse> {
  return client(accessToken).staff.createServiceCredential(workspaceId, input);
}

export async function revokeServiceCredential(
  accessToken: string,
  workspaceId: string,
  credentialId: string,
): Promise<RevokeServiceCredentialResponse> {
  return client(accessToken).staff.revokeServiceCredential(workspaceId, credentialId);
}

export async function getStaffLeads(
  accessToken: string,
  workspaceId: string,
  query?: ListWorkspaceLeadsQuery,
): Promise<ListWorkspaceLeadsResponse> {
  return client(accessToken).staff.listLeads(workspaceId, query);
}

export async function getLeadsSummary(
  accessToken: string,
  workspaceId: string,
  query?: LeadsSummaryQuery,
): Promise<LeadsSummaryResponse> {
  return client(accessToken).staff.leadsSummary(workspaceId, query);
}

/** The dashboard's counts for one lead type over a window. */
export async function getLeadStats(
  accessToken: string,
  workspaceId: string,
  query: LeadStatsQuery,
): Promise<LeadStatsResponse> {
  return client(accessToken).staff.leadStats(workspaceId, query);
}

export async function getLeadBoard(
  accessToken: string,
  workspaceId: string,
  query: LeadBoardQuery,
): Promise<LeadBoardResponse> {
  return client(accessToken).staff.leadBoard(workspaceId, query);
}

export async function getStaffLead(
  accessToken: string,
  workspaceId: string,
  leadId: string,
): Promise<GetWorkspaceLeadResponse> {
  return client(accessToken).staff.getLead(workspaceId, leadId);
}

export async function updateStaffLead(
  accessToken: string,
  workspaceId: string,
  leadId: string,
  body: UpdateWorkspaceLeadRequest,
): Promise<UpdateWorkspaceLeadResponse> {
  return client(accessToken).staff.updateLead(workspaceId, leadId, body);
}

/** Queues a mail to the lead's customer (a SIM order's number), sent within a minute. */
export async function emailLeadCustomer(
  accessToken: string,
  workspaceId: string,
  leadId: string,
  template: CustomerEmailTemplate,
): Promise<QueueCustomerEmailResponse> {
  return client(accessToken).staff.emailLeadCustomer(workspaceId, leadId, { template });
}

/** Clears the lead's "New" badge for the team; idempotent. */
export async function markLeadOpened(
  accessToken: string,
  workspaceId: string,
  leadId: string,
): Promise<MarkLeadOpenedResponse> {
  return client(accessToken).staff.markLeadOpened(workspaceId, leadId);
}

export async function setLeadTrashed(
  accessToken: string,
  workspaceId: string,
  leadId: string,
  trashed: boolean,
): Promise<LeadTrashResponse> {
  const staff = client(accessToken).staff;
  return trashed ? staff.trashLead(workspaceId, leadId) : staff.restoreLead(workspaceId, leadId);
}

export async function addLeadNote(
  accessToken: string,
  workspaceId: string,
  leadId: string,
  body: string,
): Promise<CreateLeadNoteResponse> {
  return client(accessToken).staff.createLeadNote(workspaceId, leadId, { body });
}

export async function createLeadTask(
  accessToken: string,
  workspaceId: string,
  leadId: string,
  body: CreateLeadTaskRequest,
): Promise<LeadTaskResponse> {
  return client(accessToken).staff.createLeadTask(workspaceId, leadId, body);
}

export async function updateLeadTask(
  accessToken: string,
  workspaceId: string,
  taskId: string,
  body: UpdateLeadTaskRequest,
): Promise<LeadTaskResponse> {
  return client(accessToken).staff.updateTask(workspaceId, taskId, body);
}

export async function listStaffTasks(
  accessToken: string,
  workspaceId: string,
  query?: ListWorkspaceTasksQuery,
): Promise<ListWorkspaceTasksResponse> {
  return client(accessToken).staff.listTasks(workspaceId, query);
}

export async function updateStaffProfile(
  accessToken: string,
  displayName: string,
): Promise<UpdateStaffProfileResponse> {
  return client(accessToken).staff.updateProfile({ displayName });
}

export async function listWorkspaceJobs(
  accessToken: string,
  workspaceId: string,
): Promise<ListWorkspaceJobsResponse> {
  return client(accessToken).staff.listJobs(workspaceId);
}

export async function retryWorkspaceJob(
  accessToken: string,
  workspaceId: string,
  jobId: string,
): Promise<RetryWorkspaceJobResponse> {
  return client(accessToken).staff.retryJob(workspaceId, jobId);
}

export async function resolveUncertainWorkspaceJob(
  accessToken: string,
  workspaceId: string,
  jobId: string,
  delivered: boolean,
): Promise<ResolveUncertainJobResponse> {
  return client(accessToken).staff.resolveUncertainJob(workspaceId, jobId, { delivered });
}

// ---- Documents. Downloading an original requires the document.download
// permission, checked server-side. ----

export async function reviewFile(
  accessToken: string,
  workspaceId: string,
  fileId: string,
  body: ReviewFileRequest,
): Promise<ReviewFileResponse> {
  return client(accessToken).staff.reviewFile(workspaceId, fileId, body);
}

/** A download link, or with `inline` one that opens the file in a tab of its own. */
export async function createFileDownloadLink(
  accessToken: string,
  workspaceId: string,
  fileId: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<CreateDownloadLinkResponse> {
  return client(accessToken).staff.fileDownloadLink(workspaceId, fileId, { disposition });
}

/** An owner opening a lead's sealed SIN. The backend audits it; nothing here keeps it. */
export async function revealLeadIdentity(
  accessToken: string,
  workspaceId: string,
  leadId: string,
  identityId: string,
): Promise<RevealLeadIdentityResponse> {
  return client(accessToken).staff.revealLeadIdentity(workspaceId, leadId, identityId);
}
