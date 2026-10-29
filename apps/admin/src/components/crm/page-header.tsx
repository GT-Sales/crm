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
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-crm-header px-3">
      <h1 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-foreground">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
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
