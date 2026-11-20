'use client';

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react';
import { ArrowUpIcon, PlusIcon, SquareIcon } from 'lucide-react';
import { Button, Textarea, cn } from '@gt-sales/ui';

import { useAssistant } from './assistant-provider';
import { useComposerKeys, useStopGuard } from './assistant-shared';
import { PendingAttachmentChip } from './attachment-chip';
import { ComposerNotes, keptDraft } from './composer-notes';
import { EffortControl, HIGH_EFFORT_HINT } from './effort-control';
import { ModelControl } from './model-control';

export interface ChatComposerHandle {
  focus(): void;
  /** Puts a question in the box (a suggestion) and sends it. */
  ask(question: string): void;
}

/** The box grows with its text up to this many pixels, then scrolls. */
const MAX_HEIGHT = 200;

/**
 * The full page's composer, pinned under the thread: a box that grows as it
 * fills, Enter to send and Shift+Enter for a new line (never while an input
 * method is composing), Stop while an answer streams, and, where the site
 * offers it, files: the paperclip, a drop onto the chat, or an image pasted
 * into the box. A message still needs words; files alone wait for them.
 */
export const ChatComposer = forwardRef<
  ChatComposerHandle,
  {
    disabled?: boolean;
    /** Leaves a full conversation for a new chat (and its address). */ onNewChat?: () => void;
  }
>(function ChatComposer({ disabled = false, onNewChat }, ref) {
  const {
    capabilities,
    streaming,
    send,
    stop,
    maxMessageChars,
    attachments,
    conversations,
    effort,
    conversationFull,
    newChat,
  } = useAssistant();
  const stopGuard = useStopGuard();
  const [clipped, setClipped] = useState(false);
  const composerId = useId();
  const hintId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusAfterStream = useRef(false);
  const [draft, setDraft] = useState('');

  const available = capabilities.status === 'ready' && capabilities.data.available;
  const ready = available && !disabled && conversations.load.status === 'idle' && !conversationFull;
  const { settings, pending, uploading, notice } = attachments;
  const readyFiles = pending.filter((item) => item.status === 'ready').length;
  const text = draft.trim();
  const canSend = ready && !streaming && !uploading && text.length > 0;
  const count = Array.from(draft).length;

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [draft]);

  useEffect(() => {
    if (streaming || !focusAfterStream.current) return;
    focusAfterStream.current = false;
    textareaRef.current?.focus();
  }, [streaming]);

  function submit(): void {
    if (!canSend) return;
    stopGuard.markSent();
    // The draft stays when nothing was sent, so no words are lost.
    if (!send(text, { withAttachments: true })) return;
    setDraft('');
    setClipped(false);
    textareaRef.current?.focus();
  }

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      ask(question) {
        if (!ready || streaming || uploading) return;
        stopGuard.markSent();
        send(question, { withAttachments: true });
        textareaRef.current?.focus();
      },
    }),
    [ready, send, stopGuard, streaming, uploading],
  );

  const keys = useComposerKeys(submit);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (settings === undefined) return;
    const images = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (images.length === 0) return;
    // A screenshot pasted on its own is the file; words copied with it still paste.
    if (event.clipboardData.getData('text/plain').length === 0) event.preventDefault();
    attachments.add(images);
  }

  const highChosen = effort.offered && effort.value === 'high';
  const keyHint = !uploading && !(readyFiles > 0 && text.length === 0) && !highChosen;
  const hint = uploading
    ? 'Waiting for the files to finish uploading…'
    : readyFiles > 0 && text.length === 0
      ? 'Add a question to send with the files.'
      : highChosen
        ? `High effort. ${HIGH_EFFORT_HINT}`
        : 'Enter to send · Shift+Enter for a new line';

  return (
    <div className="shrink-0 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <ComposerNotes
          clipped={clipped}
          maxChars={maxMessageChars}
          full={conversationFull}
          onNewChat={() => {
            if (onNewChat) onNewChat();
            else newChat();
            textareaRef.current?.focus();
          }}
        />
        {notice === undefined ? null : (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {notice}
          </p>
        )}
        <div
          className={cn(
            'relative z-10 rounded-[1.25rem] border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30',
            !ready && 'opacity-80',
          )}
        >
          {pending.length > 0 ? (
            <ul
              aria-label="Files to send"
              className="flex gap-2 overflow-x-auto px-3 pt-3 pb-0.5 sm:flex-wrap sm:overflow-visible"
            >
              {pending.map((item) => (
                <PendingAttachmentChip
                  key={item.localId}
                  item={item}
                  onRemove={() => {
                    attachments.remove(item.localId);
                    textareaRef.current?.focus();
                  }}
                />
              ))}
            </ul>
          ) : null}
          <label htmlFor={composerId} className="sr-only">
            Ask a question
          </label>
          <Textarea
            id={composerId}
            ref={textareaRef}
            value={draft}
            rows={1}
            maxLength={maxMessageChars * 2}
            placeholder="Ask about leads, orders or follow-ups…"
            disabled={!ready}
            aria-describedby={hintId}
            onChange={(event) => {
              const kept = keptDraft(event.target.value, maxMessageChars);
              setDraft(kept.text);
              setClipped(kept.clipped);
            }}
            onPaste={handlePaste}
            {...keys}
            className="max-h-[200px] min-h-[3.25rem] resize-none rounded-[1.25rem] border-0 bg-transparent! px-4 pt-3.5 pb-1 text-[15px] shadow-none! outline-none! focus-visible:ring-0 md:text-[15px]"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            {settings === undefined ? null : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 rounded-full text-muted-foreground"
                  aria-label="Attach files"
                  title="Attach files"
                  disabled={
                    !ready ||
                    pending.filter((item) => item.status !== 'failed').length >=
                      settings.maxPerMessage
                  }
                  onClick={() => fileRef.current?.click()}
                >
                  <PlusIcon aria-hidden="true" className="size-[1.125rem]" />
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  tabIndex={-1}
                  aria-hidden="true"
                  accept={settings.accept.join(',')}
                  className="sr-only"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    attachments.add(files);
                    textareaRef.current?.focus();
                  }}
                />
              </>
            )}
            <span aria-hidden="true" className="flex-1" />
            {count > maxMessageChars * 0.8 ? (
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {count.toLocaleString()} / {maxMessageChars.toLocaleString()}
              </span>
            ) : null}
            <ModelControl disabled={!ready} />
            <EffortControl disabled={!ready} />
            {streaming ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-8 shrink-0 rounded-full"
                aria-label="Stop"
                title="Stop"
                onClick={(event) => {
                  // The second click of a double-click on Send lands here: not a Stop.
                  if (stopGuard.ignoreStop(event)) return;
                  focusAfterStream.current = true;
                  stop();
                }}
              >
                <SquareIcon aria-hidden="true" className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                className="size-8 shrink-0 rounded-full"
                aria-label="Send"
                title="Send"
                disabled={!canSend}
                onClick={submit}
              >
                <ArrowUpIcon aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {/* The key hint sits in a strip under the box; a phone's keyboard has its own return key. */}
        <p
          id={hintId}
          className={cn(
            '-mt-3 mx-4 truncate rounded-b-xl bg-muted/50 px-3 pt-4 pb-1.5 text-xs text-muted-foreground',
            keyHint && 'max-sm:sr-only',
          )}
        >
          {hint}
        </p>
      </div>
    </div>
  );
});
