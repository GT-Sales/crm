import type { ApiErrorCode } from '@gt-sales/contracts';
import type { Response } from 'express';

/**
 * Only the codes actually used by a website route so far (plus the shared
 * `internal_error`). Extend alongside the route that first needs a new one —
 * this is not meant to pre-declare every code in `apiErrorCodeSchema`.
 */
const messages: Partial<Record<ApiErrorCode, string>> = {
  validation_error: 'The request body is invalid.',
  draft_not_found: 'No draft grant matches this lead.',
  draft_expired: 'The draft grant has expired or been revoked.',
  draft_already_submitted: 'This draft has been submitted and can no longer be edited.',
  offer_unavailable: 'The selected offer is not currently available.',
  region_not_served: 'The selected plan is not sold in the chosen province.',
  unpriced_lead_required: 'Current pricing could not be verified. Save an unpriced callback lead.',
  priced_checkout_disabled: 'Priced checkout is disabled until the withdrawal policy is confirmed.',
  idempotency_conflict: 'This idempotency key was already used with a different request.',
  idempotency_in_progress:
    'A request with this idempotency key is still being processed. Retry shortly.',
  quote_not_found: 'The quote does not exist for this draft.',
  quote_expired: 'The quote has expired. Request a new quote and confirm it.',
  quote_withdrawn: 'The quoted offer was withdrawn before submission.',
  quote_consumed: 'The quote has already been used.',
  terms_version_unsupported: 'The accepted terms do not match the quoted terms.',
  persistence_unavailable: 'The order could not be saved. Retry with the same idempotency key.',
  order_not_found: 'The order does not exist in this workspace.',
  job_not_found: 'The job does not exist in this workspace.',
  job_not_retryable: 'Only definitively failed jobs can be retried.',
  job_not_uncertain: 'Only jobs with an uncertain outcome can be resolved.',
  version_conflict: 'It changed since you loaded it. Reload it before changing it again.',
  illegal_transition: 'That order status transition is not allowed.',
  cancellation_reason_required: 'A cancellation reason is required.',
  dispatch_details_required: 'A courier is required to dispatch this order.',
  illegal_stage_move:
    'That stage move is not allowed; `details.allowed` lists the moves from this stage.',
  activation_details_required: 'An activation date is required to activate this order.',
  documents_override_not_allowed:
    'Only the site owner or an Orders member can override the documents check.',
  documents_incomplete: 'Required documents are not yet approved for this order.',
  document_override_reason_required: 'A reason is required to override the document checklist.',
  feature_not_ready: 'This action is not enabled for this site yet.',
  conflict: 'The lead lacks what this needs; `details` names the missing part.',
  lead_not_found: 'The lead does not exist in this workspace.',
  lead_trashed: 'The lead is archived. Restore it before changing it.',
  task_not_found: 'The task does not exist in this workspace.',
  assignee_not_found: 'The assignee is not an active member of this workspace.',
  reminder_not_found: 'The reminder does not exist on this order.',
  change_request_not_found: 'The change request does not exist on this order.',
  change_request_resolved: 'This change request has already been resolved.',
  change_request_not_allowed: 'This order can no longer be changed online.',
  external_ref_taken: 'Another lead already has this reference.',
  tracking_challenge_invalid: 'The code is wrong or has expired. Request a new code.',
  invalid_request: 'The request body is invalid.',
  invalid_fill_in: 'The email uses a fill-in that does not exist; `details` names it and where.',
  invalid_email_markup: 'The email markup is invalid; `details` gives the reason.',
  not_found: 'There is nothing at this address.',
  internal_error: 'An internal error occurred.',
  upload_not_found: 'The upload does not exist for this draft.',
  upload_expired: 'The upload authorisation has expired. Request a new upload.',
  checklist_mismatch: 'That document type is not on this offer’s checklist.',
  document_too_large: 'The document exceeds the 10 MB limit.',
  document_verification_failed: 'The uploaded file failed signature or checksum verification.',
  verification_in_progress: 'This upload is already being verified. Retry shortly.',
  file_not_found: 'The document does not exist in this workspace.',
  file_not_available: 'The document is not available for download.',
  download_denied: 'You do not have permission to download this document.',
  property_not_found: 'The property does not exist on this site.',
  property_limit: 'This site already has the most custom properties it may have.',
  builtin_property_locked: 'A built-in property can only be relabelled or hidden.',
  property_option_in_use:
    'Leads still hold this option; `details` names it and how many (active, trashed, restricted).',
  property_in_use:
    'Leads still hold a value for this property; `details` says how many (active, trashed, restricted).',
  unknown_property_key: 'The layout names a property this site does not have; `details` names it.',
  saved_view_not_found: 'You have no saved view with this id on this site.',
  saved_view_name_taken: 'You already have a saved view with this name.',
  saved_view_limit: 'You have reached the most saved views you can keep on this site.',
  plan_not_found: 'The plan does not exist on this site.',
  plan_name_taken: 'This site already has a plan of this type by this name.',
  plan_limit: 'This site already has the most plans it may have.',
  automation_not_found: 'No automation rule with this key on this site.',
  plan_not_available: 'The chosen plan is not available on this site for this kind of order.',
  intake_check_off: 'The intake check is off on this deployment.',
  automation_limit_reached: 'This site already has 50 flows. Archive one first.',
  revision_conflict: 'Someone else changed this flow. Reload to see their changes.',
  flow_invalid: 'The flow is not ready to be activated.',
  no_active_version: 'Activate the flow before switching it on.',
  automation_not_builtin: 'Only a built-in flow can be reset to its default.',
  automation_builtin: 'A built-in flow cannot be archived; switch it off instead.',
  activation_needs_lead_manage:
    'Activating a flow that changes leads needs the Leads permission too.',
  automation_version_not_found: 'This flow has no version with this number.',
  automation_run_not_found: 'This flow has no run with this id.',
  automation_archived: 'This flow is archived. Restore it first.',
  email_template_not_found: 'No email template with this key on this site.',
  email_template_builtin: 'A built-in email template cannot be archived.',
  email_template_limit_reached:
    'This site already has 50 email templates of its own. Archive one first.',
};

export function sendDomainError(
  res: Response,
  requestId: string,
  code: ApiErrorCode,
  status: number,
  details?: Record<string, unknown>,
): void {
  res.status(status).json({
    error: { code, message: messages[code] ?? 'Request failed.', requestId, details },
  });
}
