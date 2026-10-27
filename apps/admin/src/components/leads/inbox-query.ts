import {
  leadAssigneeFilterSchema,
  leadSearchSchema,
  leadStageSchema,
  leadTypeSchema,
  type LeadAssigneeFilter,
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

export function parseInboxQuery(params: ReadableParams): InboxQuery {
  const trash = params.get('trash') === '1';
  const type = trash ? undefined : parsed(leadTypeSchema.safeParse(params.get('type')));
  const due = !trash && params.get('due') === '1';
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    type,
    trash,
    due,
    view: params.get('view') === 'board' && type !== undefined && !due ? 'board' : 'table',
    stage: type ? parsed(leadStageSchema.safeParse(params.get('stage'))) : undefined,
    assignee: parsed(leadAssigneeFilterSchema.safeParse(params.get('assignee'))),
    q: parsed(leadSearchSchema.safeParse(params.get('q'))),
    page: Number.isInteger(page) && page > 0 ? page : 1,
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
  if (query.page > 1) params.set('page', String(query.page));
  const search = params.toString();
  return search ? `?${search}` : '';
}
