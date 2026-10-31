import { LEAD_STATS_WINDOWS, type LeadTypeCount } from '@gt-sales/contracts';

/** A dashboard window in days back from now, or `null` for all time. */
export type StatsWindow = (typeof LEAD_STATS_WINDOWS)[number] | null;

/** Get Canada Sim's windows, in its words and order (the dashboard and the reports share them). */
export const WINDOWS: readonly { days: StatsWindow; label: string; period: string }[] = [
  { days: null, label: 'All time', period: 'all time' },
  { days: 90, label: 'Last 3 months', period: 'the last 3 months' },
  { days: 30, label: 'Last 30 days', period: 'the last 30 days' },
  { days: 7, label: 'Last 7 days', period: 'the last 7 days' },
];

/** The type with the most active leads (a site's orders before its partner applications). */
export function busiest(types: readonly LeadTypeCount[]): string | undefined {
  return [...types].sort((a, b) => b.total - a.total)[0]?.leadType;
}
