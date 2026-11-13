import { sql } from 'drizzle-orm';
import { auditEvents, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import {
  LEAD_EXPORT_MAX_ROWS,
  leadExportColumns,
  leadExportFileName,
  leadTypeCatalog,
  leadTypeLabel,
  type LeadExportAccess,
  type LeadExportField,
  type LeadExportScope,
  type PropertyCatalog,
} from '@gt-sales/contracts';

import { todayInToronto } from '../stage-move.js';
import {
  countLeadsForExport,
  selectLeadsForExport,
  type LeadExportRow,
  type LeadExportSelection,
} from '../staff-queries.js';
import { leadExportCell, type CellContext } from './cells.js';
import { buildLeadWorkbook, type ExportSheet } from './workbook.js';

/**
 * Leads as an Excel file, for the staff route. One tenant transaction counts
 * the selection, reads it (every page, in the list's own order) and writes
 * the audit event; the workbook is built after the transaction ends, so the
 * pooled connection is not held while the file is made.
 */

/** The export's statements may take longer than a page of the list (the tenant default is 15 s). */
export const LEAD_EXPORT_STATEMENT_TIMEOUT_MS = 30_000;

export interface LeadExportInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  scope: LeadExportScope;
  /** The optional fields asked for; the main ones are always written. */
  fields: readonly string[];
  access: LeadExportAccess;
  /** The site's catalogue the filters were validated against and the columns are read from. */
  catalog: PropertyCatalog;
  now?: Date;
}

export type LeadExportOutcome =
  | { status: 'exported'; file: Buffer; fileName: string; rowCount: number }
  /** More leads than one export writes; nothing was read. */
  | { status: 'too_large'; total: number; max: number }
  /** Some ticked leads are not this site's (or are restricted, or gone); nothing was read. */
  | { status: 'leads_not_found'; missing: number };

export interface LeadExportStore {
  export(input: LeadExportInput): Promise<LeadExportOutcome>;
}

/**
 * What the audit event says about the selection: how many ids, or which
 * filters were on. Never the search text or a filter's value: both can be a
 * customer's name or address.
 */
function auditedScope(scope: LeadExportScope): Record<string, unknown> {
  if (scope.kind === 'ids') return { kind: 'ids', count: scope.ids.length };
  const { filter } = scope;
  return {
    kind: 'filter',
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.stage ? { stage: filter.stage } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    view: filter.view === 'archived' || filter.view === 'trash' ? 'archived' : 'active',
    ...(filter.assignee
      ? {
          assignee:
            filter.assignee === 'me' || filter.assignee === 'none' ? filter.assignee : 'member',
        }
      : {}),
    ...(filter.q ? { search: true } : {}),
    ...(filter.dueBy ? { dueBy: filter.dueBy } : {}),
    ...(filter.where && filter.where.length > 0
      ? { where: filter.where.map((entry) => ({ key: entry.key, op: entry.op })) }
      : {}),
    ...(filter.sort ? { sort: filter.sort } : {}),
  };
}

/** The lead types in the registry's order, then any other alphabetically. */
function orderedTypes(types: Iterable<string>): string[] {
  const known = Object.keys(leadTypeCatalog);
  const rank = (leadType: string) => {
    const index = known.indexOf(leadType);
    return index === -1 ? known.length : index;
  };
  return [...new Set(types)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function selectionOf(input: LeadExportInput): LeadExportSelection {
  if (input.scope.kind === 'ids') {
    return { kind: 'ids', workspaceId: input.workspaceId, ids: input.scope.ids };
  }
  const { filter } = input.scope;
  return {
    kind: 'filter',
    filters: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      status: filter.status,
      leadType: filter.type,
      stage: filter.stage,
      assignee: filter.assignee,
      search: filter.q,
      view: filter.view,
      dueBy: filter.dueBy,
      where: filter.where,
      sort: filter.sort,
      catalog: input.catalog,
    },
  };
}

/**
 * The sheet's headers: each field's label, and where two fields share one (a
 * custom property a site named "Name"), the later one says which group it is
 * from, so no two columns of a sheet read the same.
 */
export function exportHeaders(fields: readonly LeadExportField[]): string[] {
  const used = new Set<string>();
  return fields.map((field) => {
    let header = field.label;
    if (used.has(header.toLowerCase())) header = `${field.label} (${field.group})`;
    for (let n = 2; used.has(header.toLowerCase()); n += 1) header = `${field.label} (${n})`;
    used.add(header.toLowerCase());
    return header;
  });
}

interface Loaded {
  rows: LeadExportRow[];
  siteSlug: string;
  memberNames: Map<string, string>;
}

export class DatabaseLeadExportStore implements LeadExportStore {
  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    /** The row cap; only a test lowers it. */
    private readonly maxRows: number = LEAD_EXPORT_MAX_ROWS,
  ) {}

  async export(input: LeadExportInput): Promise<LeadExportOutcome> {
    const selection = selectionOf(input);
    // A sheet's columns depend only on its lead type, so they are worked out once per type.
    const columnsByType = new Map<string, LeadExportField[]>();
    const columnsFor = (leadType: string) => {
      let columns = columnsByType.get(leadType);
      if (!columns) {
        columns = leadExportColumns({
          catalog: input.catalog,
          leadType,
          access: input.access,
          fields: input.fields,
        });
        columnsByType.set(leadType, columns);
      }
      return columns;
    };
    const asked = new Set(input.fields);
    const activity = ['stageChangedAt', 'lastActivityAt', 'noteCount'].some((key) =>
      asked.has(key),
    );

    const loaded = await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx): Promise<Loaded | Exclude<LeadExportOutcome, { status: 'exported' }>> => {
        await tx.execute(
          sql`select set_config('statement_timeout', ${String(LEAD_EXPORT_STATEMENT_TIMEOUT_MS)}, true)`,
        );
        const total = await countLeadsForExport(tx, selection);
        if (selection.kind === 'ids' && total !== selection.ids.length) {
          return { status: 'leads_not_found', missing: selection.ids.length - total };
        }
        if (total > this.maxRows) {
          return { status: 'too_large', total, max: this.maxRows };
        }
        const rows = await selectLeadsForExport(
          tx,
          selection,
          // Forms, custom values and orders are not even read for a caller without contact access.
          { details: input.access.contacts, activity: activity && input.access.contacts },
          this.maxRows,
        );
        // The runtime role cannot read `app.workspaces`; this function names the open tenant.
        const [site] = await tx.execute<{ [key: string]: unknown; slug: string }>(
          sql`select workspace_slug as slug from app.current_workspace_identity()`,
        );
        const members = await tx.execute<{
          [key: string]: unknown;
          userId: string;
          displayName: string | null;
        }>(sql`
          select m.user_id as "userId", m.display_name as "displayName"
          from app.memberships m
          where m.workspace_id = ${input.workspaceId}
            and m.membership_type = 'staff'
            and m.status = 'active'
            and m.user_id is not null
        `);
        const types = orderedTypes(rows.map((row) => row.lead.leadType));
        for (const leadType of types) columnsFor(leadType);

        // Who exported what: ids and field keys only, never a customer's value.
        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'lead.exported',
          entity: 'workspace',
          entityId: input.workspaceId,
          requestId: input.requestId,
          after: {
            scope: auditedScope(input.scope),
            rowCount: rows.length,
            sheets: types.map((leadType) => ({
              leadType,
              rows: rows.filter((row) => row.lead.leadType === leadType).length,
              fields: columnsFor(leadType).map((field) => field.key),
            })),
            contacts: input.access.contacts,
          },
        });
        return {
          // Defence in depth: the contact columns are not among this caller's fields anyway.
          rows: input.access.contacts
            ? rows
            : rows.map((row) => ({ ...row, lead: { ...row.lead, contact: {} } })),
          siteSlug: site?.slug ?? 'site',
          memberNames: new Map(
            members.map((member) => [member.userId, member.displayName ?? 'Unnamed teammate']),
          ),
        };
      },
    );
    if ('status' in loaded) return loaded;

    const context: CellContext = { memberNames: loaded.memberNames };
    const types = orderedTypes(loaded.rows.map((row) => row.lead.leadType));
    // No lead at all still answers with a file: the headers of the type asked for.
    const emptyType = input.scope.kind === 'filter' ? input.scope.filter.type : undefined;
    const sheetTypes = types.length > 0 ? types : [emptyType ?? ''];
    const sheets: ExportSheet[] = sheetTypes.map((leadType) => {
      const columns = columnsFor(leadType);
      return {
        name: leadType === '' ? 'Leads' : leadTypeLabel(leadType),
        columns: exportHeaders(columns).map((label) => ({ label })),
        rows: loaded.rows
          .filter((row) => row.lead.leadType === leadType)
          .map((row) => columns.map((field) => leadExportCell(field, row, context))),
      };
    });
    const file = await buildLeadWorkbook(sheets);
    return {
      status: 'exported',
      file,
      fileName: leadExportFileName({
        siteSlug: loaded.siteSlug,
        leadType: sheetTypes.length === 1 && sheetTypes[0] !== '' ? sheetTypes[0] : undefined,
        day: todayInToronto(input.now ?? new Date()),
      }),
      rowCount: loaded.rows.length,
    };
  }
}
