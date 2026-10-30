import { z } from 'zod';

/**
 * Shared scalar schemas and the canonical error envelope for every `/api/v1`
 * family. Defined once here so leads, quotes, orders, uploads, partners,
 * webhooks, exports and tracking never re-declare a `uuid`, an ISO timestamp,
 * a currency amount or an error shape (REQ 50 / PLATFORM_CONTEXT.md §4a).
 *
 * This module imports nothing from the family files, so it can be the base of
 * the dependency graph without a cycle.
 */

/** A server-generated request identifier, echoed in every response and error. */
export const requestIdSchema = z.uuid();
export type RequestId = z.infer<typeof requestIdSchema>;

/** ISO-8601 UTC timestamp, e.g. `2026-09-14T00:00:00.000Z`. */
export const isoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** ISO-4217 currency code, upper-case, e.g. `CAD`. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'ISO-4217 currency code');
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** ISO-3166-1 alpha-2 country code, upper-case, e.g. `BD`. Customers are international. */
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO-3166-1 alpha-2 country code');
export type CountryCode = z.infer<typeof countryCodeSchema>;

export const emailSchema = z.email().max(254);
export type Email = z.infer<typeof emailSchema>;

/**
 * A money amount in integer minor units plus its currency (PLATFORM_CONTEXT.md
 * §4 — "integer minor-unit amounts"). Never a float. Signed so a charge
 * component can be a discount.
 */
export const moneySchema = z.object({
  amountMinor: z.int(),
  currency: currencyCodeSchema,
});
export type Money = z.infer<typeof moneySchema>;

/** Free-form structured context attached to an error. Never carries PII (invariant 12). */
export const errorDetailsSchema = z.record(z.string(), z.unknown());
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

/**
 * Domain error codes for the `/api/v1` request families beyond authentication.
 * The auth codes (staff / website / machine) live in `staff-auth.ts` and
 * `website-auth.ts`; `apiErrorCodeSchema` there unions both sets so one
 * envelope covers every caller. Codes already owned by the auth sets
 * (`internal_error`, `rate_limited`, `payload_too_large`) are not repeated.
 */
export const domainErrorCodeSchema = z.enum([
  'validation_error',
  'not_found',
  'conflict',
  'idempotency_conflict',
  'draft_not_found',
  'draft_expired',
  'draft_already_submitted',
  'offer_unavailable',
  'region_not_served',
  'unpriced_lead_required',
  'priced_checkout_disabled',
  'quote_not_found',
  'quote_expired',
  'quote_withdrawn',
  'quote_consumed',
  'order_not_found',
  'job_not_found',
  'job_not_retryable',
  'job_not_uncertain',
  'version_conflict',
  'illegal_transition',
  'cancellation_reason_required',
  'dispatch_details_required',
  'documents_incomplete',
  'document_override_reason_required',
  'feature_not_ready',
  'lead_not_found',
  'lead_trashed',
  'identity_not_found',
  'identity_limit_reached',
  'task_not_found',
  'assignee_not_found',
  'reminder_not_found',
  'change_request_not_found',
  'change_request_resolved',
  'change_request_not_allowed',
  'external_ref_taken',
  'persistence_unavailable',
  'terms_version_unsupported',
  'upload_not_found',
  'upload_invalid',
  'unsupported_media_type',
  'file_not_found',
  'file_not_available',
  'download_denied',
  'checklist_mismatch',
  'document_too_large',
  'document_verification_failed',
  'verification_in_progress',
  'upload_expired',
  'commission_not_found',
  'commission_state_invalid',
  'invoice_not_found',
  'invoice_conflict',
  'export_denied',
  'tracking_challenge_invalid',
  'tracking_expired',
  'tracking_attempts_exceeded',
  'webhook_rejected',
  'property_not_found',
  'property_limit',
  'builtin_property_locked',
  'property_option_in_use',
  'property_in_use',
  'unknown_property_key',
  'saved_view_not_found',
  'saved_view_name_taken',
  'saved_view_limit',
  'plan_not_available',
  'plan_not_found',
  'plan_name_taken',
  'plan_limit',
  'illegal_stage_move',
  'activation_details_required',
  'documents_override_not_allowed',
  'idempotency_in_progress',
  'invalid_fill_in',
  'invalid_email_markup',
  'automation_not_found',
]);
export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;

/**
 * A form or order payload that carries its own schema version so websites can
 * migrate at their own pace (PLATFORM_CONTEXT.md §7 — "add before removing;
 * keep old behaviour until all websites migrate"). The `payload` shape is a
 * per-plan Zod schema; this wrapper only fixes the versioning envelope.
 */
export const schemaVersionSchema = z.int().positive();
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

export function versionedFormSchema<TPayload extends z.ZodTypeAny>(payload: TPayload) {
  return z.object({
    schemaVersion: schemaVersionSchema,
    payload,
  });
}

export type VersionedForm<TPayload> = {
  schemaVersion: SchemaVersion;
  payload: TPayload;
};

/** Cursor/offset paging metadata returned by staff list endpoints. */
export const pageInfoSchema = z.object({
  page: z.int().positive(),
  pageSize: z.int().positive().max(200),
  total: z.int().nonnegative(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;
