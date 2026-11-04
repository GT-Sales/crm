'use client';
import type { AiActionDraft } from '@gt-sales/contracts';

import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button, Skeleton } from '@gt-sales/ui';

import type { AiUiError } from '../../lib/ai-transport';
import type { AiAssistantMessage, AiMessage } from './assistant-provider';
import { AssistantSources } from './assistant-sources';
import { AssistantMarkdown } from './assistant-markdown';
import { AssistantAction } from './assistant-action';

/** Plain language for each way an answer can fail. Never a provider detail. */
export function aiErrorText(error: AiUiError): string {
  switch (error) {
    case 'unavailable':
      return 'Ask AI isn’t available for this site right now.';
    case 'session_expired':
      return 'Your session expired. Sign in again to keep using Ask AI.';
    case 'denied':
      return 'You don’t have access to this site’s leads.';
    case 'rate_limited':
      return 'Too many questions right now. Wait a minute and then try again.';
    case 'cancelled':
      return 'Stopped.';
    case 'failed':
    default:
      return 'Something went wrong while answering. Try again.';
  }
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // A browser may deny the clipboard; the answer is still on screen.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-[11px] text-muted-foreground"
      aria-label={copied ? 'Answer copied' : 'Copy answer'}
      onClick={() => void copy()}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function StreamingState({ message }: { message: AiAssistantMessage }) {
  if (message.text.length > 0 && message.progress === undefined) {
    // Text is already on screen; the caret alone shows the answer is still coming.
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
      />
    );
  }
  return (
    <div className="flex flex-col gap-1" aria-hidden="true">
      {message.text.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{message.progress ?? 'Thinking…'}</p>
    </div>
  );
}

function AssistantAnswer({
  message,
  onRetry,
  onConfirmAction,
  onCancelAction,
  onReviseAction,
  onAnswerChoice,
}: {
  message: AiAssistantMessage;
  onRetry?: () => void;
  onConfirmAction?: (id: string) => void;
  onCancelAction?: (id: string) => void;
  onReviseAction?: (id: string, draft: AiActionDraft) => void;
  onAnswerChoice?: (choice: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {message.text.length > 0 ? <AssistantMarkdown text={message.text} /> : null}
      {message.status === 'streaming' ? <StreamingState message={message} /> : null}
      {message.status === 'complete' &&
      message.text.length === 0 &&
      !message.followUp &&
      !message.actions?.length ? (
        <p className="text-sm text-muted-foreground">
          No answer came back. Try asking in another way.
        </p>
      ) : null}
      {message.status === 'stopped' && message.text.length === 0 ? (
        <p className="text-sm text-muted-foreground">Stopped.</p>
      ) : null}
      {message.status === 'error' ? (
        <p className="text-sm text-muted-foreground">{aiErrorText(message.error ?? 'failed')}</p>
      ) : null}
      <AssistantSources sources={message.sources} />
      {message.status === 'complete' && message.followUp ? (
        <section aria-label="Clarifying question" className="space-y-2">
          <p className="text-sm">{message.followUp.question}</p>
          <div className="flex flex-wrap gap-2">
            {message.followUp.choices.map((choice) => (
              <Button
                key={choice}
                variant="outline"
                size="sm"
                disabled={!onAnswerChoice}
                onClick={() => onAnswerChoice?.(choice)}
              >
                {choice}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Choose an option or type your own answer.</p>
        </section>
      ) : null}
      {message.status === 'complete'
        ? message.actions?.map((action) => (
            <AssistantAction
              key={action.proposal.id}
              action={action}
              onRevise={(draft) => onReviseAction?.(action.proposal.id, draft)}
              onConfirm={() => onConfirmAction?.(action.proposal.id)}
              onCancel={() => onCancelAction?.(action.proposal.id)}
            />
          ))
        : null}
      {message.status !== 'streaming' && (message.text.length > 0 || message.status === 'error') ? (
        <div className="flex flex-wrap items-center gap-1">
          {message.text.length > 0 ? <CopyAnswer text={message.text} /> : null}
          {message.status === 'error' && onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onRetry}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One message in the conversation: the staff member's question or the answer. */
export function AssistantMessage({
  message,
  onRetry,
  onConfirmAction,
  onCancelAction,
  onReviseAction,
  onAnswerChoice,
}: {
  message: AiMessage;
  onRetry?: () => void;
  onConfirmAction?: (id: string) => void;
  onCancelAction?: (id: string) => void;
  onReviseAction?: (id: string, draft: AiActionDraft) => void;
  onAnswerChoice?: (choice: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-3 py-2 text-sm text-foreground">
          {message.text}
        </p>
      </div>
    );
  }
  return (
    <AssistantAnswer
      message={message}
      onRetry={onRetry}
      onConfirmAction={onConfirmAction}
      onCancelAction={onCancelAction}
      onReviseAction={onReviseAction}
      onAnswerChoice={onAnswerChoice}
    />
  );
}
