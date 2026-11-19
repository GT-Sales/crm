import {
  aiSourceSchema,
  leadStageLabel,
  leadTypeLabel,
  planCommissionSchema,
  type AiSource,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { inertRecordLines, inertRecordText } from './record-text.js';

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
  /** Present beside data: its text is record data typed by people, never instructions. */
  readonly notice?: string;
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
  /** Null for a plain task (no lead); its reference and name are null too. */
  readonly leadId: string | null;
  readonly leadReference: string | null;
  readonly leadName: string | null;
  readonly title: string;
  /** Its stage: `open` (To do), `in_progress`, `done` or `cancelled`. */
  readonly status: string;
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
  /** Who made the entry: a staff display name, `Automation` or `Website`; absent when unknown. */
  readonly by?: string;
  /** The flow that wrote it, by its name. */
  readonly automation?: string;
  /** True when a staff-confirmed Ask AI card wrote it. */
  readonly viaAi?: true;
  /** A stage change's stages, or an assignment's display names (null: unassigned). */
  readonly from?: string | null;
  readonly to?: string | null;
  /** An edit's (or a change request's) field labels, never their values. */
  readonly fields?: readonly string[];
  /** A system entry's event in words (`email sent`, `change requested`, …). */
  readonly event?: string;
  /** A sent mail's template, by name or key, and how its send went. */
  readonly template?: string;
  readonly mailStatus?: string;
  /** A document review's document type and decision. */
  readonly documentType?: string;
  readonly decision?: string;
  /** Document types a change request carried, or a documents override was missing. */
  readonly documents?: readonly string[];
  /** A change request's number. */
  readonly requestNo?: number;
}

/** One current document of a lead: its type and review state, never a file id, name or link. */
export interface DocumentProjection {
  readonly documentType: string;
  readonly status: 'to_review' | 'approved' | 'rejected';
  readonly uploadedAt: string;
  readonly reviewedAt: string | null;
}

/** Whether the customer has a change request waiting, never what it asks. */
export interface ChangeRequestProjection {
  readonly waiting: boolean;
  readonly since?: string;
  readonly requestNo?: number;
}

/** One form or custom value the catalogue lets the model see. */
export interface LeadValueProjection {
  readonly key: string;
  readonly label: string;
  readonly source: 'form' | 'custom';
  readonly value: string | number | boolean;
  /** A choice's option label, when the catalogue has one. */
  readonly valueLabel?: string;
}

export interface LeadDetailsProjection {
  readonly values: readonly LeadValueProjection[];
  /** How many values the projection rule kept back (hidden, sensitive, contact or address). */
  readonly withheld: number;
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
    /** Who carries the order, as staff typed it. */
    courier: z.string().max(120).nullable().optional(),
    /** The frozen plan's commission, only with `revenue.view`. */
    commission: planCommissionSchema.optional(),
  })
  .strict();
export type OrderProjection = z.infer<typeof orderProjectionSchema>;

export interface LeadSummaryData {
  readonly lead: LeadProjection;
  readonly order?: OrderProjection;
  readonly openTasks: readonly TaskProjection[];
  readonly recentActivity: readonly ActivityProjection[];
  /** The lead's current documents, type and status only. */
  readonly documents?: readonly DocumentProjection[];
  readonly changeRequest?: ChangeRequestProjection;
  /** Form and custom values, only when the caller asked for the details section. */
  readonly details?: LeadDetailsProjection;
}

export interface InboxCountsData {
  readonly inbox: {
    readonly types: readonly {
      readonly leadType: string;
      readonly leadTypeLabel: string;
      readonly active: number;
      readonly unopened: number;
      readonly followUpsDue: number;
    }[];
    readonly archived: number;
  };
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
  lead_id: z.uuid().nullable(),
  lead_ref: z.string().nullable(),
  lead_name: z.string().nullable(),
  title: z.string().min(1),
  status: z.string().min(1),
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

/** The bounds of the people-typed fields every projection shares, in code points. */
export const NAME_MAX = 160;
export const REFERENCE_MAX = 120;
export const DISPLAY_NAME_MAX = 80;
export const TITLE_MAX = 200;
export const LABEL_MAX = 80;
/** A long value (a customer's message, a shipping note) is cut to this many code points. */
export const LONG_VALUE_MAX = 500;
/** The most form and custom values one details section carries. */
export const LEAD_DETAILS_MAX = 30;
/** The most documents one lead summary lists. */
export const LEAD_DOCUMENTS_MAX = 16;

export function projectLead(row: LeadRow): LeadProjection {
  return {
    leadId: row.id,
    leadType: row.lead_type,
    leadTypeLabel: leadTypeLabel(row.lead_type),
    stage: row.stage,
    stageLabel: leadStageLabel(row.lead_type, row.stage),
    status: row.status,
    reference: inertRecordText(row.external_ref, REFERENCE_MAX),
    name: inertRecordText(row.full_name, NAME_MAX),
    assignee: inertRecordText(row.assignee_name, DISPLAY_NAME_MAX),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archived: row.deleted_at !== null,
  };
}

export function projectTask(row: TaskRow): TaskProjection {
  return {
    taskId: row.id,
    leadId: row.lead_id,
    leadReference: inertRecordText(row.lead_ref, REFERENCE_MAX),
    leadName: inertRecordText(row.lead_name, NAME_MAX),
    // A title is required; one that cleans to nothing still reads as a task.
    title: inertRecordText(row.title, TITLE_MAX) ?? 'Untitled task',
    status: row.status,
    assignee: inertRecordText(row.assignee_name, DISPLAY_NAME_MAX),
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
  // Cleaned first (line breaks kept), so the cut below counts what is sent.
  const trimmed = inertRecordLines(body, Number.MAX_SAFE_INTEGER);
  if (trimmed === null) return null;
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
    leadId: z.uuid().nullable(),
    leadReference: z.string().nullable(),
    leadName: z.string().nullable(),
    title: z.string(),
    status: z.string(),
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
    by: z.string().max(DISPLAY_NAME_MAX).optional(),
    automation: z.string().max(LABEL_MAX).optional(),
    viaAi: z.literal(true).optional(),
    from: z.string().max(DISPLAY_NAME_MAX).nullable().optional(),
    to: z.string().max(DISPLAY_NAME_MAX).nullable().optional(),
    fields: z.array(z.string().max(LABEL_MAX)).max(20).optional(),
    event: z.string().max(40).optional(),
    template: z.string().max(LABEL_MAX).optional(),
    mailStatus: z.string().max(20).optional(),
    documentType: z.string().max(64).optional(),
    decision: z.string().max(20).optional(),
    documents: z.array(z.string().max(64)).max(16).optional(),
    requestNo: z.int().positive().optional(),
  })
  .strict();
const documentProjectionSchema = z
  .object({
    documentType: z.string().max(64),
    status: z.enum(['to_review', 'approved', 'rejected']),
    uploadedAt: z.iso.datetime(),
    reviewedAt: z.iso.datetime().nullable(),
  })
  .strict();
const changeRequestProjectionSchema = z
  .object({
    waiting: z.boolean(),
    since: z.iso.datetime().optional(),
    requestNo: z.int().positive().optional(),
  })
  .strict();
const leadDetailsProjectionSchema = z
  .object({
    values: z
      .array(
        z
          .object({
            key: z.string().max(64),
            label: z.string().max(LABEL_MAX),
            source: z.enum(['form', 'custom']),
            value: z.union([z.string().max(LONG_VALUE_MAX), z.number(), z.boolean()]),
            valueLabel: z.string().max(LABEL_MAX).optional(),
          })
          .strict(),
      )
      .max(LEAD_DETAILS_MAX),
    withheld: z.int().nonnegative(),
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
            inbox: z
              .object({
                types: z
                  .array(
                    z
                      .object({
                        leadType: z.string(),
                        leadTypeLabel: z.string(),
                        active: z.int().nonnegative(),
                        unopened: z.int().nonnegative(),
                        followUpsDue: z.int().nonnegative(),
                      })
                      .strict(),
                  )
                  .max(20),
                archived: z.int().nonnegative(),
              })
              .strict(),
          })
          .strict(),
        z
          .object({
            lead: leadProjectionSchema,
            order: orderProjectionSchema.optional(),
            openTasks: z.array(taskProjectionSchema).max(10),
            recentActivity: z.array(activityProjectionSchema).max(15),
            documents: z.array(documentProjectionSchema).max(LEAD_DOCUMENTS_MAX).optional(),
            changeRequest: changeRequestProjectionSchema.optional(),
            details: leadDetailsProjectionSchema.optional(),
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
    notice: z.string().max(300).optional(),
  })
  .strict();
