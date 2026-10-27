import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  leadActivities,
  leads,
  leadTasks,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  isLeadStage,
  type LeadActivity,
  type LeadAssigneeFilter,
  type LeadBoardColumn,
  type LeadContactEdit,
  type LeadDetail,
  type LeadTask,
  type LeadTaskStatus,
  type LeadTypeCount,
  type WorkspaceTask,
} from '@gt-sales/contracts';

import {
  selectLeadBoard,
  selectLeadDetail,
  selectLeadSummary,
  selectLeadWithWork,
  selectTask,
  selectWorkspaceTasks,
  toLeadActivity,
  type LeadFilters,
} from './staff-queries.js';
import { upsertContact } from './store.js';

/**
 * Staff working a lead: the lead page's reads and every write a staff member
 * makes (stage, assignee, contact corrections, notes, tasks, trash). Each
 * write runs in one tenant transaction that locks the lead, records what
 * changed on the append-only timeline, and writes an audit event. Neither the
 * timeline nor the audit trail stores contact values or note text a second
 * time: an edit records the field names, a note's audit event its id.
 */

interface Scope {
  workspaceId: string;
  actorId: string;
}

interface WriteScope extends Scope {
  requestId: string;
}

export interface LeadWorkResult {
  lead: LeadDetail;
  activities: LeadActivity[];
  tasks: LeadTask[];
}

export type UpdateLeadWorkOutcome =
  | { status: 'updated'; lead: LeadDetail; activities: LeadActivity[] }
  | { status: 'not_found' | 'trashed' | 'invalid_stage' | 'assignee_not_found' };

export type TrashLeadOutcome =
  | { status: 'changed' | 'unchanged'; lead: LeadDetail; activity: LeadActivity | null }
  | { status: 'not_found' };

export type NoteOutcome =
  { status: 'created'; activity: LeadActivity } | { status: 'not_found' } | { status: 'trashed' };

export type TaskOutcome =
  { status: 'saved'; task: LeadTask } | { status: 'not_found' | 'trashed' | 'assignee_not_found' };

export interface UpdateLeadWorkInput extends WriteScope {
  leadId: string;
  stage?: string;
  /** `null` unassigns; `undefined` leaves the assignee alone. */
  assignedActorId?: string | null;
  contact?: LeadContactEdit;
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
  summary(input: Scope): Promise<{ types: LeadTypeCount[]; trash: number }>;
  board(
    input: Scope & { leadType: string; assignee?: LeadAssigneeFilter; search?: string },
    perStage: number,
  ): Promise<LeadBoardColumn[]>;
  /** `includeWork: false` skips the timeline and tasks for a caller who may not see them. */
  getLead(
    input: Scope & { leadId: string; includeWork: boolean },
  ): Promise<LeadWorkResult | undefined>;
  updateLead(input: UpdateLeadWorkInput): Promise<UpdateLeadWorkOutcome>;
  setTrashed(input: WriteScope & { leadId: string; trashed: boolean }): Promise<TrashLeadOutcome>;
  addNote(input: WriteScope & { leadId: string; body: string }): Promise<NoteOutcome>;
  createTask(input: CreateTaskInput): Promise<TaskOutcome>;
  updateTask(input: UpdateTaskInput): Promise<TaskOutcome>;
  listTasks(
    input: Scope & { assignee: LeadAssigneeFilter; status: LeadTaskStatus },
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
  trashed: boolean;
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
      l.deleted_at is not null as trashed
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
): Promise<LeadDetail> {
  const detail = await selectLeadDetail(tx, workspaceId, leadId);
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

type LeadDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const defaultLeadDatabase: LeadDatabase = { withTenantTx };

export class DatabaseLeadWorkStore implements LeadWorkStore {
  constructor(private readonly database: LeadDatabase = defaultLeadDatabase) {}

  summary(input: Scope) {
    return this.database.withTenantTx(input, (tx) => selectLeadSummary(tx));
  }

  board(
    input: Scope & { leadType: string; assignee?: LeadAssigneeFilter; search?: string },
    perStage: number,
  ) {
    const filters: LeadFilters & { leadType: string } = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      leadType: input.leadType,
      assignee: input.assignee,
      search: input.search,
    };
    return this.database.withTenantTx(input, (tx) => selectLeadBoard(tx, filters, perStage));
  }

  getLead(input: Scope & { leadId: string; includeWork: boolean }) {
    return this.database.withTenantTx(input, async (tx) => {
      if (input.includeWork) return selectLeadWithWork(tx, input.workspaceId, input.leadId);
      const lead = await selectLeadDetail(tx, input.workspaceId, input.leadId);
      return lead ? { lead, activities: [], tasks: [] } : undefined;
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

      if (input.stage !== undefined && input.stage !== lead.stage) {
        if (!isLeadStage(lead.leadType, input.stage)) return { status: 'invalid_stage' };
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
        entries.push({ kind: 'edit', data: { fields: changed } });
        after['changedFields'] = changed;
      }

      if (entries.length === 0) {
        return {
          status: 'updated',
          lead: await requireDetail(tx, input.workspaceId, input.leadId),
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
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.updated',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        before,
        after,
      });

      return {
        status: 'updated',
        lead: await requireDetail(tx, input.workspaceId, input.leadId),
        activities: insertedActivities(inserted),
      };
    });
  }

  setTrashed(input: WriteScope & { leadId: string; trashed: boolean }): Promise<TrashLeadOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed === input.trashed) {
        return {
          status: 'unchanged',
          lead: await requireDetail(tx, input.workspaceId, input.leadId),
          activity: null,
        };
      }

      // Trash is a visibility change, not work on the lead, so `updated_at`
      // (the inbox's order) is left alone and a restored lead returns to its
      // old place.
      await tx
        .update(leads)
        .set({ deletedAt: input.trashed ? new Date() : null })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      const [entry] = await tx
        .insert(leadActivities)
        .values({
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          actorId: input.actorId,
          kind: 'system',
          data: { event: input.trashed ? 'trashed' : 'restored' },
        })
        .returning(ACTIVITY_RETURNING);
      if (!entry) throw new Error('activity insert did not return a row');
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: input.trashed ? 'lead.trashed' : 'lead.restored',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        before: { trashed: lead.trashed },
        after: { trashed: input.trashed },
      });

      const [activity] = insertedActivities([entry]);
      return {
        status: 'changed',
        lead: await requireDetail(tx, input.workspaceId, input.leadId),
        activity: activity ?? null,
      };
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
    input: Scope & { assignee: LeadAssigneeFilter; status: LeadTaskStatus },
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
        },
        page,
        pageSize,
      ),
    );
  }
}
