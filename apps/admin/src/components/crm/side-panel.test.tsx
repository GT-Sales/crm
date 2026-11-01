import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidePanel } from './side-panel';

// React's jsdom event detection can use the prefixed transition event.
function finishAnimation(element: HTMLElement) {
  fireEvent.transitionEnd(element);
  fireEvent(element, new Event('webkitTransitionEnd', { bubbles: true }));
}

describe('SidePanel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders nothing while closed', () => {
    render(
      <SidePanel open={false} title="Lead details" onClose={vi.fn()}>
        <p>Details</p>
      </SidePanel>,
    );
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('opens with the title as its accessible name and takes focus', () => {
    render(
      <SidePanel open title="Lead details" onClose={vi.fn()}>
        <p>Details</p>
      </SidePanel>,
    );
    const panel = screen.getByRole('complementary', { name: 'Lead details' });
    expect(panel.textContent).toContain('Details');
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('takes focus without scrolling the page', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      render(
        <SidePanel open title="Lead details" onClose={vi.fn()}>
          <p>Details</p>
        </SidePanel>,
      );
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
  });

  it('finishes sliding out before closing and ignores repeated close requests', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead details" onClose={onClose}>
        <p>Details</p>
      </SidePanel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('complementary').getAttribute('data-state')).toBe('closed');
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    finishAnimation(screen.getByRole('complementary'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape that an inner control already handled alone', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead details" onClose={onClose}>
        <button type="button" onKeyDown={(event) => event.preventDefault()}>
          Inner
        </button>
      </SidePanel>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Inner' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open on an Escape typed in a field, so a draft is kept', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead details" onClose={onClose}>
        <label>
          Note
          <textarea defaultValue="Called, will" />
        </label>
        <label>
          Phone
          <input defaultValue="604" />
        </label>
        <label>
          Stage
          <select defaultValue="new">
            <option value="new">New</option>
          </select>
        </label>
        <div contentEditable suppressContentEditableWarning data-testid="rich">
          <span data-testid="rich-child">Draft</span>
        </div>
        <button type="button">Save</button>
      </SidePanel>,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Phone' }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Stage' }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('rich-child'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveProperty('value', 'Called, will');

    // Outside a field, Escape still closes.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    finishAnimation(screen.getByRole('complementary'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('finishes closing even when the browser sends no animation-end event', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead" onClose={onClose}>
        <p>Details</p>
      </SidePanel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(onClose).toHaveBeenCalledTimes(1);
    finishAnimation(screen.getByRole('complementary'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close a different lead opened during the exit animation', () => {
    const onClose = vi.fn();
    const view = render(
      <SidePanel open title="Lead" recordKey="first" onClose={onClose}>
        <p>First</p>
      </SidePanel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    view.rerender(
      <SidePanel open title="Lead" recordKey="second" onClose={onClose}>
        <p>Second</p>
      </SidePanel>,
    );
    expect(screen.getByRole('complementary').getAttribute('data-state')).toBe('open');
    finishAnimation(screen.getByRole('complementary'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes immediately when reduced motion is preferred', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead" onClose={onClose}>
        <p>Details</p>
      </SidePanel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders header actions beside the close button', () => {
    render(
      <SidePanel
        open
        title="Lead details"
        onClose={vi.fn()}
        actions={<button type="button">Open full page</button>}
      >
        <p>Details</p>
      </SidePanel>,
    );
    expect(screen.getByRole('button', { name: 'Open full page' })).toBeTruthy();
  });

  it('becomes a dialog sheet on a phone', () => {
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(
      <SidePanel open title="Lead details" onClose={vi.fn()}>
        <p>Details</p>
      </SidePanel>,
    );
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Lead details' })).toBeTruthy();
  });

  it('keeps the phone sheet open on an Escape typed in a field and closes it otherwise', () => {
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead details" onClose={onClose}>
        <label>
          Note
          <textarea defaultValue="Called, will" />
        </label>
        <button type="button">Save</button>
      </SidePanel>,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
