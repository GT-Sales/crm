import { z } from 'zod';

import { isoDateTimeSchema, pageInfoSchema, requestIdSchema } from './common';
import {
  leadContactSchema,
  leadExternalRefSchema,
  leadFormSchema,
  leadStatusSchema,
  leadTypeSchema,
} from './leads';
import { documentChecklistKeySchema } from './domain';
import { leadDocumentSchema } from './files';
import { leadFormEditSchema } from './lead-fields';
import { leadIdentitySchema } from './lead-identity';
import {
  leadAccessSchema,
  leadDueBySchema,
  leadListItemSchema,
  leadPropertyValueSchema,
  leadStageSchema,
} from './workspace-leads';
import { propertyKeySchema } from './properties';
import { leadOrderEditSchema, leadOrderSchema } from './plans';

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

/** A contact, form or custom property key (`custom_referral_code`) an entry names; never a value. */
const activityFieldKeySchema = propertyKeySchema;

const activityBase = {
  id: z.uuid(),
  actorId: z.uuid(),
  createdAt: isoDateTimeSchema,
};

/**
 * One timeline entry. The timeline is append-only: a change is a new entry,
 * never an edit of an old one. Edits record which fields changed (the
 * contact's `fullName`, `email`, `phone`, or a form field's key), never their
 * values, so the history holds no personal data a later erasure would have to
 * rewrite.
 */
/**
 * The mails staff can send a lead's customer from its page:
 * `sim_number_ready`, a SIM order's Canadian number (Get Canada Sim's
 * "email the customer this number?").
 */
export const customerEmailTemplateSchema = z.enum(['sim_number_ready']);
export type CustomerEmailTemplate = z.infer<typeof customerEmailTemplateSchema>;

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
    // Contact, form and up to PROPERTY_LIMIT custom keys in one correction.
    fields: z.array(activityFieldKeySchema).min(1).max(200),
  }),
  z.object({
    ...activityBase,
    kind: z.literal('system'),
    /**
     * `opened`: the first time someone who works leads opened it (the "New"
     * badge goes); `customer_emailed`: staff queued `template` to the
     * customer (the address and the mail's contents are not kept here);
     * `change_requested`, `change_approved`, `change_rejected`: the customer
     * asked the website to change their order (Get Canada Sim's `/track`) and
     * how its admin decided, by the website's `requestNo`.
     */
    event: z.enum([
      'trashed',
      'restored',
      'opened',
      'customer_emailed',
      'change_requested',
      'change_approved',
      'change_rejected',
      'unknown',
    ]),
    template: customerEmailTemplateSchema.optional(),
    requestNo: z.int().positive().optional(),
    /** For `change_requested`: the fields asked to change (contact or form keys), never their values. */
    fields: z.array(activityFieldKeySchema).max(50).optional(),
    /** For `change_requested`: the documents sent with it. */
    documents: z.array(documentChecklistKeySchema).max(10).optional(),
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
  /** Values of the site's custom properties (`leads.custom_values`), by property key. */
  customValues: z.record(propertyKeySchema, leadPropertyValueSchema).optional(),
  /** The order details of an order lead type (`orderLeadTypes`); only with contact access. */
  order: leadOrderSchema.optional(),
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
 * `contact` is empty, `form` is null and `activities`, `tasks`, `related`,
 * `identities` and `documents` are empty: linking requests to one person is
 * personal data too.
 */
export const getWorkspaceLeadResponseSchema = z.object({
  lead: leadDetailSchema,
  activities: z.array(leadActivitySchema),
  tasks: z.array(leadTaskSchema),
  related: z.array(relatedLeadSchema).max(RELATED_LEADS_LIMIT).default([]),
  /** The credit-check identities on the lead, newest first; empty without contact access. */
  identities: z.array(leadIdentitySchema).default([]),
  /** The lead's current documents, one per type; empty without contact access. */
  documents: z.array(leadDocumentSchema).default([]),
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

/**
 * `PATCH /workspaces/:id/leads/:leadId`: any of stage, assignee, contact,
 * form corrections, custom values and order details, at least one. `form`
 * holds the type's editable fields (`leadFields`), each a new value or null
 * to clear it.
 */
export const updateWorkspaceLeadRequestSchema = z
  .object({
    stage: leadStageSchema.optional(),
    assignedActorId: z.uuid().nullable().optional(),
    contact: leadContactEditSchema.optional(),
    form: leadFormEditSchema.optional(),
    /** New values of custom properties by key, each a value or null to clear it. */
    customValues: z
      .record(propertyKeySchema, z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]))
      .refine((values) => Object.keys(values).length <= 100)
      .optional(),
    /** Order details of an order lead type; a new `planId` re-freezes the plan. */
    order: leadOrderEditSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.stage !== undefined ||
      value.assignedActorId !== undefined ||
      value.contact !== undefined ||
      value.form !== undefined ||
      value.customValues !== undefined ||
      value.order !== undefined,
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
 * `POST /workspaces/:id/leads/:leadId/customer-emails` — queue a mail to the
 * lead's customer, sent by the outbox from the site's own sender within a
 * minute. Refused while the site cannot send (`feature_not_ready`) and when
 * the lead lacks what the mail needs (`conflict`, `details.missing` naming
 * the field: `email`, `simNumber`). `activity` is its timeline entry.
 */
export const queueCustomerEmailRequestSchema = z
  .object({ template: customerEmailTemplateSchema })
  .strict();
export type QueueCustomerEmailRequest = z.infer<typeof queueCustomerEmailRequestSchema>;

export const queueCustomerEmailResponseSchema = z.object({
  activity: leadActivitySchema,
  requestId: requestIdSchema,
});
export type QueueCustomerEmailResponse = z.infer<typeof queueCustomerEmailResponseSchema>;

/**
 * `POST /workspaces/:id/leads/:leadId/opened` — the lead page tells the
 * backend it was opened by someone who works leads, which clears its "New"
 * badge for the whole team. Idempotent: `activity` is the timeline entry the
 * first open wrote, null when it was already opened.
 */
export const markLeadOpenedResponseSchema = z.object({
  activity: leadActivitySchema.nullable(),
  requestId: requestIdSchema,
});
export type MarkLeadOpenedResponse = z.infer<typeof markLeadOpenedResponseSchema>;

/**
 * `GET /workspaces/:id/tasks` — tasks across the workspace's active leads,
 * soonest due first (undated last). Defaults to the caller's open tasks.
 */
/** Whose tasks: `me`, `none` (unassigned), `all` (the whole team) or one member's actor id. */
export const taskAssigneeFilterSchema = z.union([z.enum(['me', 'none', 'all']), z.uuid()]);
export type TaskAssigneeFilter = z.infer<typeof taskAssigneeFilterSchema>;

export const listWorkspaceTasksQuerySchema = z.object({
  assignee: taskAssigneeFilterSchema.optional(),
  status: leadTaskStatusSchema.optional(),
  /** Only tasks due on or before this day: the follow-ups due (undated tasks never are). */
  dueBy: leadDueBySchema.optional(),
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
    /** The website's own number for it (`MS-101`), which staff know it by. */
    externalRef: leadExternalRefSchema.nullable().optional(),
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
