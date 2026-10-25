import { Check } from 'lucide-react';

import { cn } from '../lib/utils';

export interface StepperStep {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: readonly StepperStep[];
  currentStepId: string;
}

type StepState = 'complete' | 'current' | 'upcoming';

function StepMarker({ state, index }: { state: StepState; index: number }) {
  const isComplete = state === 'complete';
  const isCurrent = state === 'current';

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums',
        isComplete && 'border-primary bg-primary text-primary-foreground',
        isCurrent && 'border-primary text-primary',
        state === 'upcoming' && 'border-border text-muted-foreground',
      )}
    >
      {isComplete ? <Check className="size-3.5" /> : index + 1}
    </span>
  );
}

/**
 * Presentational progress for the multi-step order form. Non-interactive: it
 * adds no tab stops and never suppresses a focus outline, so surrounding
 * controls keep their visible `focus-visible` rings. Steps before
 * `currentStepId` are `complete`, the matching step is `current` (carrying
 * `aria-current="step"`), the rest are `upcoming`.
 */
function Stepper({ steps, currentStepId }: StepperProps) {
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);

  return (
    <ol
      data-slot="stepper"
      aria-label="Order progress"
      className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-2 sm:gap-y-3"
    >
      {steps.map((step, index) => {
        const state: StepState =
          index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';

        return (
          <li
            key={step.id}
            data-slot="stepper-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-sm sm:flex-col sm:items-start sm:gap-1.5 sm:py-0"
          >
            <StepMarker state={state} index={index} />
            {state === 'complete' ? <span className="sr-only">Completed: </span> : null}
            <span
              className={cn(
                'min-w-0 break-words',
                state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export { Stepper };
