import type { MouseEvent } from 'react';

/** A plain click on a link (not a new tab or window), which the page may handle itself. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
