'use client';

import Link from 'next/link';
import { useMemo, useState, type DragEvent } from 'react';
import {
  leadStageLabel,
  leadTypeEntry,
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
  DropdownMenuTrigger,
} from '@gt-sales/ui';
import { ArrowRightLeftIcon } from 'lucide-react';

import { getLeadBoard, updateStaffLead } from '../../lib/api';
import { dueLabel, dueTone, relativeTime } from '../../lib/dates';
import { assigneeName } from '../../lib/people';
import { errorReason, useResource } from '../../lib/use-resource';
import type { InboxQuery } from './inbox-query';
import { CountdownDay, leadDisplayName, NewBadge, PersonChip, stageDotClass } from './lead-display';
import { DUE_TONE_CLASS } from './leads-table';

const PER_STAGE = 50;
const DRAG_TYPE = 'application/x-gt-lead';

interface Move {
  leadId: string;
  from: string;
  to: string;
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
 * menu (the keyboard and touch path); the move shows at once and is undone
 * if the backend refuses it.
 */
export function LeadsBoard({
  workspaceSlug,
  workspaceId,
  accessToken,
  members,
  query,
}: {
  workspaceSlug: string;
  workspaceId: string;
  accessToken: string;
  members: readonly AssignableMember[];
  query: InboxQuery & { type: string };
}) {
  const load = useMemo(
    () => () =>
      getLeadBoard(accessToken, workspaceId, {
        type: query.type,
        assignee: query.assignee,
        q: query.q,
        perStage: PER_STAGE,
      }),
    [accessToken, workspaceId, query.type, query.assignee, query.q],
  );
  const board = useResource(load);
  const [dropTarget, setDropTarget] = useState<string>();
  const [message, setMessage] = useState<string>();
  const canMove = board.data?.access.manage ?? false;
  const stages = leadTypeEntry(query.type)?.stages ?? [];

  async function move(next: Move) {
    if (next.from === next.to) return;
    setMessage(undefined);
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
      board.mutate((current) => ({
        ...current,
        columns: moveCard(current.columns, { leadId: next.leadId, from: next.to, to: next.from }),
      }));
      setMessage(`The lead could not be moved. Reason: ${errorReason(error)}.`);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>, stage: string) {
    event.preventDefault();
    setDropTarget(undefined);
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

  return (
    <div className="flex flex-col gap-3">
      {message ? (
        <p role="alert" className="text-sm text-rose-300">
          {message}
        </p>
      ) : null}
      <div
        className="-mx-6 flex snap-x scroll-px-6 gap-3 overflow-x-auto px-6 pb-4"
        aria-label={`${query.type} board`}
        role="region"
      >
        {board.data.columns.map((column) => (
          <section
            key={column.stage}
            aria-label={`${leadStageLabel(query.type, column.stage)}, ${column.total} leads`}
            className={cn(
              'flex w-72 shrink-0 snap-start flex-col gap-2 rounded-lg border bg-muted/20 p-2 transition-colors',
              dropTarget === column.stage && 'border-primary/60 bg-primary/10',
            )}
            onDragOver={(event) => {
              if (!canMove || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(column.stage);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
              if (!event.currentTarget.contains(next)) setDropTarget(undefined);
            }}
            onDrop={(event) => onDrop(event, column.stage)}
          >
            <header className="flex items-center gap-2 px-1 py-1 text-sm font-medium">
              <span
                aria-hidden="true"
                className={cn('size-2 rounded-full', stageDotClass(column.stage))}
              />
              <h2 className="truncate">{leadStageLabel(query.type, column.stage)}</h2>
              <span className="ml-auto text-xs text-muted-foreground">{column.total}</span>
            </header>
            <ol className="flex flex-col gap-2">
              {column.leads.map((lead) => {
                const assignee = assigneeName(lead.assignedActorId, members);
                return (
                  <li
                    key={lead.id}
                    draggable={canMove}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, `${lead.id} ${lead.stage}`);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    className={cn(
                      'group rounded-md border bg-card p-3 text-sm shadow-xs transition-colors hover:border-primary/40',
                      canMove && 'cursor-grab active:cursor-grabbing',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Link
                        href={`/w/${workspaceSlug}/leads/${lead.id}`}
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
                              .filter((entry) => entry.key !== lead.stage)
                              .map((entry) => (
                                <DropdownMenuItem
                                  key={entry.key}
                                  onSelect={() =>
                                    void move({ leadId: lead.id, from: lead.stage, to: entry.key })
                                  }
                                >
                                  <span
                                    aria-hidden="true"
                                    className={cn('size-2 rounded-full', stageDotClass(entry.key))}
                                  />
                                  {entry.label}
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                    {(lead.contact.phone ?? lead.contact.email) ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {lead.contact.phone ?? lead.contact.email}
                      </p>
                    ) : null}
                    <CountdownDay
                      leadType={lead.leadType}
                      day={lead.countdownDate}
                      className="mt-0.5"
                    />
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      {assignee ? (
                        <PersonChip name={assignee} size="xs" className="max-w-[9rem]" />
                      ) : (
                        <span>Unassigned</span>
                      )}
                      <span className="ml-auto whitespace-nowrap">
                        {lead.nextTaskDueAt ? (
                          <span className={DUE_TONE_CLASS[dueTone(lead.nextTaskDueAt)]}>
                            {dueLabel(lead.nextTaskDueAt)}
                          </span>
                        ) : (
                          relativeTime(lead.createdAt)
                        )}
                      </span>
                    </div>
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
          </section>
        ))}
      </div>
    </div>
  );
}
