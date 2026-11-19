'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { leadTypeLabel, type AssignableMember, type WorkspaceTask } from '@gt-sales/contracts';
import {
  Button,
  Calendar,
  Command,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
  type CommandOption,
} from '@gt-sales/ui';
import {
  CalendarIcon,
  CornerDownLeftIcon,
  LinkIcon,
  PlusIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';

import {
  addDays,
  dueAtFromDay,
  dueChipLabel,
  nextMonday,
  shortDay,
  todayDay,
} from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { memberName, initials } from '../../lib/people';
import { leadDisplayName } from '../leads/lead-display';

/** The lead a task can belong to, as the lists carry it. */
export type TaskLeadRef = NonNullable<WorkspaceTask['lead']>;

/** What the composer saves: a title, a due day at noon UTC or null, an assignee or null, and maybe a lead. */
export interface NewTask {
  title: string;
  dueAt: string | null;
  assignedActorId: string | null;
  /** Only when the composer offers the lead chip and one was chosen. */
  lead?: TaskLeadRef;
}

/** `Me`, `none` or a member's actor id. */
type AssigneeChoice = 'self' | 'none' | string;

/** A chip of the composer: a small outlined button that names its property and its value. */
function Chip({
  property,
  value,
  placeholder,
  icon,
  tone,
  className,
  ...props
}: {
  property: string;
  /** The value in words; empty when none is set. */
  value: string;
  placeholder?: string;
  icon: ReactNode;
  tone?: 'late';
} & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={`${property}: ${value || 'none'}`}
      {...props}
      className={cn(
        'inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent dark:bg-input/30',
        !value && 'text-muted-foreground',
        tone === 'late' && 'border-rose-500/40 text-rose-700 dark:text-rose-300',
        className,
      )}
    >
      {icon}
      <span className="truncate">{value || placeholder || property}</span>
    </button>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[9px] font-semibold text-accent-foreground"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Keeps focus where typing continues after a pick, and returns it to the chip
 * when a popover is dismissed without one.
 */
function useChosenFocus(title: React.RefObject<HTMLInputElement | null>) {
  const chosen = useRef(false);
  return {
    choose() {
      chosen.current = true;
    },
    onCloseAutoFocus(event: Event) {
      if (!chosen.current) return;
      chosen.current = false;
      event.preventDefault();
      title.current?.focus();
    },
  };
}

function DuePicker({
  day,
  onChange,
  title,
}: {
  day: string;
  onChange(day: string): void;
  title: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const focus = useChosenFocus(title);
  const now = new Date();
  const today = todayDay(now);
  const picks = [
    { label: 'Today', day: today },
    { label: 'Tomorrow', day: addDays(today, 1) },
    { label: 'Next Monday', day: nextMonday(today) },
    { label: 'In a week', day: addDays(today, 7) },
  ];

  function pick(next: string) {
    focus.choose();
    onChange(next);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-quick]'),
    );
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Chip
          property="Due date"
          value={day ? dueChipLabel(day, now) : ''}
          placeholder="Due date"
          tone={day && day < today ? 'late' : undefined}
          icon={<CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-auto max-w-[calc(100vw-1rem)] p-0"
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <div role="group" aria-label="Quick picks" onKeyDown={onKeyDown} className="grid p-1">
          {picks.map((entry) => (
            <button
              key={entry.label}
              type="button"
              data-quick=""
              onClick={() => pick(entry.day)}
              className="flex min-h-9 items-center justify-between gap-6 rounded-sm px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <span>{entry.label}</span>
              <span className="text-xs text-muted-foreground">{shortDay(entry.day, now)}</span>
            </button>
          ))}
          <button
            type="button"
            data-quick=""
            onClick={() => pick('')}
            className="flex min-h-9 items-center gap-2 rounded-sm px-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
            No due date
          </button>
        </div>
        <div className="border-t p-3">
          <Calendar value={day} today={today} onSelect={pick} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AssigneePicker({
  members,
  value,
  onChange,
  title,
}: {
  members: readonly AssignableMember[];
  value: AssigneeChoice;
  onChange(next: AssigneeChoice): void;
  title: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const focus = useChosenFocus(title);
  const self = members.find((member) => member.isSelf);
  const person = (member: AssignableMember) => (member.isSelf ? 'Me' : memberName(member));
  const options: CommandOption[] = [
    ...(self
      ? [
          {
            value: 'self',
            label: 'Me',
            keywords: memberName(self),
            icon: <Avatar name={memberName(self)} />,
          },
        ]
      : []),
    ...members
      .filter((member) => !member.isSelf)
      .map((member) => ({
        value: member.actorId,
        label: memberName(member),
        icon: <Avatar name={memberName(member)} />,
      })),
    {
      value: 'none',
      label: 'No one',
      keywords: 'unassigned nobody',
      icon: <UserIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />,
    },
  ];
  const chosen = value === 'self' ? self : members.find((member) => member.actorId === value);
  const text = value === 'none' ? 'No one' : chosen ? person(chosen) : value === 'self' ? 'Me' : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Chip
          property="Task assignee"
          value={text}
          placeholder="Assignee"
          icon={
            value === 'none' || !chosen ? (
              <UserIcon className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Avatar name={memberName(chosen)} />
            )
          }
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-64 max-w-[calc(100vw-1rem)] p-0"
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <Command
          label="Assign to"
          placeholder="Assign to…"
          options={options}
          selected={value}
          emptyText="No one by that name."
          onSelect={(next) => {
            focus.choose();
            onChange(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const NO_LEAD = '__none__';

function LeadPicker({
  lead,
  search,
  onChange,
  title,
}: {
  lead: TaskLeadRef | undefined;
  search(query: string): Promise<TaskLeadRef[]>;
  onChange(next: TaskLeadRef | undefined): void;
  title: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The results together with the query they answer, so a slower or newer
  // search never shows another query's leads.
  const [answer, setAnswer] = useState<{ query: string; leads: TaskLeadRef[] }>({
    query: '',
    leads: [],
  });
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const focus = useChosenFocus(title);

  // Search as the person types, a beat after the last key; the newest answer wins.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setState('loading');
    const timer = setTimeout(
      () => {
        const asked = query.trim();
        search(asked)
          .then((leads) => {
            if (!current) return;
            setAnswer({ query: asked, leads });
            setState('ready');
          })
          .catch(() => {
            if (current) setState('failed');
          });
      },
      query ? 250 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, search]);

  // Only leads that answer the query now typed, and only once they have arrived.
  const found = state === 'ready' && answer.query === query.trim() ? answer.leads : [];
  const options: CommandOption[] = [
    ...(query.trim() === ''
      ? [
          {
            value: NO_LEAD,
            label: 'No lead',
            icon: <XIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
          },
        ]
      : []),
    ...found.map((entry) => ({
      value: entry.id,
      label: leadDisplayName(entry.contact),
      description: [entry.externalRef, leadTypeLabel(entry.leadType)].filter(Boolean).join(' · '),
    })),
  ];
  const known = new Map(answer.leads.map((entry) => [entry.id, entry]));
  if (lead) known.set(lead.id, lead);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Chip
          property="Lead"
          value={lead ? leadDisplayName(lead.contact) : 'No lead'}
          icon={<LinkIcon className="size-3.5 shrink-0" aria-hidden="true" />}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-72 max-w-[calc(100vw-1rem)] p-0"
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <Command
          label="Find a lead"
          placeholder="Search leads by name or reference…"
          options={options}
          selected={lead?.id ?? NO_LEAD}
          shouldFilter={false}
          loading={state === 'loading'}
          emptyText={
            state === 'failed' ? 'The leads could not be searched. Try again.' : 'No leads found.'
          }
          onQueryChange={setQuery}
          onSelect={(next) => {
            focus.choose();
            onChange(next === NO_LEAD ? undefined : known.get(next));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The one way to add a task: a card with a large borderless task name and,
 * under it, chips for the due date, the assignee and (when `searchLeads` is
 * given) the lead. Enter or Ctrl/Cmd+Enter adds it; the composer then stays
 * open and empty with the same chips and focus back in the name, so a list of
 * tasks is typed in one go. The add is not waited for: `onAdd` may show the
 * task at once, and when it rejects the name comes back with a plain sentence
 * through `onError`.
 *
 * With `onCancel` there is a Cancel button and Escape closes the composer;
 * without it (the lead page, where the composer is always there) Escape
 * clears the name.
 */
export function TaskComposer({
  members,
  initialDay = '',
  searchLeads,
  onAdd,
  onError,
  onCancel,
  autoFocus = false,
  focusSignal = 0,
  className,
}: {
  members: readonly AssignableMember[];
  /** The due day to start with, `YYYY-MM-DD`, or empty for none. */
  initialDay?: string;
  /** Present: offer the lead chip, searching leads with this. */
  searchLeads?(query: string): Promise<TaskLeadRef[]>;
  onAdd(task: NewTask): Promise<void>;
  onError(message: string | undefined): void;
  onCancel?(): void;
  autoFocus?: boolean;
  /** A change moves focus into the task name (the page's "C" shortcut while the composer is open). */
  focusSignal?: number;
  className?: string;
}) {
  const self = members.find((member) => member.isSelf);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(initialDay);
  const [assignee, setAssignee] = useState<AssigneeChoice>('self');
  const [lead, setLead] = useState<TaskLeadRef>();
  const search = useCallback(
    (query: string) => searchLeads?.(query) ?? Promise.resolve([]),
    [searchLeads],
  );

  useEffect(() => {
    if (autoFocus || focusSignal > 0) titleRef.current?.focus();
  }, [autoFocus, focusSignal]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onError(undefined);
    const task: NewTask = {
      title: trimmed,
      dueAt: day ? dueAtFromDay(day) : null,
      assignedActorId:
        assignee === 'self' ? (self?.actorId ?? null) : assignee === 'none' ? null : assignee,
      ...(lead ? { lead } : {}),
    };
    // Ready for the next one at once; a refusal brings the name back.
    setTitle('');
    titleRef.current?.focus();
    onAdd(task).catch((error: unknown) => {
      onError(describeError(error, 'add the task'));
      setTitle((current) => (current === '' ? trimmed : current));
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // Keys typed in a popover (it is portalled) belong to the popover. A popover
    // still fading out may have claimed the key, so only where it was typed counts.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (onCancel) onCancel();
      else setTitle('');
    }
  }

  const ready = title.trim() !== '';

  return (
    <form
      aria-label="New task"
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className={cn(
        'rounded-xl border bg-card p-3 shadow-sm transition-shadow focus-within:border-ring/60 motion-reduce:transition-none dark:bg-background',
        className,
      )}
    >
      <input
        ref={titleRef}
        type="text"
        aria-label="Task name"
        placeholder="Task name"
        value={title}
        maxLength={200}
        autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
        className="h-9 w-full min-w-0 border-0 bg-transparent px-0.5 text-base font-medium outline-none placeholder:text-muted-foreground md:text-lg"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DuePicker day={day} onChange={setDay} title={titleRef} />
        <AssigneePicker
          members={members}
          value={assignee}
          onChange={setAssignee}
          title={titleRef}
        />
        {searchLeads ? (
          <LeadPicker lead={lead} search={search} onChange={setLead} title={titleRef} />
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
              <kbd className="hidden rounded border px-1 font-sans text-[10px] text-muted-foreground sm:inline">
                Esc
              </kbd>
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={!ready}>
            <PlusIcon className="size-4" aria-hidden="true" />
            Add task
            <CornerDownLeftIcon className="hidden size-3 opacity-70 sm:inline" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  );
}
