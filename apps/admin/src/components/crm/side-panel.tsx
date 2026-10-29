'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, useIsMobile } from '@gt-sales/ui';

/** A field where Escape may be part of typing: the panel must not close (and drop a draft) from it. */
const EDITING_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

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
  children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  /** Extra header buttons, e.g. "Open full page". */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open && !isMobile) panelRef.current?.focus();
  }, [open, isMobile, title]);

  // Escape closes the panel wherever focus is, unless focus is in a field or
  // a dialog or menu already used it (Radix marks the key event handled when
  // it dismisses a layer).
  useEffect(() => {
    if (!open || isMobile) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented && !isEditingTarget(event.target)) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isMobile, onClose]);

  if (!open) return null;

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-crm-header px-3">
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
      {actions}
      <button
        type="button"
        aria-label="Close panel"
        className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClose}
      >
        <XIcon aria-hidden="true" className="size-4" />
      </button>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full gap-0 p-0 sm:max-w-full"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (isEditingTarget(event.target)) event.preventDefault();
          }}
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          {header}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label={title}
      className="flex w-[560px] max-w-[50vw] shrink-0 flex-col border-l border-border bg-background outline-none"
    >
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </aside>
  );
}
