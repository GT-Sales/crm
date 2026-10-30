'use client';

import Link from 'next/link';
import { useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  allowedStageMoves,
  leadStageLabel,
  leadTypeEntry,
  stageGates,
  type AssignableMember,
  type LeadBoardColumn,
  type LeadListItem,
} from '@gt-sales/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@gt-sales/ui';
import {
  ArrowLeftIcon,
  ArrowLeftToLineIcon,
  ArrowRightIcon,
  ArrowRightLeftIcon,
  ArrowRightToLineIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
} from 'lucide-react';

import { getLeadBoard, updateStaffLead } from '../../lib/api';
import { dueLabel, dueTone, relativeTime } from '../../lib/dates';
import { assigneeName } from '../../lib/people';
import { errorReason, useResource } from '../../lib/use-resource';
import type { InboxQuery } from './inbox-query';
import { CountdownDay, leadDisplayName, NewBadge, PersonChip, stageDotClass } from './lead-display';
import { DUE_TONE_CLASS } from './leads-table';
import { stageMoveRefusal } from './stage-move-dialog';
import { useStoredList } from './view-preferences';

const PER_STAGE = 50;
const DRAG_TYPE = 'application/x-gt-lead';
const COLUMN_DRAG_TYPE = 'application/x-gt-board-column';

/** Animates board columns and lead cards smoothly between positions using FLIP. */
function animateElementMove(element: HTMLElement, dx: number, dy: number) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  if (typeof element.animate === 'function') {
    element.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    return;
  }
  element.style.transition = 'none';
  element.style.transform = `translate(${dx}px, ${dy}px)`;
  element.getBoundingClientRect();
  element.style.transition = 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)';
  element.style.transform = '';
}

/** Applies a saved column order; stages missing from it keep their place at the end. */
function orderColumns(columns: LeadBoardColumn[], order: readonly string[]) {
  if (order.length === 0) return columns;
  const rank = (stage: string) => {
    const index = order.indexOf(stage);
    return index === -1 ? order.length : index;
  };
  return [...columns].sort((a, b) => rank(a.stage) - rank(b.stage));
}

/** Moves `stage` to index `to` (clamped) in the list of stage keys. */
function reorderStages(stages: readonly string[], stage: string, to: number) {
  const rest = stages.filter((entry) => entry !== stage);
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, stage);
  return rest;
}

interface Move {
  leadId: string;
  from: string;
  to: string;
}

interface ActiveDragLead {
  id: string;
  fromStage: string;
  height: number;
  width: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  lead: LeadListItem;
}

/** Creates a 1x1 transparent image so the browser's translucent drag ghost is hidden. */
function setTransparentDragImage(dataTransfer: DataTransfer) {
  if (typeof dataTransfer.setDragImage !== 'function' || typeof document === 'undefined') return;
  const pixel = document.createElement('canvas');
  pixel.width = 1;
  pixel.height = 1;
  dataTransfer.setDragImage(pixel, 0, 0);
}

/** Moves one card between columns in place; totals follow the card. */
function moveCard(columns: LeadBoardColumn[], move: Move, replacement?: LeadListItem) {
  const card = columns
    .find((column) => column.stage === move.from)
    ?.leads.find((lead) => lead.id === move.leadId);
  if (!card) return columns;
  const moved = replacement ?? { ...card, stage: move.to };
  return columns.map((column) => {
    if (column.stage === move.from && column.stage !== move.to) {
      return {
        ...column,
        total: Math.max(0, column.total - 1),
        leads: column.leads.filter((lead) => lead.id !== move.leadId),
      };
    }
    if (column.stage === move.to && column.stage !== move.from) {
      return { ...column, total: column.total + 1, leads: [moved, ...column.leads] };
    }
    if (column.stage === move.to) {
      return {
        ...column,
        leads: column.leads.map((lead) => (lead.id === move.leadId ? moved : lead)),
      };
    }
    return column;
  });
}

/**
 * The inbox as a board for one lead type: a column per stage, newest first.
 * Staff who manage leads drag a card to another column, or use its "Move to"
 * menu (the keyboard and touch path), which offers the moves the type allows
 * from the card's stage; the move shows at once and is undone if the backend
 * refuses it. A stage that asks for details first (dispatch, activation,
 * approved documents) is moved to from the lead page, never from here. Column order, collapsed and hidden columns and
 * the card fields shown are personal view preferences kept in this browser.
 */
export function LeadsBoard({
  workspaceSlug,
  workspaceId,
  accessToken,
  members,
  query,
  waiting,
}: {
  workspaceSlug: string;
  workspaceId: string;
  accessToken: string;
  members: readonly AssignableMember[];
  query: InboxQuery & { type: string };
  /** Hold the load while the site's catalogue is still needed to read the filters. */
  waiting?: boolean;
}) {
  const load = useMemo(
    () =>
      waiting
        ? undefined
        : () =>
            getLeadBoard(accessToken, workspaceId, {
              type: query.type,
              assignee: query.assignee,
              q: query.q,
              ...(query.where && query.where.length > 0 ? { where: query.where } : {}),
              perStage: PER_STAGE,
            }),
    [waiting, accessToken, workspaceId, query.type, query.assignee, query.q, query.where],
  );
  const board = useResource(load);
  const [dropTarget, setDropTarget] = useState<string>();
  const [columnDropTarget, setColumnDropTarget] = useState<string>();
  const [activeDragLead, setActiveDragLead] = useState<ActiveDragLead>();
  const [order, setOrder] = useStoredList(`gt-board-order:${workspaceId}:${query.type}`);
  const [collapsed, setCollapsed] = useStoredList(
    `gt-board-collapsed:${workspaceId}:${query.type}`,
  );
  const [hidden, setHidden] = useStoredList(`gt-board-hidden:${workspaceId}:${query.type}`);
  const [hiddenFields] = useStoredList(`gt-board-fields:${workspaceId}:${query.type}`);
  const [message, setMessage] = useState<string>();
  const boardRef = useRef<HTMLDivElement>(null);
  const previousRectsRef = useRef<Map<string, DOMRect>>(new Map());

  function snapshotBoardPositions() {
    const container = boardRef.current;
    if (!container) return;
    const rects = new Map<string, DOMRect>();
    container.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((element) => {
      const id = element.dataset['flipId'];
      if (id) rects.set(id, element.getBoundingClientRect());
    });
    previousRectsRef.current = rects;
  }

  useLayoutEffect(() => {
    const previous = previousRectsRef.current;
    if (previous.size === 0) return;
    previousRectsRef.current = new Map();
    const container = boardRef.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((element) => {
      const id = element.dataset['flipId'];
      const before = id ? previous.get(id) : undefined;
      if (!before) return;
      const after = element.getBoundingClientRect();
      animateElementMove(element, before.left - after.left, before.top - after.top);
    });
  }, [order, collapsed, hidden, board.data]);

  function moveColumn(stage: string, to: number) {
    snapshotBoardPositions();
    const visible = orderColumns(board.data?.columns ?? [], order)
      .filter((column) => !hidden.includes(column.stage))
      .map((column) => column.stage);
    const nextVisible = reorderStages(visible, stage, to);
    const hiddenStages = orderColumns(board.data?.columns ?? [], order)
      .filter((column) => hidden.includes(column.stage))
      .map((column) => column.stage);
    setOrder([...nextVisible, ...hiddenStages]);
  }

  function toggleCollapsed(stage: string) {
    snapshotBoardPositions();
    setCollapsed(
      collapsed.includes(stage)
        ? collapsed.filter((entry) => entry !== stage)
        : [...collapsed, stage],
    );
  }

  function toggleHidden(stage: string) {
    snapshotBoardPositions();
    setHidden(
      hidden.includes(stage) ? hidden.filter((entry) => entry !== stage) : [...hidden, stage],
    );
  }
  const canMove = board.data?.access.manage ?? false;
  const stages = leadTypeEntry(query.type)?.stages ?? [];

  async function move(next: Move) {
    if (next.from === next.to) return;
    if (stageGates(query.type, next.to).length > 0) {
      setMessage(
        `Open the lead to move it to ${leadStageLabel(query.type, next.to)}: it needs details.`,
      );
      return;
    }
    setMessage(undefined);
    snapshotBoardPositions();
    board.mutate((current) => ({ ...current, columns: moveCard(current.columns, next) }));
    try {
      const result = await updateStaffLead(accessToken, workspaceId, next.leadId, {
        stage: next.to,
      });
      const { form: _form, ...card } = result.lead;
      board.mutate((current) => ({
        ...current,
        columns: moveCard(current.columns, { ...next, from: next.to }, card),
      }));
    } catch (error) {
      snapshotBoardPositions();
      board.mutate((current) => ({
        ...current,
        columns: moveCard(current.columns, { leadId: next.leadId, from: next.to, to: next.from }),
      }));
      const code = errorReason(error);
      setMessage(
        stageMoveRefusal(code, query.type, next.from) ??
          `The lead could not be moved. Reason: ${code}.`,
      );
    }
  }

  function onDrop(event: DragEvent<HTMLElement>, stage: string, index: number) {
    event.preventDefault();
    setDropTarget(undefined);
    setColumnDropTarget(undefined);
    setActiveDragLead(undefined);
    const dragged = event.dataTransfer.getData(COLUMN_DRAG_TYPE);
    if (dragged) {
      if (dragged !== stage) moveColumn(dragged, index);
      return;
    }
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    const [leadId, from] = raw.split(' ');
    if (leadId && from) void move({ leadId, from, to: stage });
  }

  if (board.error) {
    return (
      <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
        Could not load the board. Reason: {board.error}.{' '}
        <button type="button" className="underline" onClick={() => void board.reload()}>
          Try again
        </button>
      </p>
    );
  }
  if (!board.data) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground" aria-busy="true">
        Loading the board…
      </p>
    );
  }

  const orderedColumns = orderColumns(board.data.columns, order);
  const visibleColumns = orderedColumns.filter((column) => !hidden.includes(column.stage));
  const hiddenColumns = orderedColumns.filter((column) => hidden.includes(column.stage));

  return (
    <div className="flex flex-col gap-3">
      {message ? (
        <p role="alert" className="text-sm text-rose-300">
          {message}
        </p>
      ) : null}
      <div
        ref={boardRef}
        className="-mx-6 flex snap-x scroll-px-6 gap-3 overflow-x-auto px-6 pb-4"
        aria-label={`${query.type} board`}
        role="region"
      >
        {visibleColumns.map((column, index, shown) => {
          const label = leadStageLabel(query.type, column.stage);
          const isCollapsed = collapsed.includes(column.stage);
          return (
            <section
              key={column.stage}
              data-flip-id={`col:${column.stage}`}
              aria-label={`${leadStageLabel(query.type, column.stage)}, ${column.total} leads`}
              className={cn(
                'flex shrink-0 snap-start flex-col gap-2 rounded-lg border bg-muted/20 p-2 transition-[width,background-color,border-color] duration-300 ease-out',
                isCollapsed ? 'w-12 items-center self-start' : 'w-72',
                'group/col',
                dropTarget === column.stage && 'border-primary/40 bg-muted/30',
                columnDropTarget === column.stage && 'border-primary/60 border-dashed',
              )}
              onDragOver={(event) => {
                const types = event.dataTransfer.types;
                if (types.includes(COLUMN_DRAG_TYPE)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setColumnDropTarget(column.stage);
                  return;
                }
                if (!canMove || !types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dropTarget !== column.stage) {
                  snapshotBoardPositions();
                  setDropTarget(column.stage);
                }
                if (event.clientX > 0 || event.clientY > 0) {
                  setActiveDragLead((current) =>
                    current ? { ...current, x: event.clientX, y: event.clientY } : current,
                  );
                }
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
                if (!event.currentTarget.contains(next)) {
                  setDropTarget(undefined);
                  setColumnDropTarget(undefined);
                }
              }}
              onDrop={(event) => onDrop(event, column.stage, index)}
            >
              {isCollapsed ? (
                <button
                  type="button"
                  onClick={() => toggleCollapsed(column.stage)}
                  aria-expanded={false}
                  aria-label={`Expand ${label} column`}
                  className="flex flex-col items-center gap-2 rounded-md px-1 py-1 text-sm font-medium hover:bg-muted/40"
                >
                  <span
                    aria-hidden="true"
                    className={cn('size-2 rounded-full', stageDotClass(column.stage))}
                  />
                  <span className="rotate-180 [writing-mode:vertical-rl]">{label}</span>
                  <span className="text-xs text-muted-foreground">{column.total}</span>
                </button>
              ) : (
                <>
                  <header
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(COLUMN_DRAG_TYPE, column.stage);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setColumnDropTarget(undefined)}
                    className="flex cursor-grab items-center gap-2 px-1 py-1 text-sm font-medium active:cursor-grabbing"
                  >
                    <span
                      aria-hidden="true"
                      className={cn('size-2 rounded-full', stageDotClass(column.stage))}
                    />
                    <h2 className="truncate">{leadStageLabel(query.type, column.stage)}</h2>
                    <span className="shrink-0 text-xs text-muted-foreground">{column.total}</span>
                    <div className="pointer-events-none ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/col:pointer-events-auto group-focus-within/col:opacity-100 group-hover/col:pointer-events-auto group-hover/col:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground"
                        onClick={() => toggleCollapsed(column.stage)}
                        aria-expanded
                        aria-label={`Collapse ${label} column`}
                      >
                        <ArrowLeftToLineIcon className="size-3.5" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-6 text-muted-foreground"
                            aria-label={`${leadStageLabel(query.type, column.stage)} column options`}
                          >
                            <EllipsisIcon className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Move column</DropdownMenuLabel>
                          <DropdownMenuItem
                            disabled={index === 0}
                            onSelect={() => moveColumn(column.stage, index - 1)}
                          >
                            <ArrowLeftIcon className="size-3.5" />
                            Move left
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={index === shown.length - 1}
                            onSelect={() => moveColumn(column.stage, index + 1)}
                          >
                            <ArrowRightIcon className="size-3.5" />
                            Move right
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={index === shown.length - 1}
                            onSelect={() => moveColumn(column.stage, shown.length - 1)}
                          >
                            <ArrowRightToLineIcon className="size-3.5" />
                            Move to the end
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={shown.length <= 1}
                            onSelect={() => toggleHidden(column.stage)}
                          >
                            <EyeOffIcon className="size-3.5" />
                            Hide column
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </header>
                  <ol className="flex flex-col gap-2">
                    {activeDragLead &&
                    dropTarget === column.stage &&
                    activeDragLead.fromStage !== column.stage ? (
                      <li
                        aria-hidden="true"
                        style={{ minHeight: `${activeDragLead.height}px` }}
                        className="rounded-md border border-dashed border-border/60 bg-muted/40 transition-all duration-300"
                      />
                    ) : null}
                    {column.leads.map((lead) => {
                      const assignee = assigneeName(lead.assignedActorId, members);
                      const isDraggingThis = activeDragLead?.id === lead.id;
                      return (
                        <li
                          key={lead.id}
                          data-flip-id={`lead:${lead.id}`}
                          draggable={canMove}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(DRAG_TYPE, `${lead.id} ${lead.stage}`);
                            event.dataTransfer.effectAllowed = 'move';
                            setTransparentDragImage(event.dataTransfer);
                            const rect = event.currentTarget.getBoundingClientRect();
                            setActiveDragLead({
                              id: lead.id,
                              fromStage: lead.stage,
                              height: rect.height || 84,
                              width: rect.width || 270,
                              offsetX:
                                event.clientX > 0
                                  ? event.clientX - rect.left
                                  : (rect.width || 270) / 2,
                              offsetY:
                                event.clientY > 0
                                  ? event.clientY - rect.top
                                  : (rect.height || 84) / 2,
                              x: event.clientX || rect.left,
                              y: event.clientY || rect.top,
                              lead,
                            });
                          }}
                          onDrag={(event) => {
                            if (event.clientX <= 0 && event.clientY <= 0) return;
                            setActiveDragLead((current) =>
                              current && current.id === lead.id
                                ? { ...current, x: event.clientX, y: event.clientY }
                                : current,
                            );
                          }}
                          onDragEnd={() => {
                            setActiveDragLead(undefined);
                            setDropTarget(undefined);
                          }}
                          style={
                            isDraggingThis ? { minHeight: `${activeDragLead.height}px` } : undefined
                          }
                          className={cn(
                            'group rounded-md border bg-card p-3 text-sm shadow-xs transition-colors hover:border-primary/40',
                            canMove && 'cursor-grab active:cursor-grabbing',
                            isDraggingThis &&
                              'border-dashed border-border/60 bg-muted/40 shadow-none *:invisible',
                          )}
                        >
                          <div className="flex items-start gap-2">
                            {/* The card is what drags, not its link: a link grabbed by the name
                                would be the drag source, and onDragStart hiding the card's
                                contents would make Chromium cancel that drag at once. */}
                            <Link
                              href={`/w/${workspaceSlug}/leads/${lead.id}`}
                              draggable={false}
                              className="min-w-0 flex-1 truncate font-medium hover:underline"
                            >
                              {leadDisplayName(lead.contact)}
                            </Link>
                            {lead.isNew ? <NewBadge className="mt-0.5" /> : null}
                            {canMove ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground"
                                    aria-label={`Move ${leadDisplayName(lead.contact)} to another stage`}
                                  >
                                    <ArrowRightLeftIcon className="size-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuLabel>Move to</DropdownMenuLabel>
                                  {stages
                                    .filter((entry) =>
                                      allowedStageMoves(lead.leadType, lead.stage).includes(
                                        entry.key,
                                      ),
                                    )
                                    .map((entry) => (
                                      <DropdownMenuItem
                                        key={entry.key}
                                        onSelect={() =>
                                          void move({
                                            leadId: lead.id,
                                            from: lead.stage,
                                            to: entry.key,
                                          })
                                        }
                                      >
                                        <span
                                          aria-hidden="true"
                                          className={cn(
                                            'size-2 rounded-full',
                                            stageDotClass(entry.key),
                                          )}
                                        />
                                        {entry.label}
                                      </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                          {!hiddenFields.includes('contact') &&
                          (lead.contact.phone ?? lead.contact.email) ? (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {lead.contact.phone ?? lead.contact.email}
                            </p>
                          ) : null}
                          {!hiddenFields.includes('countdown') ? (
                            <CountdownDay
                              leadType={lead.leadType}
                              day={lead.countdownDate}
                              className="mt-0.5"
                            />
                          ) : null}
                          {!hiddenFields.includes('assignee') ||
                          !hiddenFields.includes('timestamp') ? (
                            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                              {!hiddenFields.includes('assignee') ? (
                                assignee ? (
                                  <PersonChip name={assignee} size="xs" className="max-w-[9rem]" />
                                ) : (
                                  <span>Unassigned</span>
                                )
                              ) : null}
                              {!hiddenFields.includes('timestamp') ? (
                                <span className="ml-auto whitespace-nowrap">
                                  {lead.nextTaskDueAt ? (
                                    <span className={DUE_TONE_CLASS[dueTone(lead.nextTaskDueAt)]}>
                                      {dueLabel(lead.nextTaskDueAt)}
                                    </span>
                                  ) : (
                                    relativeTime(lead.createdAt)
                                  )}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                  {column.total > column.leads.length ? (
                    <Link
                      href={`/w/${workspaceSlug}/leads?type=${query.type}&stage=${column.stage}`}
                      className="px-1 text-xs text-muted-foreground hover:underline"
                    >
                      {column.total - column.leads.length} more in the table
                    </Link>
                  ) : column.leads.length === 0 ? (
                    <p className="px-1 py-4 text-center text-xs text-muted-foreground">No leads</p>
                  ) : null}
                </>
              )}
            </section>
          );
        })}
        {hiddenColumns.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 self-start border-dashed text-xs text-muted-foreground"
              >
                <EyeIcon className="size-3.5" />
                Hidden columns ({hiddenColumns.length})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Hidden columns</DropdownMenuLabel>
              {hiddenColumns.map((column) => (
                <DropdownMenuItem key={column.stage} onSelect={() => toggleHidden(column.stage)}>
                  <span
                    aria-hidden="true"
                    className={cn('size-2 rounded-full', stageDotClass(column.stage))}
                  />
                  {leadStageLabel(query.type, column.stage)} ({column.total})
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {activeDragLead ? (
        <div
          aria-hidden="true"
          style={{
            left: `${activeDragLead.x - activeDragLead.offsetX}px`,
            top: `${activeDragLead.y - activeDragLead.offsetY}px`,
            width: `${activeDragLead.width}px`,
          }}
          className="pointer-events-none fixed z-50 rounded-md border border-primary/80 bg-card p-3 text-sm shadow-2xl ring-2 ring-primary/30"
        >
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">
              {leadDisplayName(activeDragLead.lead.contact)}
            </span>
            {activeDragLead.lead.isNew ? <NewBadge className="mt-0.5" /> : null}
          </div>
          {(activeDragLead.lead.contact.phone ?? activeDragLead.lead.contact.email) ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {activeDragLead.lead.contact.phone ?? activeDragLead.lead.contact.email}
            </p>
          ) : null}
          <CountdownDay
            leadType={activeDragLead.lead.leadType}
            day={activeDragLead.lead.countdownDate}
            className="mt-0.5"
          />
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {assigneeName(activeDragLead.lead.assignedActorId, members) ? (
              <PersonChip
                name={assigneeName(activeDragLead.lead.assignedActorId, members) ?? ''}
                size="xs"
                className="max-w-[9rem]"
              />
            ) : (
              <span>Unassigned</span>
            )}
            <span className="ml-auto whitespace-nowrap">
              {activeDragLead.lead.nextTaskDueAt ? (
                <span className={DUE_TONE_CLASS[dueTone(activeDragLead.lead.nextTaskDueAt)]}>
                  {dueLabel(activeDragLead.lead.nextTaskDueAt)}
                </span>
              ) : (
                relativeTime(activeDragLead.lead.createdAt)
              )}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
