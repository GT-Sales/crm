'use client';

import { useState, type ReactNode } from 'react';
import {
  ANALYTICS_COMPARE_MODES,
  ANALYTICS_GROUPS,
  ANALYTICS_MAX_RANGE_DAYS,
  analyticsRangeDays,
  leadTypeLabel,
  type AnalyticsCompare,
  type AnalyticsGroup,
} from '@gt-sales/contracts';
import { Button, NativeSelect, Popover, PopoverContent, PopoverTrigger, cn } from '@gt-sales/ui';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';

import {
  COMPARE_LABELS,
  GROUP_LABELS,
  PERIOD_KEYS,
  PERIOD_LABELS,
  addDays,
  defaultGroup,
  presetRange,
  utcToday,
  type DashboardState,
  type PeriodKey,
} from './analytics-query';

export interface FilterOptions {
  types: readonly string[];
  sources: readonly string[];
  partners: readonly { code: string; name: string | null }[];
  members: readonly { actorId: string; name: string }[];
  plans: readonly { id: string; name: string }[];
}

const PAYMENT_LABELS: Record<string, string> = {
  not_needed: 'Not needed',
  pending: 'Pending',
  paid: 'Paid',
};

const shortDate = (day: string) =>
  new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** "Nov 1, 2026 – Nov 7, 2026". */
export function rangeLabel(from: string, to: string): string {
  return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function shiftMonth(month: string, by: number): string {
  const date = new Date(`${month}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 10);
}

/** One month's grid: leading blanks to Monday, then each day. */
function monthDays(month: string): (string | null)[] {
  const first = new Date(`${month}T00:00:00.000Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = month; day.slice(0, 7) === month.slice(0, 7); day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * Two months side by side (one on a phone): the first click starts the
 * range, the second ends it. The From and To fields beside it take typed dates.
 */
export function RangeCalendar({
  from,
  to,
  today,
  onApply,
}: {
  from: string;
  to: string;
  today: string;
  onApply(range: { from: string; to: string }): void;
}) {
  const [start, setStart] = useState<string>(from);
  const [end, setEnd] = useState<string | undefined>(to);
  const [month, setMonth] = useState(shiftMonth(monthStart(to), -1));
  const [typedFrom, setTypedFrom] = useState(from);
  const [typedTo, setTypedTo] = useState(to);

  const pick = (day: string) => {
    if (end !== undefined || day < start) {
      setStart(day);
      setEnd(undefined);
      setTypedFrom(day);
      setTypedTo('');
    } else {
      setEnd(day);
      setTypedTo(day);
    }
  };

  const valid = (a: string, b: string | undefined) =>
    b !== undefined &&
    /^\d{4}-\d{2}-\d{2}$/.test(a) &&
    /^\d{4}-\d{2}-\d{2}$/.test(b) &&
    analyticsRangeDays(a, b) >= 1 &&
    analyticsRangeDays(a, b) <= ANALYTICS_MAX_RANGE_DAYS;
  const ready = valid(typedFrom, typedTo);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Next month"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        {[month, shiftMonth(month, 1)].map((shown, index) => (
          <div key={shown} className={cn(index === 1 && 'hidden sm:block')}>
            <p className="mb-2 text-center text-sm font-medium">
              {new Date(`${shown}T00:00:00.000Z`).toLocaleDateString('en-CA', {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              })}
            </p>
            <div className="grid grid-cols-7 gap-0.5 text-center text-xs" role="grid">
              {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((label) => (
                <span key={label} className="py-1 text-muted-foreground" aria-hidden="true">
                  {label}
                </span>
              ))}
              {monthDays(shown).map((day, cell) =>
                day === null ? (
                  <span key={`blank-${cell}`} />
                ) : (
                  <button
                    key={day}
                    type="button"
                    aria-label={shortDate(day)}
                    aria-pressed={day === start || day === end}
                    disabled={day > today}
                    onClick={() => pick(day)}
                    className={cn(
                      'h-8 rounded-md tabular-nums transition-colors hover:bg-muted disabled:opacity-30',
                      end !== undefined && day > start && day < end && 'bg-muted',
                      (day === start || day === end) &&
                        'bg-primary text-primary-foreground hover:bg-primary',
                    )}
                  >
                    {Number(day.slice(8))}
                  </button>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={typedFrom}
            max={today}
            onChange={(event) => setTypedFrom(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={typedTo}
            max={today}
            onChange={(event) => setTypedTo(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={!ready}
          onClick={() => onApply({ from: typedFrom, to: typedTo })}
        >
          Apply range
        </Button>
      </div>
      {!ready && typedTo !== '' ? (
        <p className="text-xs text-muted-foreground">
          Choose a start on or before the end, at most two years apart.
        </p>
      ) : null}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
  className,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="sr-only">{label}</span>
      <NativeSelect
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </NativeSelect>
    </label>
  );
}

/**
 * The sticky bar that drives the page: period, comparison, grouping and the
 * filters. Every change goes through `onChange` with the whole next state,
 * which the page writes to the URL.
 */
export function FilterBar({
  state,
  leadType,
  options,
  onChange,
  today = utcToday(),
}: {
  state: DashboardState;
  /** The type the page settled on (undefined = all types). */
  leadType: string | undefined;
  options: FilterOptions;
  onChange(next: DashboardState): void;
  today?: string;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const setPeriod = (period: PeriodKey) => {
    if (period === 'custom') {
      setCalendarOpen(true);
      return;
    }
    const range = presetRange(period, today);
    onChange({ ...state, period, ...range, group: defaultGroup(range.from, range.to) });
  };
  const filterCount = [
    state.source,
    state.partner,
    state.assignee,
    state.payment,
    state.plan,
    state.delivery,
  ].filter(Boolean).length;

  return (
    <div
      role="search"
      aria-label="Dashboard filters"
      className="sticky top-0 z-20 -mx-4 flex flex-col gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          label="Period"
          value={state.period}
          onChange={(value) => {
            const next = PERIOD_KEYS.find((key) => key === value);
            if (next) setPeriod(next);
          }}
          className="w-40"
        >
          {PERIOD_KEYS.map((key) => (
            <option key={key} value={key}>
              {PERIOD_LABELS[key]}
            </option>
          ))}
        </Select>
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-9 gap-2">
              <CalendarIcon className="size-4" aria-hidden="true" />
              <span className="tabular-nums">{rangeLabel(state.from, state.to)}</span>
              <span className="sr-only">, choose a custom range</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,40rem)]">
            <RangeCalendar
              from={state.from}
              to={state.to}
              today={today}
              onApply={(range) => {
                setCalendarOpen(false);
                onChange({
                  ...state,
                  period: 'custom',
                  ...range,
                  group: defaultGroup(range.from, range.to),
                });
              }}
            />
          </PopoverContent>
        </Popover>
        <Select
          label="Compare with"
          value={state.compare}
          onChange={(value) => {
            const compare = ANALYTICS_COMPARE_MODES.find((mode) => mode === value);
            if (compare) onChange({ ...state, compare: compare satisfies AnalyticsCompare });
          }}
          className="w-48"
        >
          {ANALYTICS_COMPARE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'none' ? COMPARE_LABELS[mode] : `vs ${COMPARE_LABELS[mode].toLowerCase()}`}
            </option>
          ))}
        </Select>
        <div
          role="group"
          aria-label="Group by"
          className="flex overflow-hidden rounded-md border border-input"
        >
          {ANALYTICS_GROUPS.map((group: AnalyticsGroup, index) => (
            <button
              key={group}
              type="button"
              aria-pressed={state.group === group}
              onClick={() => onChange({ ...state, group })}
              className={cn(
                'h-9 px-3 text-xs font-medium transition-colors hover:bg-muted/50',
                state.group === group ? 'bg-muted text-foreground' : 'text-muted-foreground',
                index > 0 && 'border-l border-input',
              )}
            >
              {GROUP_LABELS[group]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {options.types.length > 1 ? (
          <Select
            label="Lead type"
            value={leadType ?? 'all'}
            onChange={(value) => {
              const { delivery: _delivery, plan: _plan, ...rest } = state;
              onChange({ ...rest, type: value });
            }}
            className="w-44"
          >
            <option value="all">All types</option>
            {options.types.map((type) => (
              <option key={type} value={type}>
                {leadTypeLabel(type)}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          label="Source"
          value={state.source ?? ''}
          onChange={(value) => onChange(withFilter(state, 'source', value))}
          className="w-36"
        >
          <option value="">Any source</option>
          {unique([...(state.source ? [state.source] : []), ...options.sources]).map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </Select>
        <Select
          label="Partner"
          value={state.partner ?? ''}
          onChange={(value) => onChange(withFilter(state, 'partner', value))}
          className="w-36"
        >
          <option value="">Any partner</option>
          {unique([
            ...(state.partner ? [state.partner] : []),
            ...options.partners.map((p) => p.code),
          ]).map((code) => (
            <option key={code} value={code}>
              {options.partners.find((partner) => partner.code === code)?.name ?? code}
            </option>
          ))}
        </Select>
        <Select
          label="Assigned to"
          value={state.assignee ?? ''}
          onChange={(value) => onChange(withFilter(state, 'assignee', value))}
          className="w-40"
        >
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {options.members.map((member) => (
            <option key={member.actorId} value={member.actorId}>
              {member.name}
            </option>
          ))}
        </Select>
        <Select
          label="Payment status"
          value={state.payment ?? ''}
          onChange={(value) => onChange(withFilter(state, 'payment', value))}
          className="w-36"
        >
          <option value="">Any payment</option>
          {Object.entries(PAYMENT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
        {options.plans.length > 0 ? (
          <Select
            label="Plan"
            value={state.plan ?? ''}
            onChange={(value) => onChange(withFilter(state, 'plan', value))}
            className="w-44"
          >
            <option value="">Any plan</option>
            {options.plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </Select>
        ) : null}
        {leadType === 'sim_order' ? (
          <Select
            label="Delivery"
            value={state.delivery ?? ''}
            onChange={(value) => onChange(withFilter(state, 'delivery', value))}
            className="w-36"
          >
            <option value="">Any delivery</option>
            <option value="esim">eSIM</option>
            <option value="pickup">Physical SIM</option>
          </Select>
        ) : null}
        {filterCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const {
                source: _s,
                partner: _p,
                assignee: _a,
                payment: _pay,
                plan: _plan,
                delivery: _d,
                ...rest
              } = state;
              onChange(rest);
            }}
          >
            <XIcon className="size-4" aria-hidden="true" />
            Clear filters ({filterCount})
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

type FilterKey = 'source' | 'partner' | 'assignee' | 'payment' | 'plan' | 'delivery';

function withFilter(state: DashboardState, key: FilterKey, value: string): DashboardState {
  const { [key]: _removed, ...rest } = state;
  return value === '' ? rest : { ...rest, [key]: value };
}
