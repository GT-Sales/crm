import { sql } from 'drizzle-orm';
import {
  leadStatuses,
  membershipStatuses,
  permissionEffects,
  staffPermissionNames,
  staffRoleNames,
} from '@gt-sales/types';
import {
  bigint,
  boolean,
  check,
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

/**
 * The CRM schema. Every tenant table carries `workspace_id` (one workspace =
 * one website) and a row-level policy that reads the transaction-local
 * `app.workspace_id` / `app.actor_id` settings `withTenantTx` sets. The
 * backend connects as `app_runtime`, a role without BYPASSRLS, so a query
 * that forgets its tenant filter sees nothing rather than everything. Every
 * RLS table also carries `backupReadPolicy(...)`, so the backup job's
 * `backup_reader` login can dump its rows (grants in `drizzle/0007_*.sql`).
 *
 * drizzle-kit generates tables, indexes, checks, policies and ENABLE RLS from
 * this file. Role grants, FORCE RLS, the SECURITY DEFINER bootstrap functions
 * and the restriction triggers are hand-written in `drizzle/0001_*.sql` and
 * must be kept in step with any table added here.
 */
export const appSchema = pgSchema('app');

export const membershipType = appSchema.enum('membership_type', ['staff']);
export const roleName = appSchema.enum('role_name', staffRoleNames);
export const permissionName = appSchema.enum('permission_name', staffPermissionNames);
export const permissionEffect = appSchema.enum('permission_effect', permissionEffects);

const appRuntimeRole = pgRole('app_runtime').existing();
const backupReaderRole = pgRole('backup_reader').existing();

const actorPresent = sql`nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null`;

/** Row visible and writable only inside the matching tenant transaction with a verified actor. */
function tenantPolicy(name: string, workspaceId: AnyPgColumn) {
  const predicate = sql`${workspaceId} = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and ${actorPresent}`;

  return pgPolicy(name, {
    for: 'all',
    to: appRuntimeRole,
    using: predicate,
    withCheck: predicate,
  });
}

/**
 * Row visible and writable only to its own actor inside the matching tenant
 * transaction: `tenantPolicy` plus the actor equality, for private rows
 * (a person's saved views).
 */
function ownerPolicy(name: string, workspaceId: AnyPgColumn, actorId: AnyPgColumn) {
  const predicate = sql`${workspaceId} = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and ${actorId} = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid`;

  return pgPolicy(name, {
    for: 'all',
    to: appRuntimeRole,
    using: predicate,
    withCheck: predicate,
  });
}

/**
 * For the one deliberately global table (`contacts`): any verified actor in a
 * tenant transaction. Tenant scoping is enforced by the backend, which only
 * ever reaches a contact through a lead of the current workspace.
 */
function actorPolicy(name: string) {
  return pgPolicy(name, {
    for: 'all',
    to: appRuntimeRole,
    using: actorPresent,
    withCheck: actorPresent,
  });
}

/** The backup job's read-only login reads every row of every tenant table (spec §10). */
function backupReadPolicy(table: string) {
  return pgPolicy(`${table}_backup_reader_read`, {
    for: 'select',
    to: backupReaderRole,
    using: sql`true`,
  });
}

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();

const membershipStatusList = sql.raw(membershipStatuses.map((status) => `'${status}'`).join(', '));
const leadStatusList = sql.raw(leadStatuses.map((status) => `'${status}'`).join(', '));

// ---------------------------------------------------------------------------
// Sites and staff access
// ---------------------------------------------------------------------------

/**
 * Global site registry ("Site" in the admin, `workspace` in code). The runtime
 * role has no grant on it: staff discover their sites through
 * `app.list_staff_workspaces()` and websites resolve theirs through their
 * credential, so neither can enumerate the registry.
 */
export const workspaces = appSchema.table(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** The site's public hostname, e.g. `getcanadasim.com`; informational. */
    domain: text('domain'),
    status: text('status').default('active').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check('workspaces_slug_check', sql`${table.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'`),
    check('workspaces_status_check', sql`${table.status} in ('active', 'paused')`),
  ],
);

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
      /**
       * The name colleagues see on assignments, tasks and the timeline, set by
       * the member themselves. Deliberately not the email: the members list is
       * readable by every role, and it must not become a staff directory.
       */
      displayName: text('display_name'),
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
        'memberships_display_name_check',
        sql`${table.displayName} is null or (char_length(${table.displayName}) between 1 and 80 and ${table.displayName} = btrim(${table.displayName}))`,
      ),
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
      backupReadPolicy('memberships'),
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
      backupReadPolicy('roles'),
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
      backupReadPolicy('membership_roles'),
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
      backupReadPolicy('permissions'),
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
      backupReadPolicy('membership_permissions'),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------------
// Contacts and leads
// ---------------------------------------------------------------------------

/**
 * One person across every site, merged by normalized email (owner decision
 * 2026-10-25: email only, lower-cased and trimmed; Gmail dots and `+tags` are
 * kept). This is the documented exception to "every table carries
 * workspace_id": the same customer ordering a SIM on one site and asking about
 * internet on another must resolve to one row, so intake on either site needs
 * to find-or-create it. The policy therefore requires only a verified actor;
 * the backend exposes a contact to staff only through a lead of the current
 * workspace, never by listing this table.
 */
export const contacts = appSchema
  .table(
    'contacts',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      /** Normalized: `lower(btrim(email))`. The unique key the merge runs on. */
      email: text('email').notNull(),
      fullName: text('full_name'),
      phone: text('phone'),
      countryCode: text('country_code'),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('contacts_email_unique').on(table.email),
      check(
        'contacts_email_normalized_check',
        sql`${table.email} = lower(btrim(${table.email})) and position('@' in ${table.email}) > 1`,
      ),
      actorPolicy('contacts_actor_policy'),
      backupReadPolicy('contacts'),
    ],
  )
  .enableRLS();

/**
 * Every submission a website sends: a SIM order, an internet or mobility
 * enquiry, a partner application, a contact message. `lead_type` names the
 * entry in the lead-type registry, which owns the `payload` schema and the
 * per-type working stages; `external_ref` is the source system's own
 * identifier (an order number such as `MS-123`) so a migrated or mirrored
 * record is created once per site and type.
 *
 * `status` is the form's lifecycle (`incomplete` while the customer is still
 * filling it in, then `submitted`); `stage` is where staff are working it
 * (`new`, `contacted`, `won`…), one of the type's registry stages. The column
 * only checks the slug shape: which stages a type has is the registry's call,
 * enforced by the backend.
 */
export const leads = appSchema
  .table(
    'leads',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadType: text('lead_type').notNull(),
      status: text('status').notNull(),
      stage: text('stage').default('new').notNull(),
      fullName: text('full_name'),
      email: text('email'),
      phone: text('phone'),
      countryCode: text('country_code'),
      contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
      assignedActorId: uuid('assigned_actor_id'),
      externalRef: text('external_ref'),
      payload: jsonb('payload'),
      attribution: jsonb('attribution').notNull().default({}),
      /**
       * Values of the site's custom properties (`app.properties`, origin
       * `custom`), keyed by property key. Staff-written only; the backend
       * parses each value by its property's kind before it is stored.
       */
      customValues: jsonb('custom_values').notNull().default({}),
      /**
       * An order lead's order (`sim_order`, `internet`, `mobility`): the plan
       * link, the plan frozen at submission, `quantity`, `paymentStatus` and
       * `carrierCommission` (contracts `leadOrderSchema`). `{}` for every
       * other type, and for an order not yet given one (the backend reads it
       * as the default order).
       */
      orderDetails: jsonb('order_details').notNull().default({}),
      consentVersion: text('consent_version').notNull(),
      customerDataRestrictedAt: timestamp('customer_data_restricted_at', {
        withTimezone: true,
        mode: 'date',
      }),
      deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('leads_workspace_id_id_unique').on(table.workspaceId, table.id),
      check('leads_status_check', sql`${table.status} in (${leadStatusList})`),
      check('leads_stage_check', sql`${table.stage} ~ '^[a-z0-9_]{1,64}$'`),
      check('leads_lead_type_check', sql`${table.leadType} ~ '^[a-z0-9_]{1,64}$'`),
      check('leads_custom_values_check', sql`jsonb_typeof(${table.customValues}) = 'object'`),
      check('leads_order_details_check', sql`jsonb_typeof(${table.orderDetails}) = 'object'`),
      check(
        'leads_external_ref_check',
        sql`${table.externalRef} is null or char_length(${table.externalRef}) between 1 and 128`,
      ),
      uniqueIndex('leads_workspace_type_external_ref_unique')
        .on(table.workspaceId, table.leadType, table.externalRef)
        .where(sql`${table.externalRef} is not null`),
      index('leads_workspace_id_status_idx').on(table.workspaceId, table.status),
      index('leads_workspace_id_updated_at_idx').on(table.workspaceId, table.updatedAt),
      index('leads_workspace_id_lead_type_idx').on(
        table.workspaceId,
        table.leadType,
        table.updatedAt,
      ),
      // The board: one type's leads grouped by stage, newest first.
      index('leads_workspace_type_stage_idx').on(
        table.workspaceId,
        table.leadType,
        table.stage,
        table.updatedAt,
      ),
      index('leads_workspace_id_contact_id_idx').on(table.workspaceId, table.contactId),
      // Covers the single-column contacts FK, so removing a contact does not scan leads.
      index('leads_contact_id_idx').on(table.contactId),
      index('leads_workspace_id_assigned_actor_idx').on(table.workspaceId, table.assignedActorId),
      tenantPolicy('leads_tenant_policy', table.workspaceId),
      backupReadPolicy('leads'),
    ],
  )
  .enableRLS();

/**
 * Append-only timeline of a lead: notes, status changes, assignments, calls,
 * emails, edits, documents, merges. `app_runtime` is granted SELECT/INSERT
 * only, so history cannot be rewritten from the application.
 */
export const leadActivities = appSchema
  .table(
    'lead_activities',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id').notNull(),
      actorId: uuid('actor_id').notNull(),
      kind: text('kind').notNull(),
      body: text('body'),
      data: jsonb('data'),
      createdAt: createdAt(),
    },
    (table) => [
      unique('lead_activities_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'lead_activities_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }).onDelete('cascade'),
      check(
        'lead_activities_kind_check',
        sql`${table.kind} in ('note', 'status_change', 'assignment', 'email', 'call', 'edit', 'document', 'merge', 'system')`,
      ),
      check(
        'lead_activities_body_check',
        sql`${table.body} is null or char_length(${table.body}) between 1 and 4000`,
      ),
      index('lead_activities_workspace_lead_created_idx').on(
        table.workspaceId,
        table.leadId,
        table.createdAt,
      ),
      tenantPolicy('lead_activities_tenant_policy', table.workspaceId),
      backupReadPolicy('lead_activities'),
    ],
  )
  .enableRLS();

/** A follow-up on a lead with an optional due time and assignee. */
export const leadTasks = appSchema
  .table(
    'lead_tasks',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id').notNull(),
      title: text('title').notNull(),
      dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
      assignedActorId: uuid('assigned_actor_id'),
      status: text('status').default('open').notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      createdBy: uuid('created_by').notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('lead_tasks_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'lead_tasks_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }).onDelete('cascade'),
      check('lead_tasks_title_check', sql`char_length(${table.title}) between 1 and 200`),
      check('lead_tasks_status_check', sql`${table.status} in ('open', 'done', 'cancelled')`),
      check(
        'lead_tasks_completion_check',
        sql`(${table.status} = 'done') = (${table.completedAt} is not null)`,
      ),
      index('lead_tasks_workspace_status_due_idx').on(table.workspaceId, table.status, table.dueAt),
      index('lead_tasks_workspace_lead_idx').on(table.workspaceId, table.leadId),
      // "My tasks": one assignee's open tasks by due time.
      index('lead_tasks_workspace_assignee_status_due_idx').on(
        table.workspaceId,
        table.assignedActorId,
        table.status,
        table.dueAt,
      ),
      tenantPolicy('lead_tasks_tenant_policy', table.workspaceId),
      backupReadPolicy('lead_tasks'),
    ],
  )
  .enableRLS();

/**
 * A scoped bearer token letting an anonymous visitor resume their own draft
 * lead. Verified within the already-established website tenant context —
 * unlike the service credential itself, this never needs a pre-tenant lookup.
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
      backupReadPolicy('draft_grants'),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

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
      updatedAt: updatedAt(),
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
      backupReadPolicy('outbox_jobs'),
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
      index('outbox_job_alerts_workspace_job_idx').on(table.workspaceId, table.jobId),
      tenantPolicy('outbox_job_alerts_tenant_policy', table.workspaceId),
      backupReadPolicy('outbox_job_alerts'),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------------
// Website credentials, rate limits, audit
// ---------------------------------------------------------------------------

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
      // context exists (the website bootstrap lookup); a global unique hash
      // guarantees that resolution is unambiguous.
      unique('service_credentials_secret_hash_unique').on(table.secretHash),
      index('service_credentials_workspace_id_revoked_at_idx').on(
        table.workspaceId,
        table.revokedAt,
      ),
      tenantPolicy('service_credentials_tenant_policy', table.workspaceId),
      backupReadPolicy('service_credentials'),
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
      backupReadPolicy('rate_limit_buckets'),
    ],
  )
  .enableRLS();

/**
 * Append-only record of who did what. `app_runtime` may SELECT and INSERT, and
 * may UPDATE only `before`/`after` — and only to SQL null (privacy redaction,
 * enforced by the `audit_events_redaction_only` trigger), never to new values.
 */
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
      backupReadPolicy('audit_events'),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Document metadata. An upload is staged under a presigned PUT, verified by
 * file signature on finalize, then attached; the object itself lives in the
 * Storage bucket named in `bucket`. `record_type`/`record_id` name the owning
 * record (a lead today; orders in a later phase).
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
      updatedAt: updatedAt(),
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
        sql`${table.declaredContentType} in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')`,
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
      backupReadPolicy('files'),
    ],
  )
  .enableRLS();

/**
 * The identity a customer gave for a credit check (CanadaWide's mobility order,
 * step 2): a driver's licence photo, held as a verified `files` row, or a SIN.
 * A SIN is never stored readable: `sin_sealed` is AES-256-GCM under
 * `SENSITIVE_FIELDS_KEY`, which only the backend holds, bound to this row;
 * `sin_last3` is what staff see (`*** *** 123`). Append-only for the runtime
 * role: a correction is a new row.
 */
export const leadIdentities = appSchema
  .table(
    'lead_identities',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id').notNull(),
      idType: text('id_type').notNull(),
      fileId: uuid('file_id'),
      sinSealed: text('sin_sealed'),
      sinLast3: text('sin_last3'),
      dateOfBirth: date('date_of_birth', { mode: 'string' }),
      creditCheckConsentAt: timestamp('credit_check_consent_at', {
        withTimezone: true,
        mode: 'date',
      }).notNull(),
      createdBy: uuid('created_by').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('lead_identities_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'lead_identities_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'lead_identities_workspace_file_fk',
        columns: [table.workspaceId, table.fileId],
        foreignColumns: [files.workspaceId, files.id],
      }),
      check('lead_identities_id_type_check', sql`${table.idType} in ('drivers_licence', 'sin')`),
      // A licence is a file and nothing else; a SIN is the sealed number, its
      // last three digits and the date of birth, and no file.
      check(
        'lead_identities_shape_check',
        sql`(
          ${table.idType} = 'drivers_licence'
          and ${table.fileId} is not null
          and ${table.sinSealed} is null
          and ${table.sinLast3} is null
          and ${table.dateOfBirth} is null
        ) or (
          ${table.idType} = 'sin'
          and ${table.fileId} is null
          and ${table.sinSealed} is not null
          and ${table.sinLast3} ~ '^[0-9]{3}$'
          and ${table.dateOfBirth} is not null
        )`,
      ),
      index('lead_identities_workspace_lead_idx').on(
        table.workspaceId,
        table.leadId,
        table.createdAt,
      ),
      index('lead_identities_workspace_file_idx').on(table.workspaceId, table.fileId),
      tenantPolicy('lead_identities_tenant_policy', table.workspaceId),
      backupReadPolicy('lead_identities'),
    ],
  )
  .enableRLS();

/**
 * Immutable provenance of every verified object. One row is written when a
 * file's candidate is attached; a replacement adds the next revision, so
 * review/version history survives even after the current `files` row is
 * tombstoned. `app_runtime` is granted only SELECT/INSERT.
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
      backupReadPolicy('file_revisions'),
    ],
  )
  .enableRLS();

/**
 * Staff review decisions on a file (approve/reject with a note). Append-only
 * and independent of the signature-verification `status`: a file can be
 * byte-verified (`available`) yet business-rejected by staff.
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
      backupReadPolicy('file_review_events'),
    ],
  )
  .enableRLS();

export type FileRecord = typeof files.$inferSelect;
export type FileRevision = typeof fileRevisions.$inferSelect;
export type FileReviewEvent = typeof fileReviewEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * One row per logical email send. `messageId` is the stable logical job
 * identifier used for provider-level dedupe, never regenerated on retry.
 * `contactHash` is a keyed digest, never the raw address, so this table never
 * carries an unhashed contact detail.
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
      contactHash: text('contact_hash').notNull(),
      status: text('status').default('queued').notNull(),
      providerId: text('provider_id'),
      provider: text('provider'),
      providerAccount: text('provider_account'),
      lastErrorCode: text('last_error_code'),
      lastEventAt: timestamp('last_event_at', { withTimezone: true, mode: 'date' }),
      /**
       * The `app.email_template_versions` version a site-content email was
       * rendered from (`0` for the built-in copy); null for an email that is
       * not from a site template.
       */
      templateVersion: integer('template_version'),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('email_messages_workspace_id_id_unique').on(table.workspaceId, table.id),
      check(
        'email_messages_template_version_check',
        sql`${table.templateVersion} is null or ${table.templateVersion} >= 0`,
      ),
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
      index('email_messages_workspace_lead_idx').on(table.workspaceId, table.leadId),
      tenantPolicy('email_messages_tenant_policy', table.workspaceId),
      backupReadPolicy('email_messages'),
    ],
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
      backupReadPolicy('deleted_email_messages'),
    ],
  )
  .enableRLS();

/**
 * Deliverability suppression — hard bounce, complaint, or manual address
 * block. Deliberately separate from `marketing_consents.marketingOptIn`: a
 * marketing opt-out never lands here, and transactional sends only ever check
 * this table, never the opt-out flag.
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
      backupReadPolicy('email_suppressions'),
    ],
  )
  .enableRLS();

/**
 * Marketing opt-in state (CASL). Recorded per lead at capture with the consent
 * version; unsubscribe writes a new row rather than mutating history so the
 * capture record is preserved. Only a false consent with the fixed
 * retained-opt-out version may omit the lead link, preventing older opt-ins
 * from becoming effective again after a lead is removed.
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
      check(
        'marketing_consents_reference_check',
        sql`${table.leadId} is not null or (${table.marketingOptIn} = false and ${table.version} = 'retained-opt-out')`,
      ),
      index('marketing_consents_workspace_contact_hash_idx').on(
        table.workspaceId,
        table.contactHash,
        table.capturedAt,
      ),
      index('marketing_consents_workspace_lead_idx').on(table.workspaceId, table.leadId),
      tenantPolicy('marketing_consents_tenant_policy', table.workspaceId),
      backupReadPolicy('marketing_consents'),
    ],
  )
  .enableRLS();

/**
 * Centrally stored follow-up due dates and eligibility. Staff can cancel a
 * scheduled sequence; the runner re-checks lead state, consent and
 * suppression immediately before sending, never trusting this row alone.
 */
export const followUpSchedules = appSchema
  .table(
    'follow_up_schedules',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadId: uuid('lead_id').notNull(),
      template: text('template').notNull(),
      dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
      status: text('status').default('scheduled').notNull(),
      cancelledReason: text('cancelled_reason'),
      cancelledByActorId: uuid('cancelled_by_actor_id'),
      sentMessageId: uuid('sent_message_id'),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('follow_up_schedules_workspace_id_id_unique').on(table.workspaceId, table.id),
      foreignKey({
        name: 'follow_up_schedules_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }),
      check(
        'follow_up_schedules_status_check',
        sql`${table.status} in ('scheduled', 'sent', 'cancelled', 'skipped')`,
      ),
      index('follow_up_schedules_workspace_due_idx').on(
        table.workspaceId,
        table.status,
        table.dueAt,
      ),
      index('follow_up_schedules_workspace_lead_idx').on(table.workspaceId, table.leadId),
      tenantPolicy('follow_up_schedules_tenant_policy', table.workspaceId),
      backupReadPolicy('follow_up_schedules'),
    ],
  )
  .enableRLS();

/**
 * Verified provider delivery-event inbox. Deduplicated by provider event ID
 * within a workspace/account so a replayed or duplicated webhook never
 * double-applies a bounce/complaint suppression.
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
      provider: text('provider').notNull(),
      providerAccount: text('provider_account').notNull(),
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
      backupReadPolicy('email_provider_events'),
    ],
  )
  .enableRLS();

export type EmailMessageRow = typeof emailMessages.$inferSelect;
export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;
export type MarketingConsentRow = typeof marketingConsents.$inferSelect;
export type FollowUpScheduleRow = typeof followUpSchedules.$inferSelect;
export type EmailProviderEventRow = typeof emailProviderEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Properties, layouts and saved views (phase 2)
// ---------------------------------------------------------------------------

const propertyObjectList = sql.raw(['lead', 'plan'].map((object) => `'${object}'`).join(', '));
const propertyKindList = sql.raw(
  [
    'text',
    'longText',
    'number',
    'money',
    'date',
    'dateTime',
    'count',
    'yesNo',
    'choice',
    'email',
    'phone',
    'url',
  ]
    .map((kind) => `'${kind}'`)
    .join(', '),
);

/**
 * A site's property definitions per object (`lead` or `plan`): a custom
 * property (`origin = 'custom'`, its values in `leads.custom_values` or
 * `plans.custom_values`) or an override of a built-in from the code catalogue (`origin =
 * 'builtin'`: a relabel or a hide). The runtime role cannot DELETE: a custom
 * property is tombstoned with `deleted_at`, and the unique key includes
 * tombstones, so a deleted key is reserved forever. `drizzle/0010_*.sql`
 * keeps a row's site, object, key, kind and origin fixed, a tombstone
 * permanent, and built-ins un-deletable.
 */
export const properties = appSchema
  .table(
    'properties',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      object: text('object').notNull(),
      key: text('key').notNull(),
      origin: text('origin').notNull(),
      label: text('label').notNull(),
      kind: text('kind').notNull(),
      options: jsonb('options').notNull().default([]),
      staffOnly: boolean('staff_only').default(false).notNull(),
      sensitive: boolean('sensitive').default(false).notNull(),
      hidden: boolean('hidden').default(false).notNull(),
      /**
       * A plan property's value is shown to the website (in its plan list
       * and in the plan frozen onto an order). Meaningful for `object =
       * 'plan'` only; the backend refuses it elsewhere.
       */
      websiteVisible: boolean('website_visible').default(false).notNull(),
      /** The lead types the property applies to; empty means every type. */
      leadTypes: text('lead_types')
        .array()
        .default(sql`'{}'::text[]`)
        .notNull(),
      position: integer('position').default(0).notNull(),
      version: integer('version').default(1).notNull(),
      createdBy: uuid('created_by'),
      updatedBy: uuid('updated_by'),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    },
    (table) => [
      unique('properties_workspace_id_id_unique').on(table.workspaceId, table.id),
      // Tombstones included on purpose: a deleted key is never reused.
      unique('properties_workspace_object_key_unique').on(
        table.workspaceId,
        table.object,
        table.key,
      ),
      check('properties_object_check', sql`${table.object} in (${propertyObjectList})`),
      check('properties_key_check', sql`${table.key} ~ '^[a-z][A-Za-z0-9_]{0,63}$'`),
      check('properties_origin_check', sql`${table.origin} in ('builtin', 'custom')`),
      check('properties_label_check', sql`length(${table.label}) between 1 and 80`),
      check('properties_kind_check', sql`${table.kind} in (${propertyKindList})`),
      check('properties_options_check', sql`jsonb_typeof(${table.options}) = 'array'`),
      tenantPolicy('properties_tenant_policy', table.workspaceId),
      backupReadPolicy('properties'),
    ],
  )
  .enableRLS();

/**
 * A site's record layout per object and lead type (`''` = the object's
 * default): ordered sections of property keys. One row per
 * `(site, object, lead type)`, replaced in place with `version`.
 */
export const propertyLayouts = appSchema
  .table(
    'property_layouts',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      object: text('object').notNull(),
      leadType: text('lead_type').default('').notNull(),
      layout: jsonb('layout').notNull(),
      version: integer('version').default(1).notNull(),
      updatedBy: uuid('updated_by'),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('property_layouts_workspace_object_lead_type_unique').on(
        table.workspaceId,
        table.object,
        table.leadType,
      ),
      check('property_layouts_object_check', sql`${table.object} in (${propertyObjectList})`),
      check('property_layouts_lead_type_check', sql`${table.leadType} ~ '^[a-z0-9_]{0,64}$'`),
      check('property_layouts_layout_check', sql`jsonb_typeof(${table.layout}) = 'object'`),
      tenantPolicy('property_layouts_tenant_policy', table.workspaceId),
      backupReadPolicy('property_layouts'),
    ],
  )
  .enableRLS();

/**
 * A person's private saved view of a list (the inbox state minus the
 * free-text search). The owner policy shows a row only to its own actor in
 * its own site, so a colleague's view id reads as missing; removing the
 * membership removes its views.
 */
export const savedViews = appSchema
  .table(
    'saved_views',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      actorId: uuid('actor_id').notNull(),
      object: text('object').notNull(),
      name: text('name').notNull(),
      state: jsonb('state').notNull(),
      version: integer('version').default(1).notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      foreignKey({
        name: 'saved_views_workspace_actor_fk',
        columns: [table.workspaceId, table.actorId],
        foreignColumns: [memberships.workspaceId, memberships.userId],
      }).onDelete('cascade'),
      uniqueIndex('saved_views_owner_name_unique').on(
        table.workspaceId,
        table.actorId,
        table.object,
        sql`lower(${table.name})`,
      ),
      check('saved_views_object_check', sql`${table.object} in ('lead')`),
      check('saved_views_name_check', sql`length(btrim(${table.name})) between 1 and 60`),
      check('saved_views_state_check', sql`jsonb_typeof(${table.state}) = 'object'`),
      ownerPolicy('saved_views_owner_policy', table.workspaceId, table.actorId),
      backupReadPolicy('saved_views'),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const billingPeriodList = sql.raw(
  ['one_time', 'month', '30_days', '90_days', 'year'].map((period) => `'${period}'`).join(', '),
);

/**
 * A site's plans, one order lead type each (`sim_order`, `internet`,
 * `mobility`): the built-in name, price (integer cents, CAD), billing period,
 * payment rule, active switch and required documents, plus the site's custom
 * plan properties in `custom_values` (`app.properties` with `object =
 * 'plan'`). An order keeps its own frozen copy of the plan in
 * `leads.order_details`, so changing a plan rewrites no order. The runtime
 * role cannot DELETE: a plan that is no longer sold is made inactive.
 * Grants, FORCE RLS and the Get Canada Sim seed are in `drizzle/0012_*.sql`.
 */
export const plans = appSchema
  .table(
    'plans',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      leadType: text('lead_type').notNull(),
      name: text('name').notNull(),
      priceMinor: bigint('price_minor', { mode: 'number' }).default(0).notNull(),
      currency: text('currency').default('CAD').notNull(),
      billingPeriod: text('billing_period').default('month').notNull(),
      paymentRequired: boolean('payment_required').default(false).notNull(),
      active: boolean('active').default(true).notNull(),
      requiredDocuments: text('required_documents')
        .array()
        .default(sql`'{}'::text[]`)
        .notNull(),
      customValues: jsonb('custom_values').notNull().default({}),
      position: integer('position').default(0).notNull(),
      version: integer('version').default(1).notNull(),
      createdBy: uuid('created_by'),
      updatedBy: uuid('updated_by'),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('plans_workspace_id_id_unique').on(table.workspaceId, table.id),
      uniqueIndex('plans_workspace_type_name_unique').on(
        table.workspaceId,
        table.leadType,
        sql`lower(${table.name})`,
      ),
      check('plans_lead_type_check', sql`${table.leadType} ~ '^[a-z0-9_]{1,64}$'`),
      check('plans_name_check', sql`length(btrim(${table.name})) between 1 and 120`),
      check('plans_price_minor_check', sql`${table.priceMinor} >= 0`),
      check('plans_currency_check', sql`${table.currency} = 'CAD'`),
      check('plans_billing_period_check', sql`${table.billingPeriod} in (${billingPeriodList})`),
      check('plans_custom_values_check', sql`jsonb_typeof(${table.customValues}) = 'object'`),
      tenantPolicy('plans_tenant_policy', table.workspaceId),
      backupReadPolicy('plans'),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------------
// Order tools and customer email
// ---------------------------------------------------------------------------

const quotedList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/** Must match contracts' idempotency scopes. */
const idempotencyScopeList = quotedList(['lead_submission']);
/** Must match contracts' email template keys. */
const emailTemplateKeyList = quotedList([
  'tracking_code',
  'order_received',
  'information_needed',
  'dispatched',
  'activated',
  'cancelled',
  'sim_number_ready',
]);
/** Must match contracts' `BUILT_IN_AUTOMATIONS` keys. */
const automationKeyList = quotedList([
  'order_received',
  'sim_order_information_needed',
  'sim_order_dispatched',
  'sim_order_activated',
  'sim_order_cancelled',
  'mobility_activated',
]);
const automationRunOutcomeList = quotedList(['queued', 'skipped']);
const automationRunReasonList = quotedList(['no_sender', 'no_customer_email', 'missing_fill_in']);

/** A plain address check; the backend validates addresses properly before they are stored. */
const emailAddressPattern = sql.raw(`'^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'`);

/**
 * A website's double-submit protection: the keyed hash of the
 * `Idempotency-Key` it sent, the fingerprint of the request body and, once
 * the request has done its work, the lead it made. Claimed in the lead's own
 * transaction; pruned after 7 days by `app.prune_operational_rows`.
 */
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
      leadId: uuid('lead_id'),
      status: text('status').default('pending').notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      createdAt: createdAt(),
    },
    (table) => [
      unique('idempotency_keys_scope_key_unique').on(table.workspaceId, table.scope, table.keyHash),
      foreignKey({
        name: 'idempotency_keys_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }).onDelete('cascade'),
      check('idempotency_keys_scope_check', sql`${table.scope} in (${idempotencyScopeList})`),
      check('idempotency_keys_key_hash_check', sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
      check(
        'idempotency_keys_request_fingerprint_check',
        sql`${table.requestFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
      ),
      check('idempotency_keys_status_check', sql`${table.status} in ('pending', 'completed')`),
      check(
        'idempotency_keys_completed_check',
        sql`(${table.status} = 'completed') = (${table.completedAt} is not null and ${table.leadId} is not null)`,
      ),
      index('idempotency_keys_workspace_created_idx').on(table.workspaceId, table.createdAt),
      tenantPolicy('idempotency_keys_tenant_policy', table.workspaceId),
      backupReadPolicy('idempotency_keys'),
    ],
  )
  .enableRLS();

/**
 * A site's customer email identity and look (Settings → Email): the sender,
 * reply-to, logo, brand colour, footer and website link every customer email
 * of the site uses. One row per site, absent until an owner saves it.
 */
export const workspaceEmailSettings = appSchema
  .table(
    'workspace_email_settings',
    {
      workspaceId: uuid('workspace_id')
        .primaryKey()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      fromName: text('from_name').notNull(),
      fromAddress: text('from_address').notNull(),
      replyTo: text('reply_to'),
      logoUrl: text('logo_url'),
      brandColor: text('brand_color').default('#d72638').notNull(),
      footerText: text('footer_text').default('').notNull(),
      siteUrl: text('site_url'),
      updatedBy: uuid('updated_by').notNull(),
      updatedAt: updatedAt(),
    },
    (table) => [
      check(
        'workspace_email_settings_from_name_check',
        sql`char_length(btrim(${table.fromName})) between 1 and 80`,
      ),
      check(
        'workspace_email_settings_from_address_check',
        sql`char_length(${table.fromAddress}) <= 254 and ${table.fromAddress} ~ ${emailAddressPattern}`,
      ),
      check(
        'workspace_email_settings_reply_to_check',
        sql`${table.replyTo} is null or (char_length(${table.replyTo}) <= 254 and ${table.replyTo} ~ ${emailAddressPattern})`,
      ),
      check(
        'workspace_email_settings_logo_url_check',
        sql`${table.logoUrl} is null or (char_length(${table.logoUrl}) <= 2048 and ${table.logoUrl} ~ '^https://')`,
      ),
      check(
        'workspace_email_settings_brand_color_check',
        sql`${table.brandColor} ~ '^#[0-9a-f]{6}$'`,
      ),
      check(
        'workspace_email_settings_footer_text_check',
        sql`char_length(${table.footerText}) <= 500`,
      ),
      check(
        'workspace_email_settings_site_url_check',
        sql`${table.siteUrl} is null or (char_length(${table.siteUrl}) <= 2048 and ${table.siteUrl} ~ '^https://')`,
      ),
      tenantPolicy('workspace_email_settings_tenant_policy', table.workspaceId),
      backupReadPolicy('workspace_email_settings'),
    ],
  )
  .enableRLS();

/**
 * A site's current copy of one customer email (subject and body in the
 * template markup), at `version`. Content only: whether and when it is sent
 * is an automation's call (`app.automations`). Every save also appends its
 * version to `app.email_template_versions`.
 */
export const emailTemplates = appSchema
  .table(
    'email_templates',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      key: text('key').notNull(),
      subject: text('subject').notNull(),
      body: text('body').notNull(),
      version: integer('version').notNull(),
      updatedBy: uuid('updated_by').notNull(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('email_templates_workspace_key_unique').on(table.workspaceId, table.key),
      check('email_templates_key_check', sql`${table.key} in (${emailTemplateKeyList})`),
      check('email_templates_subject_check', sql`char_length(${table.subject}) between 1 and 150`),
      check('email_templates_body_check', sql`char_length(${table.body}) between 1 and 5000`),
      check('email_templates_version_check', sql`${table.version} > 0`),
      tenantPolicy('email_templates_tenant_policy', table.workspaceId),
      backupReadPolicy('email_templates'),
    ],
  )
  .enableRLS();

/**
 * Every saved version of a site's template, append-only (`app_runtime` has
 * SELECT and INSERT only), so a sent email's `template_version` always names
 * the copy it was rendered from.
 */
export const emailTemplateVersions = appSchema
  .table(
    'email_template_versions',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      key: text('key').notNull(),
      version: integer('version').notNull(),
      subject: text('subject').notNull(),
      body: text('body').notNull(),
      createdBy: uuid('created_by').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('email_template_versions_workspace_key_version_unique').on(
        table.workspaceId,
        table.key,
        table.version,
      ),
      check('email_template_versions_key_check', sql`${table.key} in (${emailTemplateKeyList})`),
      check(
        'email_template_versions_subject_check',
        sql`char_length(${table.subject}) between 1 and 150`,
      ),
      check(
        'email_template_versions_body_check',
        sql`char_length(${table.body}) between 1 and 5000`,
      ),
      check('email_template_versions_version_check', sql`${table.version} > 0`),
      tenantPolicy('email_template_versions_tenant_policy', table.workspaceId),
      backupReadPolicy('email_template_versions'),
    ],
  )
  .enableRLS();

/**
 * A site's state of one automation rule: on or off (off until an owner
 * switches it on), when it last ran and how many times. The rules themselves
 * (trigger and action) are defined in code, contracts `BUILT_IN_AUTOMATIONS`;
 * phase 8's builder adds custom rules here.
 */
export const automations = appSchema
  .table(
    'automations',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      key: text('key').notNull(),
      enabled: boolean('enabled').default(false).notNull(),
      lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
      runCount: integer('run_count').default(0).notNull(),
      updatedBy: uuid('updated_by').notNull(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('automations_workspace_key_unique').on(table.workspaceId, table.key),
      check('automations_key_check', sql`${table.key} in (${automationKeyList})`),
      check('automations_run_count_check', sql`${table.runCount} >= 0`),
      tenantPolicy('automations_tenant_policy', table.workspaceId),
      backupReadPolicy('automations'),
    ],
  )
  .enableRLS();

/**
 * One firing of an automation for a lead, append-only: `queued` with the
 * outbox job it queued, or `skipped` with why. Pruned after 90 days by
 * `app.prune_operational_rows`.
 */
export const automationRuns = appSchema
  .table(
    'automation_runs',
    {
      id: uuid('id').defaultRandom().primaryKey(),
      workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
      automationKey: text('automation_key').notNull(),
      leadId: uuid('lead_id').notNull(),
      outcome: text('outcome').notNull(),
      reason: text('reason'),
      jobId: uuid('job_id'),
      createdAt: createdAt(),
    },
    (table) => [
      foreignKey({
        name: 'automation_runs_workspace_lead_fk',
        columns: [table.workspaceId, table.leadId],
        foreignColumns: [leads.workspaceId, leads.id],
      }).onDelete('cascade'),
      check(
        'automation_runs_automation_key_check',
        sql`${table.automationKey} in (${automationKeyList})`,
      ),
      check(
        'automation_runs_outcome_check',
        sql`${table.outcome} in (${automationRunOutcomeList})`,
      ),
      check(
        'automation_runs_reason_check',
        sql`${table.reason} is null or ${table.reason} in (${automationRunReasonList})`,
      ),
      check(
        'automation_runs_skipped_reason_check',
        sql`(${table.outcome} = 'skipped') = (${table.reason} is not null)`,
      ),
      check(
        'automation_runs_queued_job_check',
        sql`(${table.outcome} = 'queued') = (${table.jobId} is not null)`,
      ),
      index('automation_runs_workspace_key_created_idx').on(
        table.workspaceId,
        table.automationKey,
        table.createdAt.desc(),
      ),
      tenantPolicy('automation_runs_tenant_policy', table.workspaceId),
      backupReadPolicy('automation_runs'),
    ],
  )
  .enableRLS();

export const schema = {
  workspaces,
  memberships,
  roles,
  membershipRoles,
  permissions,
  membershipPermissions,
  contacts,
  leads,
  leadActivities,
  leadTasks,
  draftGrants,
  outboxJobs,
  outboxJobAlerts,
  serviceCredentials,
  rateLimitBuckets,
  auditEvents,
  files,
  leadIdentities,
  fileRevisions,
  fileReviewEvents,
  emailMessages,
  deletedEmailMessages,
  emailSuppressions,
  marketingConsents,
  followUpSchedules,
  emailProviderEvents,
  properties,
  propertyLayouts,
  savedViews,
  plans,
  idempotencyKeys,
  workspaceEmailSettings,
  emailTemplates,
  emailTemplateVersions,
  automations,
  automationRuns,
};
