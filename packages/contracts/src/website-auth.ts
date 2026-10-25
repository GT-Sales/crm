import { z } from 'zod';

import { websiteScopeNames } from '@gt-sales/types';

export const websiteScopeSchema = z.enum(websiteScopeNames);

/**
 * Error codes for storefront (website credential) and machine (webhook /
 * scheduler) authentication. They join the staff codes in the shared
 * `authErrorCodeSchema` so one error envelope covers every `/api/v1` caller.
 * Unknown and revoked machine identities collapse to `machine_unknown` so a
 * caller cannot distinguish "no such selector" from "revoked".
 */
export const websiteAuthErrorCodeSchema = z.enum([
  'missing_credential',
  'invalid_credential',
  'credential_revoked',
  'credential_not_found',
  'scope_denied',
  'caller_forbidden',
  'rate_limited',
  'payload_too_large',
  'machine_unknown',
  'machine_signature_invalid',
  'machine_account_mismatch',
  'machine_workspace_mismatch',
]);

export type WebsiteAuthErrorCode = z.infer<typeof websiteAuthErrorCodeSchema>;

/** A service credential's non-secret summary. The secret itself is shown once, at creation. */
export const serviceCredentialSummarySchema = z.object({
  id: z.uuid(),
  scopes: z.array(websiteScopeSchema),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

export type ServiceCredentialSummary = z.infer<typeof serviceCredentialSummarySchema>;

export const createServiceCredentialRequestSchema = z.object({
  scopes: z.array(websiteScopeSchema).min(1).max(websiteScopeNames.length),
});

export type CreateServiceCredentialRequest = z.infer<typeof createServiceCredentialRequestSchema>;

/** The plaintext `secret` appears only in this create response and is never persisted or returned again. */
export const createServiceCredentialResponseSchema = z.object({
  credential: serviceCredentialSummarySchema,
  secret: z.string().min(1),
  requestId: z.uuid(),
});

export type CreateServiceCredentialResponse = z.infer<typeof createServiceCredentialResponseSchema>;

export const listServiceCredentialsResponseSchema = z.object({
  credentials: z.array(serviceCredentialSummarySchema),
  requestId: z.uuid(),
});

export type ListServiceCredentialsResponse = z.infer<typeof listServiceCredentialsResponseSchema>;

export const revokeServiceCredentialResponseSchema = z.object({
  id: z.uuid(),
  revokedAt: z.iso.datetime(),
  requestId: z.uuid(),
});

export type RevokeServiceCredentialResponse = z.infer<typeof revokeServiceCredentialResponseSchema>;
