'use client';

import { useSyncExternalStore } from 'react';
import { CheckCircle2Icon, CircleAlertIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { cn } from '@gt-sales/ui';

/**
 * Short confirmations after an action ("Archived 3 leads.", "Saved."), shown
 * in the bottom-right corner over the page instead of a line that pushes the
 * layout down. They close on their own; an error stays a little longer. A
 * message that must stay put (a secret shown once, a form's field error)
 * belongs on the page, not here.
 */
export type ToastTone = 'success' | 'warning' | 'error';

export interface ToastItem {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
}

const DURATION_MS: Readonly<Record<ToastTone, number>> = {
  success: 4_000,
  warning: 7_000,
  error: 8_000,
};
/** At most this many at once: the oldest goes first. */
const MAX_TOASTS = 3;

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(next: readonly ToastItem[]) {
  items = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  emit(items.filter((item) => item.id !== id));
}

/** Shows `text` in the corner; returns its id. */
export function toast(text: string, options: { tone?: ToastTone } = {}): number {
  const tone = options.tone ?? 'success';
  const id = nextId;
  nextId += 1;
  const kept = items.filter((item) => item.text !== text);
  const trimmed = kept.slice(Math.max(0, kept.length - (MAX_TOASTS - 1)));
  for (const gone of kept.filter((item) => !trimmed.includes(item))) dismissToast(gone.id);
  for (const same of items.filter((item) => item.text === text)) {
    const timer = timers.get(same.id);
    if (timer) clearTimeout(timer);
    timers.delete(same.id);
  }
  emit([...trimmed, { id, text, tone }]);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), DURATION_MS[tone]),
  );
  return id;
}

/** Every toast removed at once (tests, sign-out). */
export function clearToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  emit([]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => items;

const ICONS = {
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
} as const;

/** The corner the toasts appear in; mounted once, in the root layout. */
export function Toaster() {
  const shown = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {shown.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
          >
            <Icon
              aria-hidden="true"
              className={cn(
                'mt-0.5 size-4 shrink-0',
                item.tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
                item.tone === 'warning' && 'text-amber-600 dark:text-amber-400',
                item.tone === 'error' && 'text-destructive',
              )}
            />
            <p className="min-w-0 flex-1 break-words">{item.text}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissToast(item.id)}
              className="-m-1 rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
