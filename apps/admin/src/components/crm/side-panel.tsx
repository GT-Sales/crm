'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { AssistantTrigger } from '../ai/assistant-trigger';
import { cn, Sheet, SheetContent, SheetTitle, useIsMobile } from '@gt-sales/ui';

/** A field where Escape may be part of typing: the panel must not close (and drop a draft) from it. */
const EDITING_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

const OPEN_MS = 420;
const CLOSE_MS = 360;

function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITING_SELECTOR) !== null;
}

/**
 * The record side panel: on a computer it opens beside the list and
 * pushes it over, so the list stays visible; on a phone it becomes a
 * full-screen sheet. Escape and the × button close it; Escape typed in a
 * field (input, textarea, select, contenteditable) does not, so a half-written
 * note or edit is never lost. Focus moves into the
 * panel when it opens; the caller returns focus to the list when it closes.
 */
export function SidePanel({
  open,
  title,
  onClose,
  actions,
  recordKey,
  padded = true,
  children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  /** Extra header buttons, e.g. "Open full page". */
  actions?: ReactNode;
  /** A newly selected record cancels a close animation still in progress. */
  recordKey?: string;
  /** Tabbed records supply their own content padding beneath the fixed header. */
  padded?: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLElement>(null);
  const [closing, setClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const identity = recordKey ?? title;
  const closingRecord = useRef<string | undefined>(undefined);
  const closeCallback = useRef(onClose);

  useLayoutEffect(() => {
    closeCallback.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    if (!open || isMobile) {
      // The component stays mounted between records. Prepare the closed state
      // before the next DOM mount, rather than briefly mounting at full width
      // and starting a reversed transition when focus forces layout.
      setEntered(false);
      return;
    }
    setEntered(false);
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [open, isMobile]);
  useEffect(() => {
    closingRecord.current = undefined;
    setClosing(false);
  }, [open, identity]);

  const finishClose = useCallback(() => {
    if (closingRecord.current !== identity) return;
    closingRecord.current = undefined;
    closeCallback.current();
  }, [identity]);

  const requestClose = useCallback(() => {
    if (closing) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      closeCallback.current();
      return;
    }
    closingRecord.current = identity;
    setClosing(true);
  }, [closing, identity]);

  // Motion completion is the normal path; the timer also handles a browser
  // suppressing motion or an interrupted completion event.
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(finishClose, CLOSE_MS + 80);
    return () => window.clearTimeout(timer);
  }, [closing, finishClose]);

  useEffect(() => {
    // Without preventScroll the browser scrolls a panel taller than what is
    // left of the viewport into view, pushing the page header out of sight.
    if (open && !isMobile) panelRef.current?.focus({ preventScroll: true });
  }, [open, isMobile, title]);

  // Escape closes the panel wherever focus is, unless focus is in a field or
  // a dialog or menu already used it (Radix marks the key event handled when
  // it dismisses a layer).
  useEffect(() => {
    if (!open || isMobile || closing) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented && !isEditingTarget(event.target)) {
        requestClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isMobile, closing, requestClose]);

  if (!open) return null;

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-crm-header px-3">
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
      {actions}
      {isMobile ? <AssistantTrigger /> : null}
      <button
        type="button"
        aria-label="Close panel"
        className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={requestClose}
        disabled={closing}
      >
        <XIcon aria-hidden="true" className="size-4" />
      </button>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={!closing} onOpenChange={(next) => (next ? undefined : requestClose())}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full gap-0 p-0 sm:max-w-full"
          style={{ animationDuration: `${closing ? CLOSE_MS : OPEN_MS}ms` }}
          inert={closing}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) finishClose();
          }}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (isEditingTarget(event.target)) event.preventDefault();
          }}
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          {header}
          <div className={cn('min-h-0 flex-1 overflow-y-auto', padded && 'p-3')}>{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="crm-lead-panel-slot"
      data-state={closing ? 'closed' : 'open'}
      data-entered={entered}
      style={{ transitionDuration: `${closing ? CLOSE_MS : OPEN_MS}ms` }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget) finishClose();
      }}
    >
      <aside
        ref={panelRef}
        tabIndex={-1}
        aria-label={title}
        data-state={closing ? 'closed' : 'open'}
        inert={closing}
        style={{ transitionDuration: `${closing ? CLOSE_MS : OPEN_MS}ms` }}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget) finishClose();
        }}
        className="crm-lead-panel absolute inset-y-0 right-0 flex w-[560px] max-w-[50vw] shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-background outline-none"
      >
        {header}
        <div className={cn('min-h-0 flex-1 overflow-y-auto', padded && 'p-3')}>{children}</div>
      </aside>
    </div>
  );
}
