'use client';

import { SparklesIcon } from 'lucide-react';
import { Button } from '@gt-sales/ui';

import { useOptionalAssistant } from './assistant-provider';

/**
 * The top bar's entry point. It stays out of the DOM until the capability call
 * succeeds and says the caller may use the assistant, so a failed or slow load
 * can never flash an enabled button.
 */
export function AssistantTrigger() {
  const assistant = useOptionalAssistant();
  if (!assistant) return null;
  const { capabilities, isOpen, open } = assistant;
  if (capabilities.status !== 'ready' || !capabilities.data.available) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5 rounded-full border-primary/30 bg-primary/5 px-3 font-medium text-primary shadow-xs hover:border-primary/50 hover:bg-primary/10 hover:text-primary aria-expanded:bg-primary/15"
      aria-label="Ask AI"
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={(event) => open(event.currentTarget)}
    >
      <SparklesIcon aria-hidden="true" className="size-4" />
      <span className="hidden sm:inline">Ask AI</span>
    </Button>
  );
}
