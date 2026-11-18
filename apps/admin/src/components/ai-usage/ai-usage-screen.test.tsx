import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageResponse } from '@gt-sales/contracts';

import { AiUsageScreen, sortMembers } from './ai-usage-screen';
import { failureReason } from './failure-reasons';
import { answerTime } from './usage-format';

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

  it('reads an older backend’s answer as the page it always was', async () => {
    const { container } = render(<AiUsageScreen workspaceSlug="canadawide" />);
    await screen.findByText('Big User');
    expect(Array.from(container.querySelectorAll('h2'), (heading) => heading.textContent)).toEqual([
      'Turns',
      'Tokens in',
      'Tokens out',
      'Total tokens',
    ]);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(container.querySelectorAll('.crm-kpi-strip')).toHaveLength(1);
    for (const absent of ['Assistant', 'Turns per day', 'Models', 'Why turns failed', 'People']) {
      expect(screen.queryByText(absent)).toBeNull();
    }
  });
});

/** Seven Toronto days ending 18 Nov 2026, as the backend sends them. */
function week(): NonNullable<AiUsageResponse['daily']> {
  return [12, 13, 14, 15, 16, 17, 18].map((date, index) => ({
    day: `2026-11-${String(date)}`,
    turns: index === 1 ? 0 : index + 1,
    failedTurns: index === 6 ? 2 : 0,
    inputTokens: index === 1 ? 0 : 1000 * (index + 1),
    outputTokens: index === 1 ? 0 : 100 * (index + 1),
  }));
}

function monitoring(overrides: Partial<AiUsageResponse> = {}): AiUsageResponse {
  return {
    ...usage(7, members, { turns: 8, inputTokens: 12_000, outputTokens: 3_450 }),
    totals: {
      turns: 8,
      inputTokens: 12_000,
      outputTokens: 3_450,
      completedTurns: 4,
      failedTurns: 3,
      cancelledTurns: 1,
      toolCalls: 5,
      averageDurationMs: 1505,
    },
    assistant: {
      enabled: true,
      configuredModel: 'acme/alpha',
      providers: ['baseten', 'vertexAnthropic'],
      conversations: true,
      attachmentKinds: ['image', 'text'],
    },
    models: [
      {
        model: 'acme/alpha',
        engine: 'gateway',
        turns: 4,
        completedTurns: 2,
        failedTurns: 2,
        inputTokens: 9_000,
        outputTokens: 3_000,
        averageDurationMs: 1010,
        lastUsedAt: '2026-11-14T12:00:00.000Z',
      },
      {
        model: 'acme/beta',
        engine: 'gateway',
        turns: 3,
        completedTurns: 2,
        failedTurns: 1,
        inputTokens: 2_990,
        outputTokens: 449,
        averageDurationMs: 2001,
        lastUsedAt: '2026-11-14T12:00:00.000Z',
      },
      {
        model: null,
        engine: 'fake',
        turns: 1,
        completedTurns: 0,
        failedTurns: 0,
        inputTokens: 10,
        outputTokens: 1,
        averageDurationMs: null,
        lastUsedAt: '2026-11-14T12:00:00.000Z',
      },
    ],
    daily: week(),
    failures: [
      { code: 'rate_limited', turns: 2 },
      { code: 'quota_gone', turns: 1 },
    ],
    ...overrides,
  };
}

function tile(label: string): { value: string | null | undefined; note: string | undefined } {
  const heading = within(screen.getByRole('region', { name: 'Totals' })).getByText(label);
  return {
    value: heading.nextElementSibling?.textContent,
    note: heading.nextElementSibling?.nextElementSibling?.textContent ?? undefined,
  };
}

function modelRow(text: string): HTMLElement {
  const table = screen.getByRole('table', { name: /Models that served/ });
  const found = within(table)
    .getAllByRole('row')
    .find((candidate) => candidate.querySelector('th')?.textContent?.includes(text));
  if (!found) throw new Error(`no model row ${text}`);
  return found;
}

describe('AiUsageScreen, monitoring', () => {
  const zone = process.env.TZ;

  beforeEach(() => {
    mocks.getAiUsage.mockReset();
    mocks.getAiUsage.mockResolvedValue(monitoring());
  });

  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('shows the assistant, the totals, the days, the models, the failures and the people', async () => {
    const { container } = render(<AiUsageScreen workspaceSlug="canadawide" />);
    const assistant = await screen.findByRole('region', { name: 'Assistant' });
    expect(Array.from(container.querySelectorAll('h2'), (heading) => heading.textContent)).toEqual([
      'Assistant',
      'Turns',
      'Completed',
      'Failed',
      'Average answer time',
      'Tokens in',
      'Tokens out',
      'Total tokens',
      'Tool calls',
      'Turns per day',
      'Tokens per day',
      'Models',
      'Why turns failed',
      'People',
    ]);

    expect(within(assistant).getByText('acme/alpha').tagName).toBe('CODE');
    expect(within(assistant).getByText('baseten')).toBeTruthy();
    expect(within(assistant).getByText('vertexAnthropic')).toBeTruthy();
    expect(within(assistant).getByText('Images, Text files')).toBeTruthy();
    expect(within(assistant).queryByText(/AI_ASSISTANT_ENABLED/)).toBeNull();

    expect(tile('Turns').value).toBe('8');
    expect(tile('Completed').value).toBe('4');
    expect(tile('Failed')).toEqual({ value: '3', note: '37.5% of turns' });
    expect(tile('Average answer time').value).toBe('1.5 s');
    expect(tile('Tokens in').value).toBe('12,000');
    expect(tile('Total tokens').value).toBe('15,450');
    expect(tile('Tool calls').value).toBe('5');
    expect(
      screen.getByText('Today and the 6 days before it, as calendar days in Toronto.'),
    ).toBeTruthy();

    const turnsTable = screen.getByRole('table', { name: 'Turns per day' });
    expect(within(turnsTable).getAllByRole('row')).toHaveLength(8);
    expect(within(turnsTable).getByRole('rowheader', { name: 'Nov 18' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Tokens per day' })).toBeTruthy();

    expect(within(modelRow('acme/alpha')).getByText('Current')).toBeTruthy();
    expect(within(modelRow('acme/beta')).queryByText('Current')).toBeNull();
    expect(
      Array.from(modelRow('acme/alpha').querySelectorAll('td'), (cell) => cell.textContent),
    ).toEqual(['4', '2', '2', '9,000', '3,000', '1.0 s', expect.stringMatching(/2026/)]);
    const unknown = modelRow('Unknown');
    expect(within(unknown).getByText('Test engine')).toBeTruthy();
    expect(unknown.querySelectorAll('td')[5]?.textContent).toBe('—');
    expect(within(modelRow('acme/alpha')).queryByText('Test engine')).toBeNull();

    const failures = screen.getByRole('region', { name: 'Why turns failed' });
    const reasons = within(failures).getAllByRole('listitem');
    expect(reasons[0]?.textContent).toContain('The AI provider was rate limiting');
    expect(reasons[0]?.textContent).toContain('rate_limited');
    expect(reasons[0]?.textContent).toContain('2');
    // A code this admin does not know: a generic phrase, the code only as the small detail.
    expect(reasons[1]?.textContent).toContain('Another reason');
    const other = reasons[1];
    if (!other) throw new Error('no second reason');
    expect(within(other).getByText(/quota_gone/).className).toContain('text-muted-foreground');
    expect(within(failures).getByText('3 failed turns in this period')).toBeTruthy();

    expect(screen.getByRole('region', { name: 'People' })).toBeTruthy();
    expect(row('Big User')).toBeTruthy();
  });

  it('writes an answer time in seconds with one decimal', () => {
    expect([1505, 1000, 40, 0, null].map(answerTime)).toEqual([
      '1.5 s',
      '1.0 s',
      '< 0.1 s',
      '0.0 s',
      '—',
    ]);
  });

  it('puts every known failure code in plain words', () => {
    expect(failureReason('provider_unavailable')).toBe('The AI provider did not answer');
    expect(failureReason('rate_limited')).toBe('The AI provider was rate limiting');
    expect(failureReason('timeout')).toBe('The answer took too long');
    expect(failureReason('budget_exceeded')).toBe('The answer hit its size limit');
    for (const code of [
      'tool_unavailable',
      'internal_error',
      'cancelled',
      'access_lost',
      'unknown',
    ]) {
      expect(failureReason(code)).not.toBe('Another reason');
      expect(failureReason(code)).not.toContain(code);
    }
    expect(failureReason('constructor')).toBe('Another reason');
    expect(failureReason('something_new')).toBe('Another reason');
  });

  it('says what is off, and the setting that turns it on', async () => {
    mocks.getAiUsage.mockResolvedValue(
      monitoring({
        assistant: {
          enabled: false,
          configuredModel: null,
          providers: [],
          conversations: false,
          attachmentKinds: [],
        },
      }),
    );
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    const assistant = await screen.findByRole('region', { name: 'Assistant' });
    expect(within(assistant).getByText('Not set')).toBeTruthy();
    expect(within(assistant).getByText('Any host the Gateway chooses')).toBeTruthy();
    expect(within(assistant).getByText('Uploads off')).toBeTruthy();
    expect(within(assistant).getAllByText('Off')).toHaveLength(2);
    expect(within(assistant).getByText('AI_ASSISTANT_WORKSPACE_IDS')).toBeTruthy();
    // No configured model: no row is marked current.
    expect(screen.queryByText('Current')).toBeNull();
  });

  it('shows the empty states, and no rate or average, for a period without turns', async () => {
    mocks.getAiUsage.mockResolvedValue(
      monitoring({
        totals: {
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          completedTurns: 0,
          failedTurns: 0,
          cancelledTurns: 0,
          toolCalls: 0,
          averageDurationMs: null,
        },
        members: [],
        models: [],
        failures: [],
        daily: week().map((day) => ({
          ...day,
          turns: 0,
          failedTurns: 0,
          inputTokens: 0,
          outputTokens: 0,
        })),
      }),
    );
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    await screen.findByRole('region', { name: 'Assistant' });
    expect(tile('Failed')).toEqual({ value: '0', note: undefined });
    expect(tile('Average answer time')).toEqual({ value: '—', note: 'No completed turns' });
    expect(screen.getAllByText('No activity in this period')).toHaveLength(2);
    expect(screen.getByText('No model answered in this period.')).toBeTruthy();
    expect(screen.getByText('No turns failed in this period.')).toBeTruthy();
    expect(screen.getByText('Nobody has used Ask AI in this period.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('labels each day as the backend sent it, whatever the viewer’s time zone', async () => {
    process.env.TZ = 'America/Los_Angeles';
    // The trap this avoids: the 18th read as a UTC midnight is the 17th here.
    expect(new Date('2026-11-18').getDate()).toBe(17);
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    const table = await screen.findByRole('table', { name: 'Turns per day' });
    const days = within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent);
    expect(days).toEqual(['Nov 12', 'Nov 13', 'Nov 14', 'Nov 15', 'Nov 16', 'Nov 17', 'Nov 18']);
  });

  it('refetches for a new period and keeps the old numbers on screen while it loads', async () => {
    let finish: (value: AiUsageResponse) => void = () => undefined;
    render(<AiUsageScreen workspaceSlug="canadawide" />);
    await screen.findByRole('region', { name: 'Assistant' });
    mocks.getAiUsage.mockReturnValueOnce(
      new Promise<AiUsageResponse>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    await waitFor(() =>
      expect(mocks.getAiUsage).toHaveBeenLastCalledWith('staff-token', WORKSPACE, { period: 90 }),
    );
    expect(tile('Turns').value).toBe('8');
    expect(screen.getByText('acme/beta')).toBeTruthy();

    finish(
      monitoring({ period: 90, models: [], totals: { turns: 0, inputTokens: 0, outputTokens: 0 } }),
    );
    expect(await screen.findByText('No model answered in this period.')).toBeTruthy();
    expect(screen.queryByText('acme/beta')).toBeNull();
  });
});
