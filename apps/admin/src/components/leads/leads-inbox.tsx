'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CUSTOM_PROPERTY_KEY_PREFIX,
  DEFAULT_LEAD_VIEW_STATE,
  isValidLeadPropertyFilter,
  leadPropertyOperators,
  leadTypeEntry,
  leadTypeLabel,
  SAVED_VIEW_LIMIT,
  type FilterableLeadProperty,
  type LeadFieldOption,
  type LeadPropertyFilter,
  type LeadPropertyOperator,
  type LeadTableColumn,
  type SavedView,
} from '@gt-sales/contracts';
import {
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  NativeSelect,
  Popover,
  PopoverTrigger,
} from '@gt-sales/ui';
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  BellRingIcon,
  Columns3Icon,
  ExternalLinkIcon,
  FilterIcon,
  KanbanSquareIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TableIcon,
} from 'lucide-react';

import {
  createSavedView,
  deleteSavedView,
  getLeadsSummary,
  listSavedViews,
  updateSavedView,
} from '../../lib/api';
import { todayDay } from '../../lib/dates';
import { memberName } from '../../lib/people';
import { errorReason, useResource } from '../../lib/use-resource';
import { FilterChip } from '../crm/filter-chip';
import { MenuItem, MenuLabel, MenuPanel, MenuSeparator } from '../crm/menu';
import { SidePanel } from '../crm/side-panel';
import { dollarsToCents } from '../properties/property-value';
import { usePropertyModel } from '../properties/use-property-model';
import {
  filterQueryForLeadType,
  inboxSearch,
  parseHiddenColumns,
  parseInboxQuery,
  type InboxQuery,
} from './inbox-query';
import { stageDotClass } from './lead-display';
import { propertyFilterParts, propertyOperatorLabel } from './lead-fields';
import { LeadRecord } from './lead-record';
import { LeadsBoard } from './leads-board';
import { LeadsTable } from './leads-table';
import { SavedViewSwitcher } from './saved-view-switcher';
import { useLeadWorkspace } from './use-lead-workspace';
import { BOARD_CARD_FIELDS, TABLE_COLUMNS, useStoredList } from './view-preferences';
import {
  allLeadsQuery,
  appliedViewState,
  inboxQueryToViewState,
  isViewDirty,
  viewStateToInboxQuery,
} from './view-state';

const SEARCH_DELAY_MS = 300;

/** The outline toolbar buttons beside the filters: Add filter, Sort, Columns, View options. */
const TOOLBAR_BUTTON = 'h-9 gap-1.5';
const TOOLBAR_ICON = 'size-4 text-muted-foreground';

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
        active
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
      {value}
    </span>
  );
}

/** A choice option the site no longer offers for new values (it still finds old leads). */
function isRetired(option: LeadFieldOption): boolean {
  return 'hidden' in option && option.hidden === true;
}

/** The option a new filter starts on: the first one still offered. */
function firstOfferedOption(prop: FilterableLeadProperty): LeadFieldOption | undefined {
  return prop.options?.find((option) => !isRetired(option)) ?? prop.options?.[0];
}

function defaultDraftValueFor(prop: FilterableLeadProperty | undefined): string {
  if (!prop) return '';
  if (prop.kind === 'choice') return firstOfferedOption(prop)?.value ?? '';
  if (prop.kind === 'yesNo') return 'true';
  return '';
}

function defaultDraftMultiFor(prop: FilterableLeadProperty): string[] {
  const first = firstOfferedOption(prop);
  return first ? [first.value] : [];
}

/** A choice option as the filter offers it, a retired one marked. */
function optionLabel(option: LeadFieldOption): string {
  return isRetired(option) ? `${option.label} (retired)` : option.label;
}

/** The URL params that name properties, with the `InboxQuery` field each one carries. */
const PROPERTY_PARAMS = [
  ['where', 'where'],
  ['cols', 'columns'],
  ['sort', 'sort'],
] as const;

/**
 * While the site's catalogue cannot be read, the built-in one cannot parse a
 * custom property's filter, column or sort; a change that does not touch
 * them keeps them as the URL had them, so a shared link loses nothing.
 */
function keepUnreadProperties(
  search: string,
  currentUrl: string,
  patch: Partial<InboxQuery>,
): string {
  const params = new URLSearchParams(search.slice(1));
  const current = new URLSearchParams(currentUrl);
  for (const [param, field] of PROPERTY_PARAMS) {
    if (field in patch) continue;
    const raw = current.get(param) ?? (param === 'cols' ? current.get('columns') : null);
    if (raw !== null) params.set(param, raw);
  }
  const kept = params.toString();
  return kept ? `?${kept}` : '';
}

/** What a failed saved-view call says to the person who made it. */
function savedViewFailure(error: unknown): string {
  const reason = errorReason(error);
  if (reason === 'saved_view_name_taken') return 'A view with that name already exists.';
  if (reason === 'saved_view_limit') {
    return `You already have ${SAVED_VIEW_LIMIT} views. Delete one first.`;
  }
  if (reason === 'version_conflict') return 'This view changed elsewhere. Reload and try again.';
  if (reason === 'saved_view_not_found') return 'This view no longer exists. Reload and try again.';
  return `Could not save the view. Reason: ${reason}.`;
}

const LEGACY_HIDDEN_COLUMNS_KEY = 'gt-table-hidden-cols:';

/**
 * The hidden table columns this browser kept before they moved into the URL
 * (`?hide=`), read once and forgotten. Returns undefined when there were none.
 */
function takeLegacyHiddenColumns(workspaceId: string): LeadTableColumn[] | undefined {
  try {
    const key = `${LEGACY_HIDDEN_COLUMNS_KEY}${workspaceId}`;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    window.localStorage.removeItem(key);
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return undefined;
    const hide = parseHiddenColumns(
      saved.filter((entry): entry is string => typeof entry === 'string'),
    );
    return hide.length > 0 ? hide : undefined;
  } catch {
    return undefined;
  }
}

/** One checkbox row of a menu panel, labelled by its text. */
function CheckRow({
  id,
  label,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] hover:bg-accent',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} />
      <span className="truncate">{label}</span>
    </label>
  );
}

const SORT_FIELDS: readonly { field: string; label: string; first: 'asc' | 'desc' }[] = [
  { field: 'fullName', label: 'Name', first: 'asc' },
  { field: 'createdAt', label: 'Created', first: 'desc' },
  { field: 'updatedAt', label: 'Last activity', first: 'desc' },
];

function splitSort(sort: string | undefined): { field?: string; direction?: 'asc' | 'desc' } {
  if (!sort) return {};
  const colon = sort.lastIndexOf(':');
  const direction = sort.slice(colon + 1);
  return {
    field: sort.slice(0, colon),
    direction: direction === 'asc' || direction === 'desc' ? direction : undefined,
  };
}

/**
 * The leads inbox: a tab per lead type the site has and the archive, with the
 * saved-view switcher at the end of that row; one filter row (search, stage,
 * assignee, Add filter, "Follow-ups due", then Sort, Columns or View options
 * over the site's own properties); the active filters as chips under it while
 * there are any; and a table or (for one type) a board. Every choice is in
 * the URL.
 */
export function LeadsInbox({ workspaceSlug }: { workspaceSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const properties = usePropertyModel(workspaceId);
  const catalog = properties.catalog;
  const query = useMemo(
    () => parseInboxQuery(new URLSearchParams(urlKey), catalog),
    [urlKey, catalog],
  );
  // A link naming a custom property can only be read once the site's
  // catalogue is here; until then the list waits rather than load without it.
  const catalogSettled = properties.model !== undefined || properties.error !== undefined;
  const waitingForCatalog =
    !catalogSettled &&
    ['where', 'cols', 'columns', 'sort'].some((name) =>
      (searchParams.get(name) ?? '').includes(CUSTOM_PROPERTY_KEY_PREFIX),
    );

  // Follow-ups count as due by the viewer's own today.
  const today = todayDay();
  const loadSummary = useMemo(
    () =>
      accessToken && workspaceId
        ? () => getLeadsSummary(accessToken, workspaceId, { dueBy: today })
        : undefined,
    [accessToken, workspaceId, today],
  );
  const summary = useResource(loadSummary);
  const types = summary.data?.types ?? [];
  const access = summary.data?.access;
  const canUseProperties = access?.contacts === true && !query.archived;
  const totalActive = types.reduce((sum, entry) => sum + entry.total, 0);
  const followUpsDue = types
    .filter((entry) => !query.type || entry.leadType === query.type)
    .reduce((sum, entry) => sum + (entry.followUpsDue ?? 0), 0);

  // Every change merges into the filters as they are when it lands, not as
  // they were when it was scheduled: the delayed search below must not undo a
  // tab clicked while it waited.
  const latestQuery = useRef(query);
  const latestUrl = useRef(urlKey);
  useEffect(() => {
    latestQuery.current = query;
    latestUrl.current = urlKey;
  }, [query, urlKey]);
  // The site's catalogue could not be read and there is no earlier copy:
  // only the built-in properties are understood.
  const catalogFailed = properties.error !== undefined && properties.model === undefined;
  // The viewer's own saved views, once loaded (`undefined` until then).
  const loadViews = useMemo(
    () => (accessToken && workspaceId ? () => listSavedViews(accessToken, workspaceId) : undefined),
    [accessToken, workspaceId],
  );
  const savedViews = useResource(loadViews);
  const views = useMemo(() => savedViews.data?.views ?? [], [savedViews.data]);
  const viewsRef = useRef<readonly SavedView[] | undefined>(undefined);
  useEffect(() => {
    viewsRef.current = savedViews.data?.views;
  }, [savedViews.data]);
  /** Keeps the list, and the copy `update` reads, in step with a change that just landed. */
  function commitViews(next: readonly SavedView[]) {
    viewsRef.current = next;
    if (savedViews.data) savedViews.mutate((current) => ({ ...current, views: [...next] }));
    else void savedViews.reload();
  }

  function openQuery(next: InboxQuery, search: string) {
    latestQuery.current = next;
    latestUrl.current = search.slice(1);
    router.replace(`${pathname}${search}`, { scroll: false });
  }
  function update(patch: Partial<InboxQuery>) {
    const base = latestQuery.current;
    const known = viewsRef.current;
    // A view id the list does not have is let go once the user changes something.
    const view =
      'view' in patch
        ? patch.view
        : known && base.view && !known.some((entry) => entry.id === base.view)
          ? undefined
          : base.view;
    const next: InboxQuery = { ...base, page: 1, ...patch, view };
    openQuery(
      next,
      catalogFailed && !next.archived
        ? keepUnreadProperties(inboxSearch(next), latestUrl.current, patch)
        : inboxSearch(next),
    );
  }
  /** Opens a lead in the side panel (`?lead=`), or closes it, leaving the list as it is. */
  function setPanelLead(lead: string | undefined) {
    const next: InboxQuery = { ...latestQuery.current, lead };
    openQuery(
      next,
      catalogFailed && !next.archived
        ? keepUnreadProperties(inboxSearch(next), latestUrl.current, {})
        : inboxSearch(next),
    );
  }
  // Closing the panel hands focus back to the lead's row in the list, and
  // asks for the list and the counts again when something was saved in the
  // panel: an archive or a stage change moves the tab counts too.
  const closedLead = useRef<string | undefined>(undefined);
  const panelChanged = useRef(false);
  const [listVersion, setListVersion] = useState(0);
  function closePanel() {
    closedLead.current = latestQuery.current.lead;
    if (panelChanged.current) {
      panelChanged.current = false;
      setListVersion((current) => current + 1);
      void summary.reload();
    }
    setPanelLead(undefined);
  }
  useEffect(() => {
    const id = closedLead.current;
    if (query.lead || !id) return;
    closedLead.current = undefined;
    // `?lead=` only ever holds a uuid, so it is safe in a selector as it is.
    document.querySelector<HTMLElement>(`a[data-lead-id="${id}"]`)?.focus();
  }, [query.lead]);

  /** What a switch to `nextType` keeps of the property filters, sort and columns. */
  function propertiesFor(nextType: string | undefined) {
    // Without the site's catalogue nothing can be judged; leave them as they are.
    return catalogFailed ? {} : filterQueryForLeadType(latestQuery.current, nextType, catalog);
  }

  // Two old addresses are rewritten once, in one change so neither undoes the
  // other: hidden table columns used to live in this browser and move into
  // the URL (`?hide=`) the first time the site's inbox opens without one, and
  // links from before Archive replaced Trash said `?trash=1`; they open the
  // archive, and the address is rewritten to say `?archived=1`.
  const migratedFor = useRef<string | undefined>(undefined);
  const rewrittenUrl = useRef<string | undefined>(undefined);
  useEffect(() => {
    const params = new URLSearchParams(urlKey);
    let changed = false;
    // Once per site: the URL it reads is the one the inbox opened on.
    if (workspaceId && migratedFor.current !== workspaceId) {
      migratedFor.current = workspaceId;
      const hide = takeLegacyHiddenColumns(workspaceId);
      if (hide && !params.has('hide')) {
        params.set('hide', hide.join(','));
        latestQuery.current = { ...latestQuery.current, hide };
        changed = true;
      }
    }
    let archivedFirst = false;
    if (params.has('trash') && rewrittenUrl.current !== urlKey) {
      rewrittenUrl.current = urlKey;
      archivedFirst = params.get('trash') === '1' || params.get('archived') === '1';
      params.delete('trash');
      params.delete('archived');
      changed = true;
    }
    if (!changed) return;
    const rest = params.toString();
    const search = archivedFirst ? `?archived=1${rest ? `&${rest}` : ''}` : rest ? `?${rest}` : '';
    latestUrl.current = search.slice(1);
    router.replace(`${pathname}${search}`, { scroll: false });
  }, [urlKey, workspaceId, pathname, router]);

  // The search box answers as staff type, without a request per keystroke.
  const [searchText, setSearchText] = useState(query.q ?? '');
  useEffect(() => {
    setSearchText(query.q ?? '');
  }, [query.q]);
  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (query.q ?? '')) return;
    const timer = setTimeout(
      () => update({ q: trimmed === '' ? undefined : trimmed.slice(0, 100) }),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
    // `update` reads the latest filters through the ref; the text and the
    // current search are what should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, query.q]);

  // A saved view as the inbox would open it: before the site's catalogue is
  // here nothing can be judged, so the state goes in as saved.
  const catalogReady = catalogSettled && !catalogFailed;
  function openedState(view: SavedView) {
    return catalogReady ? appliedViewState(view.state, catalog) : view.state;
  }
  function selectView(viewId: string | undefined) {
    const target = viewId ? viewsRef.current?.find((entry) => entry.id === viewId) : undefined;
    if (viewId && !target) return;
    // The search is not part of a view.
    setSearchText('');
    const next: InboxQuery = {
      ...(target ? viewStateToInboxQuery(openedState(target), target.id) : allLeadsQuery()),
      // The lead open in the side panel stays open.
      lead: latestQuery.current.lead,
    };
    openQuery(next, inboxSearch(next));
  }
  async function saveView(): Promise<string | undefined> {
    const view = viewsRef.current?.find((entry) => entry.id === latestQuery.current.view);
    if (!view || !accessToken || !workspaceId) return undefined;
    try {
      const result = await updateSavedView(accessToken, workspaceId, view.id, {
        expectedVersion: view.version,
        state: inboxQueryToViewState(latestQuery.current),
      });
      commitViews(
        (viewsRef.current ?? []).map((entry) => (entry.id === view.id ? result.view : entry)),
      );
      return undefined;
    } catch (error) {
      return savedViewFailure(error);
    }
  }
  async function saveViewAs(name: string): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return undefined;
    try {
      const result = await createSavedView(accessToken, workspaceId, {
        object: 'lead',
        name,
        state: inboxQueryToViewState(latestQuery.current),
      });
      commitViews([...(viewsRef.current ?? []), result.view]);
      update({ view: result.view.id });
      return undefined;
    } catch (error) {
      return savedViewFailure(error);
    }
  }
  async function renameView(view: SavedView, name: string): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return undefined;
    try {
      const result = await updateSavedView(accessToken, workspaceId, view.id, {
        expectedVersion: view.version,
        name,
      });
      commitViews(
        (viewsRef.current ?? []).map((entry) => (entry.id === view.id ? result.view : entry)),
      );
      return undefined;
    } catch (error) {
      return savedViewFailure(error);
    }
  }
  async function removeView(view: SavedView): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return undefined;
    try {
      await deleteSavedView(accessToken, workspaceId, view.id);
      commitViews((viewsRef.current ?? []).filter((entry) => entry.id !== view.id));
      // The filters stay as they are; only the link to the deleted view goes.
      if (latestQuery.current.view === view.id) update({ view: undefined });
      return undefined;
    } catch (error) {
      return savedViewFailure(error);
    }
  }

  const activeView = views.find((entry) => entry.id === query.view);
  const viewsPending = query.view !== undefined && savedViews.data === undefined;
  const dirty =
    catalogReady &&
    !viewsPending &&
    isViewDirty(
      activeView ? appliedViewState(activeView.state, catalog) : DEFAULT_LEAD_VIEW_STATE,
      inboxQueryToViewState(query),
    );

  // The lead count of the open view, known only while nothing narrows the list further.
  const viewTotal =
    activeView && summary.data && !query.q && !query.stage && !query.assignee && !query.due
      ? (query.where?.length ?? 0) > 0
        ? undefined
        : query.archived
          ? summary.data.archived
          : query.type
            ? types.find((entry) => entry.leadType === query.type)?.total
            : totalActive
      : undefined;

  const availableProperties = useMemo(() => catalog.filterable(query.type), [catalog, query.type]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>(availableProperties[0]?.key ?? '');
  const selectedProperty =
    availableProperties.find((entry) => entry.key === selectedKey) ?? availableProperties[0];
  const operators = useMemo(
    () => (selectedProperty ? leadPropertyOperators(selectedProperty.kind) : []),
    [selectedProperty],
  );
  const [selectedOp, setSelectedOp] = useState<LeadPropertyOperator>(operators[0] ?? 'eq');
  const [draftValue, setDraftValue] = useState<string>(() =>
    defaultDraftValueFor(selectedProperty),
  );
  const [draftMulti, setDraftMulti] = useState<string[]>([]);

  useEffect(() => {
    const nextProp =
      availableProperties.find((entry) => entry.key === selectedKey) ?? availableProperties[0];
    if (!nextProp) return;
    if (nextProp.key !== selectedKey) setSelectedKey(nextProp.key);
    const nextOps = leadPropertyOperators(nextProp.kind);
    if (!nextOps.includes(selectedOp)) setSelectedOp(nextOps[0] ?? 'eq');
    setDraftValue(defaultDraftValueFor(nextProp));
    setDraftMulti(defaultDraftMultiFor(nextProp));
    // Reset draft controls when the active lead type changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.type]);

  function onSelectProperty(nextKey: string) {
    setSelectedKey(nextKey);
    const nextProp = availableProperties.find((entry) => entry.key === nextKey);
    if (!nextProp) return;
    const nextOps = leadPropertyOperators(nextProp.kind);
    setSelectedOp(nextOps[0] ?? 'eq');
    setDraftValue(defaultDraftValueFor(nextProp));
    setDraftMulti(defaultDraftMultiFor(nextProp));
  }

  function onSubmitFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProperty) return;
    let candidate: LeadPropertyFilter;
    if (selectedOp === 'empty' || selectedOp === 'notEmpty') {
      candidate = { key: selectedProperty.key, op: selectedOp };
    } else if (selectedProperty.kind === 'yesNo') {
      candidate = { key: selectedProperty.key, op: selectedOp, value: draftValue !== 'false' };
    } else if (selectedProperty.kind === 'count') {
      const parsedCount = Number.parseInt(draftValue, 10);
      if (!Number.isInteger(parsedCount)) return;
      candidate = { key: selectedProperty.key, op: selectedOp, value: parsedCount };
    } else if (selectedProperty.kind === 'number') {
      const parsedNumber = Number(draftValue.trim());
      if (draftValue.trim() === '' || !Number.isFinite(parsedNumber)) return;
      candidate = { key: selectedProperty.key, op: selectedOp, value: parsedNumber };
    } else if (selectedProperty.kind === 'money') {
      // Typed in dollars, compared in cents.
      const cents = dollarsToCents(draftValue);
      if (cents === undefined) return;
      candidate = { key: selectedProperty.key, op: selectedOp, value: cents };
    } else if (selectedProperty.kind === 'dateTime') {
      const iso =
        draftValue.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(draftValue)
          ? draftValue
          : Number.isNaN(Date.parse(draftValue))
            ? ''
            : new Date(draftValue).toISOString();
      candidate = { key: selectedProperty.key, op: selectedOp, value: iso };
    } else if (selectedProperty.kind === 'choice' && selectedOp === 'in') {
      const values =
        selectedProperty.options && selectedProperty.options.length > 0
          ? draftMulti
          : draftValue
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean);
      candidate = { key: selectedProperty.key, op: 'in', value: values };
    } else {
      candidate = { key: selectedProperty.key, op: selectedOp, value: draftValue.trim() };
    }
    if (!isValidLeadPropertyFilter(candidate, query.type, catalog)) return;
    const current = latestQuery.current.where ?? [];
    if (current.length >= 10) return;
    const next = [...current, candidate];
    // The backend reads `where` as a JSON string of at most 2000 characters.
    if (JSON.stringify(next).length > 2000) return;
    update({ where: next });
    setFilterOpen(false);
  }

  function removePropertyFilter(index: number) {
    const current = latestQuery.current.where ?? [];
    const next = current.filter((_, idx) => idx !== index);
    update({ where: next.length > 0 ? next : undefined });
  }

  function clearAllFilters() {
    setSearchText('');
    update({
      where: undefined,
      stage: undefined,
      assignee: undefined,
      q: undefined,
    });
  }

  function togglePropertyColumn(key: string) {
    const current = latestQuery.current.columns ?? [];
    const next = current.includes(key)
      ? current.filter((item) => item !== key)
      : current.length < 6
        ? [...current, key]
        : current;
    update({ columns: next.length > 0 ? next : undefined });
  }

  function toggleTableColumn(key: LeadTableColumn) {
    const current = latestQuery.current.hide;
    update({
      hide: current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    });
  }

  const stages = query.type ? (leadTypeEntry(query.type)?.stages ?? []) : [];
  const boardType = query.type ?? types[0]?.leadType;
  const activeBoardType = query.type ?? boardType ?? '';

  const [boardOrder, setBoardOrder] = useStoredList(
    `gt-board-order:${workspaceId ?? ''}:${activeBoardType}`,
  );
  const [boardCollapsed, setBoardCollapsed] = useStoredList(
    `gt-board-collapsed:${workspaceId ?? ''}:${activeBoardType}`,
  );
  const [boardHidden, setBoardHidden] = useStoredList(
    `gt-board-hidden:${workspaceId ?? ''}:${activeBoardType}`,
  );
  const [boardHiddenFields, setBoardHiddenFields] = useStoredList(
    `gt-board-fields:${workspaceId ?? ''}:${activeBoardType}`,
  );

  function toggleListEntry(current: string[], save: (next: string[]) => void, key: string) {
    save(current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  const onBoard = query.layout === 'board' && query.type !== undefined;
  const selectedColumns = query.columns ?? [];
  const activeWhere = query.where ?? [];
  const needsFilterValue = selectedOp !== 'empty' && selectedOp !== 'notEmpty';
  const canSort = canUseProperties && !onBoard;
  const sort = splitSort(query.sort);
  const sortFields = [
    ...SORT_FIELDS,
    ...availableProperties.map((prop) => ({
      field: `prop.${prop.key}`,
      label: prop.label,
      first: 'asc' as const,
    })),
  ];

  function chooseSortField(field: string, first: 'asc' | 'desc') {
    update({ sort: `${field}:${sort.field === field ? (sort.direction ?? first) : first}` });
  }

  const filterMenu =
    canUseProperties && availableProperties.length > 0 && selectedProperty ? (
      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className={TOOLBAR_BUTTON}>
            <FilterIcon aria-hidden="true" className={TOOLBAR_ICON} /> Add filter
          </Button>
        </PopoverTrigger>
        <MenuPanel className="w-72 p-3">
          <form aria-label="Add filter" onSubmit={onSubmitFilter} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Property
              <NativeSelect
                aria-label="Property"
                value={selectedProperty.key}
                onChange={(event) => onSelectProperty(event.target.value)}
              >
                {availableProperties.map((prop) => (
                  <option key={prop.key} value={prop.key}>
                    {prop.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Operator
              <NativeSelect
                aria-label="Operator"
                value={selectedOp}
                onChange={(event) => {
                  const next = operators.find((op) => op === event.target.value);
                  if (next) setSelectedOp(next);
                }}
              >
                {operators.map((op) => (
                  <option key={op} value={op}>
                    {propertyOperatorLabel(selectedProperty.kind, op)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {needsFilterValue ? (
              selectedProperty.kind === 'choice' &&
              selectedOp === 'in' &&
              selectedProperty.options ? (
                <fieldset className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
                  <legend className="mb-1 font-medium text-muted-foreground">Values</legend>
                  {selectedProperty.options.map((option) => {
                    const checked = draftMulti.includes(option.value);
                    return (
                      <label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-2 py-0.5 text-sm text-foreground"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setDraftMulti((current) =>
                              checked
                                ? current.filter((item) => item !== option.value)
                                : [...current, option.value],
                            )
                          }
                        />
                        <span>{optionLabel(option)}</span>
                      </label>
                    );
                  })}
                </fieldset>
              ) : selectedProperty.kind === 'choice' && selectedProperty.options ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Value
                  <NativeSelect
                    aria-label="Value"
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                  >
                    {selectedProperty.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {optionLabel(option)}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              ) : selectedProperty.kind === 'yesNo' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Value
                  <NativeSelect
                    aria-label="Value"
                    value={draftValue === 'false' ? 'false' : 'true'}
                    onChange={(event) => setDraftValue(event.target.value)}
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </NativeSelect>
                </label>
              ) : selectedProperty.kind === 'date' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Value
                  <Input
                    aria-label="Value"
                    type="date"
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                  />
                </label>
              ) : selectedProperty.kind === 'dateTime' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Value
                  <Input
                    aria-label="Value"
                    type="datetime-local"
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                  />
                </label>
              ) : selectedProperty.kind === 'count' ||
                selectedProperty.kind === 'number' ||
                selectedProperty.kind === 'money' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  {selectedProperty.kind === 'money' ? 'Value in dollars' : 'Value'}
                  <Input
                    aria-label="Value"
                    type="number"
                    min={selectedProperty.kind === 'count' ? 0 : undefined}
                    max={selectedProperty.kind === 'count' ? 10000 : undefined}
                    step={
                      selectedProperty.kind === 'money'
                        ? 0.01
                        : selectedProperty.kind === 'count'
                          ? 1
                          : 'any'
                    }
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                  />
                </label>
              ) : (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Value
                  <Input
                    aria-label="Value"
                    type="text"
                    maxLength={200}
                    value={draftValue}
                    onChange={(event) => setDraftValue(event.target.value)}
                  />
                </label>
              )
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setFilterOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Apply filter
              </Button>
            </div>
          </form>
        </MenuPanel>
      </Popover>
    ) : null;

  const sortMenu = canSort ? (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={TOOLBAR_BUTTON}>
          <ArrowUpDownIcon aria-hidden="true" className={TOOLBAR_ICON} /> Sort
        </Button>
      </PopoverTrigger>
      <MenuPanel align="end" className="max-h-96 overflow-y-auto">
        <MenuLabel>Sort by</MenuLabel>
        {sortFields.map((entry) => (
          <MenuItem
            key={entry.field}
            selected={sort.field === entry.field}
            onClick={() => chooseSortField(entry.field, entry.first)}
          >
            <span className="truncate">{entry.label}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuLabel>Order</MenuLabel>
        <MenuItem
          selected={sort.direction === 'asc'}
          disabled={!sort.field}
          onClick={() => sort.field && update({ sort: `${sort.field}:asc` })}
          className="disabled:opacity-50"
        >
          Ascending
        </MenuItem>
        <MenuItem
          selected={sort.direction === 'desc'}
          disabled={!sort.field}
          onClick={() => sort.field && update({ sort: `${sort.field}:desc` })}
          className="disabled:opacity-50"
        >
          Descending
        </MenuItem>
        {query.sort ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => update({ sort: undefined })}>
              <RotateCcwIcon aria-hidden="true" /> Default order
            </MenuItem>
          </>
        ) : null}
      </MenuPanel>
    </Popover>
  ) : null;

  const columnsMenu = onBoard ? null : (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={TOOLBAR_BUTTON}>
          <Columns3Icon aria-hidden="true" className={TOOLBAR_ICON} /> Columns
        </Button>
      </PopoverTrigger>
      <MenuPanel align="end" className="max-h-96 w-64 overflow-y-auto">
        <MenuLabel>Table columns</MenuLabel>
        {TABLE_COLUMNS.filter((col) => !(query.type && col.key === 'type')).map((col) => (
          <CheckRow
            key={col.key}
            id={`table-column-${col.key}`}
            label={col.key === 'activity' && query.archived ? 'Archived' : col.label}
            checked={!query.hide.includes(col.key)}
            onToggle={() => toggleTableColumn(col.key)}
          />
        ))}
        {query.hide.length > 0 ? (
          <MenuItem onClick={() => update({ hide: [] })}>
            <RotateCcwIcon aria-hidden="true" /> Show all table columns
          </MenuItem>
        ) : null}
        {canUseProperties && availableProperties.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuLabel>Property columns (up to 6)</MenuLabel>
            {availableProperties.map((prop) => {
              const checked = selectedColumns.includes(prop.key);
              return (
                <CheckRow
                  key={prop.key}
                  id={`property-column-${prop.key}`}
                  label={prop.label}
                  checked={checked}
                  disabled={!checked && selectedColumns.length >= 6}
                  onToggle={() => togglePropertyColumn(prop.key)}
                />
              );
            })}
          </>
        ) : null}
      </MenuPanel>
    </Popover>
  );

  const boardOptions = onBoard ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={TOOLBAR_BUTTON}>
          <SlidersHorizontalIcon aria-hidden="true" className={TOOLBAR_ICON} /> View options
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Card fields</DropdownMenuLabel>
        {BOARD_CARD_FIELDS.map((field) => (
          <DropdownMenuCheckboxItem
            key={field.key}
            checked={!boardHiddenFields.includes(field.key)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() =>
              toggleListEntry(boardHiddenFields, setBoardHiddenFields, field.key)
            }
          >
            {field.label}
          </DropdownMenuCheckboxItem>
        ))}
        {stages.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Board columns</DropdownMenuLabel>
            {stages.map((stage) => {
              const isVisible = !boardHidden.includes(stage.key);
              const visibleCount = stages.filter(
                (entry) => !boardHidden.includes(entry.key),
              ).length;
              return (
                <DropdownMenuCheckboxItem
                  key={stage.key}
                  checked={isVisible}
                  disabled={isVisible && visibleCount <= 1}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleListEntry(boardHidden, setBoardHidden, stage.key)}
                >
                  <span
                    aria-hidden="true"
                    className={cn('size-2 rounded-full', stageDotClass(stage.key))}
                  />
                  {stage.label}
                </DropdownMenuCheckboxItem>
              );
            })}
          </>
        ) : null}
        {boardOrder.length > 0 ||
        boardCollapsed.length > 0 ||
        boardHidden.length > 0 ||
        boardHiddenFields.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setBoardOrder([]);
                setBoardCollapsed([]);
                setBoardHidden([]);
                setBoardHiddenFields([]);
              }}
            >
              <RotateCcwIcon className="size-3.5" />
              Reset board view
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const chips =
    canUseProperties && activeWhere.length > 0
      ? activeWhere.map((filter, index) => {
          const { label, condition } = propertyFilterParts(query.type, filter, catalog);
          return (
            <FilterChip
              key={`${filter.key}-${filter.op}-${index}`}
              label={label}
              value={condition}
              onRemove={() => removePropertyFilter(index)}
            />
          );
        })
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {query.due
              ? 'Leads with a follow-up due today or earlier, most overdue first.'
              : 'Every enquiry the site has sent, newest activity first.'}
          </p>
        </div>
        <div
          role="group"
          aria-label="Layout"
          className="inline-flex rounded-md border p-0.5 text-sm"
        >
          <button
            type="button"
            aria-pressed={query.layout === 'table'}
            onClick={() => update({ layout: 'table' })}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1',
              query.layout === 'table' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <TableIcon className="size-4" aria-hidden="true" /> Table
          </button>
          <button
            type="button"
            aria-pressed={query.layout === 'board'}
            disabled={!boardType || query.archived}
            title={query.archived ? 'The archive has no board' : undefined}
            onClick={() =>
              update({
                layout: 'board',
                type: boardType,
                stage: undefined,
                archived: false,
                due: false,
                ...(boardType ? propertiesFor(boardType) : {}),
              })
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 disabled:opacity-50',
              query.layout === 'board' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <KanbanSquareIcon className="size-4" aria-hidden="true" /> Board
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b">
        <div
          role="tablist"
          aria-label="Lead types"
          className="flex min-w-0 overflow-x-auto overflow-y-hidden"
        >
          <TabButton
            active={!query.type && !query.archived}
            onClick={() =>
              update({
                type: undefined,
                archived: false,
                stage: undefined,
                layout: 'table',
                ...propertiesFor(undefined),
              })
            }
          >
            All leads <Count value={summary.data ? totalActive : undefined} />
          </TabButton>
          {types.map((entry) => (
            <TabButton
              key={entry.leadType}
              active={query.type === entry.leadType}
              onClick={() =>
                update({
                  type: entry.leadType,
                  archived: false,
                  stage: undefined,
                  ...propertiesFor(entry.leadType),
                })
              }
            >
              {leadTypeLabel(entry.leadType)} <Count value={entry.total} />
            </TabButton>
          ))}
          {(summary.data?.archived ?? 0) > 0 || query.archived ? (
            <TabButton
              active={query.archived}
              onClick={() =>
                update({
                  archived: true,
                  type: undefined,
                  stage: undefined,
                  where: undefined,
                  sort: undefined,
                  columns: undefined,
                  layout: 'table',
                })
              }
            >
              <ArchiveIcon className="size-3.5" aria-hidden="true" /> Archive{' '}
              <Count value={summary.data?.archived} />
            </TabButton>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center">
          <SavedViewSwitcher
            views={views}
            activeViewId={activeView?.id}
            dirty={dirty}
            total={viewTotal}
            onSelect={selectView}
            onSave={saveView}
            onSaveAs={saveViewAs}
            onRename={renameView}
            onDelete={removeView}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full max-w-xs">
          <span className="sr-only">Search leads</span>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={
              access && !access.contacts
                ? 'Search needs contact access'
                : 'Search name, email, phone…'
            }
            disabled={access ? !access.contacts : false}
            className="pl-8"
            maxLength={100}
          />
        </label>
        {query.layout === 'table' && stages.length > 0 ? (
          <label className="w-44">
            <span className="sr-only">Stage</span>
            <NativeSelect
              value={query.stage ?? ''}
              onChange={(event) => update({ stage: event.target.value || undefined })}
            >
              <option value="">All stages</option>
              {stages.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        <label className="w-48">
          <span className="sr-only">Assignee</span>
          <NativeSelect
            value={query.assignee ?? ''}
            onChange={(event) => update({ assignee: event.target.value || undefined })}
          >
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
            {members
              .filter((member) => !member.isSelf)
              .map((member) => (
                <option key={member.actorId} value={member.actorId}>
                  {memberName(member)}
                </option>
              ))}
          </NativeSelect>
        </label>
        {filterMenu}
        {/* "Who do I call today": shown while there is something due, or while on. */}
        {!query.archived && (followUpsDue > 0 || query.due) ? (
          <button
            type="button"
            aria-pressed={query.due}
            onClick={() => update(query.due ? { due: false } : { due: true, layout: 'table' })}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors',
              query.due
                ? 'border-primary bg-primary text-primary-foreground'
                : 'text-foreground hover:bg-muted',
            )}
          >
            <BellRingIcon className="size-4" aria-hidden="true" /> Follow-ups due
            {summary.data ? (
              <span
                className={cn(
                  'rounded-sm px-1 text-xs tabular-nums',
                  query.due ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground',
                )}
              >
                {followUpsDue}
              </span>
            ) : null}
          </button>
        ) : null}
        {sortMenu || columnsMenu || boardOptions ? (
          <div className="ml-auto flex items-center gap-2">
            {sortMenu}
            {columnsMenu}
            {boardOptions}
          </div>
        ) : null}
      </div>

      {chips ? (
        <div
          role="region"
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-2"
        >
          {chips}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearAllFilters}
            className="h-7 px-2 text-xs"
          >
            Clear filters
          </Button>
        </div>
      ) : null}

      {summary.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the lead counts. Reason: {summary.error}.
        </p>
      ) : null}
      {savedViews.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load your saved views. Reason: {savedViews.error}.
        </p>
      ) : null}
      {catalogFailed ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the site&apos;s properties; showing built-in ones. Reason:{' '}
          {properties.error}.
        </p>
      ) : null}

      <div className="flex min-w-0 items-start">
        <div className="min-w-0 flex-1">
          {!accessToken || !workspaceId ? null : onBoard && query.type ? (
            <LeadsBoard
              // The board loads once per mount; a new key asks again.
              key={listVersion}
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
              accessToken={accessToken}
              members={members}
              query={{ ...query, type: query.type }}
              waiting={waitingForCatalog}
            />
          ) : (
            <LeadsTable
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
              accessToken={accessToken}
              members={members}
              query={query}
              catalog={catalog}
              waiting={waitingForCatalog}
              canUseProperties={canUseProperties}
              onPage={(page) => update({ page })}
              onSort={(next) => update({ sort: next })}
              onClearFilters={clearAllFilters}
              reloadToken={listVersion}
              panel={{
                openId: query.lead,
                href: (leadId) => `${pathname}${inboxSearch({ ...query, lead: leadId })}`,
                onOpen: setPanelLead,
              }}
            />
          )}
        </div>
        {/* Beside the list the panel stays in view while the list scrolls; a phone gets a sheet. */}
        <div
          className={cn(
            'sticky top-4 flex self-start',
            query.lead !== undefined && 'md:h-[calc(100dvh-2rem)]',
          )}
        >
          <SidePanel
            open={query.lead !== undefined}
            // A stable title: the panel keeps focus while one lead replaces another.
            title="Lead"
            onClose={closePanel}
            actions={
              query.lead ? (
                <Link
                  href={`/w/${workspaceSlug}/leads/${query.lead}`}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                  Open full page
                </Link>
              ) : undefined
            }
          >
            {query.lead ? (
              <LeadRecord
                key={query.lead}
                workspaceSlug={workspaceSlug}
                leadId={query.lead}
                variant="panel"
                onChange={() => {
                  panelChanged.current = true;
                }}
              />
            ) : null}
          </SidePanel>
        </div>
      </div>
    </div>
  );
}
