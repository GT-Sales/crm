import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './select';

/**
 * jsdom has no `ResizeObserver` (Radix measures the trigger/content), and no
 * pointer-capture or `scrollIntoView` implementations, all of which Radix Select
 * touches while opening and highlighting items. Shimming exactly those APIs lets
 * a real open-and-select interaction run.
 */
class ResizeObserverStub {
  observe = (): void => undefined;
  unobserve = (): void => undefined;
  disconnect = (): void => undefined;
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

function renderProvinceSelect(onValueChange?: (value: string) => void): HTMLElement {
  render(
    <Select onValueChange={onValueChange}>
      <SelectTrigger aria-label="Province" size="sm">
        <SelectValue placeholder="Choose a province" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Provinces</SelectLabel>
          <SelectItem value="on">Ontario</SelectItem>
          <SelectItem value="bc">British Columbia</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>,
  );

  return screen.getByRole('combobox', { name: 'Province' });
}

describe('Select', () => {
  it('renders a closed combobox trigger showing the placeholder', () => {
    const trigger = renderProvinceSelect();

    expect(trigger.getAttribute('data-slot')).toBe('select-trigger');
    expect(trigger.getAttribute('data-size')).toBe('sm');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('Choose a province');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('opens on pointer down and reports the chosen item', async () => {
    const onValueChange = vi.fn();
    const trigger = renderProvinceSelect(onValueChange);

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
      clientX: 0,
      clientY: 0,
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const option = await screen.findByRole('option', { name: 'British Columbia' });

    // A real click travels onto the item: Radix ignores a release that stays
    // within 10px of the opening pointer down, so move first (jsdom computes
    // pageX/pageY from clientX/clientY).
    fireEvent.pointerMove(option, { pointerType: 'mouse', clientX: 40, clientY: 40 });
    fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(option, { pointerType: 'mouse', clientX: 40, clientY: 40 });

    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith('bc'));
    expect(trigger.textContent).toContain('British Columbia');
    expect(screen.queryByRole('option')).toBeNull();
  });
});
