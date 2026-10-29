import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { codePropertyCatalog, type PropertyLayout, type SiteProperty } from '@gt-sales/contracts';

import { LayoutEditor } from './layout-editor';
import { catalogFromModel } from './use-property-model';

const referral: SiteProperty = {
  key: 'custom_referral',
  label: 'Referral code',
  kind: 'text',
  origin: 'custom',
  storage: 'custom',
  sensitive: false,
  staffOnly: false,
  hidden: false,
  leadTypes: [],
  editable: true,
  version: 1,
};

// Partner applications carry company, businessType, country, website, volume and message.
const catalog = catalogFromModel([...codePropertyCatalog.all, referral]);

const initial: PropertyLayout = {
  sections: [
    { id: 'request', label: 'Request', keys: ['company', 'businessType', 'country'] },
    { id: 'extra', label: 'Extra', keys: ['website'] },
  ],
};

type SaveLayout = (layout: PropertyLayout) => Promise<string | undefined>;
const saver = () => vi.fn<SaveLayout>().mockResolvedValue(undefined);

function setup(onSave = saver(), layout = initial) {
  render(
    <LayoutEditor
      leadType="partner_application"
      initial={layout}
      catalog={catalog}
      onSave={onSave}
    />,
  );
  return onSave;
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

describe('LayoutEditor', () => {
  it('moves a property up and down within its section by button', async () => {
    const onSave = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move Business type up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Company down' }));
    expect(
      screen.getByRole('button', { name: 'Move Business type up' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Company down' }).hasAttribute('disabled')).toBe(
      true,
    );
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      sections: [
        { id: 'request', label: 'Request', keys: ['businessType', 'country', 'company'] },
        { id: 'extra', label: 'Extra', keys: ['website'] },
      ],
    });
  });

  it('moves a property to another section with the section selector', async () => {
    const onSave = setup();
    fireEvent.change(screen.getByLabelText('Section for Company'), { target: { value: 'extra' } });
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      sections: [
        { id: 'request', label: 'Request', keys: ['businessType', 'country'] },
        { id: 'extra', label: 'Extra', keys: ['website', 'company'] },
      ],
    });
  });

  it('lists visible properties that are not placed and adds one to a section', async () => {
    const onSave = setup();
    const unplaced = screen.getByRole('list', { name: 'Not in the layout' });
    expect(
      within(unplaced)
        .getAllByRole('listitem')
        .map((item) => item.textContent?.split('Add')[0]),
    ).toEqual(['Expected volume', 'Message', 'Referral code']);

    fireEvent.click(screen.getByRole('button', { name: 'Add Referral code to Extra' }));
    expect(screen.queryByRole('button', { name: 'Add Referral code to Extra' })).toBeNull();
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      sections: [
        { id: 'request', label: 'Request', keys: ['company', 'businessType', 'country'] },
        { id: 'extra', label: 'Extra', keys: ['website', 'custom_referral'] },
      ],
    });
  });

  it('returns a property to the unplaced list when it is removed from the layout', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Website from layout' }));
    const unplaced = screen.getByRole('list', { name: 'Not in the layout' });
    expect(within(unplaced).getByText('Website')).toBeTruthy();
  });

  it('adds, renames and reorders sections', async () => {
    const onSave = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    fireEvent.change(screen.getByLabelText('Section 3 name'), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Billing section up' }));
    fireEvent.change(screen.getByLabelText('Section 1 name'), { target: { value: 'Details' } });
    expect(screen.getByLabelText<HTMLInputElement>('Section 2 name').value).toBe('Billing');

    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      sections: [
        { id: 'request', label: 'Details', keys: ['company', 'businessType', 'country'] },
        { id: expect.stringMatching(/^section_[0-9a-f]{32}$/), label: 'Billing', keys: [] },
        { id: 'extra', label: 'Extra', keys: ['website'] },
      ],
    });
  });

  it('removes an empty section but not one that still holds properties', () => {
    setup();
    expect(
      screen.getByRole('button', { name: 'Remove Extra section' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove New section section' }));
    expect(screen.queryByLabelText('Section 3 name')).toBeNull();
  });

  it('moves a property by dragging it onto another and onto a section', async () => {
    const onSave = setup();
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
    };
    const company = screen.getByText('Company').closest('li');
    const country = screen.getByText('Country').closest('li');
    const extra = screen.getByLabelText('Section 2 name').closest('section');
    if (!company || !country || !extra) throw new Error('layout rows not found');

    fireEvent.dragStart(company, { dataTransfer });
    fireEvent.drop(country, { dataTransfer });
    store.clear();
    fireEvent.dragStart(country, { dataTransfer });
    fireEvent.drop(extra, { dataTransfer });

    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      sections: [
        { id: 'request', label: 'Request', keys: ['businessType', 'company'] },
        { id: 'extra', label: 'Extra', keys: ['website', 'country'] },
      ],
    });
  });

  it('says when the layout was saved and shows the reason when it was not', async () => {
    const onSave = saver();
    onSave.mockResolvedValueOnce('Someone else changed this layout.');
    setup(onSave);
    save();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Someone else changed this layout.',
    );
    save();
    expect((await screen.findByRole('status')).textContent).toContain('Layout saved.');
  });

  it('refuses a section without a name', () => {
    const onSave = setup();
    fireEvent.change(screen.getByLabelText('Section 1 name'), { target: { value: '  ' } });
    save();
    expect(screen.getByRole('alert').textContent).toContain('Give every section a name.');
    expect(onSave).not.toHaveBeenCalled();
  });
});
