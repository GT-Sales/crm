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
  version_conflict: 'The order changed. Reload it before applying another transition.',
  illegal_transition: 'That order status transition is not allowed.',
  cancellation_reason_required: 'A cancellation reason is required.',
  dispatch_details_required: 'A courier is required to dispatch this order.',
  documents_incomplete: 'Required documents are not yet approved for this order.',
  document_override_reason_required: 'A reason is required to override the document checklist.',
  feature_not_ready: 'This order action is not enabled yet.',
  lead_not_found: 'The lead does not exist in this workspace.',
  lead_trashed: 'The lead is in the trash. Restore it before changing it.',
  task_not_found: 'The task does not exist in this workspace.',
  assignee_not_found: 'The assignee is not an active member of this workspace.',
  reminder_not_found: 'The reminder does not exist on this order.',
  change_request_not_found: 'The change request does not exist on this order.',
  change_request_resolved: 'This change request has already been resolved.',
  invalid_request: 'The request body is invalid.',
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
