'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  ArrowDownIcon,
  Maximize2Icon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import type { LeadType } from '@gt-sales/contracts';
import { Button, Sheet, SheetContent, SheetTitle, Textarea, useIsMobile } from '@gt-sales/ui';

import { AssistantMessage } from './assistant-message';
import { useAssistant } from './assistant-provider';
import { EffortControl, HIGH_EFFORT_HINT } from './effort-control';
import {
  announcementFor,
  capabilityFailureText,
  suggestionsFor,
  useComposerKeys,
  useConversationScroll,
  useStopGuard,
} from './assistant-shared';
import { ComposerNotes, keptDraft } from './composer-notes';

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
    if (streaming || !focusComposerAfterStream.current) return;
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
    send(text);
    setDraft('');
    setClipped(false);
    composerRef.current?.focus();
  }

  function ask(question: string): void {
    if (!ready || streaming) return;
    stopGuard.markSent();
    send(question);
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
      {conversations.enabled ? (
        <Button asChild variant="ghost" size="icon" className="size-7">
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
          {available && capabilities.status === 'ready' && capabilities.data.automationAuthoring ? (
            <p className="text-sm text-muted-foreground">
              Ask to create or edit an automation. Review the visual proposal and save a draft
              before publishing in the builder.
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
      <ComposerNotes
        clipped={clipped}
        maxChars={maxMessageChars}
        full={conversationFull}
        onNewChat={startNewChat}
      />
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
        disabled={!ready || streaming}
        className="max-h-40 min-h-16 resize-none"
        onChange={(event) => {
          const kept = keptDraft(event.target.value, maxMessageChars);
          setDraft(kept.text);
          setClipped(kept.clipped);
        }}
        {...composerKeys}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] text-muted-foreground">
          {effort.offered && effort.value === 'high'
            ? `High effort. ${HIGH_EFFORT_HINT}`
            : 'Enter to send · Shift+Enter for a new line'}
        </p>
        {effort.offered ? (
          <span className="ml-auto">
            <EffortControl disabled={!ready} />
          </span>
        ) : null}
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
            disabled={!ready || draft.trim().length === 0}
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
