'use client';

import { useState, type JSX } from 'react';
import type { FlowDefinition, FlowDraft, FlowRun } from '@gt-sales/contracts';
import { CheckCircle2Icon, ClockIcon, AlertCircleIcon, MinusCircleIcon } from 'lucide-react';
import { Button, cn } from '@gt-sales/ui';
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
import { LoadingSkeleton } from '../crm/loading-skeleton';

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
  definitionVersion,
  onLoadRun,
  names = namesFromCode(),
  nextBefore = null,
  loadingMore = false,
  onLoadMore,
}: {
  workspaceSlug: string;
  runs: readonly FlowRun[];
  definition?: FlowDefinition | FlowDraft | null;
  definitionVersion?: number | null;
  onLoadRun?(run: FlowRun): Promise<{
    run: FlowRun;
    definition: FlowDefinition | FlowDraft | null;
  }>;
  names?: FlowNames;
  nextBefore?: string | null;
  loadingMore?: boolean;
  onLoadMore?(): Promise<void> | void;
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string>();
  const [details, setDetails] = useState<
    Record<string, { run: FlowRun; definition: FlowDefinition | FlowDraft | null }>
  >({});
  const [loadingId, setLoadingId] = useState<string>();
  const [loadErrorId, setLoadErrorId] = useState<string>();

  async function expand(run: FlowRun) {
    if (expandedId === run.id) {
      setExpandedId(undefined);
      return;
    }
    setExpandedId(run.id);
    if (!onLoadRun) return;
    setLoadingId(run.id);
    setLoadErrorId(undefined);
    try {
      const detail = await onLoadRun(run);
      setDetails((current) => ({ ...current, [run.id]: detail }));
    } catch {
      setLoadErrorId(run.id);
    } finally {
      setLoadingId((current) => (current === run.id ? undefined : current));
    }
  }

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Recent runs" className="divide-y rounded-md border text-sm">
        {runs.map((run) => {
          const detail = details[run.id];
          const shownRun = detail?.run ?? run;
          const runDefinition = detail
            ? detail.definition
            : run.version !== null && run.version === definitionVersion
              ? definition
              : undefined;
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
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium',
                    shownRun.status === 'failed'
                      ? 'border-destructive/30 text-destructive'
                      : shownRun.status === 'waiting'
                        ? 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200'
                        : '',
                  )}
                >
                  {shownRun.status === 'completed' ? (
                    <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                  ) : shownRun.status === 'waiting' ? (
                    <ClockIcon className="size-3.5" aria-hidden="true" />
                  ) : shownRun.status === 'failed' ? (
                    <AlertCircleIcon className="size-3.5" aria-hidden="true" />
                  ) : (
                    <MinusCircleIcon className="size-3.5" aria-hidden="true" />
                  )}
                  {runStatusText(shownRun)}
                </span>
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
                    onClick={() => void expand(run)}
                  >
                    {isExpanded ? 'Hide steps' : `Steps (${run.steps.length})`}
                  </Button>
                ) : null}
              </div>

              <div aria-label="Step statuses" className="flex flex-wrap gap-2 text-xs">
                {shownRun.steps.map((step, index) => (
                  <span key={`${step.stepId}:${index}`} className="rounded border px-2 py-0.5">
                    {stepKindLabel(step.stepKind)}: {stepOutcomeText(step)}
                  </span>
                ))}
              </div>

              {isExpanded && loadingId === run.id ? (
                <LoadingSkeleton label="Loading run…" variant="list" />
              ) : null}
              {isExpanded && loadErrorId === run.id ? (
                <p role="alert">
                  The run details could not be loaded. Close and reopen the steps to retry.
                </p>
              ) : null}

              {isExpanded && run.steps.length > 0 ? (
                <ol
                  aria-label={`Step outcomes for ${leadLabel}`}
                  className="automation-run-timeline flex flex-col gap-0 rounded-md border bg-muted/20 p-3 text-xs"
                >
                  {shownRun.steps.map((stepRun, index) => {
                    const found = runDefinition
                      ? findStepById(runDefinition.steps, stepRun.stepId)
                      : undefined;
                    const stepTitle = found
                      ? describeStep(found.step, names)
                      : stepKindLabel(stepRun.stepKind);
                    return (
                      <li
                        key={`${stepRun.stepId}:${index}`}
                        className="relative ml-3 flex flex-wrap items-start justify-between gap-2 border-l pb-4 pl-6 last:border-transparent last:pb-0"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute -left-3 top-0 flex size-6 items-center justify-center rounded-full border bg-card text-[10px]',
                            stepRun.outcome === 'failed' && 'text-destructive',
                            stepRun.outcome === 'waiting' && 'text-amber-800 dark:text-amber-200',
                          )}
                        >
                          {stepRun.outcome === 'done' ? (
                            <CheckCircle2Icon className="size-3.5" />
                          ) : stepRun.outcome === 'waiting' ? (
                            <ClockIcon className="size-3.5" />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <span className="min-w-0 flex-1 break-words font-medium">{stepTitle}</span>
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
