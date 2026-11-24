'use client';

import { toast as sonner, Toaster as SonnerToaster } from '@gt-sales/ui';

/**
 * Short confirmations after an action ("Archived 3 leads.", "Saved."), shown
 * as shadcn/ui Sonner toasts in the bottom-left corner instead of a line that
 * pushes the page down. An action that takes a moment uses `toastPromise`:
 * one toast that says what is happening, then how it went. A message that
 * must stay put (a secret shown once, a form's field error) belongs on the
 * page, not here.
 */
export type ToastTone = 'success' | 'warning' | 'error';

/** Shows `text` in the corner; an error or a warning stays longer. */
export function toast(text: string, options: { tone?: ToastTone } = {}): void {
  switch (options.tone ?? 'success') {
    case 'error':
      sonner.error(text, { duration: 8_000 });
      return;
    case 'warning':
      sonner.warning(text, { duration: 7_000 });
      return;
    default:
      sonner.success(text);
  }
}

/**
 * One toast for an action that takes a moment: `loading` while `work` runs,
 * then `success` (from its result) or `error` (from what it threw). Returns
 * `work`, so the caller still awaits its own result.
 */
export function toastPromise<T>(
  work: Promise<T>,
  messages: {
    loading: string;
    success: string | ((result: T) => string);
    error: string | ((error: unknown) => string);
  },
): Promise<T> {
  sonner.promise(work, messages);
  return work;
}

/** Every toast removed at once (tests). */
export function clearToasts(): void {
  sonner.dismiss();
}

/** The corner the toasts appear in; mounted once, in the root layout. */
export function Toaster() {
  return <SonnerToaster position="bottom-left" closeButton visibleToasts={3} />;
}
