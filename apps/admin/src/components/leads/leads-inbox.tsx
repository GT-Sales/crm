'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  filterableLeadProperties,
  isValidLeadPropertyFilter,
  leadPropertyOperators,
  leadTypeEntry,
  leadTypeLabel,
  type LeadPropertyFilter,
  type LeadPropertyOperator,
} from '@gt-sales/contracts';
import {
  Button,
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
} from '@gt-sales/ui';
import {
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
import {
  filterQueryForLeadType,
  inboxSearch,
  parseInboxQuery,
  type InboxQuery,
} from './inbox-query';
import { stageDotClass } from './lead-display';
import { propertyFilterSummary, propertyOperatorLabel } from './lead-fields';
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

function defaultDraftValueFor(
  prop: ReturnType<typeof filterableLeadProperties>[number] | undefined,
): string {
  if (!prop) return '';
  if (prop.kind === 'choice') return prop.options?.[0]?.value ?? '';
  if (prop.kind === 'yesNo') return 'true';
  return '';
}

/**
 * The leads inbox: a tab per lead type the site has, the trash, a search,
 * stage, assignee and property filters, "Follow-ups due", optional property
 * columns, and a table or (for one type) a board. Every choice is in the URL.
 */
export function LeadsInbox({ workspaceSlug }: { workspaceSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = parseInboxQuery(searchParams);
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);

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
  const urlKey = searchParams.toString();
  useEffect(() => {
    latestQuery.current = parseInboxQuery(new URLSearchParams(urlKey));
  }, [urlKey]);
  function update(patch: Partial<InboxQuery>) {
    const next: InboxQuery = { ...latestQuery.current, page: 1, ...patch };
    latestQuery.current = next;
    router.replace(`${pathname}${inboxSearch(next)}`, { scroll: false });
  }

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

  const availableProperties = useMemo(() => filterableLeadProperties(query.type), [query.type]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
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
    setDraftMulti(nextProp.options?.[0] ? [nextProp.options[0].value] : []);
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
    setDraftMulti(nextProp.options?.[0] ? [nextProp.options[0].value] : []);
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
    if (!isValidLeadPropertyFilter(candidate, query.type)) return;
    const current = latestQuery.current.where ?? [];
    if (current.length >= 10) return;
    update({ where: [...current, candidate] });
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
  const [tableHiddenCols, setTableHiddenCols] = useStoredList(
    `gt-table-hidden-cols:${workspaceId ?? ''}`,
  );

  function toggleListEntry(current: string[], save: (next: string[]) => void, key: string) {
    save(current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  const selectedColumns = query.columns ?? [];
  const activeWhere = query.where ?? [];
  const needsFilterValue = selectedOp !== 'empty' && selectedOp !== 'notEmpty';

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
        <div role="group" aria-label="View" className="inline-flex rounded-md border p-0.5 text-sm">
          <button
            type="button"
            aria-pressed={query.view === 'table'}
            onClick={() => update({ view: 'table' })}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1',
              query.view === 'table' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <TableIcon className="size-4" aria-hidden="true" /> Table
          </button>
          <button
            type="button"
            aria-pressed={query.view === 'board'}
            disabled={!boardType || query.trash}
            title={query.trash ? 'The trash has no board' : undefined}
            onClick={() =>
              update({
                view: 'board',
                type: boardType,
                stage: undefined,
                trash: false,
                due: false,
                ...(boardType ? filterQueryForLeadType(latestQuery.current, boardType) : {}),
              })
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 disabled:opacity-50',
              query.view === 'board' ? 'bg-muted text-foreground' : 'text-muted-foreground',
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
              view: 'table',
              ...filterQueryForLeadType(latestQuery.current, undefined),
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
                ...filterQueryForLeadType(latestQuery.current, entry.leadType),
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
                view: 'table',
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
        {query.view === 'table' && stages.length > 0 ? (
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
        {canUseProperties && availableProperties.length > 0 ? (
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={filterOpen}
              onClick={() => {
                setFilterOpen((open) => !open);
                setColumnsOpen(false);
              }}
              className="h-9 gap-1.5"
            >
              <FilterIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Add filter
            </Button>
            {filterOpen && selectedProperty ? (
              <form
                aria-label="Add filter"
                onSubmit={onSubmitFilter}
                className="absolute left-0 z-30 mt-1 flex w-72 flex-col gap-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
              >
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
                            <span>{option.label}</span>
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
                            {option.label}
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
                  ) : selectedProperty.kind === 'count' ? (
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                      Value
                      <Input
                        aria-label="Value"
                        type="number"
                        min={0}
                        max={10000}
                        step={1}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setFilterOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm">
                    Apply filter
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
        {/* "Who do I call today": shown while there is something due, or while on. */}
        {!query.trash && (followUpsDue > 0 || query.due) ? (
          <button
            type="button"
            aria-pressed={query.due}
            onClick={() => update(query.due ? { due: false } : { due: true, view: 'table' })}
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
        <div className="ml-auto flex items-center gap-2">
          {canUseProperties && query.view === 'table' && availableProperties.length > 0 ? (
            <div className="relative">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={columnsOpen}
                onClick={() => {
                  setColumnsOpen((open) => !open);
                  setFilterOpen(false);
                }}
                className="h-9 gap-1.5"
              >
                <Columns3Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                Columns
              </Button>
              {columnsOpen ? (
                <div
                  role="region"
                  aria-label="Property columns"
                  className="absolute right-0 z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                >
                  <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    Property columns (up to 6)
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {availableProperties.map((prop) => {
                      const checked = selectedColumns.includes(prop.key);
                      const disabled = !checked && selectedColumns.length >= 6;
                      return (
                        <label
                          key={prop.key}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted',
                            disabled && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => togglePropertyColumn(prop.key)}
                            className="size-4 rounded border"
                          />
                          <span className="truncate">{prop.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 gap-2">
                <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
                View options
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {query.view === 'board' && query.type ? (
                <>
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
                            onCheckedChange={() =>
                              toggleListEntry(boardHidden, setBoardHidden, stage.key)
                            }
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
                </>
              ) : (
                <>
                  <DropdownMenuLabel>Table columns</DropdownMenuLabel>
                  {TABLE_COLUMNS.filter((col) => !(query.type && col.key === 'type')).map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.key}
                      checked={!tableHiddenCols.includes(col.key)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={() =>
                        toggleListEntry(tableHiddenCols, setTableHiddenCols, col.key)
                      }
                    >
                      {col.key === 'activity' && query.trash ? 'Deleted' : col.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {tableHiddenCols.length > 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setTableHiddenCols([])}>
                        <RotateCcwIcon className="size-3.5" />
                        Reset table columns
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {canUseProperties && activeWhere.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2"
          role="region"
          aria-label="Active filters"
        >
          {activeWhere.map((filter, index) => {
            const text = propertyFilterSummary(query.type, filter);
            return (
              <button
                key={`${filter.key}-${filter.op}-${index}`}
                type="button"
                onClick={() => removePropertyFilter(index)}
                className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs text-foreground hover:bg-muted"
              >
                <span>{text}</span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ×
                </span>
              </button>
            );
          })}
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

      {!accessToken || !workspaceId ? null : query.view === 'board' && query.type ? (
        <LeadsBoard
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          accessToken={accessToken}
          members={members}
          query={{ ...query, type: query.type }}
        />
      ) : (
        <LeadsTable
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          accessToken={accessToken}
          members={members}
          query={query}
          canUseProperties={canUseProperties}
          onPage={(page) => update({ page })}
          onSort={(sort) => update({ sort })}
          onClearFilters={clearAllFilters}
        />
      )}
    </div>
  );
}
