'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import type { AiEffort } from '@gt-sales/contracts';
import { cn } from '@gt-sales/ui';

import { useAssistant } from './assistant-provider';

/** What High means, said once: beside the control for screen readers, under it on screen. */
export const HIGH_EFFORT_HINT = 'Takes longer. For harder questions.';

const LEVELS: readonly { value: AiEffort; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
];

/**
 * The effort level of the next message, beside Send: a two-option radio group
 * in the segmented style of the AI usage page's period switch. Shown only
 * where the site offers High (capabilities list it), so against an older
 * backend, or with High off, the composer is exactly as it was. Arrow keys
 * move the choice and Tab enters on the chosen option, as a radio group
 * does. The choice is the provider's and lasts for the tab.
 */
export function EffortControl({ disabled = false }: { disabled?: boolean }) {
  const { effort } = useAssistant();
  const hintId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!effort.offered) return null;

  function choose(index: number): void {
    const level = LEVELS[index];
    if (level === undefined) return;
    effort.set(level.value);
    refs.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    choose((index + step + LEVELS.length) % LEVELS.length);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      aria-disabled={disabled || undefined}
      className={cn(
        'flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5',
        disabled && 'opacity-60',
      )}
    >
      {LEVELS.map((level, index) => {
        const checked = effort.value === level.value;
        return (
          <button
            key={level.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            title={level.value === 'high' ? HIGH_EFFORT_HINT : undefined}
            aria-describedby={level.value === 'high' ? hintId : undefined}
            onClick={() => effort.set(level.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'h-full rounded-full px-3 text-xs font-medium whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none',
              checked ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground',
            )}
          >
            {level.label}
          </button>
        );
      })}
      <span id={hintId} className="sr-only">
        {HIGH_EFFORT_HINT}
      </span>
    </div>
  );
}
