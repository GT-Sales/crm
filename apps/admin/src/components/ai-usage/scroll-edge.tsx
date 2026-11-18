'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@gt-sales/ui';

/**
 * A table box that scrolls sideways on a narrow screen, with a soft fade on
 * its right edge while there is more to the right, so a phone shows that the
 * table goes on. The fade appears only while the content overflows and is not
 * scrolled to its end; it is decoration (`aria-hidden`), the table itself is
 * unchanged for a screen reader.
 */
export function ScrollEdge({ className, children }: { className?: string; children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (box === null) return;
    setMore(box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
  }, []);

  useEffect(() => {
    measure();
    const box = boxRef.current;
    if (box === null) return;
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure());
    observer?.observe(box);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  return (
    <div className="relative">
      <div
        ref={boxRef}
        data-overflowing={more || undefined}
        onScroll={measure}
        className={cn('overflow-x-auto rounded-lg border', className)}
      >
        {children}
      </div>
      {more ? (
        <div
          aria-hidden="true"
          data-testid="scroll-edge"
          className="pointer-events-none absolute inset-y-px right-px w-10 rounded-r-lg bg-gradient-to-l from-background to-transparent"
        />
      ) : null}
    </div>
  );
}
