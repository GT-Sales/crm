import type { JSX } from 'react';
import type { AutomationRun } from '@gt-sales/contracts';
import Link from 'next/link';

import { dateTimeLabel, relativeTime } from '../../lib/dates';

const SKIP_REASONS: Readonly<Record<NonNullable<AutomationRun['reason']>, string>> = {
  no_sender: 'no sender',
  no_customer_email: 'no customer email',
  missing_fill_in: 'missing fill-ins',
};

function outcomeLabel(run: AutomationRun): string {
  if (run.outcome === 'queued') return 'Queued';
  return run.reason === null ? 'Skipped' : `Skipped: ${SKIP_REASONS[run.reason]}`;
}

/**
 * A rule's latest runs as the backend lists them (newest first, at most 50):
 * the lead, linked to its record and named only for viewers with contact
 * access, whether the email was queued or why it was skipped, and when.
 */
export function AutomationRuns({
  workspaceSlug,
  runs,
}: {
  workspaceSlug: string;
  runs: AutomationRun[];
}): JSX.Element {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }
  return (
    <ol aria-label="Recent runs" className="divide-y rounded-md border text-sm">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <Link
            className="mr-auto font-medium underline"
            href={`/w/${workspaceSlug}/leads/${run.leadId}`}
          >
            {run.leadName ?? 'Open lead'}
          </Link>
          <span>{outcomeLabel(run)}</span>
          <time
            className="text-muted-foreground"
            dateTime={run.createdAt}
            title={dateTimeLabel(run.createdAt)}
          >
            {relativeTime(run.createdAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}
