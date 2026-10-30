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

/** How a Get Canada Sim order reaches the customer: an eSIM, or `pickup`, a physical SIM mailed to them. */
export const SIM_ORDER_DELIVERIES = ['esim', 'pickup'] as const;
/** Get Canada Sim's visa / permit types. */
export const SIM_ORDER_PERMIT_TYPES = ['newcomer', 'student', 'worker', 'tourist'] as const;

/**
 * Get Canada Sim's SIM order (`sim_order`), the website's two-step checkout.
 * Every key is optional so a draft saves whatever step 1 has; what a
 * submission must carry is the backend registry's submit check. `planId` is
 * the website's own plan slug, kept as submitted (the plan sold is the
 * order's CRM plan). The SIM number and customer notes are staff fields and
 * the email travels in `contact`, so none of them is accepted here.
 */
export const simOrderLeadPayloadSchema = z
  .object({
    planId: optional(60),
    planLabel: optional(80),
    delivery: z.enum(SIM_ORDER_DELIVERIES).optional(),
    arrivalDate: isoDate.optional(),
    permitType: z.enum(SIM_ORDER_PERMIT_TYPES).optional(),
    gotVisa: z.boolean().optional(),
    flightBooked: z.boolean().optional(),
    /** Where a mailed SIM goes (`delivery: 'pickup'`). */
    shippingAddress: optional(400),
    canadaAddress: optional(300),
    /** Who referred the customer, as they typed it (a partner's email or name). */
    reference: optional(120),
  })
  .strict();
export type SimOrderLeadPayload = z.infer<typeof simOrderLeadPayloadSchema>;

/**
 * A SIM order's number as customers and staff read it: `MS-<n>`, the lead's
 * `externalRef`. Imported orders keep their old `order_no`; new ones take the
 * next number from the site's counter.
 */
export const SIM_ORDER_REF_PREFIX = 'MS-';
const SIM_ORDER_REF = /^MS-([1-9]\d{0,8})$/;

/** `simOrderRef(153)` is `MS-153`. Throws for anything but a whole number from 1. */
export function simOrderRef(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('order number must be 1 or more');
  return `${SIM_ORDER_REF_PREFIX}${n}`;
}

/** The number of an `MS-<n>` reference (no leading zero, up to nine digits), else undefined. */
export function parseSimOrderRef(ref: string): number | undefined {
  const digits = SIM_ORDER_REF.exec(ref)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

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

/**
 * What a move into a stage asks of the lead first: the dispatch details
 * (courier, tracking number, dispatch date), the activation details (number,
 * account, activation date) or its required documents approved.
 */
export type StageGate = 'dispatch' | 'activation' | 'documents';

export interface LeadTypeCatalogEntry {
  readonly label: string;
  readonly stages: readonly LeadStageDefinition[];
  /**
   * The stages staff may move a lead to from each stage, or `'any'` for every
   * other listed stage. A lead at a stage its type does not list (an older
   * stage) may move to any listed one. Read through `allowedStageMoves`.
   */
  readonly moves: Readonly<Record<string, readonly string[]>> | 'any';
  /** What a move into the stage asks first, by stage; a stage not named asks nothing. */
  readonly gates?: Readonly<Record<string, readonly StageGate[]>>;
  /**
   * The lead is an order of one of the site's plans: it carries order details
   * (`leadOrderSchema` in `./plans`). Matches `orderLeadTypes`.
   */
  readonly order?: true;
  /** The order ends with an identity for a credit check: a licence photo or a SIN. */
  readonly takesIdentity?: true;
  /**
   * The website's printable mailer for the order (Get Canada Sim's
   * `delivery-letter.html`), which fills itself from its URL's query, as the
   * site's own admin opens it.
   */
  readonly deliveryLetterUrl?: string;
  /**
   * How the dashboard reads the stages, as the site's old admin did: finished,
   * waiting on staff, and lost (left out of the volume chart and partners).
   */
  readonly outcomes?: {
    readonly done: LeadOutcome;
    readonly waiting: LeadOutcome;
    readonly lost: LeadOutcome;
  };
}

/** One of the dashboard's stage groups: its tile's title and hint, and its stages. */
export interface LeadOutcome {
  readonly label: string;
  readonly hint: string;
  readonly stages: readonly string[];
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
    moves: 'any',
    order: true,
  },
  mobility: {
    label: 'Mobility',
    stages: [NEW, CONTACTED, QUALIFIED, stage('activated', 'Activated'), WON, LOST],
    moves: 'any',
    gates: { activated: ['activation', 'documents'] },
    order: true,
    takesIdentity: true,
  },
  // Get Canada Sim's order statuses, as its admin names them. `incomplete` is
  // a checkout the customer never finished (also the lead's status). Its old
  // money states (`invoiced`, `paid`) are order details now, not stages.
  sim_order: {
    label: 'SIM order',
    stages: [
      stage('incomplete', 'Incomplete'),
      stage('pending', 'Pending'),
      stage('verified', 'Verified'),
      stage('on_hold', 'On hold'),
      stage('delivered', 'Delivered'),
      stage('activated', 'Activated'),
      stage('completed', 'Completed'),
      stage('cancelled', 'Cancelled'),
    ],
    // The order's path: checked, dispatched, activated. On hold waits on the
    // customer; a cancelled order can be taken up again as pending.
    moves: {
      incomplete: ['pending', 'cancelled'],
      pending: ['verified', 'on_hold', 'cancelled'],
      verified: ['delivered', 'on_hold', 'cancelled'],
      on_hold: ['pending', 'verified', 'cancelled'],
      delivered: ['activated', 'on_hold', 'cancelled'],
      activated: ['completed', 'cancelled'],
      completed: [],
      cancelled: ['pending'],
    },
    gates: {
      delivered: ['dispatch', 'documents'],
      activated: ['activation', 'documents'],
    },
    order: true,
    deliveryLetterUrl: 'https://getcanadasim.com/delivery-letter.html',
    // Get Canada Sim's dashboard tiles, in its words.
    outcomes: {
      done: { label: 'Completed', hint: 'Successfully completed orders', stages: ['completed'] },
      waiting: {
        label: 'Pending action',
        hint: 'Awaiting review or activation',
        stages: ['pending', 'verified'],
      },
      lost: { label: 'Cancellations', hint: 'cancellation rate', stages: ['cancelled'] },
    },
  },
  partner_application: {
    label: 'Partner application',
    stages: [NEW, CONTACTED, stage('approved', 'Approved'), stage('declined', 'Declined')],
    moves: 'any',
  },
  contact_message: {
    label: 'Contact message',
    stages: [NEW, stage('replied', 'Replied'), stage('closed', 'Closed')],
    moves: 'any',
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

/**
 * The stages staff may move a lead of this type to from `from`, in catalogue
 * order and never `from` itself: the type's moves from that stage, every
 * other stage for a type that allows any move, and every stage when the type
 * does not list `from`. An unknown type has none.
 */
export function allowedStageMoves(leadType: string, from: string): readonly string[] {
  const entry = catalog.get(leadType);
  if (!entry) return [];
  const keys = entry.stages.map((definition) => definition.key);
  if (!keys.includes(from)) return keys;
  const { moves } = entry;
  if (moves === 'any') return keys.filter((key) => key !== from);
  const targets = Object.hasOwn(moves, from) ? (moves[from] ?? []) : [];
  return keys.filter((key) => key !== from && targets.includes(key));
}

export function isStageMoveAllowed(leadType: string, from: string, to: string): boolean {
  return allowedStageMoves(leadType, from).includes(to);
}

/** What a move of this type into `to` asks first (`StageGate`), in check order; none for most stages. */
export function stageGates(leadType: string, to: string): readonly StageGate[] {
  const gates = catalog.get(leadType)?.gates;
  if (!gates || !Object.hasOwn(gates, to)) return [];
  return gates[to] ?? [];
}

/** The lead types whose website may send a customer's identity (`POST /website/leads/:id/identity`). */
export const identityLeadTypes: readonly string[] = [...catalog]
  .filter(([, entry]) => entry.takesIdentity)
  .map(([leadType]) => leadType);

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
