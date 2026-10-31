import type { JSX } from 'react';
import type { FlowRun } from '@gt-sales/contracts';
import Link from 'next/link';

import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { runStatusText } from './flow-words';

/**
 * A flow's latest runs as the backend lists them (newest first, at most 50):
 * the lead, linked to its record and named only for viewers with contact
 * access (otherwise "Lead" and the start of its id), the run's status in
 * words, the version it ran and when it started.
 */
export function AutomationRuns({
  workspaceSlug,
  runs,
}: {
  workspaceSlug: string;
  runs: readonly FlowRun[];
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
            {run.leadName ?? `Lead ${run.leadId.slice(0, 8)}`}
          </Link>
          <span>{runStatusText(run)}</span>
          {run.version === null ? null : (
            <span className="text-muted-foreground">Version {run.version}</span>
          )}
          <time
            className="text-muted-foreground"
            dateTime={run.startedAt}
            title={dateTimeLabel(run.startedAt)}
          >
            {relativeTime(run.startedAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}
