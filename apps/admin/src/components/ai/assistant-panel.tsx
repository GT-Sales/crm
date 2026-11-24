'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MessageSquareIcon,
  Maximize2Icon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import type { LeadType } from '@gt-sales/contracts';
import { Button, Sheet, SheetContent, SheetTitle, Textarea, useIsMobile } from '@gt-sales/ui';

import { AssistantMessage } from './assistant-message';
import { useAssistant } from './assistant-provider';
import { EffortControl, HIGH_EFFORT_HINT } from './effort-control';
import { ModelControl } from './model-control';
import {
  announcementFor,
  capabilityFailureText,
  suggestionsFor,
  useComposerKeys,
  useConversationScroll,
  useStopGuard,
} from './assistant-shared';
import { ComposerNotes, keptDraft } from './composer-notes';
import { askAiIntro } from './ask-ai-intro';

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
    reviseAction,
    confirmAction,
    cancelAction,
    canRetry,
    retryNote,
    conversations,
    workspaceSlug,
    handOffToChatPage,
    effort,
    conversationFull,
    reloadCapabilities,
  } = useAssistant();
  const stopGuard = useStopGuard();
  const [clipped, setClipped] = useState(false);
  const isMobile = useIsMobile();
  const composerId = useId();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Set when the control the user pressed is replaced by the enabled composer.
  const focusComposerAfterStream = useRef(false);
  // T4: set when a question is sent. The composer is disabled while the answer
  // streams, which drops its focus; it gets it back when the answer ends,
  // unless the person has moved on to something else meanwhile.
  const focusComposerAfterAnswer = useRef(false);
  const [draft, setDraft] = useState('');
  const { scrollRef, atBottom, onScroll, jumpToLatest, resetToBottom } = useConversationScroll(
    messages,
    isOpen,
  );

  const available = capabilities.status === 'ready' && capabilities.data.available;
  const leadTypes: readonly LeadType[] =
    capabilities.status === 'ready' ? capabilities.data.leadTypes : [];
  const suggestions = suggestionsFor(leadTypes);
  const announcement = announcementFor(messages, streaming);
  const last = messages[messages.length - 1];
  const retryId = canRetry && last !== undefined ? last.id : undefined;
  // A stored conversation still loading (or gone) takes no question yet.
  const load = conversations.load;
  const ready = available && load.status === 'idle' && !conversationFull;
  const fullPageHref = `/w/${workspaceSlug}/chat${
    conversations.activeId === undefined ? '' : `/${conversations.activeId}`
  }`;

  useEffect(() => {
    if (!isOpen) return;
    // A reopened panel starts at the newest message, whatever it was scrolled to.
    resetToBottom();
    composerRef.current?.focus();
  }, [isOpen, isMobile, resetToBottom]);

  useEffect(() => {
    if (streaming) return;
    if (focusComposerAfterAnswer.current) {
      focusComposerAfterAnswer.current = false;
      const active = document.activeElement;
      if (active === null || active === document.body || active === composerRef.current)
        composerRef.current?.focus();
    }
    if (!focusComposerAfterStream.current) return;
    // The Stop button (or the disabled composer) was replaced: put the caret
    // back where the next question is typed.
    focusComposerAfterStream.current = false;
    composerRef.current?.focus();
  }, [streaming]);

  function submit(): void {
    if (!ready || streaming) return;
    const text = draft.trim();
    if (text.length === 0) return;
    stopGuard.markSent();
    if (send(text)) focusComposerAfterAnswer.current = true;
    setDraft('');
    setClipped(false);
    composerRef.current?.focus();
  }

  function ask(question: string): void {
    if (!ready || streaming) return;
    stopGuard.markSent();
    if (send(question)) focusComposerAfterAnswer.current = true;
    composerRef.current?.focus();
  }

  function startNewChat(): void {
    if (streaming) focusComposerAfterStream.current = true;
    newChat();
    setDraft('');
    resetToBottom();
    composerRef.current?.focus();
  }

  function stopStreaming(event: { detail: number }): void {
    // The second click of a double-click on Send lands here: not a Stop.
    if (stopGuard.ignoreStop(event)) return;
    focusComposerAfterStream.current = true;
    stop();
  }

  const composerKeys = useComposerKeys(submit);

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
    <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border px-3">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full border bg-card text-primary shadow-xs"
      >
        <SparklesIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium">Ask AI</h2>
        <p className="truncate text-xs text-muted-foreground">{siteName}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 rounded-full px-3 text-xs"
        onClick={startNewChat}
      >
        New chat
      </Button>
      {conversations.enabled ? (
        <Button asChild variant="ghost" size="icon" className="size-8 rounded-full">
          <Link
            href={fullPageHref}
            aria-label="Open chat in full page"
            title="Open chat in full page"
            onClick={handOffToChatPage}
          >
            <Maximize2Icon aria-hidden="true" className="size-3.5" />
          </Link>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
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
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4"
      onScroll={onScroll}
    >
      {capabilities.status === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <h2 className="text-sm font-semibold">{capabilityFailureText(capabilities).title}</h2>
          <p role="alert" className="text-sm text-muted-foreground">
            {capabilityFailureText(capabilities).text}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={reloadCapabilities}>
            Try again
          </Button>
        </div>
      ) : load.status === 'loading' ? (
        <p className="text-sm text-muted-foreground">Opening the conversation…</p>
      ) : load.status === 'not_found' ? (
        <p className="text-sm text-muted-foreground">
          This conversation is not available. Press New chat to start another.
        </p>
      ) : load.status === 'error' ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {load.message}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={conversations.reload}>
            Try again
          </Button>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-col gap-3 pt-2">
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-full border bg-card text-primary shadow-xs"
          >
            <SparklesIcon className="size-4" />
          </span>
          <p className="text-sm text-muted-foreground">
            {available
              ? askAiIntro('this site’s', {
                  actions:
                    capabilities.status === 'ready' && Boolean(capabilities.data.actions?.length),
                  automations:
                    capabilities.status === 'ready' &&
                    capabilities.data.automationAuthoring === true,
                })
              : 'Ask AI isn’t available for this site right now.'}
          </p>
          {available && suggestions.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Suggested questions</p>
              <ul className="mt-2 flex flex-col gap-2">
                {suggestions.map((question) => (
                  <li key={question}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-[13px] text-foreground shadow-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => ask(question)}
                    >
                      <MessageSquareIcon
                        aria-hidden="true"
                        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0">{question}</span>
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
            compact
            onReviseAction={(id, draft) => reviseAction(message.id, id, draft)}
            onAnswerChoice={message.id === last?.id && !streaming ? send : undefined}
            onConfirmAction={(id, acknowledged) => confirmAction(message.id, id, acknowledged)}
            onCancelAction={(id) => cancelAction(message.id, id)}
            {...(message.id === retryId ? { onRetry: retry } : {})}
            {...(message.id === last?.id ? { retryNote, onStartNewChat: startNewChat } : {})}
          />
        ))
      )}
    </div>
  );

  const footer = (
    <div className="shrink-0 bg-background px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {activeLeadId === undefined ? null : (
        <p className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground">
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
      <ComposerNotes
        clipped={clipped}
        maxChars={maxMessageChars}
        full={conversationFull}
        onNewChat={startNewChat}
      />
      <div className="rounded-[1.25rem] border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
        <label htmlFor={composerId} className="sr-only">
          Ask a question
        </label>
        <Textarea
          id={composerId}
          ref={composerRef}
          value={draft}
          rows={2}
          maxLength={maxMessageChars * 2}
          placeholder="Ask about this site’s leads..."
          disabled={!ready || streaming}
          className="max-h-40 min-h-16 resize-none rounded-[1.25rem] border-0 bg-transparent! px-3.5 pt-3 pb-1 text-sm shadow-none! outline-none! focus-visible:ring-0"
          onChange={(event) => {
            const kept = keptDraft(event.target.value, maxMessageChars);
            setDraft(kept.text);
            setClipped(kept.clipped);
          }}
          {...composerKeys}
        />
        <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
          <ModelControl disabled={!ready} />
          {effort.offered ? <EffortControl disabled={!ready} /> : null}
          {streaming ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-8 rounded-full"
              aria-label="Stop"
              title="Stop"
              onClick={stopStreaming}
            >
              <SquareIcon aria-hidden="true" className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="size-8 rounded-full"
              aria-label="Send"
              title="Send"
              disabled={!ready || draft.trim().length === 0}
              onClick={submit}
            >
              <ArrowUpIcon aria-hidden="true" className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {effort.offered && effort.value === 'high' ? (
        <p className="-mt-3 mx-4 rounded-b-xl bg-muted/50 px-3 pt-4 pb-1.5 text-xs text-muted-foreground">
          {`High effort. ${HIGH_EFFORT_HINT}`}
        </p>
      ) : null}
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
      className="fixed top-3 right-3 bottom-3 z-40 flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[1.25rem] border border-border bg-background shadow-xl"
    >
      {body}
    </aside>
  );
}
