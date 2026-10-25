/**
 * @gt-sales/types — shared domain TypeScript types: the vocabularies the
 * database schema, the API contracts and the apps all derive from. Define a
 * value list once here; the Zod schemas and Drizzle checks read it.
 */
export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

const tuple = <const Values extends readonly string[]>(...values: Values): Values => values;

/**
 * Staff roles within one workspace (one website). `owner` holds every action;
 * `leads` works the CRM inbox; `orders`, `partners`, `finance` and `content`
 * map to Get Canada Sim's admin sections; `viewer` reads without contact
 * details. Site access is the membership itself — a role never crosses sites.
 */
export const staffRoleNames = tuple(
  'owner',
  'leads',
  'orders',
  'partners',
  'finance',
  'content',
  'viewer',
);
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
 * A lead is `incomplete` while the customer is still filling in the form
 * (repeated saves update the same row) and becomes `submitted` once the form
 * is complete. Per-type working statuses (contacted, qualified, won…) arrive
 * with the lead-type registry.
 */
export const leadStatuses = tuple('incomplete', 'submitted');
export type LeadStatus = (typeof leadStatuses)[number];

/**
 * Scopes a website service credential may hold. A website may only create and
 * resume its own drafts and upload documents against them; it can never list
 * records or take a staff action.
 */
export const websiteScopeNames = tuple('leads:write', 'uploads:customer');
export type WebsiteScopeName = (typeof websiteScopeNames)[number];

/** Distinguishes how a request authenticated, so a staff-only route can refuse a website caller. */
export const callerTypes = tuple('staff', 'website', 'machine');
export type CallerType = (typeof callerTypes)[number];

/**
 * Scopes a verified machine identity may hold. Scheduler identities in the
 * server-only registry are granted an explicit subset.
 */
export const machineScopeNames = tuple('outbox:run', 'reconcile:run', 'synthetic:check');
export type MachineScopeName = (typeof machineScopeNames)[number];
