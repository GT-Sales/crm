import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PropertyValue, SiteProperty } from '@gt-sales/contracts';

import { PropertyValueControl, PropertyValueText } from './property-value';

function property(overrides: Partial<SiteProperty> & Pick<SiteProperty, 'kind'>): SiteProperty {
  return {
    key: 'custom_thing',
    label: 'Thing',
    origin: 'custom',
    storage: 'custom',
    sensitive: false,
    staffOnly: false,
    hidden: false,
    websiteVisible: false,
    leadTypes: [],
    editable: true,
    ...overrides,
  };
}

const plan = property({
  kind: 'choice',
  options: [
    { value: 'basic', label: 'Basic', hidden: false },
    { value: 'legacy', label: 'Legacy', hidden: true },
  ],
});

describe('PropertyValueText', () => {
  it('formats money from cents', () => {
    render(<PropertyValueText property={{ kind: 'money' }} value={1999} />);
    expect(screen.getByText('$19.99')).toBeTruthy();
  });

  it('links a url in a new tab without a referrer and an email with mailto', () => {
    const { rerender } = render(
      <PropertyValueText property={{ kind: 'url' }} value="https://example.com/a" />,
    );
    const link = screen.getByRole('link', { name: 'https://example.com/a' });
    expect(link.getAttribute('href')).toBe('https://example.com/a');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.getAttribute('target')).toBe('_blank');

    rerender(<PropertyValueText property={{ kind: 'email' }} value="ana@example.com" />);
    expect(screen.getByRole('link', { name: 'ana@example.com' }).getAttribute('href')).toBe(
      'mailto:ana@example.com',
    );
  });

  it('never links a url that is not http(s), and shows a dash for no value', () => {
    const { rerender } = render(
      <PropertyValueText property={{ kind: 'url' }} value="javascript:alert(1)" />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy();

    rerender(<PropertyValueText property={{ kind: 'text' }} value={undefined} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('reads a choice by its label', () => {
    render(<PropertyValueText property={plan} value="legacy" />);
    expect(screen.getByText('Legacy')).toBeTruthy();
  });
});

function Controlled({
  of,
  initial,
  onChange,
}: {
  of: SiteProperty;
  initial: PropertyValue | undefined;
  onChange(value: PropertyValue | null): void;
}) {
  const [value, setValue] = useState<PropertyValue | undefined>(initial);
  return (
    <>
      <label htmlFor="field">Value</label>
      <PropertyValueControl
        id="field"
        property={of}
        value={value}
        onChange={(next) => {
          setValue(next ?? undefined);
          onChange(next);
        }}
      />
    </>
  );
}

describe('PropertyValueControl', () => {
  it('takes money in dollars and gives cents', () => {
    const onChange = vi.fn();
    render(<Controlled of={property({ kind: 'money' })} initial={1999} onChange={onChange} />);
    const input = screen.getByLabelText('Value');
    expect(input.getAttribute('type')).toBe('number');
    expect(input).toHaveProperty('value', '19.99');
    fireEvent.change(input, { target: { value: '25.5' } });
    expect(onChange).toHaveBeenLastCalledWith(2550);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('offers a retired choice only while it is the current value', () => {
    const { unmount } = render(<Controlled of={plan} initial="legacy" onChange={vi.fn()} />);
    const options = () =>
      Array.from(screen.getByLabelText('Value').querySelectorAll('option')).map(
        (option) => option.textContent,
      );
    expect(options()).toEqual(['—', 'Basic', 'Legacy (retired)']);
    unmount();

    const onChange = vi.fn();
    render(<Controlled of={plan} initial={undefined} onChange={onChange} />);
    expect(options()).toEqual(['—', 'Basic']);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'basic' } });
    expect(onChange).toHaveBeenLastCalledWith('basic');
  });

  it('gives a yes/no as a boolean and a cleared one as null', () => {
    const onChange = vi.fn();
    render(<Controlled of={property({ kind: 'yesNo' })} initial={undefined} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'false' } });
    expect(onChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('uses the input type of the kind and a textarea for long text', () => {
    const { rerender } = render(
      <PropertyValueControl
        id="field"
        property={property({ kind: 'url' })}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    const typeOf = () => document.getElementById('field')?.getAttribute('type');
    expect(typeOf()).toBe('url');
    for (const [kind, type] of [
      ['email', 'email'],
      ['phone', 'tel'],
      ['date', 'date'],
      ['number', 'number'],
      ['text', 'text'],
    ] as const) {
      rerender(
        <PropertyValueControl
          id="field"
          property={property({ kind })}
          value={undefined}
          onChange={vi.fn()}
        />,
      );
      expect(typeOf()).toBe(type);
    }
    rerender(
      <PropertyValueControl
        id="field"
        property={property({ kind: 'longText' })}
        value="Line one"
        onChange={vi.fn()}
      />,
    );
    expect(document.getElementById('field')?.tagName).toBe('TEXTAREA');
  });
});
