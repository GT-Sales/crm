import { BackendError } from './api';

/**
 * Every error a staff user sees, in plain words: what went wrong and what to
 * do next. A screen passes the thing that failed (a `BackendError`, a
 * `TypeError` from `fetch`, a timeout's `DOMException`, or only the code it
 * kept) and a short phrase for what it was doing ("save the change", "load the
 * leads"). The one code-like string a message may carry is the request's
 * reference, so support can find it in the logs.
 */
export type ErrorKind =
  /** The CRM could not be reached: no network, a timeout, or the edge answered 502/503/504. */
  | 'offline'
  /** The CRM answered with a failure of its own (`internal_error`, any other 5xx). */
  | 'server'
  /** The sign-in is missing or no longer valid. */
  | 'session'
  /** The person's roles, membership or site do not allow it. */
  | 'permission'
  /** A refusal the CRM explains with a code this file has words for. */
  | 'known'
  /** Anything else; it reads as the `server` sentence, never as the raw code. */
  | 'unknown';

const OFFLINE_STATUSES = new Set([0, 502, 503, 504]);
const SERVER_CODES = new Set(['internal_error', 'persistence_unavailable']);
const SESSION_CODES = new Set(['missing_session', 'invalid_session']);
const PERMISSION_CODES = new Set([
  'permission_denied',
  'membership_missing',
  'membership_pending',
  'membership_revoked',
  'workspace_not_found',
  'scope_denied',
  'caller_forbidden',
  'export_denied',
]);

const TRY_AGAIN = 'Try again in a minute; if it keeps happening, tell your admin.';
const RELOAD = 'Reload the page to see the latest, then try again.';

/**
 * Words for every refusal a staff user can meet. A function gets the action
 * phrase for messages that read better with it. Codes listed here are `known`;
 * the session and permission codes have their own sentences below.
 */
const KNOWN: Record<string, string | ((action: string) => string)> = {
  // Requests and records
  invalid_request: (action) =>
    `The CRM couldn't ${action} because the request wasn't complete. Reload the page and try again.`,
  validation_error: (action) =>
    `Some of the details aren't valid, so the CRM couldn't ${action}. Check the fields and try again.`,
  not_found: `This item no longer exists. It may have been deleted; ${RELOAD.toLowerCase()}`,
  conflict: `Something else changed at the same time. ${RELOAD}`,
  version_conflict: `Someone else changed this while you were editing. ${RELOAD}`,
  revision_conflict: `Someone else changed this while you were editing. ${RELOAD}`,
  rate_limited: 'Too many requests in a short time. Wait a minute, then try again.',
  payload_too_large: 'That is too much to send at once. Make it smaller and try again.',
  feature_not_ready: 'This part of the CRM is not switched on for this site yet. Ask the owner.',
  idempotency_in_progress:
    'The CRM is still finishing your last request. Wait a few seconds, then reload the page.',
  idempotency_conflict: `This request clashes with one sent a moment ago. ${RELOAD}`,

  // Leads
  lead_not_found: 'This lead no longer exists. Go back to the leads list and reload it.',
  lead_trashed: 'This lead is archived. Restore it first, then try again.',
  illegal_stage_move:
    'A lead of this type cannot move to that stage from where it is. Pick one of the stages offered.',
  illegal_transition:
    'That change is not allowed from where this lead is now. Reload the page and pick another option.',
  dispatch_details_required:
    'Add the courier and tracking number before moving this order to that stage.',
  activation_details_required: 'Add the activation date before moving this order to that stage.',
  documents_incomplete:
    'Some required documents are missing or not approved yet. Approve them on the Documents card, then try again.',
  document_override_reason_required: 'Write a reason for moving on without the documents.',
  documents_override_not_allowed:
    'Only the owner or someone with the Orders role can move on without the documents. Ask them to do it.',
  cancellation_reason_required: 'Write a reason for cancelling, then try again.',
  external_ref_taken: 'Another lead already has that order number. Use a different one.',
  lead_id_taken: 'A lead with this id already exists. Reload the page.',
  export_too_large:
    'Too many leads to export at once. Narrow the list with filters, or pick fewer leads, and try again.',
  task_not_found: `This task no longer exists. ${RELOAD}`,
  assignee_not_found:
    'That person is no longer on this site team. Pick someone else from the list.',
  reminder_not_found: `This reminder no longer exists. ${RELOAD}`,
  identity_not_found: `This identity check no longer exists. ${RELOAD}`,
  identity_limit_reached: 'This lead already has the most identity checks it can hold.',

  // Change requests
  change_request_not_found: `This change request no longer exists. ${RELOAD}`,
  change_request_resolved: `Someone already decided this change request. ${RELOAD}`,
  change_request_not_allowed: 'This order can no longer be changed at the stage it is in.',

  // Documents and files
  download_denied: "You can't open this file. Ask the owner if you need access.",
  file_not_found: `This file no longer exists. ${RELOAD}`,
  file_not_available:
    'This file is not ready yet, or it was removed. Wait a minute and reload the page.',
  upload_not_found: 'The upload was not found. Try uploading the file again.',
  upload_invalid: 'The file could not be checked. Try uploading it again.',
  upload_expired: 'The upload took too long. Try uploading the file again.',
  unsupported_media_type: 'That kind of file is not accepted. Use a PDF, JPEG or PNG.',
  document_too_large: 'That file is too large. Use a smaller file and try again.',
  document_verification_failed: 'The file could not be verified. Try uploading it again.',
  verification_in_progress: 'The file is still being checked. Wait a minute and reload the page.',
  checklist_mismatch: `The documents list changed while you were working. ${RELOAD}`,

  // Plans
  plan_not_found: `This plan no longer exists. ${RELOAD}`,
  plan_not_available: 'That plan is switched off. Pick an active plan.',
  plan_name_taken: 'Another plan already has that name. Choose a different name.',
  plan_limit: 'This site has as many plans as it can hold. Switch off one you no longer sell.',

  // Properties and layouts
  property_not_found: `This property no longer exists. ${RELOAD}`,
  property_limit:
    'This site has as many custom properties as it can hold. Delete one you no longer use first.',
  builtin_property_locked: 'Built-in properties cannot be changed that way.',
  property_option_in_use:
    'Some leads still use that option. Change those leads first, then remove the option.',
  property_in_use: 'Some leads still use this property. Clear it on those leads first.',
  unknown_property_key: `A property on this screen no longer exists. ${RELOAD}`,

  // Saved views
  saved_view_not_found: `This saved view no longer exists. ${RELOAD}`,
  saved_view_name_taken: 'You already have a saved view with that name. Choose a different name.',
  saved_view_limit: 'You have as many saved views as you can keep. Delete one you no longer use.',

  // Team
  membership_not_found: `This team member is no longer on the site. ${RELOAD}`,
  membership_conflict: 'That person is already on this site team, or already invited.',

  // Website keys
  credential_not_found: `This key no longer exists. ${RELOAD}`,
  credential_revoked: 'This key was already revoked.',

  // Jobs
  job_not_found: `This job no longer exists. ${RELOAD}`,
  job_not_retryable: 'This job cannot be retried in the state it is in now. Reload the page.',
  job_not_uncertain: 'This job is no longer waiting for a decision. Reload the page.',

  // Email
  invalid_fill_in: 'The email uses a fill-in this template does not allow. Fix it and try again.',
  invalid_email_markup: 'The email text has formatting the CRM cannot read. Fix it and try again.',
  email_template_not_found: `This email template no longer exists. ${RELOAD}`,
  email_template_builtin: 'Built-in email templates cannot be archived or restored.',
  email_template_limit_reached:
    'This site has as many email templates as it can hold. Archive one you no longer use first.',

  // Automations
  automation_not_found: `This automation no longer exists. ${RELOAD}`,
  automation_limit_reached:
    'This site has as many automations as it can hold. Archive one you no longer use first.',
  automation_builtin: 'Built-in automations cannot be archived.',
  automation_not_builtin: 'Only built-in automations can be reset.',
  automation_archived: 'This automation is archived. Restore it first.',
  automation_version_not_found: `This version of the automation no longer exists. ${RELOAD}`,
  automation_run_not_found: `This automation run no longer exists. ${RELOAD}`,
  no_active_version: 'This automation has nothing to switch on yet. Activate a version first.',
  activation_needs_lead_manage:
    'This automation changes leads, so only someone who can manage leads can switch it on.',
  flow_invalid: 'The automation has steps that need fixing. Fix the steps marked, then try again.',
  intake_check_off: 'The intake check is switched off for this deployment.',

  // Assistant
  ai_unavailable: 'The assistant is not available on this site right now. Ask the owner.',
  ai_rate_limited: 'The assistant has had too many requests. Wait a minute, then try again.',

  // Tracking
  tracking_expired: 'The tracking session expired. Start again.',
};

const PERMISSION_TEXT: Record<string, string> = {
  membership_missing: "You aren't on this site's team. Ask the owner to invite you.",
  membership_pending:
    'Your invitation to this site is not accepted yet. Accept it, then sign in again.',
  membership_revoked: 'Your access to this site was removed. Ask the owner if you need it back.',
  workspace_not_found:
    "This site isn't available to your account. Pick another site, or ask the owner to add you.",
};

interface ErrorFacts {
  code: string | undefined;
  status: number | undefined;
  requestId: string | undefined;
  network: boolean;
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'NetworkError'
    );
  }
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'NetworkError')
  );
}

function facts(error: unknown): ErrorFacts {
  if (error instanceof BackendError) {
    // Read defensively: a stand-in error (tests, an older client) may lack a field.
    const { code, status, requestId }: { code?: unknown; status?: unknown; requestId?: unknown } =
      error;
    return {
      code: typeof code === 'string' ? code : undefined,
      status: typeof status === 'number' ? status : undefined,
      requestId: typeof requestId === 'string' ? requestId : undefined,
      network: false,
    };
  }
  if (typeof error === 'string') {
    return { code: error, status: undefined, requestId: undefined, network: false };
  }
  return {
    code: undefined,
    status: undefined,
    requestId: undefined,
    network: isNetworkFailure(error),
  };
}

/** Which of the six kinds `error` is (see `ErrorKind`). A bare code string is read as that code. */
export function errorKind(error: unknown): ErrorKind {
  const { code, status, network } = facts(error);
  if (network) return 'offline';
  if (status !== undefined && OFFLINE_STATUSES.has(status)) return 'offline';
  if (code === undefined) return 'unknown';
  if (SESSION_CODES.has(code)) return 'session';
  if (PERMISSION_CODES.has(code)) return 'permission';
  if (SERVER_CODES.has(code)) return 'server';
  if (Object.hasOwn(KNOWN, code)) return 'known';
  if (status !== undefined && status >= 500) return 'server';
  return 'unknown';
}

/** The request's short reference for support, or nothing. */
function reference(requestId: string | undefined): string {
  return requestId && requestId.length > 0 ? ` (Ref: ${requestId.slice(0, 8)})` : '';
}

/**
 * One full sentence (or two) for `error`, about `action`: a short phrase that
 * fits "couldn't …", such as "save the change" or "load the leads".
 */
export function describeError(error: unknown, action: string): string {
  const kind = errorKind(error);
  const { code, requestId } = facts(error);
  const known = kind === 'known' && code !== undefined ? KNOWN[code] : undefined;
  if (known !== undefined) return typeof known === 'function' ? known(action) : known;
  switch (kind) {
    case 'offline':
      return `Couldn't reach the CRM to ${action}. Check your internet connection and try again.`;
    case 'session':
      return 'Your sign-in has expired. Sign in again to continue.';
    case 'permission':
      return (
        (code !== undefined ? PERMISSION_TEXT[code] : undefined) ??
        `You don't have permission to ${action}. Ask the owner to give your role access.`
      );
    case 'known':
    case 'server':
    case 'unknown':
      return `The CRM had a problem and couldn't ${action}. ${TRY_AGAIN}${reference(requestId)}`;
  }
}

/** True when trying the same thing again may work: the CRM was unreachable or failed on its side. */
export function isRetryable(error: unknown): boolean {
  const kind = errorKind(error);
  return kind === 'offline' || kind === 'server' || kind === 'unknown';
}

/** The parts of a zod issue this file reads; kept structural so the admin needs no zod import. */
export interface ValidationIssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly origin?: string;
  readonly maximum?: number | bigint;
  readonly minimum?: number | bigint;
}

function fieldLabel(
  path: readonly PropertyKey[],
  labels: Readonly<Record<string, string>>,
): string {
  const keys = path.filter((part) => typeof part !== 'symbol').map(String);
  for (let length = keys.length; length > 0; length -= 1) {
    const label = labels[keys.slice(0, length).join('.')];
    if (label) return label;
  }
  for (const key of [...keys].reverse()) {
    const label = labels[key];
    if (label) return label;
  }
  return 'One of the fields';
}

function limitText(value: number | bigint | undefined): string | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-CA').format(number) : undefined;
}

function plural(count: string, one: string, many: string): string {
  return count === '1' ? one : many;
}

/**
 * The first problem a form's own check (a zod `safeParse`) found, as one
 * sentence that names the field and, where there is one, the limit: "Name can
 * be at most 120 characters." `labels` maps a field's path (`name`,
 * `options.0.label`, or any one key of it) to the label on screen.
 */
export function describeInvalid(
  error: { readonly issues: readonly ValidationIssueLike[] },
  labels: Readonly<Record<string, string>>,
): string {
  const issue = error.issues[0];
  if (!issue) return 'Some of the details are not valid. Check the fields and try again.';
  const field = fieldLabel(issue.path, labels);
  const isText = issue.origin === 'string';
  const isList = issue.origin === 'array' || issue.origin === 'set';
  if (issue.code === 'too_big') {
    const max = limitText(issue.maximum);
    if (max !== undefined) {
      if (isText)
        return `${field} can be at most ${max} ${plural(max, 'character', 'characters')}.`;
      if (isList) return `${field} can have at most ${max} ${plural(max, 'entry', 'entries')}.`;
      return `${field} can be at most ${max}.`;
    }
  }
  if (issue.code === 'too_small') {
    const min = limitText(issue.minimum);
    if (isText && (min === undefined || min === '1')) return `${field} can't be empty. Fill it in.`;
    if (min !== undefined) {
      if (isText)
        return `${field} needs at least ${min} ${plural(min, 'character', 'characters')}.`;
      if (isList) return `${field} needs at least ${min} ${plural(min, 'entry', 'entries')}.`;
      return `${field} must be at least ${min}.`;
    }
  }
  if (issue.code === 'invalid_type')
    return `${field} is missing or not filled in correctly. Check it and try again.`;
  if (issue.code === 'invalid_format')
    return `${field} isn't in the right format. Check it and try again.`;
  if (issue.code === 'not_multiple_of') return `${field} must be a whole number.`;
  return `${field} isn't valid. Check it and try again.`;
}
