import * as React from 'react';

import { cn } from '../lib/utils';

type EmptyStateProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  /** A lucide icon element, e.g. `<Inbox />`. Decorative: hidden from screen readers. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** One button or link, shown under the text. */
  action?: React.ReactNode;
};

/**
 * The one empty state: icon, a short headline, one muted line and at most one
 * action, centred. Use it instead of a lone grey sentence wherever a list,
 * pane or page has nothing to show.
 */
function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground [&_svg]:size-5"
        >
          {icon}
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export { EmptyState, type EmptyStateProps };
