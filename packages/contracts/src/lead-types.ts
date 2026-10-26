import { z } from 'zod';

/**
 * Payload shapes for the lead types whose fields the backend validates — the
 * contract half of the lead-type registry (docs/PLAN.md §5.3; the registry
 * itself is `apps/backend/src/leads/types.ts`). Each schema is the
 * `form.payload` of `POST /api/v1/website/leads` with `form.schemaVersion: 1`.
 * Name, email and phone travel in `contact`, never here.
 *
 * The schemas are strict: an unknown key is a 400, so a website adds a field
 * here first and sends it second, and nothing lands in storage unmodelled.
 * They are deliberately no stricter than the website's own validation (a
 * generic Canadian postal shape, not the site's letter-by-letter rule), so a
 * submission the site accepts is never refused here.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const canadianPostalCode = z
  .string()
  .regex(/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, 'Canadian postal code');
const required = (max: number) => z.string().min(1).max(max);
const optional = (max: number) => z.string().min(1).max(max).optional();

/** CanadaWide home-internet order (`internet`). Mirrors `lib/lead.ts` there. */
export const internetLeadPayloadSchema = z
  .object({
    /** The plan catalogue id, e.g. `ab-1gbps`. */
    planId: required(40),
    /** The plan as staff read it, e.g. `1Gbps + TV` (not unique across provinces). */
    planLabel: required(80),
    landingCity: optional(80),
    dateOfBirth: isoDate,
    streetAddress: required(200),
    aptUnit: optional(40),
    city: required(80),
    postalCode: canadianPostalCode.optional(),
    currentProvider: optional(120),
    preferredInstallationTime: optional(120),
    consent: z.literal(true),
    consentedAt: z.iso.datetime(),
  })
  .strict();
export type InternetLeadPayload = z.infer<typeof internetLeadPayloadSchema>;

/** CanadaWide mobile-plan order, step 1 (`mobility`). Mirrors `lib/mobility-application.ts` there. */
export const mobilityLeadPayloadSchema = z
  .object({
    /** The mobility plan id. */
    planId: required(40),
    /** The plan as staff read it, e.g. `100 GB $40`. */
    planLabel: required(80),
    lineCount: z.int().min(1).max(10),
    firstName: required(80),
    lastName: required(80),
    keepNumber: z.boolean(),
    simType: z.enum(['esim', 'physical']),
    currentProvider: required(60),
    streetAddress: required(200),
    aptUnit: optional(40),
    city: required(80),
    postalCode: canadianPostalCode,
  })
  .strict();
export type MobilityLeadPayload = z.infer<typeof mobilityLeadPayloadSchema>;
