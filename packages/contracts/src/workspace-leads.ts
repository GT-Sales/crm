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

export const listWorkspaceLeadsQuerySchema = z.object({
  status: leadStatusSchema.optional(),
  type: leadTypeSchema.optional(),
  stage: leadStageSchema.optional(),
  assignee: leadAssigneeFilterSchema.optional(),
  q: leadSearchSchema.optional(),
  view: leadViewSchema.optional(),
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
});
export type LeadTypeCount = z.infer<typeof leadTypeCountSchema>;

export const leadsSummaryResponseSchema = z.object({
  types: z.array(leadTypeCountSchema),
  trash: z.int().nonnegative(),
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type LeadsSummaryResponse = z.infer<typeof leadsSummaryResponseSchema>;
