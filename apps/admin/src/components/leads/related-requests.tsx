import Link from 'next/link';
import { leadTypeLabel, type RelatedLead } from '@gt-sales/contracts';
import { Card, CardContent } from '@gt-sales/ui';

import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { StageBadge } from './lead-display';

/**
 * The same person's other requests on this site, newest first, so whoever
 * calls them sees the whole picture: a second form, an earlier one already
 * won, a duplicate in the archive. Nothing shows when there are none.
 */
export function RelatedRequests({
  workspaceSlug,
  related,
}: {
  workspaceSlug: string;
  related: readonly RelatedLead[];
}) {
  if (related.length === 0) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Other requests from this person</h2>
        <ul className="flex flex-col divide-y" aria-label="Other requests from this person">
          {related.map((entry) => (
            <li key={entry.id}>
              <Link
                href={`/w/${workspaceSlug}/leads/${entry.id}`}
                className="flex items-center justify-between gap-3 py-2 text-sm underline-offset-2 hover:underline"
              >
                <span className="font-medium">{leadTypeLabel(entry.leadType)}</span>
                <span className="flex items-center gap-2">
                  {entry.deletedAt ? (
                    <span className="text-xs text-muted-foreground">In archive</span>
                  ) : (
                    <StageBadge leadType={entry.leadType} stage={entry.stage} />
                  )}
                  <time
                    dateTime={entry.createdAt}
                    title={dateTimeLabel(entry.createdAt)}
                    className="text-xs text-muted-foreground"
                  >
                    {relativeTime(entry.createdAt)}
                  </time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
