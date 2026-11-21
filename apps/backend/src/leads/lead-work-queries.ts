import { sql } from 'drizzle-orm';
import { type TenantTransaction } from '@gt-sales/db';
import {
  RELATED_LEADS_LIMIT,
  leadActivitySchema,
  leadContactSchema,
  leadDocumentSchema,
  leadFormSchema,
  leadIdentitySchema,
  leadStageSchema,
  leadTaskSchema,
  leadTypeSchema,
  relatedLeadSchema,
  type LeadActivity,
  type LeadDetail,
  type LeadDocument,
  type LeadIdentity,
  type StaffChangeRequest,
  type PropertyCatalog,
  type LeadTask,
  type TaskStatusFilter,
  type RelatedLead,
  type TaskAssigneeFilter,
  type WorkspaceTask,
} from '@gt-sales/contracts';
import {
  PENDING_REQUEST_JSON,
  pendingRequestFromJson,
  toStaffChangeRequest,
} from '../tracking/change-request-rows.js';
import { LATEST_REVIEW, currentLeadDocuments } from './documents-check.js';
import { sentMailOf } from '../email/kept-text.js';
import { draftSaveValuesOf, shownDraftValues } from './draft-changes.js';
import { dueCutoff } from './lead-filters.js';
import {
  LEAD_COLUMNS,
  LEAD_TIMESTAMPS,
  type LeadRow,
  OPEN_TASK_SUMMARY,
  iso,
  orderOf,
  toCustomValues,
  toLeadListItem,
} from './staff-queries.js';

/**
 * The lead page's read (the lead with its timeline, tasks, related leads,
 * documents and pending change request, in one statement) and the task
 * reads, in the same plain SQL as `staff-queries.ts`.
 */

export interface ActivityRow {
  [key: string]: unknown;
  id: string;
  actorId: string;
  kind: string;
  body: string | null;
  data: unknown;
  createdAt: string;
  /** How a `customer_emailed` entry's send went; read with the lead page only. */
  mailStatus?: string | null;
}

/** The entries that are a mail: one the CRM sent, or the customer's reply. Both keep their words in `body`. */
const MAIL_EVENTS: ReadonlySet<unknown> = new Set(['customer_emailed', 'customer_replied']);

/**
 * How the mail behind a `customer_emailed` entry `a` went: the provider's
 * last report when the send got that far, else where its outbox job stands.
 * Null for other entries and for mails queued before entries named their job.
 */
export const MAIL_STATUS = sql.raw(`(
  select case
    when m.status is not null and m.status <> 'queued' then m.status
    when j.status in ('pending', 'processing') then 'queued'
    when j.status in ('failed', 'uncertain') then j.status
    when j.provider_id like 'skipped:%' then 'skipped'
    else 'sent'
  end
  from app.outbox_jobs j
  left join app.email_messages m
    on m.workspace_id = j.workspace_id and m.message_id = j.message_id
  where a.kind = 'system'
    and a.data ->> 'event' = 'customer_emailed'
    and j.workspace_id = a.workspace_id
    and j.id = case
      when a.data ->> 'jobId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      then (a.data ->> 'jobId')::uuid
    end
)`);

/**
 * A stored timeline row as the contract's entry. `data` carries the kind's
 * fields (`from`/`to`, `fields`, `event`); a row that does not fit its kind
 * (written by a newer version, or a kind not yet shown) becomes a neutral
 * `system` entry rather than failing the whole lead page.
 */
export function toLeadActivity(row: ActivityRow): LeadActivity {
  const data =
    typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data) ? row.data : {};
  // A mail to the customer keeps its subject and text in `body` (keptMailText).
  const mail =
    row.kind === 'system' &&
    Object.hasOwn(data, 'event') &&
    MAIL_EVENTS.has(Reflect.get(data, 'event'))
      ? sentMailOf(row.body)
      : undefined;
  // A customer's draft save keeps the values they filled in in `body` too
  // (issue #87, `draft-changes.ts`); none once their data is erased.
  const draftSave =
    row.kind === 'system' &&
    Object.hasOwn(data, 'event') &&
    Reflect.get(data, 'event') === 'draft_saved';
  const draftValues = draftSave ? draftSaveValuesOf(row.body) : undefined;
  const parsed = leadActivitySchema.safeParse({
    ...data,
    ...(mail ?? {}),
    ...(draftValues ? { values: draftValues } : {}),
    ...(row.mailStatus ? { mailStatus: row.mailStatus } : {}),
    id: row.id,
    actorId: row.actorId,
    kind: row.kind,
    // A mail's body is served as `subject` and `text`, and a draft save's as
    // `values`, not twice.
    body: mail || draftSave ? undefined : (row.body ?? undefined),
    createdAt: row.createdAt,
  });
  if (parsed.success) return parsed.data;
  // A data migration's entry (`data.migration`) says in its body what it
  // changed, so the body is kept for the admin to show.
  const migrationBody =
    row.kind === 'system' && Object.hasOwn(data, 'migration') && row.body ? row.body : undefined;
  return {
    id: row.id,
    actorId: row.actorId,
    createdAt: row.createdAt,
    kind: 'system',
    event: 'unknown',
    ...(migrationBody ? { body: migrationBody.slice(0, 4000) } : {}),
  };
}

interface TaskRow {
  [key: string]: unknown;
  id: string;
  /** Null for a plain task. */
  leadId: string | null;
  title: string;
  dueAt: string | null;
  assignedActorId: string | null;
  status: string;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TASK_COLUMNS = sql.join(
  [
    sql.raw(
      'k.id, k.lead_id as "leadId", k.title, k.assigned_actor_id as "assignedActorId", k.status, k.created_by as "createdBy"',
    ),
    sql`${iso('k.due_at')} as "dueAt"`,
    sql`${iso('k.completed_at')} as "completedAt"`,
    sql`${iso('k.created_at')} as "createdAt"`,
    sql`${iso('k.updated_at')} as "updatedAt"`,
  ],
  sql`, `,
);

export function toLeadTask(row: TaskRow): LeadTask {
  return leadTaskSchema.parse({
    id: row.id,
    leadId: row.leadId,
    title: row.title,
    dueAt: row.dueAt,
    assignedActorId: row.assignedActorId,
    status: row.status,
    completedAt: row.completedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export interface LeadWithWork {
  lead: LeadDetail;
  activities: LeadActivity[];
  tasks: LeadTask[];
  related: RelatedLead[];
  identities: LeadIdentity[];
  documents: LeadDocument[];
  /** The customer's pending change request, if any (ruling 3: at most one). */
  changeRequest: StaffChangeRequest | null;
}

/**
 * The lead page in one statement: the lead with its form, its timeline (newest
 * first, capped so one very long history cannot stall the page), its tasks
 * (active ones — open or in progress — first, soonest due, undated last; then closed ones, most recently
 * changed first), the same person's other requests on this site (newest
 * first, trashed ones included and marked), the identities given for a
 * credit check (newest first, a SIN masked to its last three digits) and its
 * current documents (one per type, oldest first), the last five as JSON
 * arrays.
 * Each statement is a round trip to the remote pooler, so the page's reads
 * travel as one.
 */
export async function selectLeadWithWork(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  catalog: PropertyCatalog,
): Promise<LeadWithWork | undefined> {
  const [row] = await tx.execute<
    LeadRow & {
      payload: unknown;
      customValues: unknown;
      activities: ActivityRow[];
      tasks: TaskRow[];
      related: unknown[];
      identities: unknown[];
      documents: unknown[];
      changeRequest: unknown;
    }
  >(sql`
    select
      ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS},
      l.payload,
      l.custom_values as "customValues",
      l.order_details as "orderDetails",
      (
        select coalesce(json_agg(json_build_object(
          'id', a.id,
          'actorId', a.actor_id,
          'kind', a.kind,
          'body', a.body,
          'data', a.data,
          'mailStatus', ${MAIL_STATUS},
          'createdAt', ${iso('a.created_at')}
        ) order by a.created_at desc, a.id desc), '[]'::json)
        from (
          select entry.*
          from app.lead_activities entry
          where entry.workspace_id = l.workspace_id and entry.lead_id = l.id
          order by entry.created_at desc, entry.id desc
          limit 500
        ) a
      ) as activities,
      (
        select coalesce(json_agg(json_build_object(
          'id', k.id,
          'leadId', k.lead_id,
          'title', k.title,
          'assignedActorId', k.assigned_actor_id,
          'status', k.status,
          'createdBy', k.created_by,
          'dueAt', ${iso('k.due_at')},
          'completedAt', ${iso('k.completed_at')},
          'createdAt', ${iso('k.created_at')},
          'updatedAt', ${iso('k.updated_at')}
        ) order by
          (k.status in ('open', 'in_progress')) desc,
          case when k.status in ('open', 'in_progress') then k.due_at end asc nulls last,
          k.updated_at desc,
          k.id
        ), '[]'::json)
        from app.lead_tasks k
        where k.workspace_id = l.workspace_id and k.lead_id = l.id
      ) as tasks,
      (
        select coalesce(json_agg(json_build_object(
          'id', o.id,
          'leadType', o.lead_type,
          'status', o.status,
          'stage', o.stage,
          'deletedAt', ${iso('o.deleted_at')},
          'createdAt', ${iso('o.created_at')},
          'updatedAt', ${iso('o.updated_at')}
        ) order by o.created_at desc, o.id desc), '[]'::json)
        from (
          select other.*
          from app.leads other
          where other.workspace_id = l.workspace_id
            and other.contact_id = l.contact_id
            and other.id <> l.id
            and other.customer_data_restricted_at is null
          order by other.created_at desc, other.id desc
          limit ${sql.raw(String(RELATED_LEADS_LIMIT))}
        ) o
      ) as related,
      (
        select coalesce(json_agg(json_build_object(
          'id', i.id,
          'idType', i.id_type,
          'sinMasked', case when i.sin_last3 is null then null else '*** *** ' || i.sin_last3 end,
          'dateOfBirth', to_char(i.date_of_birth, 'YYYY-MM-DD'),
          'fileId', i.file_id,
          'createdAt', ${iso('i.created_at')}
        ) order by i.created_at desc, i.id desc), '[]'::json)
        from app.lead_identities i
        where i.workspace_id = l.workspace_id and i.lead_id = l.id
      ) as identities,
      (
        -- A licence photo given for the credit check is the ID check's, not here.
        select coalesce(json_agg(json_build_object(
          'id', f.id,
          'documentType', f.document_type,
          'contentType', f.detected_mime,
          'sizeBytes', f.size_bytes,
          'revision', f.revision,
          'createdAt', ${iso('f.created_at')},
          'review', case when review.decision is null then null else json_build_object(
            'decision', review.decision,
            'at', ${iso('review.created_at')}
          ) end
        ) order by f.created_at, f.id), '[]'::json)
        from app.files f
        ${LATEST_REVIEW}
        where ${currentLeadDocuments(sql`l.workspace_id`, sql`l.id`)}
      ) as documents,
      ${PENDING_REQUEST_JSON} as "changeRequest"
    from app.leads l
    ${OPEN_TASK_SUMMARY}
    where l.workspace_id = ${workspaceId}
      and l.id = ${leadId}
      and l.customer_data_restricted_at is null
  `);
  if (!row) return undefined;
  const form = leadFormSchema.safeParse(row.payload);
  const item = toLeadListItem(row);
  return {
    lead: {
      ...item,
      form: form.success ? form.data : null,
      customValues: toCustomValues(row.customValues, catalog),
      ...orderOf(row),
    },
    // A draft save's values are shown by the site's catalogue as it is now.
    activities: row.activities.map(toLeadActivity).map((activity) =>
      activity.kind === 'system' && activity.event === 'draft_saved' && activity.values
        ? {
            ...activity,
            values: shownDraftValues(activity.values, item.leadType, catalog),
          }
        : activity,
    ),
    tasks: row.tasks.map(toLeadTask),
    // A request this version cannot show (say, a newer lead type) is left
    // out rather than failing the page.
    related: row.related.flatMap((item) => {
      const parsed = relatedLeadSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    // Masked as stored: the sealed SIN never leaves the database on this path.
    identities: row.identities.flatMap((item) => {
      const parsed = leadIdentitySchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    documents: row.documents.flatMap((item) => {
      const parsed = leadDocumentSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    changeRequest: pendingStaffRequest(row.changeRequest),
  };
}

function pendingStaffRequest(value: unknown): StaffChangeRequest | null {
  const pending = pendingRequestFromJson(value);
  return pending ? toStaffChangeRequest(pending) : null;
}

export async function selectTask(
  tx: TenantTransaction,
  workspaceId: string,
  taskId: string,
): Promise<LeadTask | undefined> {
  const [row] = await tx.execute<TaskRow>(sql`
    select ${TASK_COLUMNS}
    from app.lead_tasks k
    where k.workspace_id = ${workspaceId} and k.id = ${taskId}
  `);
  return row ? toLeadTask(row) : undefined;
}

export interface TaskFilters {
  workspaceId: string;
  actorId: string;
  assignee: TaskAssigneeFilter;
  /** One status, or `active` for `open` and `in_progress` together. */
  status: TaskStatusFilter;
  /** Only tasks due on or before this calendar day (an undated task never is). */
  dueBy?: string;
  /** Only tasks completed on or after this calendar day, from 00:00 UTC. */
  completedSince?: string;
  /** The site's plain tasks (no lead) too; without it only lead tasks are listed. */
  includePlain?: boolean;
}

/**
 * Tasks on the workspace's active leads (and, with `includePlain`, its plain
 * tasks), soonest due first (undated last), with each lead's summary (null for
 * a plain task). A left join, so a plain task is a deliberate choice of this
 * filter, never one an inner join drops; the filter still reads the task
 * indexes by site, status, assignee and due time.
 */
export async function selectWorkspaceTasks(
  tx: TenantTransaction,
  filters: TaskFilters,
  page: number,
  pageSize: number,
): Promise<{ tasks: WorkspaceTask[]; total: number }> {
  const assignee =
    filters.assignee === 'all'
      ? sql`true`
      : filters.assignee === 'me'
        ? sql`k.assigned_actor_id = ${filters.actorId}`
        : filters.assignee === 'none'
          ? sql`k.assigned_actor_id is null`
          : sql`k.assigned_actor_id = ${filters.assignee}`;
  const due = filters.dueBy ? sql`k.due_at < ${dueCutoff(filters.dueBy)}` : sql`true`;
  const status =
    filters.status === 'active'
      ? sql`k.status in ('open', 'in_progress')`
      : sql`k.status = ${filters.status}`;
  const completed = filters.completedSince
    ? sql`k.completed_at >= ${`${filters.completedSince}T00:00:00.000Z`}::timestamptz`
    : sql`true`;
  // Done tasks read most recently completed first (the board's Done column);
  // everything else soonest due first.
  const order =
    filters.status === 'done'
      ? sql`k.completed_at desc nulls last, k.id`
      : sql`k.due_at asc nulls last, k.created_at asc, k.id`;
  // A lead's task only while its lead is active and unrestricted; a plain task when asked for.
  const visible = sql`(${filters.includePlain ? sql`k.lead_id is null` : sql`false`} or (l.id is not null and l.deleted_at is null and l.customer_data_restricted_at is null))`;
  const rows = await tx.execute<
    TaskRow & {
      total: number;
      leadType: string | null;
      stage: string | null;
      fullName: string | null;
      email: string | null;
      phone: string | null;
      countryCode: string | null;
      externalRef: string | null;
    }
  >(sql`
    select
      ${TASK_COLUMNS},
      count(*) over ()::int as total,
      l.lead_type as "leadType",
      l.stage,
      l.full_name as "fullName",
      l.email,
      l.phone,
      l.country_code as "countryCode",
      l.external_ref as "externalRef"
    from app.lead_tasks k
    left join app.leads l on l.workspace_id = k.workspace_id and l.id = k.lead_id
    where k.workspace_id = ${filters.workspaceId}
      and ${status}
      and ${assignee}
      and ${due}
      and ${completed}
      and ${visible}
    order by ${order}
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  return {
    tasks: rows.map((row) => ({
      ...toLeadTask(row),
      lead:
        row.leadId === null
          ? null
          : {
              id: row.leadId,
              leadType: leadTypeSchema.parse(row.leadType),
              stage: leadStageSchema.parse(row.stage),
              contact: leadContactSchema.parse({
                fullName: row.fullName ?? undefined,
                email: row.email ?? undefined,
                phone: row.phone ?? undefined,
                countryCode: row.countryCode ?? undefined,
              }),
              externalRef: row.externalRef,
            },
    })),
    total: rows[0]?.total ?? 0,
  };
}
