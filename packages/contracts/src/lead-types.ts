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

/**
 * The working stages staff move a lead through, per type, in board order.
 * The one source for the backend (which refuses a stage a type does not list)
 * and the admin (column order and labels). `internet` and `mobility` keep the
 * exact keys and labels of CanadaWide's old admin, so its history imports
 * one to one.
 */
export interface LeadStageDefinition {
  readonly key: string;
  readonly label: string;
}

export interface LeadTypeCatalogEntry {
  readonly label: string;
  readonly stages: readonly LeadStageDefinition[];
}

const stage = (key: string, label: string): LeadStageDefinition => ({ key, label });

const NEW = stage('new', 'New');
const CONTACTED = stage('contacted', 'Contacted');
const QUALIFIED = stage('qualified', 'Qualified');
const WON = stage('won', 'Won');
const LOST = stage('lost', 'Lost');

export const leadTypeCatalog = {
  internet: {
    label: 'Internet',
    stages: [
      NEW,
      CONTACTED,
      QUALIFIED,
      stage('existing_shaw', 'Existing Shaw'),
      stage('non_serviceable_address', 'Non-serviceable address'),
      stage('old_due', 'Old due'),
      stage('installed', 'Installed'),
      WON,
      LOST,
    ],
  },
  mobility: {
    label: 'Mobility',
    stages: [NEW, CONTACTED, QUALIFIED, stage('activated', 'Activated'), WON, LOST],
  },
  // Orders keep their own statuses on the order itself from phase 3.
  sim_order: { label: 'SIM order', stages: [NEW] },
  partner_application: {
    label: 'Partner application',
    stages: [NEW, CONTACTED, stage('approved', 'Approved'), stage('declined', 'Declined')],
  },
  contact_message: {
    label: 'Contact message',
    stages: [NEW, stage('replied', 'Replied'), stage('closed', 'Closed')],
  },
} as const satisfies Record<string, LeadTypeCatalogEntry>;

const catalog: ReadonlyMap<string, LeadTypeCatalogEntry> = new Map(Object.entries(leadTypeCatalog));

export function leadTypeEntry(leadType: string): LeadTypeCatalogEntry | undefined {
  return catalog.get(leadType);
}

/** The type's label, or the slug itself for a type the catalogue does not know. */
export function leadTypeLabel(leadType: string): string {
  return catalog.get(leadType)?.label ?? leadType;
}

/** The stage's label, or the slug itself for a stage the type does not list. */
export function leadStageLabel(leadType: string, stageKey: string): string {
  return catalog.get(leadType)?.stages.find((entry) => entry.key === stageKey)?.label ?? stageKey;
}

export function isLeadStage(leadType: string, stageKey: string): boolean {
  return catalog.get(leadType)?.stages.some((entry) => entry.key === stageKey) ?? false;
}

/** Where a new lead of this type starts: its first stage. */
export function initialLeadStage(leadType: string): string {
  return catalog.get(leadType)?.stages[0]?.key ?? NEW.key;
}

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
