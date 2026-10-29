import {
  codePropertyCatalog,
  filterableLeadProperties,
  isValidLeadPropertyFilter,
  isValidLeadSort,
  LEAD_TABLE_COLUMNS,
  leadAssigneeFilterSchema,
  leadPropertyFilterSchema,
  leadSearchSchema,
  leadSortSchema,
  leadStageSchema,
  leadTypeSchema,
  type LeadAssigneeFilter,
  type LeadPropertyFilter,
  type LeadTableColumn,
  type PropertyCatalog,
} from '@gt-sales/contracts';

/**
 * The inbox's state lives in the URL (`?type=internet&layout=board&assignee=me`)
 * so a filtered view can be bookmarked, shared and survives a reload. Values
 * that do not parse are dropped rather than sent to the backend. Property
 * filters, sorts and columns are checked against the site's catalogue (the
 * code one when none is given).
 */
export interface InboxQuery {
  /** One lead type, or every type when absent. */
  type?: string;
  /** The trash instead of active leads. */
  trash: boolean;
  /**
   * `?layout=board`; the board needs one type, so with none (or in the trash)
   * it is the table. Links from before saved views said `?view=board`.
   */
  layout: 'table' | 'board';
  /** The saved view the list was opened from (`?view=<id>`), kept while staff change it. */
  view?: string;
  stage?: string;
  assignee?: LeadAssigneeFilter;
  q?: string;
  /** Property filters combined with AND (`?where=[...]`). */
  where?: readonly LeadPropertyFilter[];
  /** Table sort (`?sort=<field>:<asc|desc>`). */
  sort?: string;
  /** Optional property columns on the table (`?cols=a,b`, at most 6). */
  columns?: readonly string[];
  /** Table columns turned off (`?hide=source,created`), in table order. */
  hide: LeadTableColumn[];
  /** Only leads with a follow-up due today or earlier (`?due=1`), most overdue first; a table view. */
  due: boolean;
  page: number;
  /** The lead open in the side panel (`?lead=<id>`), kept while the list changes around it. */
  lead?: string;
}

interface ReadableParams {
  get(name: string): string | null;
}

function parsed<T>(result: { success: true; data: T } | { success: false }): T | undefined {
  return result.success ? result.data : undefined;
}

function parseWhereParam(
  raw: string | null,
  leadType: string | undefined,
  catalog: PropertyCatalog,
): readonly LeadPropertyFilter[] | undefined {
  if (!raw || raw.length > 2000) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > 10) return undefined;
  const valid: LeadPropertyFilter[] = [];
  for (const item of decoded) {
    const candidate = parsed(leadPropertyFilterSchema.safeParse(item));
    if (candidate && isValidLeadPropertyFilter(candidate, leadType, catalog)) {
      valid.push(candidate);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

function parseSortParam(
  raw: string | null,
  leadType: string | undefined,
  catalog: PropertyCatalog,
): string | undefined {
  const candidate = parsed(leadSortSchema.safeParse(raw));
  if (!candidate) return undefined;
  return isValidLeadSort(candidate, leadType, catalog) ? candidate : undefined;
}

function parseColumnsParam(
  raw: string | null,
  leadType: string | undefined,
  catalog: PropertyCatalog,
): readonly string[] | undefined {
  if (!raw) return undefined;
  const allowed = new Set(filterableLeadProperties(leadType, catalog).map((entry) => entry.key));
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const part of raw.split(',')) {
    const key = part.trim();
    if (!key || seen.has(key) || !allowed.has(key)) continue;
    seen.add(key);
    valid.push(key);
    if (valid.length >= 6) break;
  }
  return valid.length > 0 ? valid : undefined;
}

/** The ids of `LEAD_TABLE_COLUMNS` named in `?hide=`, once each, in table order. */
export function parseHiddenColumns(raw: string | null | readonly string[]): LeadTableColumn[] {
  if (!raw) return [];
  const named = new Set(typeof raw === 'string' ? raw.split(',').map((part) => part.trim()) : raw);
  return LEAD_TABLE_COLUMNS.filter((key) => named.has(key));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInboxQuery(
  params: ReadableParams,
  catalog: PropertyCatalog = codePropertyCatalog,
): InboxQuery {
  const trash = params.get('trash') === '1';
  const type = trash ? undefined : parsed(leadTypeSchema.safeParse(params.get('type')));
  const due = !trash && params.get('due') === '1';
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  const where = trash ? undefined : parseWhereParam(params.get('where'), type, catalog);
  const sort = trash ? undefined : parseSortParam(params.get('sort'), type, catalog);
  const columns = trash
    ? undefined
    : parseColumnsParam(params.get('cols') ?? params.get('columns'), type, catalog);
  const viewParam = params.get('view');
  const legacyLayout = viewParam === 'board' || viewParam === 'table' ? viewParam : undefined;
  const layout = params.get('layout') ?? legacyLayout;
  const view = viewParam && UUID.test(viewParam) ? viewParam.toLowerCase() : undefined;
  const leadParam = params.get('lead');
  const lead = leadParam && UUID.test(leadParam) ? leadParam.toLowerCase() : undefined;
  return {
    type,
    trash,
    due,
    layout: layout === 'board' && type !== undefined && !due ? 'board' : 'table',
    ...(view ? { view } : {}),
    stage: type ? parsed(leadStageSchema.safeParse(params.get('stage'))) : undefined,
    assignee: parsed(leadAssigneeFilterSchema.safeParse(params.get('assignee'))),
    q: parsed(leadSearchSchema.safeParse(params.get('q'))),
    where,
    sort,
    columns,
    hide: parseHiddenColumns(params.get('hide')),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    ...(lead ? { lead } : {}),
  };
}

/**
 * Drops any property filter, optional column or property sort that `nextType`
 * does not use when the viewer switches lead type tabs.
 */
export function filterQueryForLeadType(
  query: InboxQuery,
  nextType: string | undefined,
  catalog: PropertyCatalog = codePropertyCatalog,
): Pick<InboxQuery, 'where' | 'sort' | 'columns'> {
  const allowedCols = new Set(
    filterableLeadProperties(nextType, catalog).map((entry) => entry.key),
  );
  const nextWhere = query.where?.filter((filter) =>
    isValidLeadPropertyFilter(filter, nextType, catalog),
  );
  const nextCols = query.columns?.filter((key) => allowedCols.has(key));
  const nextSort =
    query.sort && isValidLeadSort(query.sort, nextType, catalog) ? query.sort : undefined;
  return {
    where: nextWhere && nextWhere.length > 0 ? nextWhere : undefined,
    sort: nextSort,
    columns: nextCols && nextCols.length > 0 ? nextCols : undefined,
  };
}

export function inboxSearch(query: InboxQuery): string {
  const params = new URLSearchParams();
  if (query.trash) params.set('trash', '1');
  else if (query.type) params.set('type', query.type);
  if (query.due && !query.trash) params.set('due', '1');
  else if (query.layout === 'board' && query.type && !query.trash) params.set('layout', 'board');
  if (query.view) params.set('view', query.view);
  if (query.stage && query.type) params.set('stage', query.stage);
  if (query.assignee) params.set('assignee', query.assignee);
  if (query.q) params.set('q', query.q);
  if (query.where && query.where.length > 0 && !query.trash) {
    params.set('where', JSON.stringify(query.where));
  }
  if (query.sort && !query.trash && query.layout === 'table') {
    params.set('sort', query.sort);
  }
  if (query.columns && query.columns.length > 0 && !query.trash && query.layout === 'table') {
    params.set('cols', query.columns.join(','));
  }
  const hide = parseHiddenColumns(query.hide);
  if (hide.length > 0) params.set('hide', hide.join(','));
  if (query.page > 1) params.set('page', String(query.page));
  if (query.lead) params.set('lead', query.lead);
  const search = params.toString();
  return search ? `?${search}` : '';
}
