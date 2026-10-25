/**
 * @gt-sales/types — shared domain TypeScript types.
 *
 * No domain types are defined yet: Phase A's real shapes (workspace, offer,
 * quote, order, etc.) land with A1/A2. This placeholder proves the package
 * resolves and type-checks before any app depends on it.
 */
export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

const tuple = <const Values extends readonly string[]>(...values: Values): Values => values;

export const staffRoleNames = tuple('owner', 'orders', 'partners', 'finance', 'content', 'viewer');
export type StaffRoleName = (typeof staffRoleNames)[number];

export const staffPermissionNames = tuple(
  'document_download',
  'financial_data',
  'bulk_export',
  'deletion',
  'invoice_approval',
  'integration_management',
);
export type StaffPermissionName = (typeof staffPermissionNames)[number];

export const permissionEffects = tuple('allow', 'deny');
export type PermissionEffect = (typeof permissionEffects)[number];

export const membershipStatuses = tuple('pending', 'active', 'revoked');
export type MembershipStatus = (typeof membershipStatuses)[number];

/**
 * A partner (referral agency) starts `pending` review, becomes `approved` to
 * earn commission on referred orders, and can be `suspended` without losing
 * its history (T4P; commissions/invoices land with T19).
 */
export const partnerStatuses = tuple('pending', 'approved', 'suspended');
export type PartnerStatus = (typeof partnerStatuses)[number];

/**
 * How a commission rule computes its amount (T19). `fixed` is a flat CAD amount
 * per activation (integer minor units). `percentage` applies a rate to a basis
 * whose exact definition and rounding are OPEN_INPUTS #17 — unresolved, so a
 * percentage rule cannot be applied to a live activation yet.
 */
export const commissionRuleTypes = tuple('fixed', 'percentage');
export type CommissionRuleType = (typeof commissionRuleTypes)[number];

/**
 * Commission line lifecycle (PLATFORM_CONTEXT.md §4 item 10): `earned` on
 * activation → `carrier_paid` once the carrier has paid Canadian Plans →
 * `partner_paid` once Canadian Plans has paid the partner. Phase A records
 * `earned` and `carrier_paid`; `partner_paid` stays disabled while
 * OPEN_INPUTS #18 is unresolved and B1 invoice approval does not exist.
 */
export const commissionStates = tuple('earned', 'carrier_paid', 'partner_paid');
export type CommissionState = (typeof commissionStates)[number];

/** Invoice lifecycle (T19 tables only): a `draft` is `approved` once, which freezes it. */
export const invoiceStatuses = tuple('draft', 'approved');
export type InvoiceStatus = (typeof invoiceStatuses)[number];

/**
 * A lead is `incomplete` while the customer is still filling in the form
 * (repeated saves update the same row) and becomes `submitted` once it
 * converts to an order (T12). There is no separate "abandoned" state — an
 * incomplete lead that is never resumed simply stays incomplete.
 */
export const leadStatuses = tuple('incomplete', 'submitted');
export type LeadStatus = (typeof leadStatuses)[number];

/**
 * Product families a storefront sells. `sim` is the pre-arrival eSIM, `mobile` a
 * bring-your-own-device postpaid plan, `internet` internet and internet + TV.
 */
export const productTypes = tuple('sim', 'mobile', 'internet');
export type ProductType = (typeof productTypes)[number];

/** Canadian provinces and territories (ISO 3166-2:CA suffixes). */
export const provinceCodes = tuple(
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
);
export type ProvinceCode = (typeof provinceCodes)[number];

/** The region value meaning "sold in every province". */
export const NATIONAL_REGION = 'CA';

/** Where an offer is sold: one or more provinces, or `CA` for all of Canada. */
export const regionCodes = tuple(...provinceCodes, NATIONAL_REGION);
export type RegionCode = (typeof regionCodes)[number];

/** Independent order state dimensions (PLATFORM_CONTEXT invariant 9). */
export const orderStatuses = tuple(
  'submitted',
  'in_progress',
  'awaiting_customer',
  'ready_for_delivery',
  'dispatched',
  'activated',
  'cancelled',
);
export type OrderStatus = (typeof orderStatuses)[number];

export const paymentStates = tuple('not_required', 'pending', 'paid');
export type PaymentState = (typeof paymentStates)[number];

export const deliveryStates = tuple('none', 'dispatched');
export type DeliveryState = (typeof deliveryStates)[number];

/**
 * Scopes a storefront service credential may hold. The public website may only
 * create/resume its own drafts and request quotes/orders/uploads/tracking; it
 * can never list records or take a staff action (PLATFORM_CONTEXT.md §5).
 */
export const websiteScopeNames = tuple(
  'leads:write',
  'quotes:create',
  'orders:create',
  'uploads:customer',
  'tracking:otp',
);
export type WebsiteScopeName = (typeof websiteScopeNames)[number];

/** Distinguishes how a request authenticated, so a staff-only route can refuse a website caller. */
export const callerTypes = tuple('staff', 'website', 'machine');
export type CallerType = (typeof callerTypes)[number];

/**
 * Scopes a verified machine identity may hold. Scheduler identities in the
 * server-only registry (PLATFORM_CONTEXT.md §4b) are granted an explicit subset.
 */
export const machineScopeNames = tuple('outbox:run', 'reconcile:run', 'synthetic:check');
export type MachineScopeName = (typeof machineScopeNames)[number];
