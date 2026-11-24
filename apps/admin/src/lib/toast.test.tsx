import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { toast, toastPromise } from './toast';

// The setup file mounts the Toaster once, as the root layout does.
describe('toast', () => {
  it('shows a confirmation and closes it with the close button', async () => {
    act(() => toast('Archived 1 lead.'));
    const shown = await screen.findByText('Archived 1 lead.');
    const item = shown.closest('[data-sonner-toast]');
    expect(item?.getAttribute('data-type')).toBe('success');
    const close = item?.querySelector('[data-close-button]');
    if (!close) throw new Error('no close button');
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByText('Archived 1 lead.')).toBeNull());
  });

  it('marks an error and a warning by their tone', async () => {
    act(() => {
      toast('Could not save.', { tone: 'error' });
      toast('Archived 1 of 2.', { tone: 'warning' });
    });
    const tone = async (text: string) =>
      (await screen.findByText(text)).closest('[data-sonner-toast]')?.getAttribute('data-type');
    expect(await tone('Could not save.')).toBe('error');
    expect(await tone('Archived 1 of 2.')).toBe('warning');
  });

  it('says what is happening while an action runs, then how it went', async () => {
    let finish: (value: number) => void = () => undefined;
    const work = new Promise<number>((resolve) => {
      finish = resolve;
    });
    act(() => {
      void toastPromise(work, {
        loading: 'Archiving 3 leads…',
        success: (count) => `Archived ${String(count)} leads.`,
        error: 'Not archived.',
      });
    });
    expect(await screen.findByText('Archiving 3 leads…')).toBeTruthy();
    await act(async () => {
      finish(3);
      await work;
    });
    expect(await screen.findByText('Archived 3 leads.')).toBeTruthy();
    expect(screen.queryByText('Archiving 3 leads…')).toBeNull();
  });

  it('turns a failed action into its error', async () => {
    const work = Promise.reject(new Error('offline'));
    act(() => {
      toastPromise(work, {
        loading: 'Saving…',
        success: 'Saved.',
        error: (error) => `Not saved: ${error instanceof Error ? error.message : ''}`,
      }).catch(() => undefined);
    });
    expect(await screen.findByText('Not saved: offline')).toBeTruthy();
  });
});
