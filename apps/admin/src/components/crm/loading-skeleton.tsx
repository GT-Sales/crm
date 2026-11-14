import type { ReactNode } from 'react';
import { cn, Skeleton } from '@gt-sales/ui';

type LoadingLayout =
  | 'list'
  | 'table'
  | 'form'
  | 'record'
  | 'board'
  | 'dashboard'
  | 'report'
  | 'flow'
  | 'workspace'
  | 'preview';

function Lines({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="divide-y rounded-xl border">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className={index % 2 ? 'h-3.5 w-2/5' : 'h-3.5 w-3/5'} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function Heading() {
  return (
    <div aria-hidden="true" className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-6 w-40 max-w-full" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>
      <Skeleton className="h-9 w-24" />
    </div>
  );
}

function PropertyCard() {
  return (
    <div aria-hidden="true" className="space-y-6 rounded-2xl border bg-card p-6">
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="grid grid-cols-[1fr_1.6fr] gap-5">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className={index % 2 ? 'h-3.5 w-4/5' : 'h-3.5 w-full'} />
        </div>
      ))}
    </div>
  );
}

function FormLayout() {
  return (
    <>
      <Heading />
      <div aria-hidden="true" className="grid gap-6 rounded-2xl border bg-card p-5 sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-9 w-28 sm:col-span-2" />
      </div>
    </>
  );
}

function RecordLayout({ panel }: { panel: boolean }) {
  return (
    <>
      {panel ? (
        <div aria-hidden="true" className="flex gap-4 border-b pb-3">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-4 w-12" />
          ))}
        </div>
      ) : null}
      <div aria-hidden="true" className="space-y-4 border-b pb-4">
        <Skeleton className="h-7 w-3/5" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-28" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[0, 1].map((index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t pt-3">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <div className={cn('grid gap-4', !panel && 'lg:grid-cols-[1.6fr_1fr]')}>
        <div className="space-y-4">
          <PropertyCard />
          <PropertyCard />
        </div>
        {!panel ? (
          <div className="space-y-4">
            <PropertyCard />
            <Lines rows={3} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function BoardLayout() {
  return (
    <div aria-hidden="true" className="flex gap-3 overflow-hidden">
      {Array.from({ length: 4 }, (_, column) => (
        <div key={column} className="w-80 shrink-0 space-y-3 rounded-2xl border bg-sidebar p-3">
          <div className="flex items-center gap-2 py-2">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-6" />
          </div>
          {Array.from({ length: column % 2 ? 3 : 5 }, (_, row) => (
            <div key={row} className="space-y-3 rounded-md border bg-background p-3">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
              <div className="flex justify-between">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-12" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Metrics() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-2 gap-5 rounded-2xl border bg-card p-5 lg:grid-cols-4"
    >
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="space-y-3">
          <Skeleton className="h-3.5 w-24 max-w-full" />
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

function Chart() {
  return (
    <div aria-hidden="true" className="space-y-5 rounded-2xl border bg-card p-6">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="h-8 w-20" />
      <div className="flex h-44 items-end gap-3 border-b border-l px-3 pt-3">
        {[40, 65, 45, 80, 55, 90, 70, 85].map((height, index) => (
          <Skeleton
            key={index}
            className="min-w-0 flex-1 rounded-b-none"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

function DashboardLayout({ children }: { children?: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className="flex gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-40" />
      </div>
      <Metrics />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Chart />
        {children ?? <Lines rows={5} />}
        <PropertyCard />
        <Chart />
      </div>
    </>
  );
}

/** Screen-shaped placeholders: one spoken status, decorative shapes, no fake controls. */
export function LoadingSkeleton({
  label = 'Loading…',
  variant = 'list',
  rows = 4,
  panel = false,
  className,
  children,
}: {
  label?: string;
  variant?: LoadingLayout;
  rows?: number;
  panel?: boolean;
  className?: string;
  /** Dashboard follow-ups keep loading independently of its statistics. */
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="loading-skeleton"
      data-layout={variant}
      className={cn('min-w-0 space-y-5', className)}
    >
      <span className="sr-only">{label}</span>
      {variant === 'list' ? <Lines rows={rows} /> : null}
      {variant === 'table' ? (
        <>
          <div aria-hidden="true" className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-8 w-28" />
            <div className="ml-auto flex items-center gap-2">
              <Skeleton className="h-8 w-56 max-w-[40vw] rounded-full" />
              <Skeleton className="h-8 w-20 rounded-full" />
              <Skeleton className="h-8 w-20 rounded-full" />
            </div>
          </div>
          <TableSkeleton />
        </>
      ) : null}
      {variant === 'preview' ? (
        <div aria-hidden="true" className="min-h-[32rem] space-y-7 rounded-xl border p-6">
          <Skeleton className="mx-auto h-10 w-32" />
          <Skeleton className="h-6 w-3/4" />
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className={index === 4 ? 'h-3 w-2/3' : 'h-3 w-full'} />
            ))}
          </div>
          <Skeleton className="mx-auto h-10 w-40" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ) : null}
      {variant === 'form' ? <FormLayout /> : null}
      {variant === 'record' ? <RecordLayout panel={panel} /> : null}
      {variant === 'board' ? <BoardLayout /> : null}
      {variant === 'dashboard' ? <DashboardLayout>{children}</DashboardLayout> : null}
      {variant === 'report' ? (
        <>
          <Metrics />
          <Lines rows={6} />
        </>
      ) : null}
      {variant === 'flow' ? (
        <>
          <Heading />
          <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
            <div
              className="flex min-h-96 flex-col items-center justify-center gap-6 rounded-2xl border bg-muted/10"
              aria-hidden="true"
            >
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-20 w-56 max-w-[80%] rounded-xl border" />
              ))}
            </div>
            <PropertyCard />
          </div>
        </>
      ) : null}
      {variant === 'workspace' ? (
        <div className="flex min-h-screen gap-6">
          <div
            aria-hidden="true"
            className="hidden w-60 shrink-0 space-y-7 border-r bg-sidebar p-5 md:block"
          >
            <Skeleton className="h-8 w-full" />
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} className="h-5 w-4/5" />
            ))}
          </div>
          <div className="min-w-0 flex-1 space-y-6 p-5">
            <Heading />
            <DashboardLayout />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Stays in the real table so its actual headers and visible columns keep their alignment. */
export function TableRowsSkeleton({ columns, rows = 7 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden="true" className="border-b last:border-0">
          {Array.from({ length: columns }, (_, column) => (
            <td key={column} className="px-3 py-4">
              <Skeleton
                className={cn('h-3.5', column === 0 ? 'w-32' : column % 2 ? 'w-16' : 'w-20')}
              />
              {column === 0 ? <Skeleton className="mt-2 h-3 w-40" /> : null}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A whole table's shape, for a list whose columns are not known yet. */
export function TableSkeleton({ columns = 6, rows = 7 }: { columns?: number; rows?: number }) {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border">
      <table className="w-full">
        <thead>
          <tr className="border-b">
            {Array.from({ length: columns }, (_, column) => (
              <th key={column} className="px-3 py-3 text-left">
                <Skeleton className="h-3 w-14" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <TableRowsSkeleton columns={columns} rows={rows} />
        </tbody>
      </table>
    </div>
  );
}

/** Where the dashboard's date and filter controls will be, so the skeleton under it never moves. */
export function DashboardFiltersSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-9 items-center gap-2">
      <Skeleton className="h-9 w-72 max-w-[60%]" />
      <Skeleton className="h-9 w-24" />
    </div>
  );
}
