import { describe, expect, it } from 'vitest';

import {
  analyticsQueryOf,
  dashboardSearch,
  defaultGroup,
  leadsHref,
  parseDashboardState,
  presetRange,
} from './analytics-query';

const TODAY = '2026-11-08';
const parse = (search: string) => parseDashboardState(new URLSearchParams(search), TODAY);

describe('period presets', () => {
  it('covers the days each preset names, in UTC days', () => {
    expect(presetRange('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(presetRange('7d', TODAY)).toEqual({ from: '2026-11-02', to: TODAY });
    expect(presetRange('30d', TODAY)).toEqual({ from: '2026-10-10', to: TODAY });
    expect(presetRange('this_month', TODAY)).toEqual({ from: '2026-11-01', to: TODAY });
    expect(presetRange('last_month', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('this_quarter', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
    expect(presetRange('this_year', TODAY)).toEqual({ from: '2026-01-01', to: TODAY });
    expect(presetRange('last_month', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('groups a long range by week or month unless told otherwise', () => {
    expect(defaultGroup('2026-11-01', '2026-11-30')).toBe('day');
    expect(defaultGroup('2026-08-01', '2026-11-08')).toBe('week');
    expect(defaultGroup('2026-01-01', '2026-11-08')).toBe('month');
  });
});

describe('dashboard URL state', () => {
  it('opens on the last 30 days against the previous period', () => {
    expect(parse('')).toEqual({
      period: '30d',
      from: '2026-10-10',
      to: TODAY,
      compare: 'previous',
      group: 'day',
    });
    expect(dashboardSearch(parse(''))).toBe('');
  });

  it('reads and writes a custom range with its filters, so a view can be shared', () => {
    const search =
      '?period=custom&from=2026-09-01&to=2026-09-30&compare=last_year&group=week&type=sim_order&source=google&partner=PT-7&assignee=none&payment=paid&plan=70000000-0000-4000-8000-000000000001&delivery=pickup';
    const state = parse(search.slice(1));
    expect(state).toMatchObject({
      period: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      compare: 'last_year',
      group: 'week',
      type: 'sim_order',
      source: 'google',
      partner: 'PT-7',
      assignee: 'none',
      payment: 'paid',
      delivery: 'pickup',
    });
    expect(dashboardSearch(state)).toBe(search);
  });

  it('falls back to the defaults for anything it cannot use', () => {
    const state = parse(
      'period=custom&from=2026-09-31&to=2026-09-01&compare=forever&group=year&payment=refunded&plan=x&delivery=drone',
    );
    expect(state).toEqual(parse(''));
    // A range over two years is not taken either.
    expect(parse('from=2020-01-01&to=2026-01-01').period).toBe('30d');
    // Dates without a period still mean a custom range.
    expect(parse('from=2026-09-01&to=2026-09-02').period).toBe('custom');
  });

  it('builds the backend query, delivery only for SIM orders', () => {
    const state = parse('type=internet&delivery=esim&payment=pending');
    expect(analyticsQueryOf(state, 'internet')).toEqual({
      from: '2026-10-10',
      to: TODAY,
      compare: 'previous',
      group: 'day',
      leadType: 'internet',
      paymentStatus: 'pending',
    });
    expect(analyticsQueryOf(parse('delivery=esim'), 'sim_order').delivery).toBe('esim');
    expect(analyticsQueryOf(parse('type=all'), undefined)).not.toHaveProperty('leadType');
  });

  it('links to the Leads list with the filters it supports', () => {
    expect(leadsHref('gcs', { type: 'sim_order', stage: 'pending' })).toBe(
      '/w/gcs/leads?type=sim_order&stage=pending',
    );
    expect(leadsHref('gcs', { stage: 'pending', assignee: 'none' })).toBe(
      '/w/gcs/leads?assignee=none',
    );
  });
});
