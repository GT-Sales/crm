import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * Visually hidden until focused. Must be the first focusable element on the
 * page so keyboard and screen-reader users can bypass repeated nav to reach
 * the main content landmark.
 */
function SkipLink({
  className,
  href = '#main-content',
  children = 'Skip to main content',
  ...props
}: React.ComponentProps<'a'>) {
  return (
    <a
      href={href}
      data-slot="skip-link"
      className={cn(
        'sr-only z-50 rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground shadow-md focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}

export { SkipLink };
