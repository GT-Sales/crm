'use client';

import { Button, cn } from '@gt-sales/ui';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';

import type { StagePath } from '../../lib/stage-path';

/**
 * The lead's path as steps, where it stands, and the next step as one button.
 * The button makes the same move as the Stage menu, so a move that asks for
 * details (a courier, an activation date, documents) opens the same dialog;
 * what it will ask is said beside it before the click.
 */
export function StagePathBar({
  path,
  canWrite,
  saving,
  onMove,
  compact = false,
}: {
  path: StagePath;
  canWrite: boolean;
  saving: boolean;
  onMove(stage: string): void;
  compact?: boolean;
}) {
  const { next } = path;
  return (
    <section aria-label="Stage path" className="flex w-full flex-col gap-2">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
        {path.steps.map((step, index) => (
          <li key={step.key} className="flex items-center gap-1">
            {index > 0 ? <span aria-hidden="true" className="h-px w-3 bg-border sm:w-4" /> : null}
            <span
              aria-current={step.state === 'current' ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                step.state === 'current' &&
                  'border-primary bg-primary text-primary-foreground font-medium',
                step.state === 'done' && 'border-primary/30 bg-primary/10 text-foreground',
                step.state === 'upcoming' && 'border-border text-muted-foreground',
              )}
            >
              {step.state === 'done' ? <CheckIcon className="size-3" aria-hidden="true" /> : null}
              {step.label}
              {step.state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {path.offPath ? (
        <p className="text-xs text-muted-foreground">
          Now <span className="font-medium text-foreground">{path.offPath}</span>, off the main
          path. Use the Stage menu to move it back.
        </p>
      ) : null}
      {canWrite && next ? (
        <div className={cn('flex flex-wrap items-center gap-2', compact && 'text-xs')}>
          <Button type="button" size="sm" disabled={saving} onClick={() => onMove(next.key)}>
            Move to {next.label}
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </Button>
          {next.needs.length > 0 ? (
            <span
              className={cn(
                'text-xs',
                next.blocked ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground',
              )}
            >
              {`This ${next.needs.join(' and ')}.`}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
