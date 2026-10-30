import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '@gt-sales/contracts';

import { PlansSettings } from './plans-settings';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-01T00:00:00.000Z';

const mocks = vi.hoisted(() => {
  class FakeBackendError extends Error {
    constructor(
      readonly code: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(code);
    }
  }
  return {
    FakeBackendError,
    roles: ['owner'],
    listPlans: vi.fn(),
    createPlan: vi.fn(),
    updatePlan: vi.fn(),
    getPropertyModel: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({
  listPlans: mocks.listPlans,
  createPlan: mocks.createPlan,
  updatePlan: mocks.updatePlan,
  getPropertyModel: mocks.getPropertyModel,
  BackendError: mocks.FakeBackendError,
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: mocks.roles }],
  }),
}));

function plan(overrides: Partial<Plan> & Pick<Plan, 'id' | 'name' | 'leadType'>): Plan {
  return {
    priceMinor: 2500,
    currency: 'CAD',
    billingPeriod: 'month',
    paymentRequired: true,
    active: true,
    requiredDocuments: [],
    customValues: {},
    position: 0,
    version: 3,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

const bronze = plan({
  id: '20000000-0000-4000-8000-000000000001',
  name: 'Bronze',
  leadType: 'sim_order',
  priceMinor: 1999,
});
const silver = plan({
  id: '20000000-0000-4000-8000-000000000002',
  name: 'Silver',
  leadType: 'sim_order',
  billingPeriod: 'year',
  priceMinor: 9900,
  position: 1,
});
const legacy = plan({
  id: '20000000-0000-4000-8000-000000000003',
  name: 'Legacy',
  leadType: 'sim_order',
  active: false,
  position: 0,
});
const fibre = plan({
  id: '20000000-0000-4000-8000-000000000004',
  name: 'Fibre 500',
  leadType: 'internet',
  priceMinor: 7999,
});

function answer(plans: Plan[]) {
  return { plans, requestId: 'req_test' };
}

const planModel = {
  properties: [],
  layouts: {},
  capabilities: { canManage: false },
  requestId: 'req_test',
};

const list = (name: string) => screen.getByRole('list', { name });

beforeEach(() => {
  mocks.roles = ['owner'];
  for (const mock of [
    mocks.listPlans,
    mocks.createPlan,
    mocks.updatePlan,
    mocks.getPropertyModel,
  ]) {
    mock.mockReset();
  }
  mocks.listPlans.mockResolvedValue(answer([legacy, bronze, silver, fibre]));
  mocks.getPropertyModel.mockResolvedValue(planModel);
});

describe('PlansSettings list', () => {
  it('asks for inactive plans too and lists one group per order lead type', async () => {
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });
    expect(mocks.listPlans).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      includeInactive: 'true',
    });
    expect(mocks.getPropertyModel).toHaveBeenCalledWith('staff-token', WORKSPACE, 'plan');

    expect(screen.getByRole('heading', { name: 'SIM order' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Internet' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Mobility' })).toBeTruthy();
    expect(within(list('Internet plans')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('No plans yet.')).toBeTruthy();
  });

  it('shows the price in dollars and the billing period in words', async () => {
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });
    const rows = within(list('SIM order plans')).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('Bronze');
    expect(rows[0]?.textContent).toContain('$19.99');
    expect(rows[0]?.textContent).toContain('Monthly');
    expect(rows[1]?.textContent).toContain('Silver');
    expect(rows[1]?.textContent).toContain('$99.00');
    expect(rows[1]?.textContent).toContain('Yearly');
  });

  it('puts active plans first and marks inactive ones', async () => {
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });
    const rows = within(list('SIM order plans')).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('p')?.textContent ?? '')).toEqual([
      expect.stringContaining('Bronze'),
      expect.stringContaining('Silver'),
      expect.stringContaining('Legacy'),
    ]);
    expect(rows[2]?.textContent).toContain('Inactive');
    expect(rows[2]?.className).toContain('opacity');
    expect(rows[0]?.textContent).not.toContain('Inactive');
  });

  it('says when the plans cannot be read', async () => {
    mocks.listPlans.mockRejectedValue(new mocks.FakeBackendError('forbidden'));
    render(<PlansSettings workspaceSlug="canadawide" />);
    expect((await screen.findByRole('alert')).textContent).toContain('forbidden');
  });
});

describe('PlansSettings permissions', () => {
  it.each([['leads'], ['viewer'], ['finance']])(
    'shows no write controls to a %s member',
    async (role) => {
      mocks.roles = [role];
      render(<PlansSettings workspaceSlug="canadawide" />);
      await screen.findByRole('list', { name: 'SIM order plans' });
      expect(screen.queryByRole('button', { name: /^(Add|Edit)/ })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.getByText('Bronze')).toBeTruthy();
      expect(screen.getByText('Inactive')).toBeTruthy();
    },
  );

  it.each([['owner'], ['orders']])('shows write controls to a %s member', async (role) => {
    mocks.roles = [role];
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });
    expect(screen.getByRole('button', { name: 'Add SIM order plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Bronze' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Active Bronze' })).toBeTruthy();
  });
});

describe('PlansSettings writes', () => {
  it('adds a plan for the type with the price in cents, then reloads', async () => {
    mocks.createPlan.mockResolvedValue({ plan: fibre, requestId: 'r' });
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('button', { name: 'Add Internet plan' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Fibre 1G' } });
    fireEvent.change(within(dialog).getByLabelText('Price (CAD)'), { target: { value: '89.5' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Payment required' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Provincial ID' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    await waitFor(() =>
      expect(mocks.createPlan).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        leadType: 'internet',
        name: 'Fibre 1G',
        priceMinor: 8950,
        billingPeriod: 'month',
        paymentRequired: true,
        active: true,
        requiredDocuments: ['provincial_id'],
        customValues: {},
      }),
    );
    await waitFor(() => expect(mocks.listPlans).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('edits a plan with the version it read', async () => {
    mocks.updatePlan.mockResolvedValue({ plan: bronze, requestId: 'r' });
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Bronze' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Bronze plus' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    await waitFor(() =>
      expect(mocks.updatePlan).toHaveBeenCalledWith('staff-token', WORKSPACE, bronze.id, {
        expectedVersion: 3,
        name: 'Bronze plus',
      }),
    );
    await waitFor(() => expect(mocks.listPlans).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('turns a plan off and on with the Active switch', async () => {
    mocks.updatePlan.mockResolvedValue({ plan: bronze, requestId: 'r' });
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Active Bronze' }));
    await waitFor(() =>
      expect(mocks.updatePlan).toHaveBeenCalledWith('staff-token', WORKSPACE, bronze.id, {
        expectedVersion: 3,
        active: false,
      }),
    );
    await waitFor(() => expect(mocks.listPlans).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Active Legacy' }));
    await waitFor(() =>
      expect(mocks.updatePlan).toHaveBeenCalledWith('staff-token', WORKSPACE, legacy.id, {
        expectedVersion: 3,
        active: true,
      }),
    );
  });

  it.each([
    ['plan_name_taken', 'A plan with that name already exists for this type.'],
    ['plan_limit', 'This site already has 200 plans.'],
  ])('explains %s when adding', async (code, message) => {
    mocks.createPlan.mockRejectedValue(new mocks.FakeBackendError(code));
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('button', { name: 'Add SIM order plan' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Bronze' } });
    fireEvent.change(within(dialog).getByLabelText('Price (CAD)'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('explains a name clash when editing', async () => {
    mocks.updatePlan.mockRejectedValue(new mocks.FakeBackendError('plan_name_taken'));
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Bronze' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Silver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A plan with that name already exists for this type.',
    );
  });

  it('reloads and rebuilds the editor from the latest plan on a version conflict', async () => {
    mocks.updatePlan.mockRejectedValue(new mocks.FakeBackendError('version_conflict'));
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Bronze' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My draft' } });
    // Someone else renamed the plan and saved it as version 4.
    mocks.listPlans.mockResolvedValue(
      answer([legacy, { ...bronze, name: 'Bronze 2026', version: 4 }, silver, fibre]),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This plan changed elsewhere. Reload and try again.',
    );
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('Bronze 2026'),
    );

    mocks.updatePlan.mockResolvedValue({ plan: bronze, requestId: 'r' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Bronze 2027' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() =>
      expect(mocks.updatePlan).toHaveBeenLastCalledWith('staff-token', WORKSPACE, bronze.id, {
        expectedVersion: 4,
        name: 'Bronze 2027',
      }),
    );
  });

  it('says why the Active switch failed and reloads on a version conflict', async () => {
    mocks.updatePlan.mockRejectedValue(new mocks.FakeBackendError('version_conflict'));
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Active Bronze' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This plan changed elsewhere. Reload and try again.',
    );
    await waitFor(() => expect(mocks.listPlans).toHaveBeenCalledTimes(2));
  });

  it('gives any other failure with its reason', async () => {
    mocks.updatePlan.mockRejectedValue(new mocks.FakeBackendError('forbidden'));
    render(<PlansSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'SIM order plans' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Active Bronze' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The change was not saved. Reason: forbidden.',
    );
  });
});
