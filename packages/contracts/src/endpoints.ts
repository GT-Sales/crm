import type { z } from 'zod';

import {
  createDownloadLinkRequestSchema,
  createDownloadLinkResponseSchema,
  reviewFileRequestSchema,
  reviewFileResponseSchema,
} from './files';
import {
  createLeadRequestSchema,
  createLeadResponseSchema,
  updateLeadRequestSchema,
  updateLeadResponseSchema,
  readLeadResponseSchema,
} from './leads';
import {
  createServiceCredentialRequestSchema,
  createServiceCredentialResponseSchema,
  listServiceCredentialsResponseSchema,
  revokeServiceCredentialResponseSchema,
} from './website-auth';
import { createExportRequestSchema, createExportResponseSchema } from './exports';
import { healthResponseSchema } from './health';
import {
  createIdentityUploadRequestSchema,
  revealLeadIdentityResponseSchema,
  submitLeadIdentityRequestSchema,
  submitLeadIdentityResponseSchema,
} from './lead-identity';
import {
  listWorkspaceJobsResponseSchema,
  resolveUncertainJobRequestSchema,
  resolveUncertainJobResponseSchema,
  retryWorkspaceJobResponseSchema,
} from './jobs';
import {
  createLeadNoteRequestSchema,
  createLeadNoteResponseSchema,
  createLeadTaskRequestSchema,
  getWorkspaceLeadResponseSchema,
  leadTaskResponseSchema,
  leadTrashResponseSchema,
  queueCustomerEmailRequestSchema,
  queueCustomerEmailResponseSchema,
  listWorkspaceTasksQuerySchema,
  markLeadOpenedResponseSchema,
  listWorkspaceTasksResponseSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
  updateWorkspaceLeadResponseSchema,
} from './lead-work';
import { createCustomPropertySchema, updatePropertySchema } from './properties';
import {
  deletePropertyResponseSchema,
  propertyLayoutResponseSchema,
  propertyModelResponseSchema,
  propertyResponseSchema,
  savePropertyLayoutRequestSchema,
} from './property-layouts';
import {
  createPlanRequestSchema,
  listPlansQuerySchema,
  listPlansResponseSchema,
  listWebsitePlansQuerySchema,
  listWebsitePlansResponseSchema,
  planResponseSchema,
  updatePlanRequestSchema,
} from './plans';
import {
  createSavedViewRequestSchema,
  deleteSavedViewResponseSchema,
  listSavedViewsQuerySchema,
  listSavedViewsResponseSchema,
  savedViewResponseSchema,
  updateSavedViewRequestSchema,
} from './saved-views';
import {
  listAssignableMembersResponseSchema,
  updateStaffProfileRequestSchema,
  updateStaffProfileResponseSchema,
} from './members';
import {
  inviteStaffRequestSchema,
  inviteStaffResponseSchema,
  revokeStaffResponseSchema,
  staffWorkspaceAccessResponseSchema,
  staffWorkspacesResponseSchema,
} from './staff-auth';
import {
  createUploadIntentRequestSchema,
  createUploadIntentResponseSchema,
  finalizeUploadRequestSchema,
  finalizeUploadResponseSchema,
} from './uploads';
import {
  leadBoardQuerySchema,
  leadBoardResponseSchema,
  leadsSummaryQuerySchema,
  leadsSummaryResponseSchema,
  leadStatsQuerySchema,
  leadStatsResponseSchema,
  listWorkspaceLeadsQuerySchema,
  listWorkspaceLeadsResponseSchema,
} from './workspace-leads';

/**
 * The single registry of every `/api/v1` operation. It drives OpenAPI
 * generation (`openapi.ts`) and is the coverage backstop for the typed client
 * (`client.ts`). Each entry pairs a route with the exact request/response Zod
 * schemas the backend must honour, so a schema change surfaces in the generated
 * document and the client together.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** How the operation is authenticated. Drives the OpenAPI security requirement. */
export type EndpointAuth = 'public' | 'staff' | 'website' | 'customer' | 'machine';

export interface EndpointHeader {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface EndpointDef {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI path template with `{param}` placeholders, always under `/api/v1`. */
  readonly path: string;
  readonly summary: string;
  readonly auth: EndpointAuth;
  readonly successStatus: number;
  readonly request?: z.ZodType;
  readonly query?: z.ZodType;
  readonly response: z.ZodType;
  readonly headers?: readonly EndpointHeader[];
}

const DRAFT_GRANT: EndpointHeader = {
  name: 'X-Draft-Grant',
  required: true,
  description: 'Scoped grant token that authorises resuming this draft.',
};

export const endpoints: readonly EndpointDef[] = [
  {
    operationId: 'getHealth',
    method: 'GET',
    path: '/api/v1/health',
    summary: 'Liveness check.',
    auth: 'public',
    successStatus: 200,
    response: healthResponseSchema,
  },

  // Staff — bootstrap and workspace access
  {
    operationId: 'listStaffWorkspaces',
    method: 'GET',
    path: '/api/v1/staff/workspaces',
    summary: "List the actor's active memberships.",
    auth: 'staff',
    successStatus: 200,
    response: staffWorkspacesResponseSchema,
  },
  {
    operationId: 'updateStaffProfile',
    method: 'PATCH',
    path: '/api/v1/staff/profile',
    summary: "Set the caller's own display name on every site they belong to.",
    auth: 'staff',
    successStatus: 200,
    request: updateStaffProfileRequestSchema,
    response: updateStaffProfileResponseSchema,
  },
  {
    operationId: 'getStaffWorkspaceAccess',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/access',
    summary: "Re-read the actor's membership, roles and permissions for a workspace.",
    auth: 'staff',
    successStatus: 200,
    response: staffWorkspaceAccessResponseSchema,
  },
  {
    operationId: 'inviteStaff',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/invitations',
    summary: 'Invite a staff member (Owner).',
    auth: 'staff',
    successStatus: 201,
    request: inviteStaffRequestSchema,
    response: inviteStaffResponseSchema,
  },
  {
    operationId: 'revokeStaff',
    method: 'DELETE',
    path: '/api/v1/staff/workspaces/{workspaceId}/memberships/{membershipId}',
    summary: 'Revoke a membership (Owner).',
    auth: 'staff',
    successStatus: 200,
    response: revokeStaffResponseSchema,
  },
  {
    operationId: 'listWorkspaceMembers',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/members',
    summary: 'List the active staff members of this workspace as assignee options.',
    auth: 'staff',
    successStatus: 200,
    response: listAssignableMembersResponseSchema,
  },
  {
    operationId: 'listServiceCredentials',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/service-credentials',
    summary: 'List website service credentials (Owner).',
    auth: 'staff',
    successStatus: 200,
    response: listServiceCredentialsResponseSchema,
  },
  {
    operationId: 'createServiceCredential',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/service-credentials',
    summary: 'Create a website service credential; the secret is returned once (Owner).',
    auth: 'staff',
    successStatus: 201,
    request: createServiceCredentialRequestSchema,
    response: createServiceCredentialResponseSchema,
  },
  {
    operationId: 'revokeServiceCredential',
    method: 'DELETE',
    path: '/api/v1/staff/workspaces/{workspaceId}/service-credentials/{credentialId}',
    summary: 'Revoke a website service credential (Owner).',
    auth: 'staff',
    successStatus: 200,
    response: revokeServiceCredentialResponseSchema,
  },

  // Staff — leads
  {
    operationId: 'listWorkspaceLeads',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads',
    summary:
      'List leads with filters (type, stage, assignee, search, trash, follow-ups due) and attribution.',
    auth: 'staff',
    successStatus: 200,
    query: listWorkspaceLeadsQuerySchema,
    response: listWorkspaceLeadsResponseSchema,
  },
  {
    operationId: 'getWorkspaceLeadsSummary',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/summary',
    summary:
      'Count active leads per type (unopened ones, and with `dueBy` those with a follow-up due), and the trash.',
    auth: 'staff',
    successStatus: 200,
    query: leadsSummaryQuerySchema,
    response: leadsSummaryResponseSchema,
  },
  {
    operationId: 'getWorkspaceLeadStats',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/stats',
    summary:
      "The dashboard's counts for one lead type: by stage, per day and by partner, over 7, 30 or 90 days or all time.",
    auth: 'staff',
    successStatus: 200,
    query: leadStatsQuerySchema,
    response: leadStatsResponseSchema,
  },
  {
    operationId: 'getWorkspaceLeadBoard',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/board',
    summary: "One lead type's active leads by stage, a column per stage.",
    auth: 'staff',
    successStatus: 200,
    query: leadBoardQuerySchema,
    response: leadBoardResponseSchema,
  },
  {
    operationId: 'getWorkspaceLead',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}',
    summary: 'Read one lead with its form, timeline and tasks.',
    auth: 'staff',
    successStatus: 200,
    response: getWorkspaceLeadResponseSchema,
  },
  {
    operationId: 'updateWorkspaceLead',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}',
    summary: "Change a lead's stage, assignee or contact details (lead management).",
    auth: 'staff',
    successStatus: 200,
    request: updateWorkspaceLeadRequestSchema,
    response: updateWorkspaceLeadResponseSchema,
  },
  {
    operationId: 'trashWorkspaceLead',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/trash',
    summary: 'Move a lead to the trash; it can be restored (lead management).',
    auth: 'staff',
    successStatus: 200,
    response: leadTrashResponseSchema,
  },
  {
    operationId: 'revealLeadIdentity',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/identities/{identityId}/reveal',
    summary: "Reveal a lead's sealed SIN (owner only); every reveal is audited.",
    auth: 'staff',
    successStatus: 200,
    response: revealLeadIdentityResponseSchema,
  },
  {
    operationId: 'markWorkspaceLeadOpened',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/opened',
    summary:
      'Record that someone who works leads opened the lead, which clears its "New" badge (lead management; idempotent).',
    auth: 'staff',
    successStatus: 200,
    response: markLeadOpenedResponseSchema,
  },
  {
    operationId: 'restoreWorkspaceLead',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/restore',
    summary: 'Bring a lead back from the trash (lead management).',
    auth: 'staff',
    successStatus: 200,
    response: leadTrashResponseSchema,
  },
  {
    operationId: 'queueLeadCustomerEmail',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/customer-emails',
    summary:
      "Queue a mail to the lead's customer from the site's own sender, such as a SIM order's number (lead management).",
    auth: 'staff',
    successStatus: 202,
    request: queueCustomerEmailRequestSchema,
    response: queueCustomerEmailResponseSchema,
  },
  {
    operationId: 'createLeadNote',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/notes',
    summary: "Add a note to a lead's timeline (lead management).",
    auth: 'staff',
    successStatus: 201,
    request: createLeadNoteRequestSchema,
    response: createLeadNoteResponseSchema,
  },
  {
    operationId: 'createLeadTask',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/tasks',
    summary: 'Add a follow-up task to a lead (lead management).',
    auth: 'staff',
    successStatus: 201,
    request: createLeadTaskRequestSchema,
    response: leadTaskResponseSchema,
  },
  {
    operationId: 'updateLeadTask',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/tasks/{taskId}',
    summary: 'Edit, complete, reopen or cancel a task (lead management).',
    auth: 'staff',
    successStatus: 200,
    request: updateLeadTaskRequestSchema,
    response: leadTaskResponseSchema,
  },
  {
    operationId: 'listWorkspaceTasks',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/tasks',
    summary:
      "List tasks across the workspace's active leads: the caller's, unassigned, everyone's or one member's, optionally only those due by a day; defaults to the caller's open ones.",
    auth: 'staff',
    successStatus: 200,
    query: listWorkspaceTasksQuerySchema,
    response: listWorkspaceTasksResponseSchema,
  },

  // Staff — properties, record layouts and saved views
  {
    operationId: 'getPropertyModel',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties',
    summary: "The site's property catalogue and saved record layouts.",
    auth: 'staff',
    successStatus: 200,
    response: propertyModelResponseSchema,
  },
  {
    operationId: 'createProperty',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties',
    summary: 'Add a custom property (property management).',
    auth: 'staff',
    successStatus: 201,
    request: createCustomPropertySchema,
    response: propertyResponseSchema,
  },
  {
    operationId: 'updateProperty',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties/{key}',
    summary:
      'Change a property: a custom one fully, a built-in only its label and whether it is hidden (property management).',
    auth: 'staff',
    successStatus: 200,
    request: updatePropertySchema,
    response: propertyResponseSchema,
  },
  {
    operationId: 'deleteProperty',
    method: 'DELETE',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties/{key}',
    summary:
      'Delete a custom property, leaving a tombstone so its key is never reused; refused with 409 `property_in_use` while any lead (trashed and restricted included) holds a value (property management).',
    auth: 'staff',
    successStatus: 200,
    response: deletePropertyResponseSchema,
  },
  {
    operationId: 'savePropertyLayout',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties/layouts/{leadType}',
    summary: 'Save the record layout of one lead type (property management).',
    auth: 'staff',
    successStatus: 200,
    request: savePropertyLayoutRequestSchema,
    response: propertyLayoutResponseSchema,
  },
  {
    operationId: 'listSavedViews',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/views',
    summary: "List the caller's own saved views of the leads list.",
    auth: 'staff',
    successStatus: 200,
    query: listSavedViewsQuerySchema,
    response: listSavedViewsResponseSchema,
  },
  {
    operationId: 'createSavedView',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/views',
    summary: 'Save the current leads list as a private view.',
    auth: 'staff',
    successStatus: 201,
    request: createSavedViewRequestSchema,
    response: savedViewResponseSchema,
  },
  {
    operationId: 'updateSavedView',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/views/{viewId}',
    summary: "Rename one of the caller's saved views or replace its state.",
    auth: 'staff',
    successStatus: 200,
    request: updateSavedViewRequestSchema,
    response: savedViewResponseSchema,
  },
  {
    operationId: 'deleteSavedView',
    method: 'DELETE',
    path: '/api/v1/staff/workspaces/{workspaceId}/views/{viewId}',
    summary: "Delete one of the caller's saved views.",
    auth: 'staff',
    successStatus: 200,
    response: deleteSavedViewResponseSchema,
  },

  // Staff — plans
  {
    operationId: 'listPlans',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/plans',
    summary: "List the site's plans, active only unless asked for inactive ones too.",
    auth: 'staff',
    successStatus: 200,
    query: listPlansQuerySchema,
    response: listPlansResponseSchema,
  },
  {
    operationId: 'createPlan',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/plans',
    summary: 'Add a plan the site sells for one order lead type.',
    auth: 'staff',
    successStatus: 201,
    request: createPlanRequestSchema,
    response: planResponseSchema,
  },
  {
    operationId: 'updatePlan',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/plans/{planId}',
    summary: 'Change, reorder, deactivate or reactivate one of the site plans.',
    auth: 'staff',
    successStatus: 200,
    request: updatePlanRequestSchema,
    response: planResponseSchema,
  },

  // Staff — outbox jobs
  {
    operationId: 'listWorkspaceJobs',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/jobs',
    summary: 'List pending and failed workspace outbox jobs.',
    auth: 'staff',
    successStatus: 200,
    response: listWorkspaceJobsResponseSchema,
  },
  {
    operationId: 'retryWorkspaceJob',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/jobs/{jobId}/retry',
    summary: 'Retry a failed workspace outbox job (integration management).',
    auth: 'staff',
    successStatus: 200,
    response: retryWorkspaceJobResponseSchema,
  },
  {
    operationId: 'resolveUncertainWorkspaceJob',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/jobs/{jobId}/resolve',
    summary:
      'Record whether an uncertain outbox job reached the provider (integration management).',
    auth: 'staff',
    successStatus: 200,
    request: resolveUncertainJobRequestSchema,
    response: resolveUncertainJobResponseSchema,
  },

  // Staff — exports (seam only)
  {
    operationId: 'createExport',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/exports',
    summary: 'Queue a controlled data export (Owner or export permission).',
    auth: 'staff',
    successStatus: 202,
    request: createExportRequestSchema,
    response: createExportResponseSchema,
  },

  // Staff — documents
  {
    operationId: 'reviewWorkspaceFile',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/files/{fileId}/review',
    summary: 'Approve or reject a document with an optional note.',
    auth: 'staff',
    successStatus: 200,
    request: reviewFileRequestSchema,
    response: reviewFileResponseSchema,
  },
  {
    operationId: 'createWorkspaceFileDownloadLink',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/files/{fileId}/download-link',
    summary:
      'Issue a short-lived signed URL to download or view a file after a document-download permission check.',
    auth: 'staff',
    successStatus: 200,
    request: createDownloadLinkRequestSchema,
    response: createDownloadLinkResponseSchema,
  },

  // Website — lead intake
  {
    operationId: 'createLead',
    method: 'POST',
    path: '/api/v1/website/leads',
    summary: 'Create a lead draft with attribution.',
    auth: 'website',
    successStatus: 201,
    request: createLeadRequestSchema,
    response: createLeadResponseSchema,
  },
  {
    operationId: 'updateLead',
    method: 'PATCH',
    path: '/api/v1/website/leads/{leadId}',
    summary: 'Resume and update a draft.',
    auth: 'website',
    successStatus: 200,
    request: updateLeadRequestSchema,
    response: updateLeadResponseSchema,
    headers: [DRAFT_GRANT],
  },
  {
    operationId: 'readLead',
    method: 'GET',
    path: '/api/v1/website/leads/{leadId}',
    summary: 'Read an unfinished draft with its scoped grant.',
    auth: 'website',
    successStatus: 200,
    response: readLeadResponseSchema,
    headers: [DRAFT_GRANT],
  },

  // Website — plans
  {
    operationId: 'listWebsitePlans',
    method: 'GET',
    path: '/api/v1/website/plans',
    summary: "List the site's active plans with their website-visible values, for its storefront.",
    auth: 'website',
    successStatus: 200,
    query: listWebsitePlansQuerySchema,
    response: listWebsitePlansResponseSchema,
  },

  // Website — customer documents
  {
    operationId: 'createWebsiteLeadIdentityUpload',
    method: 'POST',
    path: '/api/v1/website/leads/{leadId}/identity/uploads',
    summary:
      "Authorise the upload of a recent mobility lead's licence photo for the credit check (leads:write).",
    auth: 'website',
    successStatus: 201,
    request: createIdentityUploadRequestSchema,
    response: createUploadIntentResponseSchema,
  },
  {
    operationId: 'submitWebsiteLeadIdentity',
    method: 'POST',
    path: '/api/v1/website/leads/{leadId}/identity',
    summary:
      'Record the credit-check identity of a recent mobility lead: its verified licence photo, or a SIN, stored sealed (leads:write).',
    auth: 'website',
    successStatus: 201,
    request: submitLeadIdentityRequestSchema,
    response: submitLeadIdentityResponseSchema,
  },
  {
    operationId: 'createUploadIntent',
    method: 'POST',
    path: '/api/v1/website/uploads/intents',
    summary: 'Authorise a direct-to-storage document upload.',
    auth: 'website',
    successStatus: 201,
    request: createUploadIntentRequestSchema,
    response: createUploadIntentResponseSchema,
    headers: [DRAFT_GRANT],
  },
  {
    operationId: 'finalizeUpload',
    method: 'POST',
    path: '/api/v1/website/uploads/{uploadId}/finalize',
    summary: 'Verify and attach an uploaded document by signature and checksum.',
    auth: 'website',
    successStatus: 200,
    request: finalizeUploadRequestSchema,
    response: finalizeUploadResponseSchema,
    headers: [DRAFT_GRANT],
  },
  {
    operationId: 'createDownloadLink',
    method: 'POST',
    path: '/api/v1/website/files/{fileId}/download-link',
    summary: 'Issue a short-lived signed download URL after a permission check.',
    auth: 'website',
    successStatus: 200,
    response: createDownloadLinkResponseSchema,
    headers: [DRAFT_GRANT],
  },
];
