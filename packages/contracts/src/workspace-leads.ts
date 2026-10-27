import { z } from 'zod';

import { isoDateTimeSchema, pageInfoSchema, requestIdSchema } from './common';
import {
  attributionSchema,
  leadContactSchema,
  leadExternalRefSchema,
  leadStatusSchema,
  leadTypeSchema,
} from './leads';

/**
 * Staff lead visibility — `GET /workspaces/:id/leads` and the board. Caller:
 * staff session with `workspace.read` (every role); contact details are
 * included only for roles that work leads or money, and only those roles may
 * search, since a search by name or email would reveal them. Leads are created
 * and updated by the website flow in `leads.ts`; staff work them through
 * `lead-work.ts`.
 */

/** A working stage key (`new`, `contacted`, `won`…); the type's catalogue entry lists the valid ones. */
export const leadStageSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'lower_snake_case stage');
export type LeadStage = z.infer<typeof leadStageSchema>;

/** `me`, `none` (unassigned) or one member's actor id. */
export const leadAssigneeFilterSchema = z.union([z.enum(['me', 'none']), z.uuid()]);
export type LeadAssigneeFilter = z.infer<typeof leadAssigneeFilterSchema>;

/** Active leads, or the soft-deleted ones (the trash). */
export const leadViewSchema = z.enum(['active', 'trash']);
export type LeadView = z.infer<typeof leadViewSchema>;

/** Free-text search over name, email, phone and external reference. */
export const leadSearchSchema = z.string().trim().min(1).max(100);

/**
 * A calendar day, `YYYY-MM-DD`, by which a follow-up counts as due: the
 * viewer's own today, sent by the admin, since task due dates are calendar
 * days (stored at noon UTC) and "today" depends on where staff are.
 */
export const leadDueBySchema = z.iso.date();

export const listWorkspaceLeadsQuerySchema = z.object({
  status: leadStatusSchema.optional(),
  type: leadTypeSchema.optional(),
  stage: leadStageSchema.optional(),
  assignee: leadAssigneeFilterSchema.optional(),
  q: leadSearchSchema.optional(),
  view: leadViewSchema.optional(),
  /** Only leads with an open task due on or before this day (a follow-up due), most overdue first. */
  dueBy: leadDueBySchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
export type ListWorkspaceLeadsQuery = z.infer<typeof listWorkspaceLeadsQuerySchema>;

/**
 * What the caller may do with this workspace's leads, so the admin shows only
 * the controls that will work: `contacts` — see names, emails, phones, form
 * details, notes and tasks (and search); `manage` — change stage, assignee and
 * contact details, write notes and tasks, move to the trash.
 */
export const leadAccessSchema = z.object({
  contacts: z.boolean(),
  manage: z.boolean(),
  /** May open a sealed identity number (a SIN): owners only. Absent means no. */
  revealSensitive: z.boolean().optional(),
  /** May email the lead's customer (works leads, and the site can send mail). Absent means no. */
  emailCustomer: z.boolean().optional(),
  /** May view and download the lead's documents (`document.download`). Absent means no. */
  downloadDocuments: z.boolean().optional(),
});
export type LeadAccess = z.infer<typeof leadAccessSchema>;

/**
 * One row of the admin leads list. `source` is a short human-readable label
 * derived from `attribution` (e.g. `utm:google/cpc`, `referrer:facebook.com`,
 * `partner:MAPLE10` or `direct`) so the list has a source column without every
 * consumer re-deriving it from the raw attribution fields. `openTaskCount` and
 * `nextTaskDueAt` summarise the lead's open tasks (a count and a date, never a
 * task's text, so every role may see them).
 */
export const leadListItemSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  leadType: leadTypeSchema,
  status: leadStatusSchema,
  stage: leadStageSchema,
  contact: leadContactSchema,
  contactId: z.uuid().nullable(),
  assignedActorId: z.uuid().nullable(),
  externalRef: leadExternalRefSchema.nullable(),
  source: z.string().min(1).max(160),
  attribution: attributionSchema,
  consentVersion: z.string().max(64).nullable(),
  openTaskCount: z.int().nonnegative(),
  nextTaskDueAt: isoDateTimeSchema.nullable(),
  /** No one who works leads has opened it yet: the "New" badge. Absent means no. */
  isNew: z.boolean().optional(),
  /**
   * The type's countdown date from the form (a SIM order's arrival in
   * Canada, `leadCountdownField`), for "6 days left" on lists. Form details:
   * only for roles that see contacts, like the contact fields.
   */
  countdownDate: z.iso.date().nullable().optional(),
  deletedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeadListItem = z.infer<typeof leadListItemSchema>;

export const listWorkspaceLeadsResponseSchema = z.object({
  leads: z.array(leadListItemSchema),
  page: pageInfoSchema,
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type ListWorkspaceLeadsResponse = z.infer<typeof listWorkspaceLeadsResponseSchema>;

/**
 * The board — `GET /workspaces/:id/leads/board?type=…`: one type's active
 * leads by stage, a column per catalogue stage in order (plus a trailing
 * column for any stored stage the catalogue no longer lists, so no lead
 * disappears from the board). Each column carries its full count and its
 * newest `perStage` leads.
 */
export const leadBoardQuerySchema = z.object({
  type: leadTypeSchema,
  assignee: leadAssigneeFilterSchema.optional(),
  q: leadSearchSchema.optional(),
  perStage: z.coerce.number().int().positive().max(100).optional(),
});
export type LeadBoardQuery = z.infer<typeof leadBoardQuerySchema>;

export const leadBoardColumnSchema = z.object({
  stage: leadStageSchema,
  total: z.int().nonnegative(),
  leads: z.array(leadListItemSchema),
});
export type LeadBoardColumn = z.infer<typeof leadBoardColumnSchema>;

export const leadBoardResponseSchema = z.object({
  leadType: leadTypeSchema,
  columns: z.array(leadBoardColumnSchema),
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type LeadBoardResponse = z.infer<typeof leadBoardResponseSchema>;

/**
 * Lead counts for the inbox's type tabs — `GET /workspaces/:id/leads/summary`.
 * Only types with at least one active lead appear; `trash` counts the
 * soft-deleted ones.
 */
export const leadTypeCountSchema = z.object({
  leadType: leadTypeSchema,
  total: z.int().nonnegative(),
  /** Active leads of the type no one who works leads has opened yet. */
  unopened: z.int().nonnegative().optional(),
  /** With the summary's `dueBy`: active leads of the type with an open task due by then. */
  followUpsDue: z.int().nonnegative().optional(),
});
export type LeadTypeCount = z.infer<typeof leadTypeCountSchema>;

export const leadsSummaryQuerySchema = z.object({
  /** Also count each type's leads with a follow-up due on or before this day. */
  dueBy: leadDueBySchema.optional(),
});
export type LeadsSummaryQuery = z.infer<typeof leadsSummaryQuerySchema>;

export const leadsSummaryResponseSchema = z.object({
  types: z.array(leadTypeCountSchema),
  trash: z.int().nonnegative(),
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type LeadsSummaryResponse = z.infer<typeof leadsSummaryResponseSchema>;

/** The dashboard's windows, in days back from now (Get Canada Sim's 7 days, 30 days, 3 months). */
export const LEAD_STATS_WINDOWS = [7, 30, 90] as const;

/** `GET /workspaces/:id/leads/stats`: one type's leads in a window; no window is all time. */
export const leadStatsQuerySchema = z
  .object({
    leadType: leadTypeSchema,
    days: z.coerce
      .number()
      .pipe(z.literal([...LEAD_STATS_WINDOWS]))
      .optional(),
  })
  .strict();
export type LeadStatsQuery = z.infer<typeof leadStatsQuerySchema>;

/**
 * Counts only, so every role may read them (as the summary): the type's
 * active leads received in the window by stage, per day (UTC) and by partner
 * code, the type's lost stages left out of those two as Get Canada Sim's
 * dashboard leaves out cancellations. A partner is named by its partner
 * application's company when the site has one under that code.
 */
export const leadStatsResponseSchema = z.object({
  leadType: leadTypeSchema,
  days: z.int().positive().nullable(),
  total: z.int().nonnegative(),
  stages: z.array(z.object({ stage: leadStageSchema, total: z.int().nonnegative() })),
  daily: z.array(z.object({ day: z.iso.date(), total: z.int().nonnegative() })),
  partners: z
    .array(
      z.object({
        code: z.string().min(1).max(64),
        name: z.string().min(1).max(200).nullable(),
        total: z.int().nonnegative(),
      }),
    )
    .max(10),
  requestId: requestIdSchema,
});
export type LeadStatsResponse = z.infer<typeof leadStatsResponseSchema>;
