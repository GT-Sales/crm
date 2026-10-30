import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_AUTOMATIONS,
  automationSchema,
  type Automation,
  type AutomationRun,
  type ListAutomationsResponse,
} from '@gt-sales/contracts';

import { SiteAutomations } from './automations-list';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD = '30000000-0000-4000-8000-000000000001';
const ORDER_RECEIVED = 'When an order is submitted on the website → send the Order received email';
const DISPATCHED = 'When a SIM order moves to Delivered → send the Dispatched email';

const mocks = vi.hoisted(() => {
  class FakeBackendError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    FakeBackendError,
    listAutomations: vi.fn(),
    updateAutomation: vi.fn(),
    listAutomationRuns: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({
  listAutomations: mocks.listAutomations,
  updateAutomation: mocks.updateAutomation,
  listAutomationRuns: mocks.listAutomationRuns,
  BackendError: mocks.FakeBackendError,
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

function rules(overrides: Partial<Record<string, Partial<Automation>>> = {}): Automation[] {
  return BUILT_IN_AUTOMATIONS.map((definition) =>
    automationSchema.parse({
      ...definition,
      enabled: false,
      lastRunAt: null,
      runCount: 0,
      ...overrides[definition.key],
    }),
  );
}

function answer(overrides: Partial<ListAutomationsResponse> = {}): ListAutomationsResponse {
  return {
    automations: rules(),
    canManage: true,
    hasSender: true,
    requestId: 'req_test',
    ...overrides,
  };
}

const row = (label: string) => {
  const item = screen.getByRole('switch', { name: label }).closest('li');
  if (!item) throw new Error(`no row for ${label}`);
  return item;
};

beforeEach(() => {
  for (const mock of [mocks.listAutomations, mocks.updateAutomation, mocks.listAutomationRuns]) {
    mock.mockReset();
  }
  mocks.listAutomations.mockResolvedValue(answer());
});

describe('SiteAutomations', () => {
  it('lists one row per built-in rule, by its label', async () => {
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const list = await screen.findByRole('list', { name: 'Automations' });
    expect(mocks.listAutomations).toHaveBeenCalledWith('staff-token', WORKSPACE);
    const switches = within(list).getAllByRole('switch');
    expect(switches.map((control) => control.getAttribute('aria-label'))).toEqual(
      BUILT_IN_AUTOMATIONS.map(({ label }) => label),
    );
    for (const control of switches) {
      expect(control.getAttribute('aria-checked')).toBe('false');
      expect(control.hasAttribute('disabled')).toBe(false);
    }
  });

  it('switches a rule on for the owner', async () => {
    mocks.updateAutomation.mockResolvedValue({
      automation: rules({ order_received: { enabled: true } })[0],
      requestId: 'req_test',
    });
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const control = await screen.findByRole('switch', { name: ORDER_RECEIVED });

    fireEvent.click(control);

    await waitFor(() =>
      expect(mocks.updateAutomation).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'order_received',
        { enabled: true },
      ),
    );
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('puts the switch back and says why when the change fails', async () => {
    mocks.updateAutomation.mockRejectedValue(new mocks.FakeBackendError('internal_error'));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const control = await screen.findByRole('switch', { name: ORDER_RECEIVED });

    fireEvent.click(control);

    expect((await within(row(ORDER_RECEIVED)).findByRole('alert')).textContent).toBe(
      'The change was not saved. Reason: internal_error.',
    );
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the confirmed state when a later change fails', async () => {
    mocks.updateAutomation.mockResolvedValueOnce({
      automation: rules({ order_received: { enabled: true, runCount: 4 } })[0],
      requestId: 'req_test',
    });
    mocks.updateAutomation.mockRejectedValueOnce(new mocks.FakeBackendError('internal_error'));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const control = await screen.findByRole('switch', { name: ORDER_RECEIVED });

    fireEvent.click(control);
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
    // The saved rule as the backend answered it, counts included.
    await waitFor(() =>
      expect(
        within(row(ORDER_RECEIVED)).getByText('Emails queued').nextElementSibling?.textContent,
      ).toBe('4'),
    );

    fireEvent.click(control);

    expect((await within(row(ORDER_RECEIVED)).findByRole('alert')).textContent).toBe(
      'The change was not saved. Reason: internal_error.',
    );
    expect(mocks.updateAutomation).toHaveBeenLastCalledWith(
      'staff-token',
      WORKSPACE,
      'order_received',
      { enabled: false },
    );
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('ignores a second click while a change is being saved', async () => {
    let settle: (value: unknown) => void = () => undefined;
    mocks.updateAutomation.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const control = await screen.findByRole('switch', { name: ORDER_RECEIVED });

    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(control);
    expect(mocks.updateAutomation).toHaveBeenCalledTimes(1);
    expect(control.getAttribute('aria-checked')).toBe('true');

    settle({
      automation: rules({ order_received: { enabled: true } })[0],
      requestId: 'req_test',
    });
    await waitFor(() => expect(control.hasAttribute('aria-disabled')).toBe(false));
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(mocks.updateAutomation).toHaveBeenCalledTimes(1);
  });

  it('announces the recent runs while they load', async () => {
    mocks.listAutomationRuns.mockReturnValue(new Promise(() => undefined));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Automations' });
    fireEvent.click(within(row(DISPATCHED)).getByRole('button', { name: 'Recent runs' }));

    expect(within(row(DISPATCHED)).getByRole('status').textContent).toBe(
      'Loading the recent runs…',
    );
  });

  it('says a refused change needs the site owner', async () => {
    mocks.updateAutomation.mockRejectedValue(new mocks.FakeBackendError('permission_denied'));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('switch', { name: DISPATCHED }));

    expect((await within(row(DISPATCHED)).findByRole('alert')).textContent).toBe(
      'Only the site owner can switch automations.',
    );
    expect(row(DISPATCHED).querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('is read-only for a member who cannot manage the rules', async () => {
    mocks.listAutomations.mockResolvedValue(
      answer({ canManage: false, automations: rules({ order_received: { enabled: true } }) }),
    );
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const note = await screen.findByText('Only the site owner can switch automations.');

    for (const control of screen.getAllByRole('switch')) {
      expect(control.hasAttribute('disabled')).toBe(true);
      expect(control.getAttribute('aria-describedby')).toBe(note.id);
    }
    expect(screen.getByRole('switch', { name: ORDER_RECEIVED }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('switch', { name: ORDER_RECEIVED }));
    expect(mocks.updateAutomation).not.toHaveBeenCalled();
    // Reading the runs is still open to them.
    expect(
      within(row(ORDER_RECEIVED))
        .getByRole('button', { name: 'Recent runs' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('shows the last run and the emails queued, or Never', async () => {
    const lastRunAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    mocks.listAutomations.mockResolvedValue(
      answer({ automations: rules({ sim_order_dispatched: { lastRunAt, runCount: 3 } }) }),
    );
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Automations' });

    const dispatched = within(row(DISPATCHED));
    expect(dispatched.getByText('Emails queued').nextElementSibling?.textContent).toBe('3');
    expect(dispatched.getByText('Last run').nextElementSibling?.textContent).toBe('3h ago');

    const received = within(row(ORDER_RECEIVED));
    expect(received.getByText('Emails queued').nextElementSibling?.textContent).toBe('0');
    expect(received.getByText('Last run').nextElementSibling?.textContent).toBe('Never');
  });

  it("links each rule to its email's editor", async () => {
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Automations' });

    expect(
      within(row(DISPATCHED)).getByRole('link', { name: 'Edit the email' }).getAttribute('href'),
    ).toBe('/w/canadawide/settings/email?template=dispatched');
    expect(
      within(row(ORDER_RECEIVED))
        .getByRole('link', { name: 'Edit the email' })
        .getAttribute('href'),
    ).toBe('/w/canadawide/settings/email?template=order_received');
  });

  it('loads the recent runs when they are opened', async () => {
    const runs: AutomationRun[] = [
      {
        id: '40000000-0000-4000-8000-000000000001',
        leadId: LEAD,
        leadName: 'Ada Lovelace',
        outcome: 'skipped',
        reason: 'no_customer_email',
        createdAt: new Date().toISOString(),
      },
    ];
    mocks.listAutomationRuns.mockResolvedValue({ runs, requestId: 'req_test' });
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Automations' });
    const toggle = within(row(DISPATCHED)).getByRole('button', { name: 'Recent runs' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(mocks.listAutomationRuns).not.toHaveBeenCalled();

    fireEvent.click(toggle);

    expect(mocks.listAutomationRuns).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      'sim_order_dispatched',
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const lead = await within(row(DISPATCHED)).findByRole('link', { name: 'Ada Lovelace' });
    expect(lead.getAttribute('href')).toBe(`/w/canadawide/leads/${LEAD}`);
    expect(within(row(DISPATCHED)).getByText('Skipped: no customer email')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(row(DISPATCHED)).queryByRole('link', { name: 'Ada Lovelace' })).toBeNull();
  });

  it('says when the recent runs cannot be loaded', async () => {
    mocks.listAutomationRuns.mockRejectedValue(new mocks.FakeBackendError('internal_error'));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Automations' });
    fireEvent.click(within(row(DISPATCHED)).getByRole('button', { name: 'Recent runs' }));

    expect((await within(row(DISPATCHED)).findByRole('alert')).textContent).toBe(
      'The recent runs could not be loaded. Reason: internal_error.',
    );
  });

  it('warns that every run is skipped until the site has a sender', async () => {
    mocks.listAutomations.mockResolvedValue(answer({ hasSender: false }));
    render(<SiteAutomations workspaceSlug="canadawide" />);

    expect(
      await screen.findByText(
        'Switch an email on once Settings → Email is saved; until then every run is skipped.',
      ),
    ).toBeTruthy();
  });

  it('has no sender notice once the site can send', async () => {
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Automations' });

    expect(screen.queryByText(/until then every run is skipped/)).toBeNull();
  });

  it('says why the rules could not be loaded', async () => {
    mocks.listAutomations.mockRejectedValue(new mocks.FakeBackendError('permission_denied'));
    render(<SiteAutomations workspaceSlug="canadawide" />);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The automations could not be loaded. Reason: permission_denied.',
    );
  });
});
