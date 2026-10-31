import type { z } from 'zod';

import {
  createDownloadLinkRequestSchema,
  createDownloadLinkResponseSchema,
  reviewFileRequestSchema,
  reviewFileResponseSchema,
} from './files';
import {
  activateFlowRequestSchema,
  createFlowRequestSchema,
  flowCatalogResponseSchema,
  flowDetailResponseSchema,
  flowListQuerySchema,
  flowListResponseSchema,
  flowRunResponseSchema,
  flowToggleResponseSchema,
  flowVersionResponseSchema,
  listFlowRunsQuerySchema,
  listFlowRunsResponseSchema,
  saveFlowDraftRequestSchema,
  toggleFlowRequestSchema,
  updateFlowDetailsRequestSchema,
} from './automation-api';
import {
  createEmailTemplateRequestSchema,
  siteEmailTemplateResponseSchema,
  emailSettingsResponseSchema,
  emailTemplateResponseSchema,
  listEmailTemplatesResponseSchema,
  previewEmailTemplateRequestSchema,
  previewEmailTemplateResponseSchema,
  sendTestEmailResponseSchema,
  updateEmailSettingsRequestSchema,
  updateEmailTemplateRequestSchema,
} from './customer-email';
import {
  IDEMPOTENCY_KEY_HEADER,
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
  resolveChangeRequestRequestSchema,
  resolveChangeRequestResponseSchema,
} from './lead-work';
import {
  TRACKING_GRANT_HEADER,
  createTrackedChangeRequestSchema,
  trackedChangeResponseSchema,
  trackingCodeRequestSchema,
  trackingCodeResponseSchema,
  trackingOrdersResponseSchema,
  trackingUploadIntentRequestSchema,
  trackingVerifyRequestSchema,
  trackingVerifyResponseSchema,
} from './tracking';
import { createCustomPropertySchema, updatePropertySchema } from './properties';
import {
  deletePropertyResponseSchema,
  propertyLayoutResponseSchema,
  propertyModelResponseSchema,
  propertyObjectQuerySchema,
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
import { sourceReportQuerySchema, sourceReportResponseSchema } from './reports';
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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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

const CUSTOMER_GRANT: EndpointHeader = {
  name: TRACKING_GRANT_HEADER,
  required: true,
  description: 'The 30-minute grant from verifyTrackingCode, bound to this site and email.',
};

const IDEMPOTENCY_KEY: EndpointHeader = {
  name: IDEMPOTENCY_KEY_HEADER,
  required: false,
  description:
    'Optional; with submit, a retry with the same key and body within 24 hours returns the lead already created (replayed: true).',
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
      'List leads with filters (type, stage, assignee, search, archive, follow-ups due) and attribution.',
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
      'Count active leads per type (unopened ones, and with `dueBy` those with a follow-up due), and the archive.',
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
    operationId: 'getWorkspaceSourceReport',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/reports/sources',
    summary:
      'Leads per source for one lead type: received, submitted and made it, over 7, 30 or 90 days or all time.',
    auth: 'staff',
    successStatus: 200,
    query: sourceReportQuerySchema,
    response: sourceReportResponseSchema,
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
    operationId: 'approveLeadChangeRequest',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/change-requests/{changeRequestId}/approve',
    summary:
      "Apply the customer's pending change request to the lead and email them (lead management).",
    auth: 'staff',
    successStatus: 200,
    request: resolveChangeRequestRequestSchema,
    response: resolveChangeRequestResponseSchema,
  },
  {
    operationId: 'rejectLeadChangeRequest',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/change-requests/{changeRequestId}/reject',
    summary:
      "Turn down the customer's pending change request, discard its files and email them (lead management).",
    auth: 'staff',
    successStatus: 200,
    request: resolveChangeRequestRequestSchema,
    response: resolveChangeRequestResponseSchema,
  },
  {
    operationId: 'archiveWorkspaceLead',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/archive',
    summary: 'Archive a lead; it can be restored (lead management).',
    auth: 'staff',
    successStatus: 200,
    response: leadTrashResponseSchema,
  },
  {
    operationId: 'trashWorkspaceLead',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/leads/{leadId}/trash',
    summary: 'Deprecated alias of archiveWorkspaceLead (lead management).',
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
    summary: 'Bring a lead back from the archive (lead management).',
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
    query: propertyObjectQuerySchema,
    response: propertyModelResponseSchema,
  },
  {
    operationId: 'createProperty',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties',
    summary: 'Add a custom property (property management).',
    auth: 'staff',
    successStatus: 201,
    query: propertyObjectQuerySchema,
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
    query: propertyObjectQuerySchema,
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
    query: propertyObjectQuerySchema,
    response: deletePropertyResponseSchema,
  },
  {
    operationId: 'savePropertyLayout',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/properties/layouts/{leadType}',
    summary:
      'Save the record layout of one lead type, or with `object=plan` the plan record layout (no lead type in the path) (property management).',
    auth: 'staff',
    successStatus: 200,
    query: propertyObjectQuerySchema,
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

  // Staff — customer email and automations
  {
    operationId: 'getEmailSettings',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/settings',
    summary:
      "Read the site's email sender and look, or the deployment's sender while none is saved.",
    auth: 'staff',
    successStatus: 200,
    response: emailSettingsResponseSchema,
  },
  {
    operationId: 'updateEmailSettings',
    method: 'PUT',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/settings',
    summary: "Save the site's email sender and look (integration management).",
    auth: 'staff',
    successStatus: 200,
    request: updateEmailSettingsRequestSchema,
    response: emailSettingsResponseSchema,
  },
  {
    operationId: 'listEmailTemplates',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates',
    summary: "List the site's nine email templates, starter text where none is saved.",
    auth: 'staff',
    successStatus: 200,
    response: listEmailTemplatesResponseSchema,
  },
  {
    operationId: 'updateEmailTemplate',
    method: 'PUT',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates/{key}',
    summary:
      "Save a template's subject and body against the version the editor loaded (integration management).",
    auth: 'staff',
    successStatus: 200,
    request: updateEmailTemplateRequestSchema,
    response: emailTemplateResponseSchema,
  },
  {
    operationId: 'previewEmailTemplate',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates/{key}/preview',
    summary: 'Render an unsaved subject and body with sample values (integration management).',
    auth: 'staff',
    successStatus: 200,
    request: previewEmailTemplateRequestSchema,
    response: previewEmailTemplateResponseSchema,
  },
  {
    operationId: 'sendTestEmail',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates/{key}/test',
    summary: 'Queue the saved template to the caller as a test (integration management).',
    auth: 'staff',
    successStatus: 202,
    response: sendTestEmailResponseSchema,
  },
  {
    operationId: 'createEmailTemplate',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates',
    summary: 'Create a site-made email template (integration management).',
    auth: 'staff',
    successStatus: 201,
    request: createEmailTemplateRequestSchema,
    response: siteEmailTemplateResponseSchema,
  },
  {
    operationId: 'archiveEmailTemplate',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates/{key}/archive',
    summary: 'Archive a site-made email template (integration management).',
    auth: 'staff',
    successStatus: 200,
    response: siteEmailTemplateResponseSchema,
  },
  {
    operationId: 'restoreEmailTemplate',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/email/templates/{key}/restore',
    summary: 'Restore an archived site-made email template (integration management).',
    auth: 'staff',
    successStatus: 200,
    response: siteEmailTemplateResponseSchema,
  },
  {
    operationId: 'listAutomations',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations',
    summary:
      "List the site's flows (the six built-ins seeded first) with their overlap warnings, or a page of the archived ones.",
    auth: 'staff',
    successStatus: 200,
    query: flowListQuerySchema,
    response: flowListResponseSchema,
  },
  {
    operationId: 'updateAutomation',
    method: 'PUT',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}',
    summary:
      'Switch a flow on or off (integration management); on needs an active version, off cancels its waiting runs.',
    auth: 'staff',
    successStatus: 200,
    request: toggleFlowRequestSchema,
    response: flowToggleResponseSchema,
  },
  {
    operationId: 'listAutomationRuns',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/runs',
    summary: "List a flow's runs, newest first, with each step's outcome.",
    auth: 'staff',
    successStatus: 200,
    query: listFlowRunsQuerySchema,
    response: listFlowRunsResponseSchema,
  },
  {
    operationId: 'createAutomation',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations',
    summary: 'Create a custom flow with an empty draft (integration management).',
    auth: 'staff',
    successStatus: 201,
    request: createFlowRequestSchema,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'getAutomationCatalog',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/catalog',
    summary:
      'What a flow may name on this site: lead types and stages, templates, members, plans and properties.',
    auth: 'staff',
    successStatus: 200,
    response: flowCatalogResponseSchema,
  },
  {
    operationId: 'getAutomation',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}',
    summary:
      'Read one flow: its draft with the site warnings, its active definition and its versions.',
    auth: 'staff',
    successStatus: 200,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'updateAutomationDetails',
    method: 'PATCH',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}',
    summary: 'Rename a flow or change its description (integration management).',
    auth: 'staff',
    successStatus: 200,
    request: updateFlowDetailsRequestSchema,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'saveAutomationDraft',
    method: 'PUT',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/draft',
    summary: "Save a flow's draft against the revision the editor loaded (integration management).",
    auth: 'staff',
    successStatus: 200,
    request: saveFlowDraftRequestSchema,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'discardAutomationDraft',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/draft/discard',
    summary: "Discard a flow's draft (integration management).",
    auth: 'staff',
    successStatus: 200,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'activateAutomation',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/activate',
    summary:
      "Make a flow's draft its active version (integration management; lead management too for a flow that changes leads).",
    auth: 'staff',
    successStatus: 200,
    request: activateFlowRequestSchema,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'resetAutomation',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/reset',
    summary: "Replace a built-in flow's draft with its default (integration management).",
    auth: 'staff',
    successStatus: 200,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'archiveAutomation',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/archive',
    summary: 'Switch a custom flow off and archive it (integration management).',
    auth: 'staff',
    successStatus: 200,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'restoreAutomation',
    method: 'POST',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/restore',
    summary: 'Restore an archived custom flow, off (integration management).',
    auth: 'staff',
    successStatus: 200,
    response: flowDetailResponseSchema,
  },
  {
    operationId: 'getAutomationVersion',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/versions/{version}',
    summary: 'Read one version of a flow, its definition as stored.',
    auth: 'staff',
    successStatus: 200,
    response: flowVersionResponseSchema,
  },
  {
    operationId: 'getAutomationRun',
    method: 'GET',
    path: '/api/v1/staff/workspaces/{workspaceId}/automations/{key}/runs/{runId}',
    summary: "Read one run of a flow with every step's outcome.",
    auth: 'staff',
    successStatus: 200,
    response: flowRunResponseSchema,
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
    headers: [IDEMPOTENCY_KEY],
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
    headers: [DRAFT_GRANT, IDEMPOTENCY_KEY],
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

  // Website — customer order tracking (the `tracking` scope)
  {
    operationId: 'requestTrackingCode',
    method: 'POST',
    path: '/api/v1/website/tracking/code',
    summary:
      'Email a six-digit tracking code; the answer is the same whether or not the email has orders.',
    auth: 'website',
    successStatus: 200,
    request: trackingCodeRequestSchema,
    response: trackingCodeResponseSchema,
  },
  {
    operationId: 'verifyTrackingCode',
    method: 'POST',
    path: '/api/v1/website/tracking/verify',
    summary: 'Trade a tracking code for a 30-minute grant bound to this site and email.',
    auth: 'website',
    successStatus: 200,
    request: trackingVerifyRequestSchema,
    response: trackingVerifyResponseSchema,
  },
  {
    operationId: 'listTrackedOrders',
    method: 'GET',
    path: '/api/v1/website/tracking/orders',
    summary: "List the verified email's submitted orders on this site, newest first.",
    auth: 'customer',
    successStatus: 200,
    response: trackingOrdersResponseSchema,
    headers: [CUSTOMER_GRANT],
  },
  {
    operationId: 'createTrackedOrderChange',
    method: 'POST',
    path: '/api/v1/website/tracking/orders/{reference}/changes',
    summary: "Ask for a change to one of the verified email's SIM orders, for staff to decide.",
    auth: 'customer',
    successStatus: 201,
    request: createTrackedChangeRequestSchema,
    response: trackedChangeResponseSchema,
    headers: [CUSTOMER_GRANT],
  },
  {
    operationId: 'createTrackedOrderUpload',
    method: 'POST',
    path: '/api/v1/website/tracking/orders/{reference}/uploads/intents',
    summary: 'Authorise a passport or visa upload for the order’s pending change request.',
    auth: 'customer',
    successStatus: 201,
    request: trackingUploadIntentRequestSchema,
    response: createUploadIntentResponseSchema,
    headers: [CUSTOMER_GRANT],
  },
  {
    operationId: 'finalizeTrackedOrderUpload',
    method: 'POST',
    path: '/api/v1/website/tracking/orders/{reference}/uploads/{uploadId}/finalize',
    summary: 'Verify the uploaded document and add it to the order’s pending change request.',
    auth: 'customer',
    successStatus: 200,
    request: finalizeUploadRequestSchema,
    response: trackedChangeResponseSchema,
    headers: [CUSTOMER_GRANT],
  },
];
