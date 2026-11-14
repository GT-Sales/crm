import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webAnalyticsResponseSchema } from '@gt-sales/contracts';

import { durationLabel, WebAnalytics } from './web-analytics';

const mocks = vi.hoisted(() => ({ getWebAnalytics: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  getWebAnalytics: mocks.getWebAnalytics,
}));
const WORKSPACE = '10000000-0000-4000-8000-000000000101';
vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'getcanadasim' }],
  }),
}));
// The line chart measures its box, which a test page does not have.
vi.mock('../analytics/charts', async (original) => ({
  ...(await original<typeof import('../analytics/charts')>()),
  TrendChart: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const REQUEST = '70000000-0000-4000-8000-000000000001';
const report = (days: 7 | 30 | 90) =>
  webAnalyticsResponseSchema.parse({
    report: {
      days,
      from: '2026-10-15',
      to: '2026-11-14',
      totals: { pageviews: 1200, visitors: 400, visits: 500, bounces: 200, totalSeconds: 45_000 },
      previous: { pageviews: 600, visitors: 500, visits: 400, bounces: 200, totalSeconds: 20_000 },
      daily: [
        { day: '2026-11-13', pageviews: 70, visitors: 20 },
        { day: '2026-11-14', pageviews: 50, visitors: 25 },
      ],
      pages: [{ label: '/plans', total: 80 }],
      referrers: [{ label: 'l.facebook.com', total: 30 }],
      countries: [{ label: 'CA', total: 35 }],
      devices: [{ label: 'mobile', total: 28 }],
      activeNow: 3,
    },
    requestId: REQUEST,
  });

describe('WebAnalytics', () => {
  it('shows the figures with their change, and the top lists', async () => {
    mocks.getWebAnalytics.mockResolvedValue(report(30));
    render(<WebAnalytics workspaceSlug="getcanadasim" />);

    const figures = await screen.findByRole('region', { name: 'Key figures' });
    expect(mocks.getWebAnalytics).toHaveBeenCalledWith('staff-token', WORKSPACE, { days: 30 });
    const text = figures.textContent ?? '';
    expect(text).toContain('Visitors400');
    expect(text).toContain('20% less');
    expect(text).toContain('Page views1,200');
    expect(text).toContain('100% more');
    // 200 of 500 visits; 45,000 seconds over 500 visits.
    expect(text).toContain('40%');
    expect(text).toContain('1m 30s');
    expect(text).toContain('On the website now3');

    expect(
      within(screen.getByRole('list', { name: 'Countries' })).getByText('Canada'),
    ).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Devices' })).getByText('Mobile')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Most visited pages' }).textContent).toContain(
      '/plans',
    );
    expect(screen.getByRole('list', { name: 'Where visitors came from' }).textContent).toContain(
      'l.facebook.com',
    );
  });

  it('asks again for another period', async () => {
    mocks.getWebAnalytics.mockImplementation(async (_token, _site, query: { days: 7 | 30 | 90 }) =>
      report(query.days),
    );
    render(<WebAnalytics workspaceSlug="getcanadasim" />);
    await screen.findByRole('region', { name: 'Key figures' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(mocks.getWebAnalytics).toHaveBeenLastCalledWith('staff-token', WORKSPACE, { days: 7 }),
    );
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('says plainly when there is nothing to read', async () => {
    mocks.getWebAnalytics.mockResolvedValueOnce({
      report: null,
      unavailable: 'not_configured',
      requestId: REQUEST,
    });
    const first = render(<WebAnalytics workspaceSlug="getcanadasim" />);
    expect(await screen.findByText(/not connected yet/)).toBeTruthy();
    first.unmount();

    mocks.getWebAnalytics.mockResolvedValueOnce({
      report: null,
      unavailable: 'unreachable',
      requestId: REQUEST,
    });
    render(<WebAnalytics workspaceSlug="getcanadasim" />);
    expect(await screen.findByText(/did not answer/)).toBeTruthy();
  });

  it('reads a length of time', () => {
    expect(durationLabel(42)).toBe('42s');
    expect(durationLabel(90)).toBe('1m 30s');
    expect(durationLabel(7380)).toBe('2h 03m');
  });
});
