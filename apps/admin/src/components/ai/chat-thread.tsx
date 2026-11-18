'use client';

import type { ReactNode, RefObject } from 'react';
import { ArrowDownIcon, MessagesSquareIcon, SparklesIcon } from 'lucide-react';
import type { LeadType } from '@gt-sales/contracts';
import { Button, Skeleton } from '@gt-sales/ui';

import { AssistantMessage } from './assistant-message';
import { useAssistant } from './assistant-provider';
import { suggestionsFor } from './assistant-shared';

function ThreadSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Opening the conversation…</span>
      {[0, 1].map((turn) => (
        <div key={turn} aria-hidden="true" className="flex flex-col gap-3">
          <Skeleton className="ml-auto h-9 w-2/5 rounded-2xl" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      ))}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
      {children}
    </div>
  );
}

/**
 * The open conversation on the full page: a log (never itself live; the
 * page's one status line announces the answer's state), centred at a reading
 * width. A new chat greets with the site's name and the suggested questions;
 * a stored conversation shows a skeleton while it loads, a plain sentence if
 * it is not available, and Try again if it failed to load.
 */
export function ChatThread({
  scrollRef,
  onScroll,
  atBottom,
  onJumpToLatest,
  onAsk,
  onNewChat,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll(): void;
  atBottom: boolean;
  onJumpToLatest(): void;
  onAsk(question: string): void;
  onNewChat(): void;
}) {
  const {
    capabilities,
    messages,
    streaming,
    siteName,
    send,
    retry,
    canRetry,
    reviseAction,
    confirmAction,
    cancelAction,
    conversations,
  } = useAssistant();
  const { load } = conversations;
  const leadTypes: readonly LeadType[] =
    capabilities.status === 'ready' ? capabilities.data.leadTypes : [];
  const suggestions = suggestionsFor(leadTypes);
  const last = messages[messages.length - 1];
  const retryId = canRetry && last !== undefined ? last.id : undefined;
  const data = capabilities.status === 'ready' ? capabilities.data : undefined;

  let content: ReactNode;
  if (load.status === 'loading') {
    content = <ThreadSkeleton />;
  } else if (load.status === 'not_found') {
    content = (
      <Centered>
        <MessagesSquareIcon aria-hidden="true" className="size-7 text-muted-foreground" />
        <h2 className="text-base font-semibold">This conversation is not available</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          It may have been deleted, or it belongs to someone else. Your own conversations are in the
          list.
        </p>
        <Button type="button" onClick={onNewChat}>
          Start a new chat
        </Button>
      </Centered>
    );
  } else if (load.status === 'error') {
    content = (
      <Centered>
        <p role="alert" className="max-w-sm text-sm text-muted-foreground">
          {load.message}
        </p>
        <Button type="button" variant="outline" onClick={conversations.reload}>
          Try again
        </Button>
      </Centered>
    );
  } else if (messages.length === 0) {
    content = (
      <Centered>
        <span className="grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary">
          <SparklesIcon aria-hidden="true" className="size-5" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">What would you like to know?</h2>
          <p className="text-sm text-muted-foreground">
            Ask about {siteName}’s leads, orders, follow-ups or sources.
          </p>
        </div>
        {data?.actions?.length ? (
          <p className="max-w-md text-xs text-muted-foreground">
            You can also ask to prepare a task or note. Review the details and confirm before
            saving.
          </p>
        ) : null}
        {data?.automationAuthoring ? (
          <p className="max-w-md text-xs text-muted-foreground">
            Ask to create or edit an automation. Review the visual proposal and save a draft before
            publishing in the builder.
          </p>
        ) : null}
        {suggestions.length > 0 ? (
          <div className="mt-3 w-full max-w-xl">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Suggested questions
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {suggestions.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    className="h-full w-full rounded-xl border bg-card px-3 py-2.5 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onAsk(question)}
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Centered>
    );
  } else {
    content = (
      <div className="flex flex-col gap-6">
        {messages.map((message) => (
          <AssistantMessage
            key={message.id}
            message={message}
            onReviseAction={(id, draft) => reviseAction(message.id, id, draft)}
            onAnswerChoice={message.id === last?.id && !streaming ? send : undefined}
            onConfirmAction={(id) => confirmAction(message.id, id)}
            onCancelAction={(id) => cancelAction(message.id, id)}
            {...(message.id === retryId ? { onRetry: retry } : {})}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        // Tokens stream into this region, so it is silent; the page's one
        // sr-only status is what a screen reader hears change.
        aria-live="off"
        aria-relevant="additions"
        aria-busy={load.status === 'loading'}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
          {content}
        </div>
      </div>
      {!atBottom && messages.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-events-auto rounded-full bg-background shadow-sm"
            onClick={onJumpToLatest}
          >
            <ArrowDownIcon aria-hidden="true" className="size-3.5" />
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
