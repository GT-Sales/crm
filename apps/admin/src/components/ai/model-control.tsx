'use client';

import { useId } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { NativeSelect, cn } from '@gt-sales/ui';

import { useAssistant } from './assistant-provider';

/** How the site's default reads in the list, after its name. */
export const DEFAULT_MODEL_TAG = 'Default';

/**
 * The model of the next message, beside the effort control: the browser's own
 * select (keyboard and screen-reader ready, native on a phone), in the effort
 * control's pill style. Shown only where the site offers a choice
 * (capabilities list `models`), so against an older backend, before
 * migration 0040, or on a site that allows one model, the composer is exactly
 * as it was. The site's default comes first, tagged "Default". The pick is
 * kept in this browser per site (the provider's `model`).
 */
export function ModelControl({ disabled = false }: { disabled?: boolean }) {
  const { model } = useAssistant();
  const id = useId();
  if (!model.offered) return null;
  const chosen = model.options.find((option) => option.id === model.value);
  return (
    <div className={cn('relative flex h-8 min-w-0 shrink items-center', disabled && 'opacity-60')}>
      <label htmlFor={id} className="sr-only">
        Model
      </label>
      <NativeSelect
        id={id}
        value={model.value}
        disabled={disabled}
        title={chosen ? `Model: ${chosen.label}` : 'Model'}
        onChange={(event) => model.set(event.target.value)}
        className="h-8 w-auto max-w-[7.5rem] cursor-pointer appearance-none truncate rounded-full border-0 bg-muted py-0 pr-7 pl-3 text-xs font-medium text-foreground shadow-none sm:max-w-[13rem] md:text-xs dark:bg-muted"
      >
        {model.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.id === model.defaultModel
              ? `${option.label} · ${DEFAULT_MODEL_TAG}`
              : option.label}
          </option>
        ))}
      </NativeSelect>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 size-3.5 text-muted-foreground"
      />
    </div>
  );
}
