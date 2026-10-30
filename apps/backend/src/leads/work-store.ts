import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  leadActivities,
  leads,
  leadTasks,
  outboxJobs,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  ORDER_PROPERTY_KEYS,
  ORDER_STORAGE_KEYS,
  applyCustomValueEdits,
  applyLeadFormEdit,
  freezePlan,
  isLeadStage,
  isOrderLeadType,
  leadFormSchema,
  leadTypeEntry,
  type QueueCustomerEmailRequest,
  type LeadActivity,
  type LeadAssigneeFilter,
  type LeadBoardColumn,
  type LeadContactEdit,
  type LeadDetail,
  type LeadForm,
  type LeadOrder,
  type LeadOrderEdit,
  type PlanSnapshot,
  type LeadPropertyFilter,
  type LeadTask,
  type LeadTaskStatus,
  type PropertyCatalog,
  type TaskAssigneeFilter,
  type LeadTypeCount,
  type WorkspaceTask,
} from '@gt-sales/contracts';

import { draftCustomerEmail } from '../email/customer-emails.js';
import { loadPlanForFreeze } from '../plans/store.js';
import { findMissingDocuments } from './documents-check.js';
import { isPlanAvailable, toLeadOrder } from './order.js';
import { planStageMove, todayInToronto, type StageMoveRefusal } from './stage-move.js';
import {
  iso,
  selectLeadBoard,
  selectLeadDetail,
  selectLeadStats,
  selectLeadSummary,
  selectLeadWithWork,
  selectTask,
  selectWorkspaceTasks,
  toLeadActivity,
  type ActivityRow,
  type LeadFilters,
  type LeadStats,
  type LeadWithWork,
} from './staff-queries.js';
import type { Scope, WriteScope } from '../tenant-scope.js';
import { upsertContact } from './store.js';

/**
 * Staff working a lead: the lead page's reads and every write a staff member
 * makes (stage, assignee, contact corrections, order details, notes, tasks,
 * archive). Each write runs in one tenant transaction that locks the lead,
 * records what changed on the append-only timeline, and writes an audit
 * event. Neither the
 * timeline nor the audit trail stores contact values or note text a second
 * time: an edit records the field names, a note's audit event its id.
 */

export type { Scope, WriteScope };

export type LeadWorkResult = LeadWithWork;

export type UpdateLeadWorkOutcome =
  | { status: 'updated'; lead: LeadDetail; activities: LeadActivity[] }
  | { status: 'not_found' | 'trashed' | 'invalid_stage' | 'assignee_not_found' }
  /** A form correction the type does not allow; names the field, never the value. */
  | { status: 'invalid_field'; field: string }
  /** A move the type does not allow, or one whose dispatch or activation details are missing. */
  | StageMoveRefusal
  /** The required documents of the order's plan that have no approved current file. */
  | { status: 'documents_incomplete'; missing: string[] }
  /** An override reason was given but is blank. */
  | { status: 'document_override_reason_required' };

export type ArchiveLeadOutcome =
  | { status: 'changed' | 'unchanged'; lead: LeadDetail; activity: LeadActivity | null }
  | { status: 'not_found' };

export type NoteOutcome =
  { status: 'created'; activity: LeadActivity } | { status: 'not_found' } | { status: 'trashed' };

export type CustomerEmailOutcome =
  | { status: 'queued'; activity: LeadActivity }
  | { status: 'not_found' }
  | { status: 'trashed' }
  | { status: 'missing'; missing: 'email' | 'simNumber' };

export interface QueueCustomerEmailInput extends WriteScope {
  leadId: string;
  template: QueueCustomerEmailRequest['template'];
  /** The site's public address, for the mail's link back to it. */
  siteUrl?: string;
  /** The keyed digest of the address, for suppression and delivery records. */
  contactHash(email: string): string;
}

export type TaskOutcome =
  { status: 'saved'; task: LeadTask } | { status: 'not_found' | 'trashed' | 'assignee_not_found' };

export interface UpdateLeadWorkInput extends WriteScope {
  leadId: string;
  stage?: string;
  /** `null` unassigns; `undefined` leaves the assignee alone. */
  assignedActorId?: string | null;
  contact?: LeadContactEdit;
  /** Corrections to the form's editable fields; null clears one. */
  form?: Record<string, string | number | boolean | null>;
  /** New values of the site's custom properties; null clears one. */
  customValues?: Record<string, string | number | boolean | null>;
  /** The site's property catalogue, loaded once for the request; custom values are checked against it. */
  catalog: PropertyCatalog;
  /** Order details of an order lead type: a new `planId` re-freezes the plan, null clears it. */
  order?: LeadOrderEdit;
  /**
   * Why the stage move goes ahead without the plan's documents approved. The
   * route admits it only from an actor with `order.override`; the store
   * trusts it. Ignored when nothing is missing.
   */
  documentsOverrideReason?: string;
}

export interface CreateTaskInput extends WriteScope {
  leadId: string;
  title: string;
  dueAt?: string | null;
  assignedActorId?: string | null;
}

export interface UpdateTaskInput extends WriteScope {
  taskId: string;
  title?: string;
  dueAt?: string | null;
  assignedActorId?: string | null;
  status?: LeadTaskStatus;
}

export interface LeadWorkStore {
  /** With `dueBy`, each type also counts its leads with a follow-up due by that day. */
  summary(input: Scope & { dueBy?: string }): Promise<{ types: LeadTypeCount[]; archived: number }>;
  /** The dashboard's counts for one type, received in the last `days` days or ever. */
  stats(input: Scope & { leadType: string; days?: number }): Promise<LeadStats>;
  board(
    input: Scope & {
      leadType: string;
      assignee?: LeadAssigneeFilter;
      search?: string;
      where?: readonly LeadPropertyFilter[];
      /** The site's property catalogue `where` was validated against. */
      catalog: PropertyCatalog;
    },
    perStage: number,
  ): Promise<LeadBoardColumn[]>;
  /**
   * `includeWork: false` skips the timeline, tasks, related requests, identities, documents and custom values for a caller who may not see them.
   * `catalog` is the site's property catalogue, loaded once for the request.
   */
  getLead(
    input: Scope & { leadId: string; includeWork: boolean; catalog: PropertyCatalog },
  ): Promise<LeadWorkResult | undefined>;
  updateLead(input: UpdateLeadWorkInput): Promise<UpdateLeadWorkOutcome>;
  /** Archives a lead (or restores one); the timeline and audit keep the `trashed`/`restored` names. */
  setArchived(
    input: WriteScope & { leadId: string; archived: boolean },
  ): Promise<ArchiveLeadOutcome>;
  /** The first open by someone who works leads; null activity when it was already opened. */
  markOpened(
    input: WriteScope & { leadId: string },
  ): Promise<{ status: 'opened'; activity: LeadActivity | null } | { status: 'not_found' }>;
  addNote(input: WriteScope & { leadId: string; body: string }): Promise<NoteOutcome>;
  /** Queues a mail to the lead's customer in the outbox, with its timeline entry. */
  queueCustomerEmail(input: QueueCustomerEmailInput): Promise<CustomerEmailOutcome>;
  createTask(input: CreateTaskInput): Promise<TaskOutcome>;
  updateTask(input: UpdateTaskInput): Promise<TaskOutcome>;
  listTasks(
    input: Scope & { assignee: TaskAssigneeFilter; status: LeadTaskStatus; dueBy?: string },
    page: number,
    pageSize: number,
  ): Promise<{ tasks: WorkspaceTask[]; total: number }>;
}

interface LockedLead {
  [key: string]: unknown;
  id: string;
  leadType: string;
  stage: string;
  assignedActorId: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  externalRef: string | null;
  trashed: boolean;
  payload: unknown;
  customValues: unknown;
  orderDetails: unknown;
}

const isStoredObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stored form, or an empty version-1 one for a lead that has none yet. */
function storedForm(payload: unknown): LeadForm {
  const form = leadFormSchema.safeParse(payload);
  return form.success ? form.data : { schemaVersion: 1, payload: {} };
}

/** The lead, locked for the rest of the transaction; restricted leads do not exist here. */
async function lockLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<LockedLead | undefined> {
  const [row] = await tx.execute<LockedLead>(sql`
    select
      l.id,
      l.lead_type as "leadType",
      l.stage,
      l.assigned_actor_id as "assignedActorId",
      l.full_name as "fullName",
      l.email,
      l.phone,
      l.country_code as "countryCode",
      l.external_ref as "externalRef",
      l.deleted_at is not null as trashed,
      l.payload,
      l.custom_values as "customValues",
      l.order_details as "orderDetails"
    from app.leads l
    where l.workspace_id = ${workspaceId}
      and l.id = ${leadId}
      and l.customer_data_restricted_at is null
    for update
  `);
  return row;
}

/** Only an active staff member of this site can be given a lead or a task. */
async function isActiveMember(
  tx: TenantTransaction,
  workspaceId: string,
  actorId: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    select 1
    from app.memberships m
    where m.workspace_id = ${workspaceId}
      and m.user_id = ${actorId}
      and m.membership_type = 'staff'
      and m.status = 'active'
    limit 1
  `);
  return rows.length > 0;
}

async function requireDetail(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  catalog?: PropertyCatalog,
): Promise<LeadDetail> {
  const detail = await selectLeadDetail(tx, workspaceId, leadId, catalog);
  if (!detail) throw new Error('lead vanished inside its own transaction');
  return detail;
}

async function requireTask(
  tx: TenantTransaction,
  workspaceId: string,
  taskId: string,
): Promise<LeadTask> {
  const task = await selectTask(tx, workspaceId, taskId);
  if (!task) throw new Error('task vanished inside its own transaction');
  return task;
}

/** A timeline insert returns its entries, so the response needs no second read. */
const ACTIVITY_RETURNING = {
  id: leadActivities.id,
  actorId: leadActivities.actorId,
  kind: leadActivities.kind,
  body: leadActivities.body,
  data: leadActivities.data,
  createdAt: leadActivities.createdAt,
};

interface InsertedActivity {
  id: string;
  actorId: string;
  kind: string;
  body: string | null;
  data: unknown;
  createdAt: Date;
}

/** Newly written timeline rows as entries, in the lead page's order: newest first, ties by id descending. */
function insertedActivities(rows: readonly InsertedActivity[]): LeadActivity[] {
  return rows
    .map((row) => toLeadActivity({ ...row, createdAt: row.createdAt.toISOString() }))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}

const CONTACT_FIELDS = ['fullName', 'email', 'phone'] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

type OrderEditResult =
  | {
      ok: true;
      /** The stored object with only the changed fields written over it. */
      stored: Record<string, unknown>;
      changedKeys: string[];
    }
  | { ok: false; field: string };

/** The stored `order_details` as an object to write over; anything else reads as empty. */
function storedObject(stored: unknown): Record<string, unknown> {
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? Object.fromEntries(Object.entries(stored))
    : {};
}

/** JSON text with every object's keys sorted: a stored copy comes back from JSONB in its own key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Two frozen copies of one plan are the same when only the moment they were taken differs. */
function sameSnapshot(a: PlanSnapshot | null, b: PlanSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return canonicalJson({ ...a, frozenAt: '' }) === canonicalJson({ ...b, frozenAt: '' });
}

/** The dispatch and activation details: text or a date each, null clears one. */
const ORDER_DETAIL_FIELDS = [
  'courier',
  'trackingNumber',
  'dispatchedAt',
  'activatedAt',
  'activationNumber',
  'activationAccount',
] as const;

/**
 * The stored order as the audit trail keeps it: without the dispatch and
 * activation details, whose activation number is the customer's phone and
 * whose account and tracking number identify them too. The edit's
 * `changedFields` names which of them changed; nothing scrubs an audit row.
 */
function auditedOrder(stored: unknown): Record<string, unknown> {
  const details: ReadonlySet<string> = new Set(ORDER_DETAIL_FIELDS);
  return Object.fromEntries(
    Object.entries(storedObject(stored)).filter(([key]) => !details.has(key)),
  );
}

/** One staff audit event on a lead. */
async function auditLead(
  tx: TenantTransaction,
  scope: WriteScope & { leadId: string },
  action: string,
  values: { before?: Record<string, unknown>; after: Record<string, unknown> },
): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: scope.workspaceId,
    actorId: scope.actorId,
    actorLabel: 'staff actor',
    action,
    entity: 'lead',
    entityId: scope.leadId,
    requestId: scope.requestId,
    ...values,
  });
}

/**
 * Staff's change to a lead's order: a new plan is frozen from the site's
 * current plan (it must be active and of the lead's type, else the `plan`
 * field is refused), null clears the link and the copy, and the quantity, the
 * two statuses and the dispatch and activation details are set as given.
 * Names the changed catalogue keys.
 * Only the changed fields are written over the stored object: a key the
 * parse does not know, or a stored value it cannot read, survives an
 * unrelated edit, and so does the frozen copy while the plan stays the same.
 */
async function editOrder(
  tx: TenantTransaction,
  workspaceId: string,
  lead: LockedLead,
  edit: LeadOrderEdit,
): Promise<OrderEditResult> {
  if (!isOrderLeadType(lead.leadType)) return { ok: false, field: 'order' };
  const current = toLeadOrder(lead.orderDetails);
  const next: LeadOrder = { ...current };
  const changed = new Set<keyof LeadOrderEdit>();

  if (edit.planId === null) {
    next.planId = null;
    next.plan = null;
  } else if (edit.planId !== undefined) {
    const found = await loadPlanForFreeze(tx, workspaceId, edit.planId);
    if (!isPlanAvailable(found, lead.leadType)) return { ok: false, field: 'plan' };
    next.planId = found.plan.id;
    next.plan = freezePlan(found.plan, found.visibleKeys, new Date());
  }
  if (next.planId !== current.planId || !sameSnapshot(next.plan, current.plan)) {
    changed.add('planId');
  }
  if (edit.quantity !== undefined && edit.quantity !== current.quantity) {
    next.quantity = edit.quantity;
    changed.add('quantity');
  }
  if (edit.paymentStatus !== undefined && edit.paymentStatus !== current.paymentStatus) {
    next.paymentStatus = edit.paymentStatus;
    changed.add('paymentStatus');
  }
  if (
    edit.carrierCommission !== undefined &&
    edit.carrierCommission !== current.carrierCommission
  ) {
    next.carrierCommission = edit.carrierCommission;
    changed.add('carrierCommission');
  }
  for (const field of ORDER_DETAIL_FIELDS) {
    const value = edit[field];
    if (value !== undefined && value !== current[field]) {
      next[field] = value;
      changed.add(field);
    }
  }
  // Each changed field under its stored name (`ORDER_STORAGE_KEYS`: `plan` is
  // `planId`); a new plan writes its frozen copy with it. A re-freeze of the
  // same plan with nothing new keeps the copy already held, as stored.
  const written: Record<string, unknown> = {};
  const changedKeys: string[] = [];
  for (const key of ORDER_PROPERTY_KEYS) {
    const field = ORDER_STORAGE_KEYS[key];
    if (!changed.has(field)) continue;
    changedKeys.push(key);
    written[field] = next[field];
    if (field === 'planId') written['plan'] = next.plan;
  }
  return {
    ok: true,
    stored: { ...storedObject(lead.orderDetails), ...written },
    changedKeys,
  };
}

type LeadDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const defaultLeadDatabase: LeadDatabase = { withTenantTx };

export class DatabaseLeadWorkStore implements LeadWorkStore {
  constructor(private readonly database: LeadDatabase = defaultLeadDatabase) {}

  summary(input: Scope & { dueBy?: string }) {
    return this.database.withTenantTx(input, (tx) => selectLeadSummary(tx, input.dueBy));
  }

  stats(input: Scope & { leadType: string; days?: number }) {
    const lost = leadTypeEntry(input.leadType)?.outcomes?.lost.stages ?? [];
    return this.database.withTenantTx(input, (tx) =>
      selectLeadStats(tx, { leadType: input.leadType, days: input.days, lost }),
    );
  }

  board(
    input: Scope & {
      leadType: string;
      assignee?: LeadAssigneeFilter;
      search?: string;
      where?: readonly LeadPropertyFilter[];
      catalog: PropertyCatalog;
    },
    perStage: number,
  ) {
    const filters: LeadFilters & { leadType: string } = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      leadType: input.leadType,
      assignee: input.assignee,
      search: input.search,
      where: input.where,
      catalog: input.catalog,
    };
    return this.database.withTenantTx(input, (tx) => selectLeadBoard(tx, filters, perStage));
  }

  getLead(input: Scope & { leadId: string; includeWork: boolean; catalog: PropertyCatalog }) {
    return this.database.withTenantTx(input, async (tx) => {
      if (input.includeWork) {
        return selectLeadWithWork(tx, input.workspaceId, input.leadId, input.catalog);
      }
      const detail = await selectLeadDetail(tx, input.workspaceId, input.leadId, input.catalog);
      if (!detail) return undefined;
      // Custom values and the order travel with contact visibility, as the form does.
      const { customValues: _customValues, order: _order, ...rest } = detail;
      const lead: LeadDetail = rest;
      return { lead, activities: [], tasks: [], related: [], identities: [], documents: [] };
    });
  }

  updateLead(input: UpdateLeadWorkInput): Promise<UpdateLeadWorkOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };

      const set: Partial<typeof leads.$inferInsert> = {};
      const entries: Array<{ kind: string; data: Record<string, unknown> }> = [];
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      // The order edit to write: the one given, with the dates a move defaults.
      let orderEdit = input.order;
      let override: { reason: string; missing: string[] } | undefined;
      if (input.stage !== undefined && input.stage !== lead.stage) {
        if (!isLeadStage(lead.leadType, input.stage)) return { status: 'invalid_stage' };
        const current = toLeadOrder(lead.orderDetails);
        const move = planStageMove({
          leadType: lead.leadType,
          from: lead.stage,
          to: input.stage,
          current,
          edit: input.order,
          today: todayInToronto(new Date()),
        });
        if (!move.ok) return move.refusal;
        const reason = input.documentsOverrideReason?.trim();
        if (reason === '') return { status: 'document_override_reason_required' };
        if (move.gates.includes('documents')) {
          // What the frozen plan requires; no plan, or a plan from before the field, requires nothing.
          const missing = await findMissingDocuments(tx, {
            workspaceId: input.workspaceId,
            leadId: input.leadId,
            required: current.plan?.requiredDocuments ?? [],
          });
          if (missing.length > 0) {
            if (reason === undefined) return { status: 'documents_incomplete', missing };
            override = { reason, missing };
          }
        }
        orderEdit = move.order;
        set.stage = input.stage;
        entries.push({ kind: 'status_change', data: { from: lead.stage, to: input.stage } });
        before['stage'] = lead.stage;
        after['stage'] = input.stage;
      }

      if (input.assignedActorId !== undefined && input.assignedActorId !== lead.assignedActorId) {
        if (
          input.assignedActorId !== null &&
          !(await isActiveMember(tx, input.workspaceId, input.assignedActorId))
        ) {
          return { status: 'assignee_not_found' };
        }
        set.assignedActorId = input.assignedActorId;
        entries.push({
          kind: 'assignment',
          data: { from: lead.assignedActorId, to: input.assignedActorId },
        });
        before['assignedActorId'] = lead.assignedActorId;
        after['assignedActorId'] = input.assignedActorId;
      }

      const contact = input.contact;
      const changed: ContactField[] = contact
        ? CONTACT_FIELDS.filter(
            (field) => contact[field] !== undefined && contact[field] !== lead[field],
          )
        : [];
      if (contact && changed.length > 0) {
        const next = {
          fullName: contact.fullName ?? lead.fullName,
          email: contact.email ?? lead.email,
          phone: contact.phone ?? lead.phone,
        };
        if (changed.includes('fullName')) set.fullName = next.fullName;
        if (changed.includes('email')) set.email = next.email;
        if (changed.includes('phone')) set.phone = next.phone;
        // A corrected address moves the lead to that person's contact; a
        // corrected name or phone refreshes the contact it already has.
        if (next.email) {
          set.contactId = await upsertContact(tx, {
            email: next.email,
            fullName: next.fullName ?? undefined,
            phone: next.phone ?? undefined,
            countryCode: lead.countryCode ?? undefined,
          });
        }
      }

      const changedForm: string[] = [];
      if (input.form && Object.keys(input.form).length > 0) {
        const form = storedForm(lead.payload);
        const edit = applyLeadFormEdit(lead.leadType, form.payload, input.form);
        if (!edit.ok) return { status: 'invalid_field', field: edit.field };
        if (edit.changed.length > 0) {
          set.payload = { schemaVersion: form.schemaVersion, payload: edit.payload };
          changedForm.push(...edit.changed);
        }
      }

      const changedCustom: string[] = [];
      if (input.customValues && Object.keys(input.customValues).length > 0) {
        // Only the custom properties this type shows; a hidden or unknown key is refused.
        const current = isStoredObject(lead.customValues) ? lead.customValues : {};
        const edit = applyCustomValueEdits({
          properties: input.catalog.forType(lead.leadType),
          current,
          edits: input.customValues,
        });
        if (!edit.ok) return { status: 'invalid_field', field: edit.field };
        if (edit.changedKeys.length > 0) {
          // Only the changed keys are written; every other stored value stays as it is.
          const cleared = edit.changedKeys.filter((key) => !Object.hasOwn(edit.values, key));
          const setValues = Object.fromEntries(
            edit.changedKeys.flatMap((key) =>
              Object.hasOwn(edit.values, key) ? [[key, edit.values[key]]] : [],
            ),
          );
          const remaining = cleared.reduce(
            (expression, key) => sql`(${expression} - ${key}::text)`,
            sql`${leads.customValues}`,
          );
          set.customValues = sql`(${remaining} || ${JSON.stringify(setValues)}::jsonb)`;
          changedCustom.push(...edit.changedKeys);
        }
      }

      const changedOrder: string[] = [];
      let storedOrder: Record<string, unknown> | undefined;
      if (orderEdit) {
        const edit = await editOrder(tx, input.workspaceId, lead, orderEdit);
        if (!edit.ok) return { status: 'invalid_field', field: edit.field };
        if (edit.changedKeys.length > 0) {
          storedOrder = edit.stored;
          changedOrder.push(...edit.changedKeys);
        }
      }
      if (override) {
        // Only a move that actually went past missing documents records an override.
        storedOrder = {
          ...(storedOrder ?? storedObject(lead.orderDetails)),
          documentsOverride: { ...override, at: new Date().toISOString() },
        };
      }
      if (storedOrder) {
        set.orderDetails = storedOrder;
        before['order'] = auditedOrder(lead.orderDetails);
        after['order'] = auditedOrder(storedOrder);
      }

      // One entry for the whole correction, naming the fields (built-in, custom and order) and never their values.
      const changedFields = [...changed, ...changedForm, ...changedCustom, ...changedOrder];
      if (changedFields.length > 0) {
        entries.push({ kind: 'edit', data: { fields: changedFields } });
        after['changedFields'] = changedFields;
      }
      if (override) {
        entries.push({
          kind: 'system',
          data: { event: 'documents_override', missing: override.missing, reason: override.reason },
        });
      }

      if (entries.length === 0) {
        return {
          status: 'updated',
          lead: await requireDetail(tx, input.workspaceId, input.leadId, input.catalog),
          activities: [],
        };
      }

      await tx
        .update(leads)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      const inserted = await tx
        .insert(leadActivities)
        .values(
          entries.map((entry) => ({
            workspaceId: input.workspaceId,
            leadId: input.leadId,
            actorId: input.actorId,
            kind: entry.kind,
            data: entry.data,
          })),
        )
        .returning(ACTIVITY_RETURNING);
      await auditLead(tx, input, 'lead.updated', { before, after });
      if (override) {
        await auditLead(tx, input, 'lead.documents_overridden', {
          after: {
            from: lead.stage,
            to: input.stage,
            missing: override.missing,
            reason: override.reason,
          },
        });
      }

      return {
        status: 'updated',
        lead: await requireDetail(tx, input.workspaceId, input.leadId, input.catalog),
        activities: insertedActivities(inserted),
      };
    });
  }

  markOpened(
    input: WriteScope & { leadId: string },
  ): Promise<{ status: 'opened'; activity: LeadActivity | null } | { status: 'not_found' }> {
    return this.database.withTenantTx(input, async (tx) => {
      // Locked, so two people opening the lead at once write one entry.
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      // Opening is not work on the lead: `updated_at` (the inbox's order) stays.
      const inserted = await tx.execute<ActivityRow>(sql`
        insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, data)
        select ${input.workspaceId}::uuid, ${input.leadId}::uuid, ${input.actorId}::uuid,
               'system', '{"event":"opened"}'::jsonb
        where not exists (
          select 1 from app.lead_activities opened
          where opened.workspace_id = ${input.workspaceId}
            and opened.lead_id = ${input.leadId}
            and opened.kind = 'system'
            and opened.data ->> 'event' = 'opened'
        )
        returning id, actor_id as "actorId", kind, body, data, ${iso('created_at')} as "createdAt"
      `);
      const [row] = inserted;
      return { status: 'opened', activity: row ? toLeadActivity(row) : null };
    });
  }

  setArchived(
    input: WriteScope & { leadId: string; archived: boolean },
  ): Promise<ArchiveLeadOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed === input.archived) {
        return {
          status: 'unchanged',
          lead: await requireDetail(tx, input.workspaceId, input.leadId),
          activity: null,
        };
      }

      // Archiving is a visibility change, not work on the lead, so
      // `updated_at` (the inbox's order) is left alone and a restored lead
      // returns to its old place. Stored names stay `trashed`/`restored`.
      await tx
        .update(leads)
        .set({ deletedAt: input.archived ? new Date() : null })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      const [entry] = await tx
        .insert(leadActivities)
        .values({
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          actorId: input.actorId,
          kind: 'system',
          data: { event: input.archived ? 'trashed' : 'restored' },
        })
        .returning(ACTIVITY_RETURNING);
      if (!entry) throw new Error('activity insert did not return a row');
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: input.archived ? 'lead.trashed' : 'lead.restored',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        before: { trashed: lead.trashed },
        after: { trashed: input.archived },
      });

      const [activity] = insertedActivities([entry]);
      return {
        status: 'changed',
        lead: await requireDetail(tx, input.workspaceId, input.leadId),
        activity: activity ?? null,
      };
    });
  }

  queueCustomerEmail(input: QueueCustomerEmailInput): Promise<CustomerEmailOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };
      const draft = draftCustomerEmail(
        input.template,
        { ...lead, form: storedForm(lead.payload).payload },
        { siteUrl: input.siteUrl },
      );
      if (!draft.ok) return { status: 'missing', missing: draft.missing };

      // Sent by the outbox, after this commits; the address and the mail's
      // contents live only in the job, never on the timeline or in the audit.
      const [job] = await tx
        .insert(outboxJobs)
        .values({
          workspaceId: input.workspaceId,
          jobType: draft.jobType,
          // One mail per request: sending again is a second, deliberate mail.
          dedupeKey: `${input.leadId}:${input.requestId}`,
          payload: {
            leadId: input.leadId,
            toAddress: draft.toAddress,
            contactHash: input.contactHash(draft.toAddress),
            ...(draft.reference ? { reference: draft.reference } : {}),
            variables: draft.variables,
          },
        })
        .returning({ id: outboxJobs.id });
      if (!job) throw new Error('outbox insert did not return a row');
      const [entry] = await tx
        .insert(leadActivities)
        .values({
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          actorId: input.actorId,
          kind: 'system',
          data: { event: 'customer_emailed', template: input.template },
        })
        .returning(ACTIVITY_RETURNING);
      if (!entry) throw new Error('activity insert did not return a row');
      // Writing to the customer is work on the lead: it moves up the inbox.
      await tx
        .update(leads)
        .set({ updatedAt: new Date() })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.customer_emailed',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        after: { template: input.template, jobId: job.id },
      });

      const [activity] = insertedActivities([entry]);
      if (!activity) throw new Error('email entry did not map');
      return { status: 'queued', activity };
    });
  }

  addNote(input: WriteScope & { leadId: string; body: string }): Promise<NoteOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };

      const [entry] = await tx
        .insert(leadActivities)
        .values({
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          actorId: input.actorId,
          kind: 'note',
          body: input.body,
        })
        .returning(ACTIVITY_RETURNING);
      if (!entry) throw new Error('activity insert did not return a row');
      // A note is work on the lead: it moves up the inbox.
      await tx
        .update(leads)
        .set({ updatedAt: new Date() })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.note_added',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        after: { activityId: entry.id },
      });

      const [activity] = insertedActivities([entry]);
      if (!activity) throw new Error('note insert did not return its entry');
      return { status: 'created', activity };
    });
  }

  createTask(input: CreateTaskInput): Promise<TaskOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };
      const assignee = input.assignedActorId ?? null;
      if (assignee !== null && !(await isActiveMember(tx, input.workspaceId, assignee))) {
        return { status: 'assignee_not_found' };
      }

      const [row] = await tx
        .insert(leadTasks)
        .values({
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          title: input.title,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          assignedActorId: assignee,
          createdBy: input.actorId,
        })
        .returning({ id: leadTasks.id });
      if (!row) throw new Error('task insert did not return a row');
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.task_created',
        entity: 'lead_task',
        entityId: row.id,
        requestId: input.requestId,
        after: { leadId: input.leadId, dueAt: input.dueAt ?? null, assignedActorId: assignee },
      });
      return { status: 'saved', task: await requireTask(tx, input.workspaceId, row.id) };
    });
  }

  updateTask(input: UpdateTaskInput): Promise<TaskOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const [current] = await tx.execute<{
        [key: string]: unknown;
        status: string;
        title: string;
        dueAt: Date | string | null;
        assignedActorId: string | null;
        trashed: boolean;
      }>(sql`
        select
          k.status,
          k.title,
          k.due_at as "dueAt",
          k.assigned_actor_id as "assignedActorId",
          l.deleted_at is not null as trashed
        from app.lead_tasks k
        inner join app.leads l on l.workspace_id = k.workspace_id and l.id = k.lead_id
        where k.workspace_id = ${input.workspaceId}
          and k.id = ${input.taskId}
          and l.customer_data_restricted_at is null
        for update of k
      `);
      if (!current) return { status: 'not_found' };
      if (current.trashed) return { status: 'trashed' };
      if (
        input.assignedActorId !== undefined &&
        input.assignedActorId !== null &&
        input.assignedActorId !== current.assignedActorId &&
        !(await isActiveMember(tx, input.workspaceId, input.assignedActorId))
      ) {
        return { status: 'assignee_not_found' };
      }

      const set: Partial<typeof leadTasks.$inferInsert> = {};
      const changedFields: string[] = [];
      if (input.title !== undefined && input.title !== current.title) {
        set.title = input.title;
        changedFields.push('title');
      }
      if (input.dueAt !== undefined) {
        set.dueAt = input.dueAt === null ? null : new Date(input.dueAt);
        changedFields.push('dueAt');
      }
      if (
        input.assignedActorId !== undefined &&
        input.assignedActorId !== current.assignedActorId
      ) {
        set.assignedActorId = input.assignedActorId;
        changedFields.push('assignedActorId');
      }
      if (input.status !== undefined && input.status !== current.status) {
        set.status = input.status;
        // The completion check pairs `done` with a completion time; any other
        // status clears it, so a reopened task is open again in full.
        set.completedAt = input.status === 'done' ? new Date() : null;
        changedFields.push('status');
      }
      if (changedFields.length === 0) {
        return { status: 'saved', task: await requireTask(tx, input.workspaceId, input.taskId) };
      }

      await tx
        .update(leadTasks)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(leadTasks.workspaceId, input.workspaceId), eq(leadTasks.id, input.taskId)));
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.task_updated',
        entity: 'lead_task',
        entityId: input.taskId,
        requestId: input.requestId,
        before: { status: current.status },
        after: { changedFields, status: input.status ?? current.status },
      });
      return { status: 'saved', task: await requireTask(tx, input.workspaceId, input.taskId) };
    });
  }

  listTasks(
    input: Scope & { assignee: TaskAssigneeFilter; status: LeadTaskStatus; dueBy?: string },
    page: number,
    pageSize: number,
  ) {
    return this.database.withTenantTx(input, (tx) =>
      selectWorkspaceTasks(
        tx,
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          assignee: input.assignee,
          status: input.status,
          dueBy: input.dueBy,
        },
        page,
        pageSize,
      ),
    );
  }
}
