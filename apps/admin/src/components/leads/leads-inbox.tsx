'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CUSTOM_PROPERTY_KEY_PREFIX,
  isValidLeadPropertyFilter,
  leadPropertyOperators,
  leadTypeEntry,
  leadTypeLabel,
  type FilterableLeadProperty,
  type LeadFieldOption,
  type LeadPropertyFilter,
  type LeadPropertyOperator,
  type LeadTableColumn,
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
  ArrowUpDownIcon,
  BellRingIcon,
  Columns3Icon,
  FilterIcon,
  KanbanSquareIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TableIcon,
  Trash2Icon,
} from 'lucide-react';

import { getLeadsSummary } from '../../lib/api';
import { todayDay } from '../../lib/dates';
import { memberName } from '../../lib/people';
import { useResource } from '../../lib/use-resource';
import { BarButton, MenuItem, MenuLabel, MenuPanel, MenuSeparator } from '../crm/menu';
import { FilterChip, ViewBar } from '../crm/view-bar';
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
import { LeadsBoard } from './leads-board';
import { LeadsTable } from './leads-table';
import { useLeadWorkspace } from './use-lead-workspace';
import { BOARD_CARD_FIELDS, TABLE_COLUMNS, useStoredList } from './view-preferences';

const SEARCH_DELAY_MS = 300;

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
 * The leads inbox: a tab per lead type the site has, the trash, a search,
 * stage and assignee, "Follow-ups due", then the view bar (Filter, Sort and
 * Columns over the site's own properties, active filters as chips) and a
 * table or (for one type) a board. Every choice is in the URL.
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
  const canUseProperties = access?.contacts === true && !query.trash;
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
  function update(patch: Partial<InboxQuery>) {
    const next: InboxQuery = { ...latestQuery.current, page: 1, ...patch };
    latestQuery.current = next;
    const search =
      catalogFailed && !next.trash
        ? keepUnreadProperties(inboxSearch(next), latestUrl.current, patch)
        : inboxSearch(next);
    latestUrl.current = search.slice(1);
    router.replace(`${pathname}${search}`, { scroll: false });
  }
  /** What a switch to `nextType` keeps of the property filters, sort and columns. */
  function propertiesFor(nextType: string | undefined) {
    // Without the site's catalogue nothing can be judged; leave them as they are.
    return catalogFailed ? {} : filterQueryForLeadType(latestQuery.current, nextType, catalog);
  }

  // Hidden table columns used to live in this browser; they move into the URL
  // once, the first time the site's inbox opens without `?hide=`.
  const migratedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!workspaceId || migratedFor.current === workspaceId) return;
    migratedFor.current = workspaceId;
    const hide = takeLegacyHiddenColumns(workspaceId);
    const params = new URLSearchParams(urlKey);
    if (!hide || params.has('hide')) return;
    params.set('hide', hide.join(','));
    latestQuery.current = { ...latestQuery.current, hide };
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // Once per site: the URL it reads is the one the inbox opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

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
          <BarButton>
            <FilterIcon aria-hidden="true" /> Filter
          </BarButton>
        </PopoverTrigger>
        <MenuPanel align="end" className="w-72 p-3">
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
        <BarButton className={cn(query.sort && 'text-foreground')}>
          <ArrowUpDownIcon aria-hidden="true" /> Sort
        </BarButton>
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
        <BarButton>
          <Columns3Icon aria-hidden="true" /> Columns
        </BarButton>
      </PopoverTrigger>
      <MenuPanel align="end" className="max-h-96 w-64 overflow-y-auto">
        <MenuLabel>Table columns</MenuLabel>
        {TABLE_COLUMNS.filter((col) => !(query.type && col.key === 'type')).map((col) => (
          <CheckRow
            key={col.key}
            id={`table-column-${col.key}`}
            label={col.key === 'activity' && query.trash ? 'Deleted' : col.label}
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
        <BarButton>
          <SlidersHorizontalIcon aria-hidden="true" /> View options
        </BarButton>
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
            disabled={!boardType || query.trash}
            title={query.trash ? 'The trash has no board' : undefined}
            onClick={() =>
              update({
                layout: 'board',
                type: boardType,
                stage: undefined,
                trash: false,
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

      <div
        role="tablist"
        aria-label="Lead types"
        className="flex overflow-x-auto overflow-y-hidden border-b"
      >
        <TabButton
          active={!query.type && !query.trash}
          onClick={() =>
            update({
              type: undefined,
              trash: false,
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
                trash: false,
                stage: undefined,
                ...propertiesFor(entry.leadType),
              })
            }
          >
            {leadTypeLabel(entry.leadType)} <Count value={entry.total} />
          </TabButton>
        ))}
        {(summary.data?.trash ?? 0) > 0 || query.trash ? (
          <TabButton
            active={query.trash}
            onClick={() =>
              update({
                trash: true,
                type: undefined,
                stage: undefined,
                where: undefined,
                sort: undefined,
                columns: undefined,
                layout: 'table',
              })
            }
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" /> Trash{' '}
            <Count value={summary.data?.trash} />
          </TabButton>
        ) : null}
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
        {/* "Who do I call today": shown while there is something due, or while on. */}
        {!query.trash && (followUpsDue > 0 || query.due) ? (
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
      </div>

      <ViewBar
        // The saved view switcher (Task 10) takes this slot.
        switcher={
          <span className="px-1 text-[13px] font-medium text-foreground">
            {query.trash ? 'Trash' : query.type ? leadTypeLabel(query.type) : 'All leads'}
          </span>
        }
        actions={
          <>
            {filterMenu}
            {sortMenu}
            {columnsMenu}
            {boardOptions}
          </>
        }
        chips={chips}
        details={chips ? <BarButton onClick={clearAllFilters}>Clear filters</BarButton> : undefined}
      />

      {summary.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the lead counts. Reason: {summary.error}.
        </p>
      ) : null}
      {catalogFailed ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the site&apos;s properties; showing built-in ones. Reason:{' '}
          {properties.error}.
        </p>
      ) : null}

      {!accessToken || !workspaceId ? null : onBoard && query.type ? (
        <LeadsBoard
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
        />
      )}
    </div>
  );
}
