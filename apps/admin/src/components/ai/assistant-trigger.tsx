'use client';

import { SparklesIcon } from 'lucide-react';
import { Button } from '@gt-sales/ui';

import { useAssistant } from './assistant-provider';

/**
 * The top bar's entry point. It stays out of the DOM until the capability call
 * succeeds and says the caller may use the assistant, so a failed or slow load
 * can never flash an enabled button.
 */
export function AssistantTrigger() {
  const { capabilities, isOpen, open } = useAssistant();
  if (capabilities.status !== 'ready' || !capabilities.data.available) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
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
