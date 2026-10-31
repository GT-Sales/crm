'use client';

import { useState, type JSX } from 'react';
import type { FlowDefinition, FlowDraft, FlowRun } from '@gt-sales/contracts';
import { Button } from '@gt-sales/ui';
import Link from 'next/link';

import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { findStepById } from './canvas/draft-mutations';
import {
  describeStep,
  namesFromCode,
  runStatusText,
  stepKindLabel,
  stepOutcomeText,
  type FlowNames,
} from './flow-words';

/**
 * A flow's latest runs as the backend lists them (newest first, at most 50 per
 * page): the lead (linked to its record and named only for viewers with contact
 * access), the run's status in words, the version it ran, when it started, and
 * an expandable step-by-step outcome breakdown.
 */
export function AutomationRuns({
  workspaceSlug,
  runs,
  definition,
  names = namesFromCode(),
  nextBefore = null,
  loadingMore = false,
  onLoadMore,
}: {
  workspaceSlug: string;
  runs: readonly FlowRun[];
  definition?: FlowDefinition | FlowDraft | null;
  names?: FlowNames;
  nextBefore?: string | null;
  loadingMore?: boolean;
  onLoadMore?(): Promise<void> | void;
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string>();

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Recent runs" className="divide-y rounded-md border text-sm">
        {runs.map((run) => {
          const leadLabel = run.leadName ?? `Lead ${run.leadId.slice(0, 8)}`;
          const isExpanded = expandedId === run.id;
          return (
            <li key={run.id} className="flex flex-col gap-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  className="mr-auto font-medium underline"
                  href={`/w/${workspaceSlug}/leads/${run.leadId}`}
                >
                  {leadLabel}
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
                {run.steps.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-expanded={isExpanded}
                    aria-label={`Steps for ${leadLabel}`}
                    onClick={() => setExpandedId(isExpanded ? undefined : run.id)}
                  >
                    {isExpanded ? 'Hide steps' : `Steps (${run.steps.length})`}
                  </Button>
                ) : null}
              </div>

              {isExpanded && run.steps.length > 0 ? (
                <ol
                  aria-label={`Step outcomes for ${leadLabel}`}
                  className="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-2.5 text-xs"
                >
                  {run.steps.map((stepRun, index) => {
                    const found = definition
                      ? findStepById(definition.steps, stepRun.stepId)
                      : undefined;
                    const stepTitle = found
                      ? describeStep(found.step, names)
                      : stepKindLabel(stepRun.stepKind);
                    return (
                      <li
                        key={`${stepRun.stepId}:${index}`}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="font-medium">{stepTitle}</span>
                        <span className="text-muted-foreground">{stepOutcomeText(stepRun)}</span>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
      {nextBefore && onLoadMore ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loadingMore}
            onClick={() => void onLoadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
