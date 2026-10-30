import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  codePropertyCatalog,
  type PropertyLayoutRow,
  type SavePropertyLayoutRequest,
  type SiteProperty,
} from '@gt-sales/contracts';

import { PropertiesSettings } from './properties-settings';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

type SaveLayoutCall = (
  token: string,
  workspaceId: string,
  leadType: string,
  body: SavePropertyLayoutRequest,
) => Promise<unknown>;

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
    getPropertyModel: vi.fn(),
    createProperty: vi.fn(),
    updateProperty: vi.fn(),
    deleteProperty: vi.fn(),
    savePropertyLayout: vi.fn<SaveLayoutCall>(),
  };
});

vi.mock('../../lib/api', () => ({
  getPropertyModel: mocks.getPropertyModel,
  createProperty: mocks.createProperty,
  updateProperty: mocks.updateProperty,
  deleteProperty: mocks.deleteProperty,
  savePropertyLayout: mocks.savePropertyLayout,
  BackendError: mocks.FakeBackendError,
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: mocks.roles }],
  }),
}));

function custom(
  overrides: Partial<SiteProperty> & Pick<SiteProperty, 'key' | 'label' | 'kind'>,
): SiteProperty {
  return {
    origin: 'custom',
    storage: 'custom',
    sensitive: false,
    staffOnly: false,
    hidden: false,
    websiteVisible: false,
    leadTypes: [],
    editable: true,
    version: 2,
    ...overrides,
  };
}

const referral = custom({ key: 'custom_referral_code', label: 'Referral code', kind: 'text' });
const tier = custom({
  key: 'custom_tier',
  label: 'Tier',
  kind: 'choice',
  leadTypes: ['sim_order'],
  options: [
    { value: 'bronze', label: 'Bronze', hidden: false },
    { value: 'gold', label: 'Gold', hidden: false },
  ],
});

/** `GET /properties` as the backend answers it. */
function model(
  options: {
    canManage?: boolean;
    layouts?: Record<string, PropertyLayoutRow>;
    referral?: SiteProperty;
  } = {},
) {
  return {
    properties: [
      // City was hidden before, so the site has a row (version 3); every other built-in has none.
      ...codePropertyCatalog.all.map((entry) =>
        entry.key === 'city' ? { ...entry, hidden: true, version: 3 } : entry,
      ),
      options.referral ?? referral,
      tier,
    ],
    layouts: options.layouts ?? {},
    capabilities: { canManage: options.canManage ?? true },
    requestId: 'req_test',
  };
}

const builtins = () => screen.getByRole('list', { name: 'Built-in properties' });
const customs = () => screen.getByRole('list', { name: 'Custom properties' });

beforeEach(() => {
  mocks.roles = ['owner'];
  for (const mock of [
    mocks.getPropertyModel,
    mocks.createProperty,
    mocks.updateProperty,
    mocks.deleteProperty,
    mocks.savePropertyLayout,
  ]) {
    mock.mockReset();
  }
  mocks.getPropertyModel.mockResolvedValue(model());
});

describe('PropertiesSettings properties', () => {
  it('lists built-in and custom properties with their lead types and status', async () => {
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Built-in properties' });
    expect(mocks.getPropertyModel).toHaveBeenCalledWith('staff-token', WORKSPACE);

    const cityRow = within(builtins()).getByText('City').closest('li');
    expect(cityRow?.textContent).toContain('Hidden');

    const rows = within(customs()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Referral code');
    expect(rows[0]?.textContent).toContain('Text');
    expect(rows[0]?.textContent).toContain('All lead types');
    expect(rows[1]?.textContent).toContain('Tier');
    expect(rows[1]?.textContent).toContain('Choice');
    expect(rows[1]?.textContent).toContain('SIM order');
  });

  it('shows no write controls when the member cannot manage properties', async () => {
    mocks.roles = ['leads'];
    mocks.getPropertyModel.mockResolvedValue(model({ canManage: false }));
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Rename|Hide|Show|Edit|Delete)/ })).toBeNull();
    expect(screen.getByText('Referral code')).toBeTruthy();
  });

  it('says when the properties cannot be read', async () => {
    mocks.getPropertyModel.mockRejectedValue(new mocks.FakeBackendError('forbidden'));
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    expect((await screen.findByRole('alert')).textContent).toContain('forbidden');
  });

  it('renames a built-in with the expected version of 1 when the site has no row, then reloads', async () => {
    mocks.updateProperty.mockResolvedValue({ property: referral, requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Built-in properties' });

    fireEvent.click(within(builtins()).getByRole('button', { name: 'Rename Postal code' }));
    fireEvent.change(screen.getByLabelText('Label for Postal code'), {
      target: { value: 'Region' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }));

    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith('staff-token', WORKSPACE, 'postalCode', {
        expectedVersion: 1,
        label: 'Region',
      }),
    );
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
  });

  it('hides and shows a built-in using its row version', async () => {
    mocks.updateProperty.mockResolvedValue({ property: referral, requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Built-in properties' });

    fireEvent.click(within(builtins()).getByRole('button', { name: 'Show City' }));
    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith('staff-token', WORKSPACE, 'city', {
        expectedVersion: 3,
        hidden: false,
      }),
    );
    fireEvent.click(within(builtins()).getByRole('button', { name: 'Hide Postal code' }));
    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith('staff-token', WORKSPACE, 'postalCode', {
        expectedVersion: 1,
        hidden: true,
      }),
    );
  });

  it('offers a built-in only a label and hide, never edit or delete', async () => {
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Built-in properties' });
    expect(within(builtins()).queryByRole('button', { name: /^(Edit|Delete)/ })).toBeNull();
  });

  it('adds a custom property and reloads', async () => {
    mocks.createProperty.mockResolvedValue({ property: referral, requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Label'), {
      target: { value: 'Account manager' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));

    await waitFor(() =>
      expect(mocks.createProperty).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        label: 'Account manager',
        kind: 'text',
        options: [],
        staffOnly: false,
        sensitive: false,
        websiteVisible: false,
        leadTypes: [],
      }),
    );
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('edits a custom property against its version', async () => {
    mocks.updateProperty.mockResolvedValue({ property: referral, requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Referral code' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Partner code' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));

    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'custom_referral_code',
        {
          expectedVersion: 2,
          label: 'Partner code',
          staffOnly: false,
          sensitive: false,
          leadTypes: [],
        },
      ),
    );
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
  });

  it('says which option is in use when removing it is refused', async () => {
    mocks.updateProperty.mockRejectedValue(
      new mocks.FakeBackendError('property_option_in_use', {
        optionValue: 'bronze',
        leadCount: 4,
        active: 3,
        trashed: 1,
        restricted: 0,
      }),
    );
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Tier' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove option 1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Option bronze is used on 4 leads: 3 active, 1 in the archive (restore, clear the value, archive again). Hide it instead of removing it.',
    );
  });

  it('hides a custom property', async () => {
    mocks.updateProperty.mockResolvedValue({ property: referral, requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Referral code' }));
    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'custom_referral_code',
        { expectedVersion: 2, hidden: true },
      ),
    );
  });

  it('reloads and says so when someone else changed the property first', async () => {
    mocks.updateProperty.mockRejectedValue(new mocks.FakeBackendError('version_conflict'));
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Referral code' }));
    expect(
      await screen.findByText('Someone else changed this property. The latest version is loaded.'),
    ).toBeTruthy();
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
  });

  it('rebuilds the edit dialog from the reloaded property after a conflict, so a retry sends the new version', async () => {
    mocks.getPropertyModel
      .mockResolvedValueOnce(model())
      .mockResolvedValue(model({ referral: { ...referral, label: 'Partner ref', version: 5 } }));
    mocks.updateProperty
      .mockRejectedValueOnce(new mocks.FakeBackendError('version_conflict'))
      .mockResolvedValue({ property: referral, requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Referral code' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'My draft' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));

    expect(
      await within(dialog).findByText(
        'Someone else changed this property. The latest version is loaded.',
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('Label').value).toBe('Partner ref'),
    );

    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Retry' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));
    await waitFor(() => expect(mocks.updateProperty).toHaveBeenCalledTimes(2));
    expect(mocks.updateProperty).toHaveBeenLastCalledWith(
      'staff-token',
      WORKSPACE,
      'custom_referral_code',
      expect.objectContaining({ expectedVersion: 5, label: 'Retry' }),
    );
  });

  it('deletes a custom property only after confirming', async () => {
    mocks.deleteProperty.mockResolvedValue({ key: 'custom_referral_code', requestId: 'r' });
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Referral code' }));
    expect(mocks.deleteProperty).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete property' }));

    await waitFor(() =>
      expect(mocks.deleteProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'custom_referral_code',
      ),
    );
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
  });

  it('says where the leads holding a value are when deleting a property is refused', async () => {
    mocks.deleteProperty.mockRejectedValue(
      new mocks.FakeBackendError('property_in_use', {
        leadCount: 5,
        active: 2,
        trashed: 2,
        restricted: 1,
      }),
    );
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Referral code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete property' }));

    expect(
      await screen.findByText(
        'Used on 5 leads: 2 active, 2 in the archive (restore, clear the value, archive again), 1 restricted (cannot be edited). Hide the property instead.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('suggests clearing the value when every lead holding it can be edited', async () => {
    mocks.deleteProperty.mockRejectedValue(
      new mocks.FakeBackendError('property_in_use', {
        leadCount: 1,
        active: 1,
        trashed: 0,
        restricted: 0,
      }),
    );
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Referral code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete property' }));

    expect(
      await screen.findByText(
        'Used on 1 lead: 1 active. Clear the value on that lead first, or hide the property instead.',
      ),
    ).toBeTruthy();
  });
});

describe('PropertiesSettings layouts', () => {
  const openLayouts = async () => {
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Custom properties' });
    fireEvent.click(screen.getByRole('tab', { name: 'Layouts' }));
    fireEvent.change(await screen.findByLabelText('Lead type'), {
      target: { value: 'partner_application' },
    });
  };

  it('saves the first layout without an expected version, then reloads', async () => {
    mocks.savePropertyLayout.mockResolvedValue({ layout: {}, requestId: 'r' });
    await openLayouts();
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

    await waitFor(() => expect(mocks.savePropertyLayout).toHaveBeenCalledTimes(1));
    const call = mocks.savePropertyLayout.mock.calls[0];
    expect(call?.slice(0, 3)).toEqual(['staff-token', WORKSPACE, 'partner_application']);
    expect(call?.[3]).not.toHaveProperty('expectedVersion');
    expect(call?.[3].layout.sections[0]).toMatchObject({ id: 'request', label: 'Request' });
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
  });

  it('sends the saved version when the site already has a layout', async () => {
    mocks.getPropertyModel.mockResolvedValue(
      model({
        layouts: {
          partner_application: {
            object: 'lead',
            leadType: 'partner_application',
            layout: { sections: [{ id: 'main', label: 'Main', keys: ['company'] }] },
            version: 4,
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        },
      }),
    );
    mocks.savePropertyLayout.mockResolvedValue({ layout: {}, requestId: 'r' });
    await openLayouts();
    expect(screen.getByLabelText<HTMLInputElement>('Section 1 name').value).toBe('Main');
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

    await waitFor(() =>
      expect(mocks.savePropertyLayout).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'partner_application',
        {
          layout: { sections: [{ id: 'main', label: 'Main', keys: ['company'] }] },
          expectedVersion: 4,
        },
      ),
    );
  });

  it('shows a refused layout save and leaves the editor', async () => {
    mocks.savePropertyLayout.mockRejectedValue(new mocks.FakeBackendError('version_conflict'));
    await openLayouts();
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    expect(
      await screen.findByText('Someone else changed this layout. The latest version is loaded.'),
    ).toBeTruthy();
  });

  it('replaces the draft with the reloaded layout after a conflict, so the next save sends its version', async () => {
    const newer = {
      partner_application: {
        object: 'lead' as const,
        leadType: 'partner_application',
        layout: { sections: [{ id: 'main', label: 'Main', keys: ['company'] }] },
        version: 4,
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    };
    mocks.getPropertyModel
      .mockResolvedValueOnce(model())
      .mockResolvedValue(model({ layouts: newer }));
    mocks.savePropertyLayout
      .mockRejectedValueOnce(new mocks.FakeBackendError('version_conflict'))
      .mockResolvedValue({ layout: {}, requestId: 'r' });
    await openLayouts();

    fireEvent.change(screen.getByLabelText('Section 1 name'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

    expect(
      await screen.findByText('Someone else changed this layout. The latest version is loaded.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Section 1 name').value).toBe('Main'),
    );
    expect(mocks.savePropertyLayout.mock.calls[0]?.[3]).not.toHaveProperty('expectedVersion');

    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(mocks.savePropertyLayout).toHaveBeenCalledTimes(2));
    expect(mocks.savePropertyLayout).toHaveBeenLastCalledWith(
      'staff-token',
      WORKSPACE,
      'partner_application',
      {
        layout: { sections: [{ id: 'main', label: 'Main', keys: ['company'] }] },
        expectedVersion: 4,
      },
    );
  });

  it('shows a read-only layout to a member who cannot manage', async () => {
    mocks.roles = ['leads'];
    mocks.getPropertyModel.mockResolvedValue(model({ canManage: false }));
    await openLayouts();
    expect(screen.queryByRole('button', { name: 'Save layout' })).toBeNull();
    expect(screen.getByText('Company')).toBeTruthy();
  });
});

describe('PropertiesSettings for plans', () => {
  const dataAllowance = custom({
    key: 'custom_data',
    label: 'Data allowance',
    kind: 'text',
    websiteVisible: true,
  });
  const carrierCost = custom({ key: 'custom_cost', label: 'Carrier cost', kind: 'money' });

  /** `GET /properties?object=plan`: a plan has no built-ins and one layout keyed ''. */
  function planModel(canManage = true) {
    return {
      properties: [dataAllowance, carrierCost],
      layouts: {},
      capabilities: { canManage },
      requestId: 'req_test',
    };
  }

  beforeEach(() => {
    mocks.getPropertyModel.mockResolvedValue(planModel());
  });

  async function openPlans() {
    render(<PropertiesSettings workspaceSlug="canadawide" object="plan" />);
    await screen.findByRole('list', { name: 'Custom properties' });
  }

  it('reads the plan properties and shows one Plan properties tab, no layouts and no built-ins', async () => {
    await openPlans();
    expect(mocks.getPropertyModel).toHaveBeenCalledWith('staff-token', WORKSPACE, 'plan');
    expect(screen.getByRole('tab', { name: 'Plan properties' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Layouts' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Built-in properties' })).toBeNull();
    const rows = within(customs()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('On website');
    expect(rows[1]?.textContent).not.toContain('On website');
    expect(rows[0]?.textContent).not.toContain('All lead types');
  });

  it('adds a plan property with the Show on website switch and no lead types', async () => {
    mocks.createProperty.mockResolvedValue({ property: dataAllowance, requestId: 'r' });
    await openPlans();

    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Lead types')).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: 'Staff only' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Label'), { target: { value: 'Contract' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Show on website' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));

    await waitFor(() =>
      expect(mocks.createProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        {
          label: 'Contract',
          kind: 'text',
          options: [],
          staffOnly: false,
          sensitive: false,
          websiteVisible: true,
          leadTypes: [],
        },
        'plan',
      ),
    );
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalledTimes(2));
  });

  it('changes the Show on website switch of an existing plan property', async () => {
    mocks.updateProperty.mockResolvedValue({ property: carrierCost, requestId: 'r' });
    await openPlans();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Carrier cost' }));
    const dialog = await screen.findByRole('dialog');
    const show = within(dialog).getByRole('checkbox', { name: 'Show on website' });
    expect(show.getAttribute('data-state')).toBe('unchecked');
    fireEvent.click(show);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save property' }));

    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'custom_cost',
        { expectedVersion: 2, label: 'Carrier cost', websiteVisible: true },
        'plan',
      ),
    );
  });

  it('hides and deletes a plan property against the plan object', async () => {
    mocks.updateProperty.mockResolvedValue({ property: carrierCost, requestId: 'r' });
    mocks.deleteProperty.mockResolvedValue({ requestId: 'r' });
    await openPlans();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Carrier cost' }));
    await waitFor(() =>
      expect(mocks.updateProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'custom_cost',
        { expectedVersion: 2, hidden: true },
        'plan',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Data allowance' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete property' }));
    await waitFor(() =>
      expect(mocks.deleteProperty).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'custom_data',
        'plan',
      ),
    );
  });

  it('shows no write controls to a member who cannot manage properties', async () => {
    mocks.roles = ['orders'];
    mocks.getPropertyModel.mockResolvedValue(planModel(false));
    await openPlans();
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Edit|Hide|Show|Delete)/ })).toBeNull();
  });

  it('keeps asking for lead properties when no object is given', async () => {
    mocks.getPropertyModel.mockResolvedValue(model());
    render(<PropertiesSettings workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Built-in properties' });
    expect(mocks.getPropertyModel).toHaveBeenCalledWith('staff-token', WORKSPACE);
    expect(screen.getByRole('tab', { name: 'Layouts' })).toBeTruthy();
  });
});
