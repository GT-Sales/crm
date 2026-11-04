'use client';

import type { FlowDefinition, FlowDraft, FlowIssue } from '@gt-sales/contracts';
import { CheckIcon, CircleIcon, ArrowRightIcon } from 'lucide-react';
import { cn } from '@gt-sales/ui';
import { layoutFlow, type FlowCanvasNode } from './canvas/layout-flow';
import type { FlowNames } from './flow-words';

/** A navigation aid, not a claim that a flow has been tested or published. */
export function FlowSetup({
  definition,
  names,
  issues,
  selectedId,
  onSelect,
  onReview,
  canReview,
}: {
  definition: FlowDefinition | FlowDraft;
  names: FlowNames;
  issues: readonly FlowIssue[];
  selectedId?: string;
  onSelect(id: string): void;
  onReview(): void;
  canReview: boolean;
}) {
  const nodes = layoutFlow(definition, { names, issues }).nodes;
  const trigger = nodes.find((node) => node.data.kind === 'trigger');
  const steps = nodes.filter((node) => node.data.kind === 'step' || node.data.kind === 'if_else');
  const needsSetup = (node: FlowCanvasNode) =>
    node.data.kind !== 'add_step' &&
    node.data.kind !== 'end' &&
    (node.data.incomplete || node.data.issues.length > 0);
  const incomplete = steps.filter(needsSetup);
  const triggerReady =
    trigger?.data.kind === 'trigger' &&
    !trigger.data.incomplete &&
    !trigger.data.issues.some((issue) => issue.path.startsWith('trigger'));
  const actionsReady = steps.length > 0 && incomplete.length === 0;
  const firstAction = incomplete[0] ?? steps[0];
  return (
    <nav aria-label="Flow setup" className="rounded-lg border bg-card">
      <ol className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          {
            label: 'Trigger',
            detail: triggerReady ? 'When it starts is set' : 'Choose when this flow starts',
            done: triggerReady,
            selected: selectedId === 'trigger',
            click: () => onSelect('trigger'),
            disabled: false,
          },
          {
            label: 'Actions',
            detail:
              steps.length === 0
                ? 'Add your first action below'
                : incomplete.length > 0
                  ? `${incomplete.length} of ${steps.length} steps need setup`
                  : `${steps.length} steps configured`,
            done: actionsReady,
            selected: steps.some((node) => node.id === selectedId),
            click: () => onSelect(firstAction?.id ?? 'trigger'),
            disabled: !firstAction,
          },
          {
            label: 'Review',
            detail: canReview ? 'Review before publishing' : 'Finish setup to review',
            done: false,
            selected: false,
            click: onReview,
            disabled: !canReview,
          },
        ].map((item, index) => (
          <li key={item.label}>
            <button
              type="button"
              disabled={item.disabled}
              onClick={item.click}
              aria-current={item.selected ? 'step' : undefined}
              className={cn(
                'flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                item.selected && 'bg-muted/60',
              )}
            >
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                aria-hidden="true"
              >
                {item.done ? <CheckIcon className="size-4" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.detail}</span>
              </span>
              <ArrowRightIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ol>
      {incomplete.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
          <span className="text-muted-foreground">Continue setup:</span>
          {incomplete.map((node) => (
            <button
              type="button"
              key={node.id}
              onClick={() => onSelect(node.id)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-amber-800 underline decoration-dotted underline-offset-4 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-200"
            >
              <CircleIcon className="size-3" aria-hidden="true" />
              {'kindLabel' in node.data ? String(node.data.kindLabel) : 'Step'}
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
