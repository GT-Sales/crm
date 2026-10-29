import {
  filterableLeadProperties,
  isValidLeadPropertyFilter,
  isValidLeadSort,
  leadAssigneeFilterSchema,
  leadPropertyFilterSchema,
  leadSearchSchema,
  leadSortSchema,
  leadStageSchema,
  leadTypeSchema,
  type LeadAssigneeFilter,
  type LeadPropertyFilter,
} from '@gt-sales/contracts';

/**
 * The inbox's state lives in the URL (`?type=internet&view=board&assignee=me`)
 * so a filtered view can be bookmarked, shared and survives a reload. Values
 * that do not parse are dropped rather than sent to the backend.
 */
export interface InboxQuery {
  /** One lead type, or every type when absent. */
  type?: string;
  /** The trash instead of active leads. */
  trash: boolean;
  /** The board needs one type; with none (or in the trash) it is the table. */
  view: 'table' | 'board';
  stage?: string;
  assignee?: LeadAssigneeFilter;
  q?: string;
  /** Property filters combined with AND (`?where=[...]`). */
  where?: readonly LeadPropertyFilter[];
  /** Table sort (`?sort=<field>:<asc|desc>`). */
  sort?: string;
  /** Optional property columns on the table (`?cols=a,b`, at most 6). */
  columns?: readonly string[];
  /** Only leads with a follow-up due today or earlier (`?due=1`), most overdue first; a table view. */
  due: boolean;
  page: number;
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
    if (candidate && isValidLeadPropertyFilter(candidate, leadType)) {
      valid.push(candidate);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

function parseSortParam(raw: string | null, leadType: string | undefined): string | undefined {
  const candidate = parsed(leadSortSchema.safeParse(raw));
  if (!candidate) return undefined;
  return isValidLeadSort(candidate, leadType) ? candidate : undefined;
}

function parseColumnsParam(
  raw: string | null,
  leadType: string | undefined,
): readonly string[] | undefined {
  if (!raw) return undefined;
  const allowed = new Set(filterableLeadProperties(leadType).map((entry) => entry.key));
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

export function parseInboxQuery(params: ReadableParams): InboxQuery {
  const trash = params.get('trash') === '1';
  const type = trash ? undefined : parsed(leadTypeSchema.safeParse(params.get('type')));
  const due = !trash && params.get('due') === '1';
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  const where = trash ? undefined : parseWhereParam(params.get('where'), type);
  const sort = trash ? undefined : parseSortParam(params.get('sort'), type);
  const columns = trash
    ? undefined
    : parseColumnsParam(params.get('cols') ?? params.get('columns'), type);
  return {
    type,
    trash,
    due,
    view: params.get('view') === 'board' && type !== undefined && !due ? 'board' : 'table',
    stage: type ? parsed(leadStageSchema.safeParse(params.get('stage'))) : undefined,
    assignee: parsed(leadAssigneeFilterSchema.safeParse(params.get('assignee'))),
    q: parsed(leadSearchSchema.safeParse(params.get('q'))),
    where,
    sort,
    columns,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/**
 * Drops any property filter, optional column or property sort that `nextType`
 * does not use when the viewer switches lead type tabs.
 */
export function filterQueryForLeadType(
  query: InboxQuery,
  nextType: string | undefined,
): Pick<InboxQuery, 'where' | 'sort' | 'columns'> {
  const allowedCols = new Set(filterableLeadProperties(nextType).map((entry) => entry.key));
  const nextWhere = query.where?.filter((filter) => isValidLeadPropertyFilter(filter, nextType));
  const nextCols = query.columns?.filter((key) => allowedCols.has(key));
  const nextSort = query.sort && isValidLeadSort(query.sort, nextType) ? query.sort : undefined;
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
  else if (query.view === 'board' && query.type && !query.trash) params.set('view', 'board');
  if (query.stage && query.type) params.set('stage', query.stage);
  if (query.assignee) params.set('assignee', query.assignee);
  if (query.q) params.set('q', query.q);
  if (query.where && query.where.length > 0 && !query.trash) {
    params.set('where', JSON.stringify(query.where));
  }
  if (query.sort && !query.trash && query.view === 'table') {
    params.set('sort', query.sort);
  }
  if (query.columns && query.columns.length > 0 && !query.trash && query.view === 'table') {
    params.set('cols', query.columns.join(','));
  }
  if (query.page > 1) params.set('page', String(query.page));
  const search = params.toString();
  return search ? `?${search}` : '';
}
