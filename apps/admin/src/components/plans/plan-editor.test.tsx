import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPropertyCatalog,
  type CreatePlanRequest,
  type Plan,
  type PropertyRow,
  type UpdatePlanRequest,
} from '@gt-sales/contracts';

import { PlanEditor } from './plan-editor';

const DOCUMENT_TYPES = [
  'passport',
  'visa',
  'study_permit',
  'work_permit',
  'drivers_licence',
  'provincial_id',
] as const;

const ROW_TIMESTAMP = '2026-10-01T00:00:00.000Z';

function propertyRow(
  overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key' | 'label' | 'kind'>,
): PropertyRow {
  return {
    object: 'plan',
    origin: 'custom',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: false,
    websiteVisible: false,
    leadTypes: [],
    position: 0,
    version: 1,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
    ...overrides,
  };
}

const catalog = buildPropertyCatalog(
  [
    propertyRow({ key: 'custom_data', label: 'Data allowance', kind: 'text', position: 0 }),
    propertyRow({ key: 'custom_cost', label: 'Carrier cost', kind: 'money', position: 1 }),
    propertyRow({
      key: 'custom_old',
      label: 'Retired field',
      kind: 'text',
      hidden: true,
      position: 2,
    }),
  ],
  'plan',
);

const bronze: Plan = {
  id: '20000000-0000-4000-8000-000000000001',
  leadType: 'sim_order',
  name: 'Bronze',
  priceMinor: 2500,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  active: true,
  requiredDocuments: ['passport'],
  customValues: { custom_data: '10 GB' },
  position: 0,
  version: 4,
  createdAt: ROW_TIMESTAMP,
  updatedAt: ROW_TIMESTAMP,
};

type Save = (input: CreatePlanRequest | UpdatePlanRequest) => Promise<string | undefined>;

function setup(initial?: Plan, onSave: Save = vi.fn<Save>().mockResolvedValue(undefined)) {
  render(
    <PlanEditor
      leadType={initial?.leadType ?? 'internet'}
      {...(initial ? { initial } : {})}
      catalog={catalog}
      documentTypes={DOCUMENT_TYPES}
      onSave={onSave}
    />,
  );
  return onSave;
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));

describe('PlanEditor when adding', () => {
  it('sends the price in cents with the lead type and the defaults', async () => {
    const onSave = setup();
    type('Name', '  Fibre 500  ');
    type('Price (CAD)', '49.9');
    type('Billing period', 'year');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      leadType: 'internet',
      name: 'Fibre 500',
      priceMinor: 4990,
      billingPeriod: 'year',
      paymentRequired: false,
      active: true,
      requiredDocuments: [],
      customValues: {},
    });
  });

  it('offers the billing periods in words', () => {
    setup();
    const labels = Array.from(
      screen.getByLabelText<HTMLSelectElement>('Billing period').options,
    ).map((option) => option.textContent);
    expect(labels).toEqual(['One-time', 'Monthly', '30 days', '90 days', 'Yearly']);
  });

  it('sends the payment, active and required document choices', async () => {
    const onSave = setup();
    type('Name', 'Student SIM');
    type('Price (CAD)', '30');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payment required' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Study permit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Passport' }));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        priceMinor: 3000,
        paymentRequired: true,
        active: false,
        requiredDocuments: ['passport', 'study_permit'],
      }),
    );
  });

  it('lists the six document types in sentence case', () => {
    setup();
    for (const label of [
      'Passport',
      'Visa',
      'Study permit',
      'Work permit',
      "Driver's licence",
      'Provincial ID',
    ]) {
      expect(screen.getByRole('checkbox', { name: label })).toBeTruthy();
    }
  });

  it('shows the visible plan properties and sends the values typed', async () => {
    const onSave = setup();
    expect(screen.queryByLabelText('Retired field')).toBeNull();
    type('Name', 'Fibre');
    type('Price (CAD)', '10');
    type('Data allowance', '100 GB');
    type('Carrier cost', '4.5');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ customValues: { custom_data: '100 GB', custom_cost: 450 } }),
    );
  });

  it('asks for a name and a price before saving', async () => {
    const onSave = setup();
    save();
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a name.');
    type('Name', 'Fibre');
    save();
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a price.');
    type('Price (CAD)', '12.345');
    save();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Enter the price in dollars, such as 19.99.',
    );
    type('Price (CAD)', '-1');
    save();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Enter the price in dollars, such as 19.99.',
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the reason a save was refused', async () => {
    const onSave = setup(
      undefined,
      vi.fn<Save>().mockResolvedValue('A plan with that name already exists for this type.'),
    );
    type('Name', 'Fibre');
    type('Price (CAD)', '10');
    save();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A plan with that name already exists for this type.',
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('PlanEditor when editing', () => {
  it('shows the saved plan, the price in dollars and the lead type locked in', () => {
    setup(bronze);
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Bronze');
    expect(screen.getByLabelText<HTMLInputElement>('Price (CAD)').value).toBe('25.00');
    expect(screen.getByLabelText<HTMLSelectElement>('Billing period').value).toBe('month');
    expect(
      screen.getByRole('checkbox', { name: 'Payment required' }).getAttribute('data-state'),
    ).toBe('checked');
    expect(screen.getByRole('checkbox', { name: 'Passport' }).getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Data allowance').value).toBe('10 GB');
  });

  it('sends the expected version and only what changed', async () => {
    const onSave = setup(bronze);
    type('Price (CAD)', '25.99');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ expectedVersion: 4, priceMinor: 2599 });
  });

  it('sends changed documents and clears a custom value with null', async () => {
    const onSave = setup(bronze);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Passport' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visa' }));
    type('Data allowance', '');
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      expectedVersion: 4,
      requiredDocuments: ['visa'],
      customValues: { custom_data: null },
    });
  });

  it('turns the plan off from the editor', async () => {
    const onSave = setup(bronze);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ expectedVersion: 4, active: false });
  });

  it('does not save when nothing changed', async () => {
    const onSave = setup(bronze);
    save();
    expect((await screen.findByRole('alert')).textContent).toBe('Nothing has changed.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps a document the list no longer offers so it is not dropped silently', () => {
    setup({ ...bronze, requiredDocuments: ['passport', 'sin_card'] });
    expect(screen.getByRole('checkbox', { name: 'Sin card' }).getAttribute('data-state')).toBe(
      'checked',
    );
  });
});
