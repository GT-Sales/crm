import type { ReactNode } from 'react';
import { Layers3Icon, WorkflowIcon, ListChecksIcon } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';

/** Shared staff entry layout; the forms retain their existing auth behavior. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className="grid min-h-svh outline-none lg:grid-cols-2">
      <aside className="hidden flex-col justify-between border-r bg-sidebar p-12 lg:flex">
        <div className="flex items-center gap-3 text-sm font-semibold">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-xs text-primary-foreground">
            GT
          </span>
          GT Sales CRM
        </div>
        <div className="flex max-w-md flex-col gap-6 py-12">
          <div>
            <p className="mb-3 text-sm text-muted-foreground">Your sales workspace</p>
            <p className="text-4xl font-semibold leading-tight tracking-tight">
              Every enquiry.
              <br />
              One place to follow through.
            </p>
          </div>
          <p className="text-muted-foreground">
            Work your sites’ leads, keep orders moving, and give every customer a clear next step.
          </p>
          <ul className="mt-3 flex flex-col gap-4 text-sm">
            {[
              { icon: Layers3Icon, label: 'One workspace for each website' },
              { icon: ListChecksIcon, label: 'Tasks and documents alongside each lead' },
              { icon: WorkflowIcon, label: 'Flows that keep follow-ups moving' },
            ].map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3">
                <span className="rounded-lg border bg-background p-2">
                  <Icon className="size-4 text-muted-foreground" />
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">GT Sales · Staff workspace</p>
      </aside>
      <section className="relative flex min-w-0 items-center justify-center px-6 py-20">
        <div className="absolute top-5 right-5">
          <ThemeToggle />
        </div>
        {children}
      </section>
    </main>
  );
}
