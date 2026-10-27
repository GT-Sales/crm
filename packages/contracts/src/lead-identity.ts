import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { MAX_DOCUMENT_BYTES, documentMediaTypeSchema } from './domain';

/**
 * The identity a customer gives for a credit check: CanadaWide's mobility
 * order, step 2, sent by the website's server right after the lead (scope
 * `leads:write`). Either a driver's licence photo, uploaded with the usual
 * signed PUT and verified like any document, or a SIN with the date of birth.
 * The CRM stores a SIN sealed, never readable; staff see its last three digits
 * and only an owner can reveal it, which is audited.
 */

export const leadIdentityTypeSchema = z.enum(['drivers_licence', 'sin']);
export type LeadIdentityType = z.infer<typeof leadIdentityTypeSchema>;

/** How many identities one lead may receive (a customer retrying is fine; a flood is not). */
export const MAX_IDENTITIES_PER_LEAD = 3;

/** The licence photo limit CanadaWide's form already enforces. */
export const MAX_IDENTITY_FILE_BYTES = Math.min(4 * 1024 * 1024, MAX_DOCUMENT_BYTES);

/** A Canadian SIN: nine digits passing the Luhn check, as CanadaWide's form validates it. */
export function isValidSin(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** A real calendar date from 1900 to today (UTC), `YYYY-MM-DD`. */
export function isValidDateOfBirth(value: string, today: Date = new Date()): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  return year >= 1900 && value <= today.toISOString().slice(0, 10);
}

/** `POST /website/leads/:leadId/identity/uploads`: a signed PUT for the licence photo. */
export const createIdentityUploadRequestSchema = z
  .object({
    contentType: documentMediaTypeSchema,
    sizeBytes: z.int().positive().max(MAX_IDENTITY_FILE_BYTES),
  })
  .strict();
export type CreateIdentityUploadRequest = z.infer<typeof createIdentityUploadRequestSchema>;

const consentSchema = z.literal(true);

/** `POST /website/leads/:leadId/identity`: the licence (its finished upload) or the SIN. */
export const submitLeadIdentityRequestSchema = z.discriminatedUnion('idType', [
  z
    .object({
      idType: z.literal('drivers_licence'),
      uploadId: z.uuid(),
      checksumSha256: z.string().regex(/^[a-f0-9]{64}$/, 'lower-case hex SHA-256'),
      creditCheckConsent: consentSchema,
    })
    .strict(),
  z
    .object({
      idType: z.literal('sin'),
      sin: z.string().refine(isValidSin, 'a valid 9-digit SIN'),
      dateOfBirth: z.string().refine((value) => isValidDateOfBirth(value), 'a real date of birth'),
      creditCheckConsent: consentSchema,
    })
    .strict(),
]);
export type SubmitLeadIdentityRequest = z.infer<typeof submitLeadIdentityRequestSchema>;

/** What the website learns back: that it was kept. Never the SIN. */
export const submitLeadIdentityResponseSchema = z.object({
  identity: z.object({
    id: z.uuid(),
    idType: leadIdentityTypeSchema,
    createdAt: isoDateTimeSchema,
  }),
  requestId: requestIdSchema,
});
export type SubmitLeadIdentityResponse = z.infer<typeof submitLeadIdentityResponseSchema>;

/** An identity on the lead page: the SIN masked to its last three digits, the licence by file. */
export const leadIdentitySchema = z.object({
  id: z.uuid(),
  idType: leadIdentityTypeSchema,
  /** `*** *** 123` for a SIN; null for a licence. */
  sinMasked: z
    .string()
    .regex(/^\*\*\* \*\*\* \d{3}$/)
    .nullable(),
  dateOfBirth: z.iso.date().nullable(),
  fileId: z.uuid().nullable(),
  createdAt: isoDateTimeSchema,
});
export type LeadIdentity = z.infer<typeof leadIdentitySchema>;

/** `POST /staff/workspaces/:id/leads/:leadId/identities/:identityId/reveal` (owner, audited). */
export const revealLeadIdentityResponseSchema = z.object({
  sin: z.string().regex(/^\d{9}$/),
  requestId: requestIdSchema,
});
export type RevealLeadIdentityResponse = z.infer<typeof revealLeadIdentityResponseSchema>;
