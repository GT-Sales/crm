import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CUSTOM_PROPERTY_KINDS, type SiteProperty } from '@gt-sales/contracts';

import { PropertyEditor } from './property-editor';

const leadTypes = [
  { key: 'sim_order', label: 'SIM order' },
  { key: 'internet', label: 'Internet' },
];

function setup(initial?: SiteProperty, onSave = vi.fn().mockResolvedValue(undefined)) {
  render(
    <PropertyEditor {...(initial ? { initial } : {})} leadTypes={leadTypes} onSave={onSave} />,
  );
  return onSave;
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const tier: SiteProperty = {
  key: 'custom_tier',
  label: 'Tier',
  kind: 'choice',
  options: [
    { value: 'bronze', label: 'Bronze', hidden: false },
    { value: 'gold', label: 'Gold', hidden: false },
  ],
  origin: 'custom',
  storage: 'custom',
  sensitive: false,
  staffOnly: false,
  hidden: false,
  leadTypes: ['sim_order'],
  editable: true,
  version: 3,
};

describe('PropertyEditor when adding', () => {
  it.each(CUSTOM_PROPERTY_KINDS.filter((kind) => kind !== 'choice'))(
    'saves a %s property with no options',
    async (kind) => {
      const onSave = setup();
      type('Label', 'Referral');
      type('Kind', kind);
      expect(screen.queryByText('Options')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Save property' }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave).toHaveBeenCalledWith({
        label: 'Referral',
        kind,
        options: [],
        staffOnly: false,
        sensitive: false,
        leadTypes: [],
      });
    },
  );

  it('asks for a label before saving', () => {
    const onSave = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));
    expect(screen.getByRole('alert').textContent).toContain('Enter a label.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('requires at least one option for a choice and derives each option value from its label', async () => {
    const onSave = setup();
    type('Label', 'Tier');
    type('Kind', 'choice');
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));
    expect(screen.getByRole('alert').textContent).toContain('Add at least one option.');
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    type('Option 1 label', 'Bronze plan');
    type('Option 2 label', 'Bronze plan');
    fireEvent.click(screen.getByLabelText('Hide option 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      label: 'Tier',
      kind: 'choice',
      options: [
        { value: 'bronze_plan', label: 'Bronze plan', hidden: false },
        { value: 'bronze_plan_2', label: 'Bronze plan', hidden: true },
      ],
      staffOnly: false,
      sensitive: false,
      leadTypes: [],
    });
  });

  it('refuses an option without a label and lets staff remove an option', () => {
    const onSave = setup();
    type('Label', 'Tier');
    type('Kind', 'choice');
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));
    expect(screen.getByRole('alert').textContent).toContain('Give every option a label.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove option 1' }));
    expect(screen.queryByLabelText('Option 1 label')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends staff only, sensitive and the chosen lead types', async () => {
    const onSave = setup();
    type('Label', 'Referral');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Staff only' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sensitive' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'SIM order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      label: 'Referral',
      kind: 'text',
      options: [],
      staffOnly: true,
      sensitive: true,
      leadTypes: ['sim_order'],
    });
  });

  it('shows the reason a save was refused and keeps the form', async () => {
    const onSave = vi.fn().mockResolvedValue('Someone else changed this property.');
    setup(undefined, onSave);
    type('Label', 'Referral');
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Someone else changed this property.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Label').value).toBe('Referral');
  });
});

describe('PropertyEditor when editing', () => {
  it('locks the kind and saves the changes against the property version', async () => {
    const onSave = setup(tier);
    const kind = screen.getByLabelText<HTMLSelectElement>('Kind');
    expect(kind.disabled).toBe(true);
    expect(kind.value).toBe('choice');
    expect(screen.getByRole('checkbox', { name: 'SIM order' }).getAttribute('data-state')).toBe(
      'checked',
    );

    type('Label', 'Customer tier');
    type('Option 1 label', 'Bronze tier');
    fireEvent.click(screen.getByLabelText('Hide option 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Save property' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      expectedVersion: 3,
      label: 'Customer tier',
      options: [
        { value: 'bronze', label: 'Bronze tier', hidden: false },
        { value: 'gold', label: 'Gold', hidden: true },
      ],
      staffOnly: false,
      sensitive: false,
      leadTypes: ['sim_order'],
    });
  });
});
