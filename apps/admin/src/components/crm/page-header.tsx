import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

const countFormat = new Intl.NumberFormat('en-CA');

/**
 * The 48px bar at the top of a CRM page: object icon, title and record count on
 * the left, page actions on the right.
 */
export function PageHeader({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-crm-header px-5 py-3">
      <h1 className="flex min-w-0 items-center gap-3 text-lg font-semibold tracking-tight text-foreground">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs">
          <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        </span>
        <span className="truncate">{title}</span>
        {count === undefined ? null : (
          <span className="font-normal text-muted-foreground">
            <span aria-hidden="true">· </span>
            <span>{countFormat.format(count)}</span>
          </span>
        )}
      </h1>
      {children ? <div className="ml-auto flex items-center gap-1">{children}</div> : null}
    </header>
  );
}
