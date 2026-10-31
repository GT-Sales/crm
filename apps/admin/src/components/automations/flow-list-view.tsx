import type { JSX } from 'react';
import type { FlowDefinition, FlowDraft, FlowDraftStep, FlowStep } from '@gt-sales/contracts';

import { describeCondition, describeStep, describeTrigger, type FlowNames } from './flow-words';

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function Steps({
  steps,
  names,
  label,
}: {
  steps: readonly (FlowStep | FlowDraftStep)[];
  names: FlowNames;
  label?: string;
}): JSX.Element {
  if (steps.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing.</p>;
  }
  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {steps.map((step) => (
        <li key={step.id} className="rounded-md border bg-card px-3 py-2 text-sm">
          <p>{describeStep(step, names)}</p>
          {step.kind === 'if_else' ? (
            <div className="mt-2 flex flex-col gap-2 border-l-2 pl-3">
              <p className="text-xs font-medium text-muted-foreground">Yes</p>
              <Steps steps={step.then} names={names} label="Yes" />
              <p className="text-xs font-medium text-muted-foreground">No</p>
              <Steps steps={step.else} names={names} label="No" />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * A flow read top to bottom, as an ordered list: when it starts, the
 * condition it only runs on, then each step in words, an if/else's two
 * branches as nested lists labelled "Yes" and "No". The keyboard and screen
 * reader route to a flow; Step B shows it beside the canvas.
 */
export function FlowListView({
  definition,
  names,
}: {
  definition: FlowDefinition | FlowDraft;
  names: FlowNames;
}): JSX.Element {
  const { trigger } = definition;
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="When it runs" className="flex flex-col gap-1 text-sm">
        <li className="font-medium">
          {trigger === null
            ? 'No trigger yet.'
            : `When ${lowerFirst(describeTrigger(trigger, names))}`}
        </li>
        {trigger?.when ? (
          <li className="text-muted-foreground">
            Only when {describeCondition(trigger.when, names)}
          </li>
        ) : null}
      </ol>
      <Steps steps={definition.steps} names={names} label="Steps" />
    </div>
  );
}
