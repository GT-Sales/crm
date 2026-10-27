import { z } from 'zod';

import { isoDateTimeSchema, pageInfoSchema, requestIdSchema } from './common';
import { leadContactSchema, leadFormSchema, leadStatusSchema, leadTypeSchema } from './leads';
import { leadIdentitySchema } from './lead-identity';
import {
  leadAccessSchema,
  leadAssigneeFilterSchema,
  leadListItemSchema,
  leadStageSchema,
} from './workspace-leads';

/**
 * Staff working a lead — the lead page, its timeline, notes and tasks, and
 * the "my tasks" list. Reads need `workspace.read`, and only roles that may
 * see contacts receive the form details, notes and tasks (they carry personal
 * details as freely as the contact fields do). Every write needs
 * `lead.manage`.
 */

/**
 * The actor recorded on timeline entries and tasks carried over from a
 * site's old admin by the historical import (docs/RUNBOOKS/legacy-import.md).
 * It is no one's account; the admin shows it as "Old admin".
 */
export const LEGACY_IMPORT_ACTOR_ID = '00000000-0000-4000-8000-00000000a001';

const activityBase = {
  id: z.uuid(),
  actorId: z.uuid(),
  createdAt: isoDateTimeSchema,
};

/**
 * One timeline entry. The timeline is append-only: a change is a new entry,
 * never an edit of an old one. Contact edits record which fields changed,
 * never their values, so the history holds no personal data a later erasure
 * would have to rewrite.
 */
export const leadActivitySchema = z.discriminatedUnion('kind', [
  z.object({ ...activityBase, kind: z.literal('note'), body: z.string().min(1).max(4000) }),
  z.object({
    ...activityBase,
    kind: z.literal('status_change'),
    from: leadStageSchema,
    to: leadStageSchema,
  }),
  z.object({
    ...activityBase,
    kind: z.literal('assignment'),
    from: z.uuid().nullable(),
    to: z.uuid().nullable(),
  }),
  z.object({
    ...activityBase,
    kind: z.literal('edit'),
    fields: z.array(z.enum(['fullName', 'email', 'phone'])).min(1),
  }),
  z.object({
    ...activityBase,
    kind: z.literal('system'),
    event: z.enum(['trashed', 'restored', 'unknown']),
  }),
]);
export type LeadActivity = z.infer<typeof leadActivitySchema>;
export type LeadActivityKind = LeadActivity['kind'];

export const leadTaskStatusSchema = z.enum(['open', 'done', 'cancelled']);
export type LeadTaskStatus = z.infer<typeof leadTaskStatusSchema>;

export const leadTaskTitleSchema = z.string().trim().min(1).max(200);

export const leadTaskSchema = z.object({
  id: z.uuid(),
  leadId: z.uuid(),
  title: z.string().min(1).max(200),
  /** A due date is stored as noon UTC, which is the same calendar day from UTC−11 to UTC+11. */
  dueAt: isoDateTimeSchema.nullable(),
  assignedActorId: z.uuid().nullable(),
  status: leadTaskStatusSchema,
  completedAt: isoDateTimeSchema.nullable(),
  createdBy: z.uuid(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeadTask = z.infer<typeof leadTaskSchema>;

/** The lead page's record: the list row plus the submitted form. */
export const leadDetailSchema = leadListItemSchema.extend({
  form: leadFormSchema.nullable(),
});
export type LeadDetail = z.infer<typeof leadDetailSchema>;

/**
 * Another request on the same site from the same person (the same contact),
 * for the lead page: what it was and where it stands, newest first. Its
 * contact is the lead's own, so it is not repeated.
 */
export const relatedLeadSchema = z.object({
  id: z.uuid(),
  leadType: leadTypeSchema,
  status: leadStatusSchema,
  stage: leadStageSchema,
  deletedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type RelatedLead = z.infer<typeof relatedLeadSchema>;

/** How many of the person's other requests the lead page lists. */
export const RELATED_LEADS_LIMIT = 20;

/**
 * `GET /workspaces/:id/leads/:leadId`. For a caller who cannot see contacts,
 * `contact` is empty, `form` is null and `activities`, `tasks`, `related` and
 * `identities` are empty: linking requests to one person is personal data too.
 */
export const getWorkspaceLeadResponseSchema = z.object({
  lead: leadDetailSchema,
  activities: z.array(leadActivitySchema),
  tasks: z.array(leadTaskSchema),
  related: z.array(relatedLeadSchema).max(RELATED_LEADS_LIMIT).default([]),
  /** The credit-check identities on the lead, newest first; empty without contact access. */
  identities: z.array(leadIdentitySchema).default([]),
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type GetWorkspaceLeadResponse = z.infer<typeof getWorkspaceLeadResponseSchema>;

const staffEmailSchema = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email address');

/** Corrections staff make to what the customer typed. */
export const leadContactEditSchema = z
  .object({
    fullName: z.string().trim().min(1).max(160).optional(),
    email: staffEmailSchema.optional(),
    phone: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one contact field',
  });
export type LeadContactEdit = z.infer<typeof leadContactEditSchema>;

/** `PATCH /workspaces/:id/leads/:leadId`: any of stage, assignee and contact, at least one. */
export const updateWorkspaceLeadRequestSchema = z
  .object({
    stage: leadStageSchema.optional(),
    assignedActorId: z.uuid().nullable().optional(),
    contact: leadContactEditSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.stage !== undefined ||
      value.assignedActorId !== undefined ||
      value.contact !== undefined,
    { message: 'nothing to change' },
  );
export type UpdateWorkspaceLeadRequest = z.infer<typeof updateWorkspaceLeadRequestSchema>;

/** The updated lead and the timeline entries the change wrote (none for a no-op). */
export const updateWorkspaceLeadResponseSchema = z.object({
  lead: leadDetailSchema,
  activities: z.array(leadActivitySchema),
  requestId: requestIdSchema,
});
export type UpdateWorkspaceLeadResponse = z.infer<typeof updateWorkspaceLeadResponseSchema>;

export const createLeadNoteRequestSchema = z
  .object({ body: z.string().trim().min(1).max(4000) })
  .strict();
export type CreateLeadNoteRequest = z.infer<typeof createLeadNoteRequestSchema>;

export const createLeadNoteResponseSchema = z.object({
  activity: leadActivitySchema,
  requestId: requestIdSchema,
});
export type CreateLeadNoteResponse = z.infer<typeof createLeadNoteResponseSchema>;

export const createLeadTaskRequestSchema = z
  .object({
    title: leadTaskTitleSchema,
    dueAt: isoDateTimeSchema.nullable().optional(),
    assignedActorId: z.uuid().nullable().optional(),
  })
  .strict();
export type CreateLeadTaskRequest = z.infer<typeof createLeadTaskRequestSchema>;

/** `PATCH /workspaces/:id/tasks/:taskId`: completing sets `completedAt`; reopening clears it. */
export const updateLeadTaskRequestSchema = z
  .object({
    title: leadTaskTitleSchema.optional(),
    dueAt: isoDateTimeSchema.nullable().optional(),
    assignedActorId: z.uuid().nullable().optional(),
    status: leadTaskStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'nothing to change',
  });
export type UpdateLeadTaskRequest = z.infer<typeof updateLeadTaskRequestSchema>;

export const leadTaskResponseSchema = z.object({
  task: leadTaskSchema,
  requestId: requestIdSchema,
});
export type LeadTaskResponse = z.infer<typeof leadTaskResponseSchema>;

/**
 * Moving a lead to the trash and back: the lead and the timeline entry, which
 * is null when the lead was already where the request asked (both calls are
 * idempotent).
 */
export const leadTrashResponseSchema = z.object({
  lead: leadDetailSchema,
  activity: leadActivitySchema.nullable(),
  requestId: requestIdSchema,
});
export type LeadTrashResponse = z.infer<typeof leadTrashResponseSchema>;

/**
 * `GET /workspaces/:id/tasks` — tasks across the workspace's active leads,
 * soonest due first (undated last). Defaults to the caller's open tasks.
 */
export const listWorkspaceTasksQuerySchema = z.object({
  assignee: leadAssigneeFilterSchema.optional(),
  status: leadTaskStatusSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
export type ListWorkspaceTasksQuery = z.infer<typeof listWorkspaceTasksQuerySchema>;

export const workspaceTaskSchema = leadTaskSchema.extend({
  lead: z.object({
    id: z.uuid(),
    leadType: leadTypeSchema,
    stage: leadStageSchema,
    contact: leadContactSchema,
  }),
});
export type WorkspaceTask = z.infer<typeof workspaceTaskSchema>;

export const listWorkspaceTasksResponseSchema = z.object({
  tasks: z.array(workspaceTaskSchema),
  page: pageInfoSchema,
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type ListWorkspaceTasksResponse = z.infer<typeof listWorkspaceTasksResponseSchema>;
