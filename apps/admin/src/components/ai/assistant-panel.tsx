'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ArrowDownIcon, SendIcon, SparklesIcon, SquareIcon, XIcon } from 'lucide-react';
import type { LeadType } from '@gt-sales/contracts';
import { Button, Sheet, SheetContent, SheetTitle, Textarea, useIsMobile } from '@gt-sales/ui';

import { AssistantMessage, aiErrorText } from './assistant-message';
import { useAssistant, type AiMessage } from './assistant-provider';

/** A suggested question, offered only when the site has a lead type it needs. */
const SUGGESTED_QUESTIONS: readonly { text: string; leadTypes?: readonly LeadType[] }[] = [
  { text: 'Summarize leads from the last 30 days' },
  { text: 'Which follow-ups are due today or earlier?' },
  { text: 'How are SIM orders distributed by stage?', leadTypes: ['sim_order'] },
  {
    text: 'Which sources brought submitted SIM orders in the last 30 days?',
    leadTypes: ['sim_order'],
  },
];

function suggestionsFor(leadTypes: readonly LeadType[]): readonly string[] {
  return SUGGESTED_QUESTIONS.filter(
    (question) =>
      question.leadTypes === undefined ||
      question.leadTypes.some((leadType) => leadTypes.includes(leadType)),
  ).map((question) => question.text);
}

/**
 * The live region's one sentence. Progress labels live inside the conversation
 * (announced only by reading), so an answer's tokens are never read out one at
 * a time: only the move to thinking, answering, ready or an error is.
 */
function announcementFor(messages: readonly AiMessage[], streaming: boolean): string {
  const last = messages[messages.length - 1];
  if (last === undefined) return '';
  if (last.role === 'user') return streaming ? 'Thinking.' : '';
  if (last.status === 'streaming') return last.text.length > 0 ? 'Answering.' : 'Thinking.';
  if (last.status === 'complete') return 'Answer ready.';
  if (last.status === 'stopped') return 'Answer stopped.';
  return aiErrorText(last.error ?? 'failed');
}

function isNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 48;
}

export function AssistantPanel() {
  const {
    capabilities,
    messages,
    streaming,
    isOpen,
    activeLeadId,
    siteName,
    maxMessageChars,
    historyTrimmed,
    removeLeadContext,
    close,
    send,
    stop,
    retry,
    newChat,
    confirmAction,
    cancelAction,
  } = useAssistant();
  const isMobile = useIsMobile();
  const composerId = useId();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const atBottomRef = useRef(true);
  // Set when the control the user pressed is replaced by the enabled composer.
  const focusComposerAfterStream = useRef(false);
  const [draft, setDraft] = useState('');
  const [atBottom, setAtBottom] = useState(true);

  const available = capabilities.status === 'ready' && capabilities.data.available;
  const leadTypes: readonly LeadType[] =
    capabilities.status === 'ready' ? capabilities.data.leadTypes : [];
  const suggestions = suggestionsFor(leadTypes);
  const announcement = announcementFor(messages, streaming);
  const last = messages[messages.length - 1];
  const retryId =
    last !== undefined && last.role === 'assistant' && last.status === 'error'
      ? last.id
      : undefined;

  useEffect(() => {
    if (!isOpen) return;
    // A reopened panel starts at the newest message, whatever it was scrolled to.
    atBottomRef.current = true;
    setAtBottom(true);
    composerRef.current?.focus();
  }, [isOpen, isMobile]);

  useEffect(() => {
    if (streaming || !focusComposerAfterStream.current) return;
    // The Stop button (or the disabled composer) was replaced: put the caret
    // back where the next question is typed.
    focusComposerAfterStream.current = false;
    composerRef.current?.focus();
  }, [streaming]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const near = isNearBottom(node);
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const node = scrollRef.current;
    if (node === null || !atBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [isOpen, messages]);

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (typeof node.scrollTo === 'function') {
      node.scrollTo({ top: node.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
    } else {
      node.scrollTop = node.scrollHeight;
    }
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  function submit(): void {
    if (!available || streaming) return;
    const text = draft.trim();
    if (text.length === 0) return;
    send(text);
    setDraft('');
    composerRef.current?.focus();
  }

  function ask(question: string): void {
    if (!available || streaming) return;
    send(question);
    composerRef.current?.focus();
  }

  function startNewChat(): void {
    if (streaming) focusComposerAfterStream.current = true;
    newChat();
    setDraft('');
    atBottomRef.current = true;
    setAtBottom(true);
    composerRef.current?.focus();
  }

  function stopStreaming(): void {
    focusComposerAfterStream.current = true;
    stop();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    submit();
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.nativeEvent.isComposing) return;
    // Only this overlay closes: the event never reaches the lead panel's
    // document listener while the composer (or anything here) has focus.
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  if (!isOpen) return null;

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-crm-header px-3">
      <SparklesIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[13px] font-semibold">Ask AI</h2>
        <p className="truncate text-[11px] text-muted-foreground">{siteName}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[12px]"
        onClick={startNewChat}
      >
        New chat
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Close Ask AI"
        onClick={close}
      >
        <XIcon aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );

  const conversation = (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Conversation"
      // Tokens stream into this region, so it is silent; the one sr-only status
      // below is what a screen reader hears change.
      aria-live="off"
      aria-relevant="additions"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      onScroll={handleScroll}
    >
      {messages.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {available
              ? 'Ask about this site’s leads, orders, follow-ups or sources.'
              : 'Ask AI isn’t available for this site right now.'}
          </p>
          {available && capabilities.status === 'ready' && capabilities.data.actions?.length ? (
            <p className="text-sm text-muted-foreground">
              You can also ask to prepare a task or note. Review the details and confirm before
              saving.
            </p>
          ) : null}
          {available && suggestions.length > 0 ? (
            <div>
              <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Suggested questions
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {suggestions.map((question) => (
                  <li key={question}>
                    <button
                      type="button"
                      className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-left text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => ask(question)}
                    >
                      {question}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        messages.map((message) => (
          <AssistantMessage
            key={message.id}
            message={message}
            onConfirmAction={(id) => confirmAction(message.id, id)}
            onCancelAction={(id) => cancelAction(message.id, id)}
            {...(message.id === retryId ? { onRetry: retry } : {})}
          />
        ))
      )}
    </div>
  );

  const footer = (
    <div className="shrink-0 border-t border-border bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {activeLeadId === undefined ? null : (
        <p className="mb-2 inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          <SparklesIcon aria-hidden="true" className="size-3" />
          Asking about the open lead
          <button type="button" aria-label="Remove lead context" onClick={removeLeadContext}>
            <XIcon aria-hidden="true" className="size-3" />
          </button>
        </p>
      )}
      {historyTrimmed ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Older messages were omitted from this answer’s context.
        </p>
      ) : null}
      <label htmlFor={composerId} className="sr-only">
        Ask a question
      </label>
      <Textarea
        id={composerId}
        ref={composerRef}
        value={draft}
        rows={3}
        maxLength={maxMessageChars * 2}
        placeholder="Ask about this site’s leads..."
        disabled={!available || streaming}
        className="max-h-40 min-h-16 resize-none"
        onChange={(event) =>
          setDraft(Array.from(event.target.value).slice(0, maxMessageChars).join(''))
        }
        onKeyDown={handleComposerKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] text-muted-foreground">
          Enter to send · Shift+Enter for a new line
        </p>
        {streaming ? (
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={stopStreaming}>
            <SquareIcon aria-hidden="true" className="size-3.5" />
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={!available || draft.trim().length === 0}
            onClick={submit}
          >
            <SendIcon aria-hidden="true" className="size-3.5" />
            Send
          </Button>
        )}
      </div>
    </div>
  );

  const body = (
    <>
      {header}
      {conversation}
      {!atBottom && messages.length > 0 ? (
        <div className="shrink-0 px-3 pb-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={jumpToLatest}
          >
            <ArrowDownIcon aria-hidden="true" className="size-3.5" />
            Jump to latest
          </Button>
        </div>
      ) : null}
      {footer}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );

  if (isMobile) {
    return (
      <Sheet
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            composerRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="h-dvh w-full max-w-full gap-0 p-0 sm:max-w-full"
        >
          <SheetTitle className="sr-only">Ask AI</SheetTitle>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      role="dialog"
      aria-modal={false}
      aria-label="Ask AI"
      onKeyDown={handlePanelKeyDown}
      className="fixed top-3 right-3 bottom-3 z-40 flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
    >
      {body}
    </aside>
  );
}
