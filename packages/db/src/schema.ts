import { sql } from 'drizzle-orm';
import {
  leadStatuses,
  membershipStatuses,
  permissionEffects,
  staffPermissionNames,
  staffRoleNames,
} from '@gt-sales/types';
import {
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
 * that forgets its tenant filter sees nothing rather than everything.
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
      createdAt: createdAt(),
      updatedAt: updatedAt(),
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
};
