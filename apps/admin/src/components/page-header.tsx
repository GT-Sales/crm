import type { ReactNode } from 'react';

import { cn } from '@gt-sales/ui';

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons and controls shown at the right; they wrap under the title on phones. */
  actions?: ReactNode;
  className?: string;
};

/**
 * The one page header: the page's only `<h1>`, a muted line under it and the
 * page's main actions at the right. Use it instead of writing the heading by hand.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn('flex flex-wrap items-end justify-between gap-3', className)}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
