import { z } from 'zod';

import { websiteScopeNames } from '@gt-sales/types';

import { leadTypeSchema } from './leads';
import { leadTypeCatalog, leadTypeEntry } from './lead-types';

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

/**
 * The lead types a website key may create and save: registered types only
 * (`leadTypeCatalog`), each once, at least one.
 */
export const credentialLeadTypesSchema = z
  .array(leadTypeSchema.refine((leadType) => leadTypeEntry(leadType) !== undefined))
  .min(1)
  .max(Object.keys(leadTypeCatalog).length)
  .refine((leadTypes) => new Set(leadTypes).size === leadTypes.length);

/** A service credential's non-secret summary. The secret itself is shown once, at creation. */
export const serviceCredentialSummarySchema = z.object({
  id: z.uuid(),
  scopes: z.array(websiteScopeSchema),
  /**
   * The lead types this key may create and save; a lead of any other type is
   * refused with `403 lead_type_not_permitted` and nothing is stored. `null`
   * is "not limited": the database does not hold the list yet (migration
   * 0043 not applied), or the key was made by a backend from before it.
   * Optional so a client reading a backend from before issue #84 still
   * parses the list.
   */
  leadTypes: z.array(leadTypeSchema).nullable().optional(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

export type ServiceCredentialSummary = z.infer<typeof serviceCredentialSummarySchema>;

export const createServiceCredentialRequestSchema = z.object({
  scopes: z.array(websiteScopeSchema).min(1).max(websiteScopeNames.length),
  /** The lead types the key may send; `503 credential_lead_types_unavailable` until migration 0043 is applied. */
  leadTypes: credentialLeadTypesSchema,
});

export type CreateServiceCredentialRequest = z.infer<typeof createServiceCredentialRequestSchema>;

/** The plaintext `secret` appears only in this create response and is never persisted or returned again. */
export const createServiceCredentialResponseSchema = z.object({
  credential: serviceCredentialSummarySchema,
  secret: z.string().min(1),
  requestId: z.uuid(),
});

export type CreateServiceCredentialResponse = z.infer<typeof createServiceCredentialResponseSchema>;

/**
 * A change to an existing key: the lead types it may send from now on, by the
 * same rule as a new key's. A revoked key is refused (`409 credential_revoked`).
 */
export const updateServiceCredentialRequestSchema = z.object({
  leadTypes: credentialLeadTypesSchema,
});

export type UpdateServiceCredentialRequest = z.infer<typeof updateServiceCredentialRequestSchema>;

export const updateServiceCredentialResponseSchema = z.object({
  credential: serviceCredentialSummarySchema,
  requestId: z.uuid(),
});

export type UpdateServiceCredentialResponse = z.infer<typeof updateServiceCredentialResponseSchema>;

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
