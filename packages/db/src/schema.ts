import { sql } from 'drizzle-orm';
import {
  commissionRuleTypes,
  commissionStates,
  deliveryStates,
  invoiceStatuses,
  leadStatuses,
  membershipStatuses,
  orderStatuses,
  partnerStatuses,
  paymentStates,
  permissionEffects,
  productTypes,
  provinceCodes,
  staffPermissionNames,
  staffRoleNames,
} from '@gt-sales/types';
import {
  check,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

export const membershipType = appSchema.enum('membership_type', ['staff', 'partner']);
export const roleName = appSchema.enum('role_name', staffRoleNames);
export const permissionName = appSchema.enum('permission_name', staffPermissionNames);
export const permissionEffect = appSchema.enum('permission_effect', permissionEffects);

const appRuntimeRole = pgRole('app_runtime').existing();

function tenantPolicy(name: string, workspaceId: AnyPgColumn) {
  const predicate = sql`${workspaceId} = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null`;

  return pgPolicy(name, {
    for: 'all',
    to: appRuntimeRole,
    using: predicate,
    withCheck: predicate,
  });
}

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();

const membershipStatusList = sql.raw(membershipStatuses.map((status) => `'${status}'`).join(', '));
const partnerStatusList = sql.raw(partnerStatuses.map((status) => `'${status}'`).join(', '));
const leadStatusList = sql.raw(leadStatuses.map((status) => `'${status}'`).join(', '));
const orderStatusList = sql.raw(orderStatuses.map((status) => `'${status}'`).join(', '));
const provinceList = sql.raw(provinceCodes.map((code) => `'${code}'`).join(', '));
const productTypeList = sql.raw(productTypes.map((type) => `'${type}'`).join(', '));
const commissionRuleTypeList = sql.raw(commissionRuleTypes.map((type) => `'${type}'`).join(', '));
const commissionStateList = sql.raw(commissionStates.map((state) => `'${state}'`).join(', '));
const invoiceStatusList = sql.raw(invoiceStatuses.map((status) => `'${status}'`).join(', '));
const paymentStateList = sql.raw(paymentStates.map((state) => `'${state}'`).join(', '));
const deliveryStateList = sql.raw(deliveryStates.map((state) => `'${state}'`).join(', '));

/** Global workspace registry: the sole non-tenant table in this migration. */
export const workspaces = appSchema.table('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const memberships = appSchema
  .table(
    'memberships',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      userId: uuid('user_id'),
      invitedEmail: text('invited_email'),
      membershipType: membershipType('membership_type').notNull(),
      status: text('status').notNull(),
      acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('memberships_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('memberships_workspace_id_user_id_unique').on(table.workspaceId, table.userId),
      uniqueIndex('memberships_workspace_pending_email_unique')
        .on(table.workspaceId, sql`lower(${table.invitedEmail})`)
        .where(sql`${table.status} = 'pending'`),
      index('memberships_workspace_id_status_idx').on(
        table.workspaceId,
        table.status,
        table.userId,
      ),
      index('memberships_user_id_status_workspace_id_idx').on(
        table.userId,
        table.status,
        table.workspaceId,
      ),
      check('memberships_status_check', sql`${table.status} in (${membershipStatusList})`),
      check(
        'memberships_identity_state_check',
        sql`(
          ${table.status} = 'pending'
          and ${table.userId} is null
          and ${table.invitedEmail} is not null
        ) or (
          ${table.status} = 'active'
          and ${table.userId} is not null
          and ${table.invitedEmail} is null
        ) or ${table.status} = 'revoked'`,
      ),
      tenantPolicy('memberships_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const roles = appSchema
  .table(
    'roles',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      name: roleName('name').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('roles_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('roles_workspace_id_name_unique').on(table.workspaceId, table.name),
      tenantPolicy('roles_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const membershipRoles = appSchema
  .table(
    'membership_roles',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      membershipId: uuid('membership_id').notNull(),
      roleId: uuid('role_id').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('membership_roles_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('membership_roles_workspace_membership_role_unique').on(
        table.workspaceId,
        table.membershipId,
        table.roleId,
      ),
      foreignKey({
        name: 'membership_roles_workspace_membership_fk',
        columns: [table.workspaceId, table.membershipId],
        foreignColumns: [memberships.workspaceId, memberships.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'membership_roles_workspace_role_fk',
        columns: [table.workspaceId, table.roleId],
        foreignColumns: [roles.workspaceId, roles.id],
      }).onDelete('cascade'),
      index('membership_roles_workspace_id_role_id_idx').on(table.workspaceId, table.roleId),
      tenantPolicy('membership_roles_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const permissions = appSchema
  .table(
    'permissions',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      name: permissionName('name').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('permissions_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('permissions_workspace_id_name_unique').on(table.workspaceId, table.name),
      tenantPolicy('permissions_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const membershipPermissions = appSchema
  .table(
    'membership_permissions',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      membershipId: uuid('membership_id').notNull(),
      permissionId: uuid('permission_id').notNull(),
      effect: permissionEffect('effect').default('allow').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('membership_permissions_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('membership_permissions_workspace_membership_permission_unique').on(
        table.workspaceId,
        table.membershipId,
        table.permissionId,
      ),
      foreignKey({
        name: 'membership_permissions_workspace_membership_fk',
        columns: [table.workspaceId, table.membershipId],
        foreignColumns: [memberships.workspaceId, memberships.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'membership_permissions_workspace_permission_fk',
        columns: [table.workspaceId, table.permissionId],
        foreignColumns: [permissions.workspaceId, permissions.id],
      }).onDelete('cascade'),
      index('membership_permissions_workspace_id_permission_id_idx').on(
        table.workspaceId,
        table.permissionId,
      ),
      tenantPolicy('membership_permissions_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Referral agencies. T4P provides only identity, lifecycle state and the
 * referral code; T19 extends this same table with commission rules/lines and
 * invoices, so nothing here anticipates that shape.
 */
export const partners = appSchema
  .table(
    'partners',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      referralCode: text('referral_code').notNull(),
      status: text('status').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('partners_workspace_id_id_unique').on(table.workspaceId, table.id),
      uniqueIndex('partners_workspace_id_referral_code_unique').on(
        table.workspaceId,
        sql`lower(${table.referralCode})`,
      ),
      index('partners_workspace_id_status_idx').on(table.workspaceId, table.status),
      check('partners_status_check', sql`${table.status} in (${partnerStatusList})`),
      tenantPolicy('partners_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Commission rules (T19; REQ 32). A rule is workspace-scoped and time-bounded:
 * the rule *in effect at activation time* is the one whose window contains that
 * instant. Its full shape is snapshotted onto each commission line, so a later
 * rule change never alters lines already earned (invariant 10). `valueMinor`
 * is a flat CAD amount for `fixed` rules; for `percentage` it is a rate whose
 * basis and rounding are OPEN_INPUTS #17 (unresolved — percentage rules cannot
 * be applied to a live activation yet). `isTest` marks a placeholder rule that
 * may only produce commission lines outside production (the TEST fixed-zero
 * rule must never enter live immutable records). Rules are never updated or
 * deleted — a change is a new row — so the runtime role gets only SELECT/INSERT.
 */
export const commissionRules = appSchema
  .table(
    'commission_rules',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      ruleType: text('rule_type').notNull(),
      valueMinor: integer('value_minor').notNull(),
      currency: text('currency').notNull(),
      isTest: boolean('is_test').default(false).notNull(),
      effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
      effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('commission_rules_workspace_id_id_unique').on(table.workspaceId, table.id),
      check('commission_rules_type_check', sql`${table.ruleType} in (${commissionRuleTypeList})`),
      check('commission_rules_value_nonnegative_check', sql`${table.valueMinor} >= 0`),
      check(
        'commission_rules_window_check',
        sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
      ),
      index('commission_rules_workspace_effective_idx').on(
        table.workspaceId,
        table.effectiveFrom,
        table.effectiveTo,
      ),
      tenantPolicy('commission_rules_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Invoices and their lines (T19 — tables only in Phase A; no generation UI).
 * One draft invoice per partner per period; approval freezes it. Invoice
 * numbers are sequential per workspace (REQ 33). Generation and approval land
 * in B1, so the runtime role gets SELECT/INSERT/UPDATE but no code path writes
 * these in Phase A.
 */
export const invoices = appSchema
  .table(
    'invoices',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      partnerId: uuid('partner_id').notNull(),
      invoiceNumber: integer('invoice_number').notNull(),
      periodStart: date('period_start').notNull(),
      periodEnd: date('period_end').notNull(),
      status: text('status').default('draft').notNull(),
      totalMinor: integer('total_minor').default(0).notNull(),
      currency: text('currency').notNull(),
      approvedBy: uuid('approved_by'),
      approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('invoices_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('invoices_workspace_number_unique').on(table.workspaceId, table.invoiceNumber),
      unique('invoices_workspace_partner_period_unique').on(
        table.workspaceId,
        table.partnerId,
        table.periodStart,
        table.periodEnd,
      ),
      foreignKey({
        name: 'invoices_workspace_partner_fk',
        columns: [table.workspaceId, table.partnerId],
        foreignColumns: [partners.workspaceId, partners.id],
      }),
      check('invoices_status_check', sql`${table.status} in (${invoiceStatusList})`),
      check('invoices_period_check', sql`${table.periodEnd} >= ${table.periodStart}`),
      check(
        'invoices_approved_state_check',
        sql`(${table.status} = 'approved') = (${table.approvedAt} is not null)`,
      ),
      index('invoices_workspace_partner_idx').on(table.workspaceId, table.partnerId),
      tenantPolicy('invoices_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Product identity (T10A). Keyed by the CMS's stable `productKey` (never the
 * Sanity `_id`, `title` or `slug` — see `product` in
 * packages/contracts/src/cms/schema-types.ts). T10 owns creating these rows
 * during catalogue sync; this table only anchors workspace ownership.
 */
export const products = appSchema
  .table(
    'products',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      productKey: text('product_key').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('products_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('products_workspace_id_product_key_unique').on(table.workspaceId, table.productKey),
      tenantPolicy('products_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Immutable commercial-content snapshots for a product (T10A;
 * IMPLEMENTATION_PLAN.md §6 "Offer synchronisation"). `content` is the exact
 * validated commercial payload T10's sync copies from the published CMS
 * offer document; `contentHash` is T10's canonical hash of that same payload,
 * unique per product so re-syncing unchanged content never creates a
 * duplicate version. `cmsDocumentId`/`cmsRevisionId` are provenance only —
 * nullable (synthetic/test fixtures have none) and excluded from the
 * uniqueness key, so reconfirming a version from a later CMS revision never
 * forces a new row. Rows are never updated or deleted: `app_runtime` is
 * granted only SELECT/INSERT, the same immutability enforcement already used
 * for `audit_events`.
 */
export const offerVersions = appSchema
  .table(
    'offer_versions',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      productId: uuid('product_id').notNull(),
      content: jsonb('content').notNull(),
      contentHash: text('content_hash').notNull(),
      cmsDocumentId: text('cms_document_id'),
      cmsRevisionId: text('cms_revision_id'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('offer_versions_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('offer_versions_workspace_product_content_hash_unique').on(
        table.workspaceId,
        table.productId,
        table.contentHash,
      ),
      unique('offer_versions_workspace_product_id_unique').on(
        table.workspaceId,
        table.productId,
        table.id,
      ),
      foreignKey({
        name: 'offer_versions_workspace_product_fk',
        columns: [table.workspaceId, table.productId],
        foreignColumns: [products.workspaceId, products.id],
      }),
      index('offer_versions_workspace_id_product_id_created_at_idx').on(
        table.workspaceId,
        table.productId,
        table.createdAt,
      ),
      tenantPolicy('offer_versions_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Mutable availability/revocation state, kept separate from immutable
 * `offer_versions` so unpublishing a product never edits offer history
 * (IMPLEMENTATION_PLAN.md §6). One row per product; `revokedAt` null means
 * available for new quotes, matching the `revokedAt` convention already used
 * by `memberships` and `service_credentials`.
 */
export const productAvailability = appSchema
  .table(
    'product_availability',
    {
      productId: uuid('product_id').primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      currentOfferVersionId: uuid('current_offer_version_id'),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
      lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    },
    (table) => [
      foreignKey({
        name: 'product_availability_workspace_product_fk',
        columns: [table.workspaceId, table.productId],
        foreignColumns: [products.workspaceId, products.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'product_availability_workspace_current_version_fk',
        columns: [table.workspaceId, table.productId, table.currentOfferVersionId],
        foreignColumns: [offerVersions.workspaceId, offerVersions.productId, offerVersions.id],
      }),
      tenantPolicy('product_availability_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** Durable, tenant-scoped Sanity webhook inbox. Payloads are retained only as
 * delivery evidence/selectors; commercial fields are always re-fetched. */
export const catalogueSyncEvents = appSchema
  .table(
    'catalogue_sync_events',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      selector: text('selector').notNull(),
      providerAccount: text('provider_account').notNull(),
      deliveryId: text('delivery_id').notNull(),
      documentId: text('document_id').notNull(),
      /** Verified machine actor that ingested the delivery; reused for later drain writes. */
      actorId: uuid('actor_id').notNull(),
      payload: jsonb('payload').notNull(),
      status: text('status').default('pending').notNull(),
      attempts: integer('attempts').default(0).notNull(),
      errorCode: text('error_code'),
      cmsRevisionId: text('cms_revision_id'),
      occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
      processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('catalogue_sync_events_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('catalogue_sync_events_delivery_unique').on(
        table.workspaceId,
        table.providerAccount,
        table.deliveryId,
      ),
      check(
        'catalogue_sync_events_status_check',
        sql`${table.status} in ('pending', 'processing', 'completed', 'failed', 'ignored')`,
      ),
      index('catalogue_sync_events_workspace_status_created_idx').on(
        table.workspaceId,
        table.status,
        table.createdAt,
      ),
      tenantPolicy('catalogue_sync_events_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** Short database-backed lease; process memory is not durable on Vercel. */
export const catalogueSyncLeases = appSchema
  .table(
    'catalogue_sync_leases',
    {
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      productKey: text('product_key').notNull(),
      ownerId: uuid('owner_id').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.workspaceId, table.productKey] }),
      index('catalogue_sync_leases_workspace_expires_idx').on(table.workspaceId, table.expiresAt),
      tenantPolicy('catalogue_sync_leases_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** One operational summary row per workspace for the read-only admin view. */
export const catalogueSyncState = appSchema
  .table(
    'catalogue_sync_state',
    {
      workspaceId: uuid('workspace_id')
        .primaryKey()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
      lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
      lastErrorCode: text('last_error_code'),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [tenantPolicy('catalogue_sync_state_tenant_policy', table.workspaceId)],
  )
  .enableRLS();

/**
 * A prospective customer's in-progress plan application (T11; REQ 16/17).
 * `incomplete` while the customer is still filling in the form — repeated
 * saves update this same row via its draft grant; `submitted` once it
 * converts to an order (T12). Contact fields are individually nullable since
 * they are captured progressively. `payload` is the versioned form
 * (`{schemaVersion, payload}`); `attribution` is the bounded, allowlisted
 * UTM/referrer/landing-page/partner-code snapshot the backend sanitizes
 * before it is ever written (REQ 35) — never raw request data.
 */
export const leads = appSchema
  .table(
    'leads',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      status: text('status').notNull(),
      fullName: text('full_name'),
      email: text('email'),
      phone: text('phone'),
      countryCode: text('country_code'),
      partnerId: uuid('partner_id'),
      selectedOfferVersionId: uuid('selected_offer_version_id'),
      payload: jsonb('payload'),
      attribution: jsonb('attribution').notNull().default({}),
      consentVersion: text('consent_version').notNull(),
      customerDataRestrictedAt: timestamp('customer_data_restricted_at', {
        withTimezone: true,
        mode: 'date',
      }),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('leads_workspace_id_id_unique').on(table.workspaceId, table.id),
      check('leads_status_check', sql`${table.status} in (${leadStatusList})`),
      foreignKey({
        name: 'leads_workspace_partner_fk',
        columns: [table.workspaceId, table.partnerId],
        foreignColumns: [partners.workspaceId, partners.id],
      }),
      foreignKey({
        name: 'leads_workspace_offer_version_fk',
        columns: [table.workspaceId, table.selectedOfferVersionId],
        foreignColumns: [offerVersions.workspaceId, offerVersions.id],
      }),
      index('leads_workspace_id_status_idx').on(table.workspaceId, table.status),
      index('leads_workspace_id_updated_at_idx').on(table.workspaceId, table.updatedAt),
      tenantPolicy('leads_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * A scoped bearer token letting an anonymous visitor resume their own draft
 * lead (glossary; T11). Verified within the already-established website
 * tenant context — unlike the service credential itself, this never needs a
 * pre-tenant lookup. `revokedAt` is unused by this task (no revoke endpoint
 * yet) but reserved for the future deletion/withdrawal path.
 */
export const draftGrants = appSchema
  .table(
    'draft_grants',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id').notNull(),
      tokenHash: text('token_hash').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('draft_grants_token_hash_unique').on(table.tokenHash),
      foreignKey({
        name: 'draft_grants_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }).onDelete('cascade'),
      index('draft_grants_workspace_id_lead_id_idx').on(table.workspaceId, table.leadId),
      tenantPolicy('draft_grants_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** Immutable-at-submission order envelope. Commercial details live in snapshot. */
export const orders = appSchema
  .table(
    'orders',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      reference: text('reference').notNull(),
      leadId: uuid('lead_id').notNull(),
      status: text('status').notNull(),
      paymentState: text('payment_state').notNull(),
      deliveryState: text('delivery_state').notNull(),
      customerDataRestrictedAt: timestamp('customer_data_restricted_at', {
        withTimezone: true,
        mode: 'date',
      }),
      customerDataDeletedAt: timestamp('customer_data_deleted_at', {
        withTimezone: true,
        mode: 'date',
      }),
      archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
      assigneeId: uuid('assignee_id'),
      version: integer('version').default(1).notNull(),
      snapshot: jsonb('snapshot').notNull(),
      payload: jsonb('payload').notNull(),
      consent: jsonb('consent'),
      partnerId: uuid('partner_id'),
      submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('orders_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('orders_workspace_reference_unique').on(table.workspaceId, table.reference),
      unique('orders_workspace_lead_unique').on(table.workspaceId, table.leadId),
      foreignKey({
        name: 'orders_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      foreignKey({
        name: 'orders_workspace_assignee_fk',
        columns: [table.workspaceId, table.assigneeId],
        foreignColumns: [memberships.workspaceId, memberships.id],
      }),
      foreignKey({
        name: 'orders_workspace_partner_fk',
        columns: [table.workspaceId, table.partnerId],
        foreignColumns: [partners.workspaceId, partners.id],
      }),
      check('orders_status_check', sql`${table.status} in (${orderStatusList})`),
      check('orders_payment_state_check', sql`${table.paymentState} in (${paymentStateList})`),
      check('orders_delivery_state_check', sql`${table.deliveryState} in (${deliveryStateList})`),
      check('orders_version_positive_check', sql`${table.version} > 0`),
      check('orders_snapshot_object_check', sql`jsonb_typeof(${table.snapshot}) = 'object'`),
      check('orders_payload_object_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
      check(
        'orders_consent_object_check',
        sql`${table.consent} is null or jsonb_typeof(${table.consent}) = 'object'`,
      ),
      index('orders_workspace_status_submitted_idx').on(
        table.workspaceId,
        table.status,
        table.submittedAt,
      ),
      index('orders_workspace_assignee_idx').on(table.workspaceId, table.assigneeId),
      index('orders_workspace_partner_idx').on(table.workspaceId, table.partnerId),
      tenantPolicy('orders_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * One earned commission for one activated order (invariant 10), with the rule
 * snapshotted at activation. The unique `(workspace_id, order_id)` is what makes
 * activation create *exactly one* line: a retried or concurrent activation
 * conflicts on this key rather than inserting a second line. `amountMinor`,
 * `currency`, `ruleId` and `ruleSnapshot` are the immutable financial facts;
 * only `state` and `invoiceId` change afterwards, through audited Finance
 * actions. `invoiceId` is nullable until B1 invoicing links the line.
 */
export const commissionLines = appSchema
  .table(
    'commission_lines',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      partnerId: uuid('partner_id').notNull(),
      ruleId: uuid('rule_id').notNull(),
      ruleSnapshot: jsonb('rule_snapshot').notNull(),
      amountMinor: integer('amount_minor').notNull(),
      currency: text('currency').notNull(),
      state: text('state').default('earned').notNull(),
      invoiceId: uuid('invoice_id'),
      earnedAt: timestamp('earned_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('commission_lines_workspace_id_id_unique').on(table.workspaceId, table.id),
      // Exactly one commission line per activated order (invariant 10).
      unique('commission_lines_workspace_order_unique').on(table.workspaceId, table.orderId),
      foreignKey({
        name: 'commission_lines_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }),
      foreignKey({
        name: 'commission_lines_workspace_partner_fk',
        columns: [table.workspaceId, table.partnerId],
        foreignColumns: [partners.workspaceId, partners.id],
      }),
      foreignKey({
        name: 'commission_lines_workspace_rule_fk',
        columns: [table.workspaceId, table.ruleId],
        foreignColumns: [commissionRules.workspaceId, commissionRules.id],
      }),
      foreignKey({
        name: 'commission_lines_workspace_invoice_fk',
        columns: [table.workspaceId, table.invoiceId],
        foreignColumns: [invoices.workspaceId, invoices.id],
      }),
      check('commission_lines_state_check', sql`${table.state} in (${commissionStateList})`),
      check('commission_lines_amount_nonnegative_check', sql`${table.amountMinor} >= 0`),
      check(
        'commission_lines_snapshot_object_check',
        sql`jsonb_typeof(${table.ruleSnapshot}) = 'object'`,
      ),
      index('commission_lines_workspace_partner_idx').on(table.workspaceId, table.partnerId),
      index('commission_lines_workspace_state_idx').on(table.workspaceId, table.state),
      tenantPolicy('commission_lines_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Append-only state history for a commission line (REQ 32 — "state history").
 * Every transition (including the initial `earned`) writes one row so the full
 * carrier-paid / partner-paid trail is reconstructable. Immutable, so the
 * runtime role gets only SELECT/INSERT, matching `audit_events`.
 */
export const commissionLineEvents = appSchema
  .table(
    'commission_line_events',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      commissionLineId: uuid('commission_line_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      fromState: text('from_state'),
      toState: text('to_state').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('commission_line_events_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'commission_line_events_workspace_line_fk',
        columns: [table.workspaceId, table.commissionLineId],
        foreignColumns: [commissionLines.workspaceId, commissionLines.id],
      }).onDelete('cascade'),
      check(
        'commission_line_events_from_state_check',
        sql`${table.fromState} is null or ${table.fromState} in (${commissionStateList})`,
      ),
      check(
        'commission_line_events_to_state_check',
        sql`${table.toState} in (${commissionStateList})`,
      ),
      index('commission_line_events_workspace_line_created_idx').on(
        table.workspaceId,
        table.commissionLineId,
        table.createdAt,
      ),
      tenantPolicy('commission_line_events_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const invoiceLines = appSchema
  .table(
    'invoice_lines',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      invoiceId: uuid('invoice_id').notNull(),
      commissionLineId: uuid('commission_line_id').notNull(),
      orderId: uuid('order_id').notNull(),
      amountMinor: integer('amount_minor').notNull(),
      currency: text('currency').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('invoice_lines_workspace_id_id_unique').on(table.workspaceId, table.id),
      // A commission line belongs to exactly one invoice (REQ 33).
      unique('invoice_lines_workspace_commission_unique').on(
        table.workspaceId,
        table.commissionLineId,
      ),
      foreignKey({
        name: 'invoice_lines_workspace_invoice_fk',
        columns: [table.workspaceId, table.invoiceId],
        foreignColumns: [invoices.workspaceId, invoices.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'invoice_lines_workspace_commission_fk',
        columns: [table.workspaceId, table.commissionLineId],
        foreignColumns: [commissionLines.workspaceId, commissionLines.id],
      }),
      index('invoice_lines_workspace_invoice_idx').on(table.workspaceId, table.invoiceId),
      tenantPolicy('invoice_lines_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** A 15-minute, server-authoritative commercial snapshot tied to one draft. */
export const quotes = appSchema
  .table(
    'quotes',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      draftId: uuid('draft_id').notNull(),
      productId: uuid('product_id').notNull(),
      offerVersionId: uuid('offer_version_id').notNull(),
      currency: text('currency').notNull(),
      charges: jsonb('charges').notNull(),
      totalAmountMinor: integer('total_amount_minor').notNull(),
      amountPayableTodayMinor: integer('amount_payable_today_minor').notNull(),
      paymentRequired: boolean('payment_required').notNull(),
      documentChecklist: text('document_checklist').array().notNull(),
      termsVersion: text('terms_version').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
      consumedByOrderId: uuid('consumed_by_order_id'),
      consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('quotes_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('quotes_workspace_consumed_order_unique').on(
        table.workspaceId,
        table.consumedByOrderId,
      ),
      foreignKey({
        name: 'quotes_workspace_draft_fk',
        columns: [table.workspaceId, table.draftId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      foreignKey({
        name: 'quotes_workspace_product_fk',
        columns: [table.workspaceId, table.productId],
        foreignColumns: [products.workspaceId, products.id],
      }),
      foreignKey({
        name: 'quotes_workspace_product_offer_version_fk',
        columns: [table.workspaceId, table.productId, table.offerVersionId],
        foreignColumns: [offerVersions.workspaceId, offerVersions.productId, offerVersions.id],
      }),
      foreignKey({
        name: 'quotes_workspace_consumed_order_fk',
        columns: [table.workspaceId, table.consumedByOrderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }),
      check('quotes_currency_check', sql`${table.currency} ~ '^[A-Z]{3}$'`),
      check('quotes_charges_array_check', sql`jsonb_typeof(${table.charges}) = 'array'`),
      check('quotes_total_nonnegative_check', sql`${table.totalAmountMinor} >= 0`),
      check('quotes_payable_today_nonnegative_check', sql`${table.amountPayableTodayMinor} >= 0`),
      check(
        'quotes_consumption_pair_check',
        sql`(${table.consumedByOrderId} is null) = (${table.consumedAt} is null)`,
      ),
      index('quotes_workspace_draft_created_idx').on(
        table.workspaceId,
        table.draftId,
        table.createdAt,
      ),
      index('quotes_workspace_product_expires_idx').on(
        table.workspaceId,
        table.productId,
        table.expiresAt,
      ),
      tenantPolicy('quotes_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const orderStatusHistory = appSchema
  .table(
    'order_status_history',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      fromStatus: text('from_status'),
      toStatus: text('to_status').notNull(),
      orderVersion: integer('order_version').notNull(),
      reason: text('reason'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('order_status_history_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'order_status_history_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      check(
        'order_status_history_from_status_check',
        sql`${table.fromStatus} is null or ${table.fromStatus} in (${orderStatusList})`,
      ),
      check('order_status_history_to_status_check', sql`${table.toStatus} in (${orderStatusList})`),
      check('order_status_history_version_positive_check', sql`${table.orderVersion} > 0`),
      index('order_status_history_workspace_order_created_idx').on(
        table.workspaceId,
        table.orderId,
        table.createdAt,
      ),
      tenantPolicy('order_status_history_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const orderAmendments = appSchema
  .table(
    'order_amendments',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      reason: text('reason').notNull(),
      patch: jsonb('patch').notNull(),
      before: jsonb('before').notNull(),
      after: jsonb('after').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('order_amendments_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'order_amendments_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      index('order_amendments_workspace_order_created_idx').on(
        table.workspaceId,
        table.orderId,
        table.createdAt,
      ),
      tenantPolicy('order_amendments_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const orderChangeRequests = appSchema
  .table(
    'order_change_requests',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      requestedBy: uuid('requested_by').notNull(),
      payload: jsonb('payload').notNull(),
      status: text('status').default('pending').notNull(),
      resolvedBy: uuid('resolved_by'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('order_change_requests_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'order_change_requests_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      check(
        'order_change_requests_status_check',
        sql`${table.status} in ('pending', 'approved', 'rejected')`,
      ),
      index('order_change_requests_workspace_order_status_idx').on(
        table.workspaceId,
        table.orderId,
        table.status,
      ),
      tenantPolicy('order_change_requests_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Operational contact notes (REQ 20). Append-only child records of an order;
 * the author and time make every note attributable without editing the order
 * envelope, so adding a note never races a status transition.
 */
export const orderNotes = appSchema
  .table(
    'order_notes',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      authorId: uuid('author_id').notNull(),
      body: text('body').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('order_notes_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'order_notes_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      check('order_notes_body_check', sql`char_length(${table.body}) between 1 and 2000`),
      index('order_notes_workspace_order_created_idx').on(
        table.workspaceId,
        table.orderId,
        table.createdAt,
      ),
      tenantPolicy('order_notes_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * A scheduled follow-up reminder (REQ 20/27). The scheduling runner in T18
 * re-checks whether the customer completed, cancelled or unsubscribed before
 * sending; deleting the row cancels the reminder.
 */
export const orderReminders = appSchema
  .table(
    'order_reminders',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      createdBy: uuid('created_by').notNull(),
      remindAt: timestamp('remind_at', { withTimezone: true, mode: 'date' }).notNull(),
      note: text('note'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('order_reminders_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'order_reminders_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      check(
        'order_reminders_note_check',
        sql`${table.note} is null or char_length(${table.note}) between 1 and 2000`,
      ),
      index('order_reminders_workspace_order_remind_idx').on(
        table.workspaceId,
        table.orderId,
        table.remindAt,
      ),
      index('order_reminders_workspace_remind_at_idx').on(table.workspaceId, table.remindAt),
      tenantPolicy('order_reminders_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const idempotencyKeys = appSchema
  .table(
    'idempotency_keys',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      scope: text('scope').notNull(),
      keyHash: text('key_hash').notNull(),
      requestFingerprint: text('request_fingerprint').notNull(),
      leadId: uuid('lead_id').notNull(),
      orderId: uuid('order_id'),
      responseReference: text('response_reference'),
      status: text('status').default('pending').notNull(),
      createdAt: createdAt(),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    },
    (table) => [
      unique('idempotency_keys_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('idempotency_keys_workspace_scope_key_unique').on(
        table.workspaceId,
        table.scope,
        table.keyHash,
      ),
      foreignKey({
        name: 'idempotency_keys_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      foreignKey({
        name: 'idempotency_keys_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }),
      check('idempotency_keys_status_check', sql`${table.status} in ('pending', 'completed')`),
      check(
        'idempotency_keys_completion_check',
        sql`(${table.status} = 'pending' and ${table.orderId} is null and ${table.responseReference} is null and ${table.completedAt} is null) or (${table.status} = 'completed' and ${table.orderId} is not null and ${table.responseReference} is not null and ${table.completedAt} is not null)`,
      ),
      index('idempotency_keys_workspace_order_idx').on(table.workspaceId, table.orderId),
      tenantPolicy('idempotency_keys_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const outboxJobs = appSchema
  .table(
    'outbox_jobs',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      jobType: text('job_type').notNull(),
      dedupeKey: text('dedupe_key').notNull(),
      messageId: uuid('message_id').defaultRandom().notNull(),
      payloadVersion: integer('payload_version').default(1).notNull(),
      payload: jsonb('payload').notNull(),
      status: text('status').default('pending').notNull(),
      attempts: integer('attempts').default(0).notNull(),
      availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
      lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
      leaseOwnerId: uuid('lease_owner_id'),
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
      lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      uncertainAt: timestamp('uncertain_at', { withTimezone: true, mode: 'date' }),
      lastErrorCode: text('last_error_code'),
      providerId: text('provider_id'),
      outcome: jsonb('outcome'),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('outbox_jobs_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('outbox_jobs_workspace_type_dedupe_unique').on(
        table.workspaceId,
        table.jobType,
        table.dedupeKey,
      ),
      check(
        'outbox_jobs_status_check',
        sql`${table.status} in ('pending', 'processing', 'completed', 'failed', 'uncertain')`,
      ),
      check('outbox_jobs_attempts_check', sql`${table.attempts} >= 0`),
      check('outbox_jobs_payload_version_check', sql`${table.payloadVersion} > 0`),
      check(
        'outbox_jobs_lease_check',
        sql`(${table.status} = 'processing' and ${table.leaseOwnerId} is not null and ${table.leaseExpiresAt} is not null and ${table.lockedAt} is not null) or (${table.status} <> 'processing' and ${table.leaseOwnerId} is null and ${table.leaseExpiresAt} is null)`,
      ),
      index('outbox_jobs_workspace_status_available_idx').on(
        table.workspaceId,
        table.status,
        table.availableAt,
      ),
      tenantPolicy('outbox_jobs_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const outboxJobAlerts = appSchema
  .table(
    'outbox_job_alerts',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      jobId: uuid('job_id').notNull(),
      alertCode: text('alert_code').notNull(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('outbox_job_alerts_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'outbox_job_alerts_workspace_job_fk',
        columns: [table.workspaceId, table.jobId],
        foreignColumns: [outboxJobs.workspaceId, outboxJobs.id],
      }).onDelete('cascade'),
      index('outbox_job_alerts_workspace_unresolved_idx').on(
        table.workspaceId,
        table.resolvedAt,
        table.createdAt,
      ),
      tenantPolicy('outbox_job_alerts_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const dispatchRecords = appSchema
  .table(
    'dispatch_records',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      courier: text('courier').notNull(),
      trackingReference: text('tracking_reference'),
      dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('dispatch_records_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'dispatch_records_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      index('dispatch_records_workspace_order_idx').on(table.workspaceId, table.orderId),
      tenantPolicy('dispatch_records_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const paymentRecords = appSchema
  .table(
    'payment_records',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      fromState: text('from_state').notNull(),
      toState: text('to_state').notNull(),
      method: text('method'),
      paymentReference: text('payment_reference'),
      amountMinor: integer('amount_minor'),
      currency: text('currency'),
      recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('payment_records_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'payment_records_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      check('payment_records_from_state_check', sql`${table.fromState} in (${paymentStateList})`),
      check('payment_records_to_state_check', sql`${table.toState} in (${paymentStateList})`),
      check(
        'payment_records_amount_check',
        sql`${table.amountMinor} is null or ${table.amountMinor} >= 0`,
      ),
      index('payment_records_workspace_order_recorded_idx').on(
        table.workspaceId,
        table.orderId,
        table.recordedAt,
      ),
      tenantPolicy('payment_records_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export const serviceCredentials = appSchema
  .table(
    'service_credentials',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      secretHash: text('secret_hash').notNull(),
      scopes: text('scopes')
        .array()
        .default(sql`array[]::text[]`)
        .notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('service_credentials_workspace_id_id_unique').on(table.workspaceId, table.id),
      // A credential secret resolves to exactly one workspace before tenant
      // context exists (the website bootstrap lookup in PLATFORM_CONTEXT §4b);
      // a global unique hash guarantees that resolution is unambiguous.
      unique('service_credentials_secret_hash_unique').on(table.secretHash),
      index('service_credentials_workspace_id_revoked_at_idx').on(
        table.workspaceId,
        table.revokedAt,
      ),
      tenantPolicy('service_credentials_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Durable, bounded per-key rate-limit buckets for public (pre-tenant) requests.
 * There is no tenant policy and no `app_runtime` table grant: the runtime role
 * reaches these rows only through the SECURITY DEFINER `app.rate_limit_hit`
 * function, so a bug in application code cannot read or scan the counters. Rows
 * are keyed per credential/IP + fixed window, never a single global counter.
 */
export const rateLimitBuckets = appSchema
  .table(
    'rate_limit_buckets',
    {
      bucketKey: text('bucket_key').notNull(),
      windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
      requestCount: integer('request_count').default(1).notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.bucketKey, table.windowStart] }),
      index('rate_limit_buckets_expires_at_idx').on(table.expiresAt),
    ],
  )
  .enableRLS();

/**
 * Global pause marker written directly by the independent backup runner's own
 * privileged credential (never `app_runtime`) while it builds the referenced-
 * object manifest and copies R2 objects (IMPLEMENTATION_PLAN §13: "Prevent
 * object cleanup racing the archive with a snapshot reference set and
 * lease."). Not tenant-scoped: a backup run spans every workspace. `app_runtime`
 * has no direct grant; it only calls `app.backup_lease_active()` (see the
 * accompanying migration), matching `rate_limit_buckets`/`resolve_website_credential`.
 */
export const backupLeases = appSchema
  .table(
    'backup_leases',
    {
      runId: text('run_id').primaryKey(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [index('backup_leases_expires_at_idx').on(table.expiresAt)],
  )
  .enableRLS();

export const auditEvents = appSchema
  .table(
    'audit_events',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      actorId: uuid('actor_id').notNull(),
      actorLabel: text('actor_label').notNull(),
      action: text('action').notNull(),
      entity: text('entity').notNull(),
      entityId: uuid('entity_id').notNull(),
      before: jsonb('before'),
      after: jsonb('after'),
      requestId: uuid('request_id').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('audit_events_workspace_id_id_unique').on(table.workspaceId, table.id),
      index('audit_events_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
      index('audit_events_workspace_id_entity_idx').on(
        table.workspaceId,
        table.entity,
        table.entityId,
      ),
      index('audit_events_workspace_id_request_id_idx').on(table.workspaceId, table.requestId),
      tenantPolicy('audit_events_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Local mirror of the external deletion ledger intent (T21, §13). It holds the
 * logical operation the app committed and restricted; the durable event lives
 * in the independent ledger. Identifiers and an action only — never the deleted
 * personal data.
 */
export const deletionIntents = appSchema
  .table(
    'deletion_intents',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      action: text('action').notNull(),
      subjectType: text('subject_type').notNull(),
      subjectId: uuid('subject_id').notNull(),
      relatedLeadId: uuid('related_lead_id'),
      status: text('status').notNull().default('pending'),
      reason: text('reason'),
      actorId: uuid('actor_id').notNull(),
      ledgerAckId: text('ledger_ack_id'),
      lastErrorCode: text('last_error_code'),
      createdAt: createdAt(),
      acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
      localCleanedAt: timestamp('local_cleaned_at', { withTimezone: true, mode: 'date' }),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    },
    (table) => [
      unique('deletion_intents_workspace_id_id_unique').on(table.workspaceId, table.id),
      check(
        'deletion_intents_status_check',
        sql`${table.status} in ('pending', 'acknowledged', 'failed')`,
      ),
      check('deletion_intents_action_check', sql`${table.action} in ('delete_customer_data')`),
      check(
        'deletion_intents_subject_type_check',
        sql`${table.subjectType} in ('order', 'lead', 'region_waitlist')`,
      ),
      index('deletion_intents_workspace_subject_idx').on(
        table.workspaceId,
        table.subjectType,
        table.subjectId,
      ),
      index('deletion_intents_workspace_status_idx').on(table.workspaceId, table.status),
      tenantPolicy('deletion_intents_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** Durable private-object cleanup; a ledger acknowledgement is required before deletion. */
export const deletionObjects = appSchema
  .table(
    'deletion_objects',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      deletionId: uuid('deletion_id').notNull(),
      bucket: text('bucket').notNull(),
      objectKey: text('object_key').notNull(),
      availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('deletion_objects_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('deletion_objects_workspace_intent_key_unique').on(
        table.workspaceId,
        table.deletionId,
        table.bucket,
        table.objectKey,
      ),
      foreignKey({
        name: 'deletion_objects_workspace_intent_fk',
        columns: [table.workspaceId, table.deletionId],
        foreignColumns: [deletionIntents.workspaceId, deletionIntents.id],
      }).onDelete('cascade'),
      index('deletion_objects_pending_idx').on(
        table.workspaceId,
        table.completedAt,
        table.availableAt,
      ),
      tenantPolicy('deletion_objects_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/** Protected lease table; narrow functions coordinate R2 cleanup with backup acquisition. */
export const documentCleanupLeases = appSchema
  .table(
    'document_cleanup_leases',
    {
      objectId: uuid('object_id')
        .primaryKey()
        .references(() => deletionObjects.id, { onDelete: 'cascade' }),
      workspaceId: uuid('workspace_id').notNull(),
      leaseOwnerId: uuid('lease_owner_id').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (table) => [index('document_cleanup_leases_expires_idx').on(table.expiresAt)],
  )
  .enableRLS();

/** Minimal provider dedupe tombstones prevent late events from recreating erased associations. */
export const deletedEmailMessages = appSchema
  .table(
    'deleted_email_messages',
    {
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      messageId: uuid('message_id').notNull(),
      provider: text('provider'),
      providerAccount: text('provider_account'),
      providerId: text('provider_id'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('deleted_email_messages_workspace_message_unique').on(
        table.workspaceId,
        table.messageId,
      ),
      index('deleted_email_messages_provider_idx').on(
        table.workspaceId,
        table.provider,
        table.providerAccount,
        table.providerId,
      ),
      tenantPolicy('deleted_email_messages_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * A customer order-tracking one-time-code challenge (T22, REQ 05). The code and
 * the binding email are stored only as keyed hashes bound to workspace, order
 * and normalized email; the plaintext code is never persisted. Consumed,
 * expired or over-attempted challenges never verify.
 */
export const trackingChallenges = appSchema
  .table(
    'tracking_challenges',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      orderId: uuid('order_id').notNull(),
      emailHash: text('email_hash').notNull(),
      codeHash: text('code_hash').notNull(),
      status: text('status').notNull().default('pending'),
      attempts: integer('attempts').notNull().default(0),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
      consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    },
    (table) => [
      unique('tracking_challenges_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'tracking_challenges_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }).onDelete('cascade'),
      check('tracking_challenges_status_check', sql`${table.status} in ('pending', 'consumed')`),
      check('tracking_challenges_attempts_check', sql`${table.attempts} >= 0`),
      index('tracking_challenges_workspace_order_status_idx').on(
        table.workspaceId,
        table.orderId,
        table.status,
      ),
      index('tracking_challenges_workspace_email_idx').on(table.workspaceId, table.emailHash),
      tenantPolicy('tracking_challenges_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * A visitor asking to be told when a province we do not serve yet gets plans
 * (ADR 0005, D5). Holds an email address, so it is personal data: the consent
 * version is recorded with it, it is never written to logs or analytics, and an
 * audit event records the join without the address. One row per workspace,
 * province and (case-insensitive) email, so repeated sign-ups are harmless.
 */
export const regionWaitlist = appSchema
  .table(
    'region_waitlist',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      province: text('province').notNull(),
      email: text('email').notNull(),
      customerDataRestrictedAt: timestamp('customer_data_restricted_at', {
        withTimezone: true,
        mode: 'date',
      }),
      /** The plan type the visitor asked about, when known. */
      interest: text('interest'),
      consentVersion: text('consent_version').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('region_waitlist_workspace_id_id_unique').on(table.workspaceId, table.id),
      check('region_waitlist_province_check', sql`${table.province} in (${provinceList})`),
      check(
        'region_waitlist_interest_check',
        sql`${table.interest} is null or ${table.interest} in (${productTypeList})`,
      ),
      uniqueIndex('region_waitlist_workspace_province_email_unique').on(
        table.workspaceId,
        table.province,
        sql`lower(${table.email})`,
      ),
      index('region_waitlist_workspace_province_idx').on(table.workspaceId, table.province),
      tenantPolicy('region_waitlist_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export type Workspace = typeof workspaces.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type MembershipRole = typeof membershipRoles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type MembershipPermission = typeof membershipPermissions.$inferSelect;
export type Partner = typeof partners.$inferSelect;
export type CommissionRule = typeof commissionRules.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type CommissionLine = typeof commissionLines.$inferSelect;
export type CommissionLineEvent = typeof commissionLineEvents.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type Product = typeof products.$inferSelect;
export type OfferVersion = typeof offerVersions.$inferSelect;
export type ProductAvailability = typeof productAvailability.$inferSelect;
export type CatalogueSyncEvent = typeof catalogueSyncEvents.$inferSelect;
export type CatalogueSyncLease = typeof catalogueSyncLeases.$inferSelect;
export type CatalogueSyncState = typeof catalogueSyncState.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type DraftGrant = typeof draftGrants.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type OrderStatusHistory = typeof orderStatusHistory.$inferSelect;
export type OrderAmendment = typeof orderAmendments.$inferSelect;
export type OrderChangeRequest = typeof orderChangeRequests.$inferSelect;
export type OrderNote = typeof orderNotes.$inferSelect;
export type OrderReminder = typeof orderReminders.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type OutboxJob = typeof outboxJobs.$inferSelect;
export type OutboxJobAlert = typeof outboxJobAlerts.$inferSelect;
export type DispatchRecord = typeof dispatchRecords.$inferSelect;
export type PaymentRecord = typeof paymentRecords.$inferSelect;
export type ServiceCredential = typeof serviceCredentials.$inferSelect;
export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

/**
 * Uploaded document metadata (T17; REQ 22-25; IMPLEMENTATION_PLAN.md §8). One
 * row per uploaded object with the full lifecycle from the task brief:
 * `uploading` (intent issued, client uploading to the staging key) →
 * `verifying` (finalize claimed; staging copied to the private candidate key
 * the uploader cannot write to) → `available` (candidate verified by signature
 * + checksum and atomically attached) or `rejected` (verification failed) →
 * `deleted` (tombstoned, scheduled for cleanup). The object key, detected MIME,
 * actual size and checksum are set only when verification succeeds. `record_type`
 * is polymorphic (a lead or an order) so, like `audit_events`, ownership is
 * enforced by the tenant RLS policy and the backend rather than a single
 * composite FK. `object_key`/`staging_key`/`candidate_key` are random and never
 * leak the customer's identity (REQ 22).
 */
export const files = appSchema
  .table(
    'files',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      recordType: text('record_type').notNull(),
      recordId: uuid('record_id').notNull(),
      documentType: text('document_type').notNull(),
      bucket: text('bucket').notNull(),
      /** The uploader-writable staging object the presigned PUT targets. */
      stagingKey: text('staging_key').notNull(),
      /** The private candidate the uploader cannot write to; set when finalize is claimed. */
      candidateKey: text('candidate_key'),
      /** The attached, verified object served to staff. Equals the candidate key. */
      objectKey: text('object_key'),
      declaredContentType: text('declared_content_type').notNull(),
      detectedMime: text('detected_mime'),
      declaredSizeBytes: integer('declared_size_bytes').notNull(),
      sizeBytes: integer('size_bytes'),
      checksumSha256: text('checksum_sha256'),
      status: text('status').default('uploading').notNull(),
      rejectReason: text('reject_reason'),
      revision: integer('revision').default(1).notNull(),
      /** Set on a superseded object when a replacement is attached to the same slot. */
      supersededByFileId: uuid('superseded_by_file_id'),
      uploadedBy: uuid('uploaded_by').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
      finalizedAt: timestamp('finalized_at', { withTimezone: true, mode: 'date' }),
      deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('files_workspace_id_id_unique').on(table.workspaceId, table.id),
      uniqueIndex('files_staging_key_unique').on(table.stagingKey),
      uniqueIndex('files_object_key_unique')
        .on(table.objectKey)
        .where(sql`${table.objectKey} is not null`),
      check(
        'files_status_check',
        sql`${table.status} in ('uploading', 'verifying', 'available', 'rejected', 'deleted')`,
      ),
      check('files_record_type_check', sql`${table.recordType} in ('lead', 'order')`),
      check(
        'files_content_type_check',
        sql`${table.declaredContentType} in ('application/pdf', 'image/jpeg', 'image/png')`,
      ),
      check('files_declared_size_check', sql`${table.declaredSizeBytes} > 0`),
      check('files_size_check', sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`),
      check('files_revision_positive_check', sql`${table.revision} > 0`),
      // An available object must carry the verified provenance; a non-available
      // object must not (so an unchecked object can never look attached).
      check(
        'files_available_provenance_check',
        sql`(
          ${table.status} = 'available'
          and ${table.objectKey} is not null
          and ${table.detectedMime} is not null
          and ${table.checksumSha256} is not null
          and ${table.sizeBytes} is not null
        ) or (
          ${table.status} <> 'available'
        )`,
      ),
      index('files_workspace_record_idx').on(
        table.workspaceId,
        table.recordType,
        table.recordId,
        table.status,
      ),
      index('files_workspace_status_expires_idx').on(
        table.workspaceId,
        table.status,
        table.expiresAt,
      ),
      tenantPolicy('files_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Immutable provenance of every verified object (T17; REQ 23/24). One row is
 * written when a file's candidate is attached; a replacement adds the next
 * revision, so review/version history survives even after the current `files`
 * row is tombstoned or scrubbed. `app_runtime` is granted only SELECT/INSERT.
 */
export const fileRevisions = appSchema
  .table(
    'file_revisions',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      fileId: uuid('file_id').notNull(),
      revision: integer('revision').notNull(),
      objectKey: text('object_key').notNull(),
      detectedMime: text('detected_mime').notNull(),
      sizeBytes: integer('size_bytes').notNull(),
      checksumSha256: text('checksum_sha256').notNull(),
      createdBy: uuid('created_by').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('file_revisions_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('file_revisions_workspace_file_revision_unique').on(
        table.workspaceId,
        table.fileId,
        table.revision,
      ),
      foreignKey({
        name: 'file_revisions_workspace_file_fk',
        columns: [table.workspaceId, table.fileId],
        foreignColumns: [files.workspaceId, files.id],
      }).onDelete('cascade'),
      check('file_revisions_revision_positive_check', sql`${table.revision} > 0`),
      index('file_revisions_workspace_file_idx').on(
        table.workspaceId,
        table.fileId,
        table.revision,
      ),
      tenantPolicy('file_revisions_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Staff review decisions on a file (T17; admin Documents panel — approve/reject
 * with a note). Append-only and independent of the signature-verification
 * `status`: a file can be byte-verified (`available`) yet business-rejected by
 * staff. Every decision records who and when (invariant 11).
 */
export const fileReviewEvents = appSchema
  .table(
    'file_review_events',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      fileId: uuid('file_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      decision: text('decision').notNull(),
      note: text('note'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('file_review_events_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'file_review_events_workspace_file_fk',
        columns: [table.workspaceId, table.fileId],
        foreignColumns: [files.workspaceId, files.id],
      }).onDelete('cascade'),
      check(
        'file_review_events_decision_check',
        sql`${table.decision} in ('approved', 'rejected')`,
      ),
      check(
        'file_review_events_note_check',
        sql`${table.note} is null or char_length(${table.note}) between 1 and 2000`,
      ),
      index('file_review_events_workspace_file_created_idx').on(
        table.workspaceId,
        table.fileId,
        table.createdAt,
      ),
      tenantPolicy('file_review_events_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export type FileRecord = typeof files.$inferSelect;
export type FileRevision = typeof fileRevisions.$inferSelect;
export type FileReviewEvent = typeof fileReviewEvents.$inferSelect;

/**
 * One row per logical email send (T18/REQ 26-27). `messageId` is the stable
 * logical job identifier used for provider-level dedupe, never regenerated on
 * retry. `contactHash` is a keyed digest, never the raw address, so this table
 * never carries an unhashed contact detail (§4 invariant 12).
 */
export const emailMessages = appSchema
  .table(
    'email_messages',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      messageId: uuid('message_id').notNull(),
      template: text('template').notNull(),
      messageClass: text('message_class').notNull(),
      leadId: uuid('lead_id'),
      orderId: uuid('order_id'),
      contactHash: text('contact_hash').notNull(),
      status: text('status').default('queued').notNull(),
      providerId: text('provider_id'),
      provider: text('provider'),
      providerAccount: text('provider_account'),
      lastErrorCode: text('last_error_code'),
      lastEventAt: timestamp('last_event_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('email_messages_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('email_messages_workspace_message_id_unique').on(table.workspaceId, table.messageId),
      check(
        'email_messages_class_check',
        sql`${table.messageClass} in ('transactional', 'marketing')`,
      ),
      check(
        'email_messages_status_check',
        sql`${table.status} in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'uncertain')`,
      ),
      foreignKey({
        name: 'email_messages_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      foreignKey({
        name: 'email_messages_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }),
      unique('email_messages_provider_id_unique').on(
        table.workspaceId,
        table.provider,
        table.providerAccount,
        table.providerId,
      ),
      check(
        'email_messages_provider_pair_check',
        sql`(${table.provider} is null) = (${table.providerAccount} is null)`,
      ),
      index('email_messages_workspace_status_idx').on(table.workspaceId, table.status),
      index('email_messages_workspace_contact_hash_idx').on(table.workspaceId, table.contactHash),
      tenantPolicy('email_messages_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Deliverability suppression — hard bounce, complaint, or manual address
 * block. Deliberately separate from `marketing_consents.marketingOptIn`
 * (REQ 26): a marketing opt-out never lands here, and transactional sends
 * only ever check this table, never the opt-out flag.
 */
export const emailSuppressions = appSchema
  .table(
    'email_suppressions',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      contactHash: text('contact_hash').notNull(),
      reason: text('reason').notNull(),
      sourceEventId: text('source_event_id'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('email_suppressions_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('email_suppressions_workspace_contact_reason_unique').on(
        table.workspaceId,
        table.contactHash,
        table.reason,
      ),
      check(
        'email_suppressions_reason_check',
        sql`${table.reason} in ('hard_bounce', 'complaint', 'manual')`,
      ),
      index('email_suppressions_workspace_contact_hash_idx').on(
        table.workspaceId,
        table.contactHash,
      ),
      tenantPolicy('email_suppressions_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Marketing opt-in state (CASL, REQ 34). Recorded per lead and/or order at
 * capture with the consent version; unsubscribe writes a new row rather than
 * mutating history so the capture record is preserved. After a deletion request,
 * only false consent with the fixed retained-opt-out version may omit both
 * customer links, preventing older opt-ins from becoming effective again.
 */
export const marketingConsents = appSchema
  .table(
    'marketing_consents',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id'),
      orderId: uuid('order_id'),
      contactHash: text('contact_hash').notNull(),
      marketingOptIn: boolean('marketing_opt_in').notNull(),
      version: text('version').notNull(),
      capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('marketing_consents_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'marketing_consents_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      foreignKey({
        name: 'marketing_consents_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }),
      check(
        'marketing_consents_reference_check',
        sql`${table.leadId} is not null or ${table.orderId} is not null or (${table.marketingOptIn} = false and ${table.version} = 'retained-opt-out')`,
      ),
      index('marketing_consents_workspace_contact_hash_idx').on(
        table.workspaceId,
        table.contactHash,
        table.capturedAt,
      ),
      tenantPolicy('marketing_consents_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Centrally stored follow-up due dates and eligibility (REQ 27). Staff can
 * cancel a scheduled sequence; the runner re-checks lead/order state, consent
 * and suppression immediately before sending, never trusting this row alone.
 */
export const followUpSchedules = appSchema
  .table(
    'follow_up_schedules',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id'),
      orderId: uuid('order_id'),
      template: text('template').notNull(),
      dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
      status: text('status').default('scheduled').notNull(),
      cancelledReason: text('cancelled_reason'),
      cancelledByActorId: uuid('cancelled_by_actor_id'),
      sentMessageId: uuid('sent_message_id'),
      createdAt: createdAt(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      unique('follow_up_schedules_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'follow_up_schedules_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      foreignKey({
        name: 'follow_up_schedules_workspace_order_fk',
        columns: [table.workspaceId, table.orderId],
        foreignColumns: [orders.workspaceId, orders.id],
      }),
      check(
        'follow_up_schedules_reference_check',
        sql`${table.leadId} is not null or ${table.orderId} is not null`,
      ),
      check(
        'follow_up_schedules_status_check',
        sql`${table.status} in ('scheduled', 'sent', 'cancelled', 'skipped')`,
      ),
      index('follow_up_schedules_workspace_due_idx').on(
        table.workspaceId,
        table.status,
        table.dueAt,
      ),
      tenantPolicy('follow_up_schedules_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

/**
 * Verified provider delivery-event inbox (REQ 26). Deduplicated by provider
 * event ID within a workspace/account so a replayed or duplicated webhook
 * never double-applies a bounce/complaint suppression.
 */
export const emailProviderEvents = appSchema
  .table(
    'email_provider_events',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      providerEventId: text('provider_event_id').notNull(),
      provider: text('provider').default('legacy').notNull(),
      providerAccount: text('provider_account').default('legacy').notNull(),
      eventType: text('event_type').notNull(),
      messageId: uuid('message_id'),
      contactHash: text('contact_hash'),
      receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
      appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('email_provider_events_workspace_id_id_unique').on(table.workspaceId, table.id),
      unique('email_provider_events_workspace_provider_event_unique').on(
        table.workspaceId,
        table.provider,
        table.providerAccount,
        table.providerEventId,
      ),
      check(
        'email_provider_events_type_check',
        sql`${table.eventType} in ('delivered', 'bounce', 'complaint', 'reject')`,
      ),
      index('email_provider_events_workspace_message_idx').on(table.workspaceId, table.messageId),
      tenantPolicy('email_provider_events_tenant_policy', table.workspaceId),
    ],
  )
  .enableRLS();

export type EmailMessageRow = typeof emailMessages.$inferSelect;
export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;
export type MarketingConsentRow = typeof marketingConsents.$inferSelect;
export type FollowUpScheduleRow = typeof followUpSchedules.$inferSelect;
export type EmailProviderEventRow = typeof emailProviderEvents.$inferSelect;

export const schema = {
  workspaces,
  memberships,
  roles,
  membershipRoles,
  permissions,
  membershipPermissions,
  partners,
  commissionRules,
  invoices,
  commissionLines,
  commissionLineEvents,
  invoiceLines,
  products,
  offerVersions,
  productAvailability,
  catalogueSyncEvents,
  catalogueSyncLeases,
  catalogueSyncState,
  leads,
  draftGrants,
  orders,
  quotes,
  orderStatusHistory,
  orderAmendments,
  orderChangeRequests,
  orderNotes,
  orderReminders,
  idempotencyKeys,
  outboxJobs,
  outboxJobAlerts,
  dispatchRecords,
  paymentRecords,
  serviceCredentials,
  rateLimitBuckets,
  backupLeases,
  auditEvents,
  deletionIntents,
  deletionObjects,
  documentCleanupLeases,
  deletedEmailMessages,
  trackingChallenges,
  regionWaitlist,
  files,
  fileRevisions,
  fileReviewEvents,
  emailMessages,
  emailSuppressions,
  marketingConsents,
  followUpSchedules,
  emailProviderEvents,
};
