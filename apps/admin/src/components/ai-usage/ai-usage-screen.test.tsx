import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageResponse } from '@gt-sales/contracts';

import { AiUsageScreen, sortMembers } from './ai-usage-screen';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({ getAiUsage: vi.fn() }));

vi.mock('../../lib/api', () => ({
  getAiUsage: mocks.getAiUsage,
  BackendError: class BackendError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly requestId = '',
    ) {
      super(code);
    }
  },
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

const { BackendError } = await import('../../lib/api');

function member(
  n: number,
  overrides: Partial<AiUsageResponse['members'][number]> = {},
): AiUsageResponse['members'][number] {
  return {
    actorId: `20000000-0000-4000-8000-00000000000${String(n)}`,
    displayName: `Member ${String(n)}`,
    turns: 1,
    inputTokens: 100,
    outputTokens: 50,
    // Midday UTC: the same calendar day in every zone from UTC-11 to UTC+11.
    lastUsedAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  };
}

function usage(
  period: 7 | 30 | 90,
  members: AiUsageResponse['members'],
  totals = { turns: 9, inputTokens: 12_000, outputTokens: 3_450 },
): AiUsageResponse {
  return { period, totals, members, requestId: REQUEST };
}

const members = [
  member(1, { displayName: 'Small User', turns: 2, inputTokens: 100, outputTokens: 50 }),
  member(2, { displayName: 'Big User', turns: 7, inputTokens: 11_000, outputTokens: 3_000 }),
  member(3, { displayName: null, turns: 1, inputTokens: 900, outputTokens: 400 }),
];

function row(name: string): HTMLElement {
  const found = screen
    .getAllByRole('row')
    .find((candidate) => candidate.querySelector('th')?.textContent === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
}

describe('AiUsageScreen', () => {
  beforeEach(() => {
    mocks.getAiUsage.mockReset();
    mocks.getAiUsage.mockResolvedValue(usage(30, members));
  });

  it('asks for the last 30 days and shows the totals and the rows by total tokens', async () => {
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    const totals = await screen.findByRole('region', { name: 'Totals' });
    expect(mocks.getAiUsage).toHaveBeenCalledWith('staff-token', WORKSPACE, { period: 30 });
    expect(within(totals).getByText('Turns').nextElementSibling?.textContent).toBe('9');
    expect(within(totals).getByText('Tokens in').nextElementSibling?.textContent).toBe('12,000');
    expect(within(totals).getByText('Tokens out').nextElementSibling?.textContent).toBe('3,450');
    expect(within(totals).getByText('Total tokens').nextElementSibling?.textContent).toBe('15,450');

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((candidate) => candidate.querySelector('th')?.textContent);
    expect(names).toEqual(['Big User', 'Unnamed member', 'Small User']);
    const cells = Array.from(row('Big User').querySelectorAll('td'), (cell) => cell.textContent);
    expect(cells.slice(0, 4)).toEqual(['7', '11,000', '3,000', '14,000']);
    expect(row('Big User').querySelector('time')?.textContent).toMatch(/2026/);
    expect(screen.getByText('Usage older than 90 days is not kept.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows "Unnamed member" when the name is null, and breaks ties by name', () => {
    const tied = sortMembers([
      member(1, { displayName: 'Zed' }),
      member(2, { displayName: null }),
      member(3, { displayName: 'Amy' }),
    ]);
    expect(tied.map((entry) => entry.displayName)).toEqual(['Amy', null, 'Zed']);
  });

  it('renders a null name as "Unnamed member"', async () => {
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    expect(await screen.findByText('Unnamed member')).toBeTruthy();
  });

  it('refetches for a new period and keeps the old rows on screen while it loads', async () => {
    let finish: (value: AiUsageResponse) => void = () => undefined;
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    await screen.findByText('Big User');
    mocks.getAiUsage.mockReturnValueOnce(
      new Promise<AiUsageResponse>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(mocks.getAiUsage).toHaveBeenLastCalledWith('staff-token', WORKSPACE, { period: 7 }),
    );
    expect(screen.getByText('Big User')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading AI usage…' })).toBeNull();

    finish(usage(7, [member(4, { displayName: 'Week User' })]));
    expect(await screen.findByText('Week User')).toBeTruthy();
    expect(screen.queryByText('Big User')).toBeNull();
  });

  it('says so when nobody used Ask AI', async () => {
    mocks.getAiUsage.mockResolvedValue(
      usage(30, [], { turns: 0, inputTokens: 0, outputTokens: 0 }),
    );
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    expect(await screen.findByText('Nobody has used Ask AI in this period.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a plain sentence with Try again, and Try again loads it once more', async () => {
    mocks.getAiUsage.mockRejectedValueOnce(new BackendError('internal_error', 500, 'abcdef0123'));
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("couldn't load AI usage");
    expect(alert.textContent).not.toContain('internal_error');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Big User')).toBeTruthy();
    expect(mocks.getAiUsage).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, 'not_found'],
    [503, 'ai_unavailable'],
  ] as const)('reads a %s as "not available yet"', async (status, code) => {
    mocks.getAiUsage.mockRejectedValue(new BackendError(code, status, 'abcdef0123'));
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    const text = await screen.findByText(/AI usage is not available yet\./);
    expect(text.closest('[role="status"]')).not.toBeNull();
    expect(text.textContent).not.toContain(code);
  });

  it('tells someone the backend refuses (403) that their role does not allow it', async () => {
    mocks.getAiUsage.mockRejectedValue(new BackendError('permission_denied', 403, 'abcdef0123'));
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("don't have permission to view AI usage");
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Total tokens')).toBeNull();
  });
});
