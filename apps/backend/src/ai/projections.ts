import { aiSourceSchema, leadStageLabel, leadTypeLabel, type AiSource } from '@gt-sales/contracts';
import { z } from 'zod';

/**
 * What a read tool is allowed to hand back.
 *
 * Nothing here is a database row: every field is chosen for the question this
 * version answers, so a wider table never widens what reaches the model. There
 * is no email, phone, address, SIN, passport, document link, custom secret or
 * money amount. Notes appear only as bounded excerpts when the caller asked
 * for them, and a lead's contact details are represented by a link to its page
 * instead of copied into the answer.
 */

export type ToolStatus = 'ok' | 'not_available' | 'invalid_filter' | 'temporary_failure';

export interface ToolWindow {
  /** Inclusive ISO instant. */
  readonly start: string;
  /** Exclusive ISO instant. */
  readonly end: string;
  readonly timezone: string;
  readonly label: string;
}

export interface ToolScope {
  readonly siteId: string;
  readonly siteName: string;
  readonly leadType: string | null;
  readonly archivePolicy: 'active_only' | 'including_archived' | 'archived_only';
  readonly window: ToolWindow | null;
  readonly filters: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * The one shape every tool answers with. `not_available`, `invalid_filter` and
 * `temporary_failure` are distinct from a successful empty result so a model
 * (and a person reading it) cannot mistake "could not look" for "found none".
 */
export interface ToolResult<TData> {
  readonly status: ToolStatus;
  readonly asOf: string;
  readonly scope: ToolScope;
  readonly data?: TData;
  readonly total?: number;
  readonly returnedCount?: number;
  readonly truncated?: boolean;
  readonly hasMore?: boolean;
  readonly sources: readonly AiSource[];
  /** A bounded, safe explanation for a non-ok status. */
  readonly message?: string;
}

export interface LeadProjection {
  readonly leadId: string;
  readonly leadType: string;
  readonly leadTypeLabel: string;
  readonly stage: string;
  readonly stageLabel: string;
  readonly status: string;
  readonly reference: string | null;
  readonly name: string | null;
  readonly assignee: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

export interface TaskProjection {
  readonly taskId: string;
  readonly leadId: string;
  readonly leadReference: string | null;
  readonly leadName: string | null;
  readonly title: string;
  readonly assignee: string | null;
  readonly dueAt: string | null;
  /** The calendar day the due date names, `YYYY-MM-DD`, read in UTC. */
  readonly dueDay: string | null;
}

export interface ActivityProjection {
  readonly kind: string;
  readonly at: string;
  /** Present only for the notes section the caller explicitly asked for. */
  readonly noteExcerpt?: string;
}

export interface OverviewStageCount {
  readonly stage: string;
  readonly stageLabel: string;
  readonly count: number;
}

export interface OverviewData {
  readonly received: number;
  readonly submitted: number;
  readonly byStage: readonly OverviewStageCount[];
}

export const orderProjectionSchema = z
  .object({
    planName: z.string().max(160).nullable().optional(),
    quantity: z.int().min(1).max(99).optional(),
    dispatchedAt: z.string().nullable().optional(),
    activatedAt: z.string().nullable().optional(),
    priceMinor: z.int().nonnegative().nullable().optional(),
    currency: z.literal('CAD').optional(),
    paymentStatus: z.enum(['not_needed', 'pending', 'paid']).optional(),
    carrierCommission: z.enum(['not_yet', 'invoiced', 'received', 'clawback']).optional(),
  })
  .strict();
export type OrderProjection = z.infer<typeof orderProjectionSchema>;

export interface LeadSummaryData {
  readonly lead: LeadProjection;
  readonly order?: OrderProjection;
  readonly openTasks: readonly TaskProjection[];
  readonly recentActivity: readonly ActivityProjection[];
}

export interface FindLeadsData {
  readonly leads: readonly LeadProjection[];
}

export interface OpenTasksData {
  readonly tasks: readonly TaskProjection[];
}

export interface SourcePerformanceRow {
  readonly source: string;
  readonly kind: string;
  readonly received: number;
  readonly submitted: number;
  readonly madeIt: number;
  readonly other: boolean;
}

export interface SourcePerformanceData {
  readonly totals: {
    readonly received: number;
    readonly submitted: number;
    readonly madeIt: number;
  };
  readonly rows: readonly SourcePerformanceRow[];
  readonly withSourceData: number;
  readonly sourcesShown: number;
  /** True when the report's own "Other" row aggregated sources not listed. */
  readonly aggregatedOther: boolean;
}

/** One raw lead row, as the AI's own narrow queries select it. */
export const leadRowSchema = z.object({
  id: z.uuid(),
  lead_type: z.string().min(1),
  stage: z.string().min(1),
  status: z.string().min(1),
  external_ref: z.string().nullable(),
  full_name: z.string().nullable(),
  assignee_name: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  deleted_at: z.coerce.date().nullable(),
});

export type LeadRow = z.infer<typeof leadRowSchema>;

export const taskRowSchema = z.object({
  id: z.uuid(),
  lead_id: z.uuid(),
  lead_ref: z.string().nullable(),
  lead_name: z.string().nullable(),
  title: z.string().min(1),
  assignee_name: z.string().nullable(),
  due_at: z.coerce.date().nullable(),
});

export type TaskRow = z.infer<typeof taskRowSchema>;

/**
 * `YYYY-MM-DD` of a task's due date, read in UTC on purpose: the due date is a
 * calendar day stored at noon UTC, so converting it to Toronto would move a
 * midnight-adjacent value to another day.
 */
export function dueDayOf(dueAt: Date | null): string | null {
  return dueAt === null ? null : dueAt.toISOString().slice(0, 10);
}

export function projectLead(row: LeadRow): LeadProjection {
  return {
    leadId: row.id,
    leadType: row.lead_type,
    leadTypeLabel: leadTypeLabel(row.lead_type),
    stage: row.stage,
    stageLabel: leadStageLabel(row.lead_type, row.stage),
    status: row.status,
    reference: row.external_ref,
    name: row.full_name,
    assignee: row.assignee_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archived: row.deleted_at !== null,
  };
}

export function projectTask(row: TaskRow): TaskProjection {
  return {
    taskId: row.id,
    leadId: row.lead_id,
    leadReference: row.lead_ref,
    leadName: row.lead_name,
    title: row.title,
    assignee: row.assignee_name,
    dueAt: row.due_at === null ? null : row.due_at.toISOString(),
    dueDay: dueDayOf(row.due_at),
  };
}

/** The safe word for an activity kind; the body is never included here. */
export function activityKindWords(kind: string): string {
  switch (kind) {
    case 'note':
      return 'note';
    case 'status_change':
      return 'status change';
    case 'assignment':
      return 'assignment';
    case 'email':
      return 'email';
    case 'call':
      return 'call';
    case 'edit':
      return 'edit';
    case 'document':
      return 'document';
    case 'merge':
      return 'merge';
    case 'system':
      return 'system event';
    default:
      return 'activity';
  }
}

/** A note excerpt, bounded to 500 characters, never re-flowed into markdown. */
export function noteExcerpt(body: string | null): string | null {
  if (body === null) return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 497)}...`;
}

/** Serialized size of a result, for the turn budget. */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const leadProjectionSchema = z
  .object({
    leadId: z.uuid(),
    leadType: z.string(),
    leadTypeLabel: z.string(),
    stage: z.string(),
    stageLabel: z.string(),
    status: z.string(),
    reference: z.string().nullable(),
    name: z.string().nullable(),
    assignee: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archived: z.boolean(),
  })
  .strict();
const taskProjectionSchema = z
  .object({
    taskId: z.uuid(),
    leadId: z.uuid(),
    leadReference: z.string().nullable(),
    leadName: z.string().nullable(),
    title: z.string(),
    assignee: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    dueDay: z.string().nullable(),
  })
  .strict();
const activityProjectionSchema = z
  .object({
    kind: z.string(),
    at: z.iso.datetime(),
    noteExcerpt: z.string().max(500).optional(),
  })
  .strict();
const countsSchema = z
  .object({
    received: z.int().nonnegative(),
    submitted: z.int().nonnegative(),
    madeIt: z.int().nonnegative(),
  })
  .strict();

/** Validate the final minimized result, not merely the SQL input row. */
export const toolResultSchema = z
  .object({
    status: z.enum(['ok', 'not_available', 'invalid_filter', 'temporary_failure']),
    asOf: z.iso.datetime(),
    scope: z
      .object({
        siteId: z.uuid(),
        siteName: z.string(),
        leadType: z.string().nullable(),
        archivePolicy: z.enum(['active_only', 'including_archived', 'archived_only']),
        window: z
          .object({
            start: z.iso.datetime(),
            end: z.iso.datetime(),
            timezone: z.string(),
            label: z.string(),
          })
          .strict()
          .nullable(),
        filters: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      })
      .strict(),
    data: z
      .union([
        z.object({ leads: z.array(leadProjectionSchema).max(10) }).strict(),
        z.object({ tasks: z.array(taskProjectionSchema).max(20) }).strict(),
        z
          .object({
            lead: leadProjectionSchema,
            order: orderProjectionSchema.optional(),
            openTasks: z.array(taskProjectionSchema).max(10),
            recentActivity: z.array(activityProjectionSchema).max(15),
          })
          .strict(),
        z
          .object({
            received: z.int().nonnegative(),
            submitted: z.int().nonnegative(),
            byStage: z.array(
              z
                .object({ stage: z.string(), stageLabel: z.string(), count: z.int().nonnegative() })
                .strict(),
            ),
          })
          .strict(),
        z
          .object({
            totals: countsSchema,
            rows: z.array(
              countsSchema.extend({ source: z.string(), kind: z.string(), other: z.boolean() }),
            ),
            withSourceData: z.int().nonnegative(),
            sourcesShown: z.int().nonnegative(),
            aggregatedOther: z.boolean(),
          })
          .strict(),
      ])
      .optional(),
    total: z.int().nonnegative().optional(),
    returnedCount: z.int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    sources: z.array(aiSourceSchema).max(20),
    message: z.string().max(500).optional(),
  })
  .strict();
