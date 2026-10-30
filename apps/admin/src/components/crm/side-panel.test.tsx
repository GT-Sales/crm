import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidePanel } from './side-panel';

describe('SidePanel', () => {
  afterEach(() => {
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
    render(
      <SidePanel open title="Lead details" onClose={vi.fn()}>
        <p>Details</p>
      </SidePanel>,
    );
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('closes from its button and from the Escape key', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open title="Lead details" onClose={onClose}>
        <p>Details</p>
      </SidePanel>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
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
