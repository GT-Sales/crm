import {
  ANALYTICS_COMPARE_MODES,
  ANALYTICS_DELIVERIES,
  ANALYTICS_GROUPS,
  ANALYTICS_MAX_RANGE_DAYS,
  analyticsRangeDays,
  leadAssigneeFilterSchema,
  leadTypeSchema,
  paymentStatusSchema,
  type AnalyticsCompare,
  type AnalyticsGroup,
  type AnalyticsQueryInput,
} from '@gt-sales/contracts';

/**
 * The dashboard's state, kept in the URL so a view can be shared: the period
 * (a preset, or `custom` with `from` and `to`), the comparison, the grouping
 * and the filters. Days are UTC calendar days, as the backend counts them.
 */

export const PERIOD_KEYS = [
  'today',
  '7d',
  '30d',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'custom',
] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  this_year: 'This year',
  custom: 'Custom range',
};

export const DEFAULT_PERIOD: Exclude<PeriodKey, 'custom'> = '30d';

export const COMPARE_LABELS: Record<AnalyticsCompare, string> = {
  previous: 'Previous period',
  last_year: 'Same period last year',
  none: 'No comparison',
};

export const GROUP_LABELS: Record<AnalyticsGroup, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

export interface DashboardState {
  period: PeriodKey;
  from: string;
  to: string;
  compare: AnalyticsCompare;
  group: AnalyticsGroup;
  /** Set in the URL; else the dashboard's default type. `all` is every type. */
  type?: string;
  source?: string;
  partner?: string;
  assignee?: string;
  payment?: string;
  plan?: string;
  delivery?: string;
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Today as a UTC calendar day. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isDay(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    DAY.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
  );
}

function dayOf(year: number, month: number, date: number): string {
  return new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);
}

/** The days a preset covers, as of `today`. */
export function presetRange(preset: Exclude<PeriodKey, 'custom'>, today: string) {
  const [year = 1970, month = 1] = today.split('-').map(Number);
  const m = month - 1;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'this_month':
      return { from: dayOf(year, m, 1), to: today };
    case 'last_month':
      return { from: dayOf(year, m - 1, 1), to: dayOf(year, m, 0) };
    case 'this_quarter':
      return { from: dayOf(year, m - (m % 3), 1), to: today };
    case 'this_year':
      return { from: dayOf(year, 0, 1), to: today };
  }
}

/** The grouping that reads best for a range when the URL names none. */
export function defaultGroup(from: string, to: string): AnalyticsGroup {
  const days = analyticsRangeDays(from, to);
  if (days > 186) return 'month';
  if (days > 62) return 'week';
  return 'day';
}

interface ReadableParams {
  get(name: string): string | null;
}

function oneOf<const T extends readonly string[]>(
  values: T,
  raw: string | null,
): T[number] | undefined {
  return values.find((value) => value === raw);
}

function text(raw: string | null, max: number): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** The dashboard state from the URL; anything invalid falls back to the defaults. */
export function parseDashboardState(params: ReadableParams, today = utcToday()): DashboardState {
  let period: PeriodKey | undefined = oneOf(PERIOD_KEYS, params.get('period'));
  let range: { from: string; to: string } | undefined;
  const from = params.get('from');
  const to = params.get('to');
  if ((period === 'custom' || period === undefined) && isDay(from) && isDay(to)) {
    const days = analyticsRangeDays(from, to);
    if (days >= 1 && days <= ANALYTICS_MAX_RANGE_DAYS) {
      period = 'custom';
      range = { from, to };
    }
  }
  if (!range) {
    const preset = period === undefined || period === 'custom' ? DEFAULT_PERIOD : period;
    period = preset;
    range = presetRange(preset, today);
  }
  const type = params.get('type');
  const assignee = params.get('assignee');
  const plan = params.get('plan');
  return {
    period: period ?? DEFAULT_PERIOD,
    ...range,
    compare: oneOf(ANALYTICS_COMPARE_MODES, params.get('compare')) ?? 'previous',
    group: oneOf(ANALYTICS_GROUPS, params.get('group')) ?? defaultGroup(range.from, range.to),
    ...(type === 'all' || leadTypeSchema.safeParse(type).success
      ? { type: type ?? undefined }
      : {}),
    ...(text(params.get('source'), 200) ? { source: text(params.get('source'), 200) } : {}),
    ...(text(params.get('partner'), 64) ? { partner: text(params.get('partner'), 64) } : {}),
    ...(leadAssigneeFilterSchema.safeParse(assignee).success && assignee ? { assignee } : {}),
    ...(paymentStatusSchema.safeParse(params.get('payment')).success
      ? { payment: params.get('payment') ?? undefined }
      : {}),
    ...(plan && UUID.test(plan) ? { plan: plan.toLowerCase() } : {}),
    ...(oneOf(ANALYTICS_DELIVERIES, params.get('delivery'))
      ? { delivery: params.get('delivery') ?? undefined }
      : {}),
  };
}

/** The URL query of a state: only what differs from the defaults, presets without dates. */
export function dashboardSearch(state: DashboardState): string {
  const params = new URLSearchParams();
  if (state.period === 'custom') {
    params.set('period', 'custom');
    params.set('from', state.from);
    params.set('to', state.to);
  } else if (state.period !== DEFAULT_PERIOD) {
    params.set('period', state.period);
  }
  if (state.compare !== 'previous') params.set('compare', state.compare);
  if (state.group !== defaultGroup(state.from, state.to)) params.set('group', state.group);
  const optional = [
    ['type', state.type],
    ['source', state.source],
    ['partner', state.partner],
    ['assignee', state.assignee],
    ['payment', state.payment],
    ['plan', state.plan],
    ['delivery', state.delivery],
  ] as const;
  for (const [key, value] of optional) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `?${search}` : '';
}

/** The backend query of a state, with the lead type the dashboard settled on. */
export function analyticsQueryOf(
  state: DashboardState,
  leadType: string | undefined,
): AnalyticsQueryInput {
  const payment = paymentStatusSchema.safeParse(state.payment);
  const delivery = oneOf(ANALYTICS_DELIVERIES, state.delivery ?? null);
  return {
    from: state.from,
    to: state.to,
    compare: state.compare,
    group: state.group,
    ...(leadType ? { leadType } : {}),
    ...(state.source ? { source: state.source } : {}),
    ...(state.partner ? { partner: state.partner } : {}),
    ...(state.assignee ? { assignee: state.assignee } : {}),
    ...(payment.success ? { paymentStatus: payment.data } : {}),
    ...(state.plan ? { planId: state.plan } : {}),
    ...(delivery && leadType === 'sim_order' ? { delivery } : {}),
  };
}

/** The Leads list pre-filtered where its URL supports it: type, stage, assignee. */
export function leadsHref(
  workspaceSlug: string,
  filters: { type?: string; stage?: string; assignee?: string },
): string {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.type && filters.stage) params.set('stage', filters.stage);
  if (filters.assignee) params.set('assignee', filters.assignee);
  const search = params.toString();
  return `/w/${workspaceSlug}/leads${search ? `?${search}` : ''}`;
}
