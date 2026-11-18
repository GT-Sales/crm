'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { PanelLeftOpenIcon, SparklesIcon, SquarePenIcon, UploadIcon } from 'lucide-react';
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Skeleton,
  cn,
} from '@gt-sales/ui';

import { useAssistant } from './assistant-provider';
import { announcementFor, useConversationScroll } from './assistant-shared';
import { ChatComposer, type ChatComposerHandle } from './chat-composer';
import { ChatThread } from './chat-thread';
import { ConversationList } from './conversation-list';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation id in `/w/<site>/chat/<id>`; undefined for a new chat (or a malformed id). */
export function chatIdFromPath(pathname: string | null): string | undefined | null {
  const parts = (pathname ?? '').split('/');
  if (parts[3] !== 'chat') return undefined;
  const id = parts[4];
  if (id === undefined || id.length === 0) return undefined;
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** The frame both columns sit in: the page's whole height under the top bar, like Mail. */
const FRAME =
  'grid h-[calc(100dvh-5.5rem)] min-h-[26rem] overflow-hidden rounded-2xl border bg-card md:h-[calc(100dvh-6.5rem)] md:grid-cols-[17.5rem_minmax(0,1fr)]';

function ChatSkeleton() {
  return (
    <div role="status" className={FRAME}>
      <span className="sr-only">Loading Ask AI…</span>
      <div aria-hidden="true" className="hidden flex-col gap-2 border-r bg-sidebar/60 p-3 md:flex">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-8 w-full" />
        <div className="mt-3 flex flex-col gap-3 px-2">
          <Skeleton className="h-3 w-14" />
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className={index % 2 ? 'h-4 w-3/5' : 'h-4 w-4/5'} />
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="flex min-w-0 flex-col">
        <div className="flex h-12 items-center gap-2 border-b px-3">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <Skeleton className="size-11 rounded-2xl" />
          <Skeleton className="h-5 w-56 max-w-full" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        <div className="p-3">
          <Skeleton className="mx-auto h-24 w-full max-w-3xl rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function Unavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn(FRAME, 'md:grid-cols-1')}>
      <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <SparklesIcon aria-hidden="true" className="size-5" />
        </span>
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="max-w-md text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

/**
 * Moves the address within the page. Both chat routes draw nothing of their
 * own (the layout draws the screen), so the history API, which the App Router
 * follows, is all a move needs: no server round trip that could land after
 * the member has already started typing in the new place. Returns false when
 * the address is already there.
 */
function writeAddress(url: string, mode: 'push' | 'replace'): boolean {
  if (window.location.pathname === url) return false;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  return true;
}

/** How long an address move of the page's own may take to show in `usePathname`. */
const MOVE_SETTLE_MS = 10_000;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Ask AI as a full page: the member's saved conversations on the left (a
 * drawer on a phone) and the open one on the right, with the composer pinned
 * under it. The address is the state: `/chat/<id>` opens that conversation,
 * and the first message of a new chat moves the address to its new id with
 * `history.replaceState`, which the App Router follows without re-rendering
 * the route, so the thread stays where it is. Everything shown is the
 * provider's state, the same the side panel shows.
 */
export function ChatScreen({ workspaceSlug }: { workspaceSlug: string }) {
  const assistant = useAssistant();
  const {
    capabilities,
    conversations,
    messages,
    streaming,
    siteName,
    newChat,
    attachments,
    registerChatPage,
  } = assistant;
  const pathname = usePathname();
  const urlId = chatIdFromPath(pathname);
  const base = `/w/${workspaceSlug}/chat`;
  const enabled = conversations.enabled;
  const activeId = conversations.activeId;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const composerRef = useRef<ChatComposerHandle>(null);
  const { scrollRef, atBottom, onScroll, jumpToLatest, resetToBottom } = useConversationScroll(
    messages,
    enabled,
  );

  // The page and the header's panel are the same conversation: while the page
  // is here the panel stays shut and its trigger away.
  useEffect(() => {
    if (!enabled) return;
    return registerChatPage();
  }, [enabled, registerChatPage]);

  // The first page of the list, and a quiet refresh each time the page opens.
  const { loadList } = conversations;
  useEffect(() => {
    if (enabled) loadList();
  }, [enabled, loadList]);

  // The page's own address moves. Until the router shows the address the page
  // wrote, any other address it shows is the router catching up (it rewrites
  // its last committed address while a newer one is still on its way), never
  // the member's intent, so it must not open or clear a conversation.
  const ownMove = useRef<{ target: string | undefined; until: number } | null>(null);
  const moveTo = useCallback((url: string, mode: 'push' | 'replace') => {
    const target = chatIdFromPath(url) ?? undefined;
    if (writeAddress(url, mode)) ownMove.current = { target, until: Date.now() + MOVE_SETTLE_MS };
  }, []);
  // Address → conversation, for moves from outside the page: the first load,
  // back and forward, a link from elsewhere. The page's own moves change the
  // conversation first and then the address. Reads the newest provider state
  // without running again when it changes.
  const latest = useRef({ activeId, enabled, open: conversations.open, newChat });
  latest.current = { activeId, enabled, open: conversations.open, newChat };
  const follow = useCallback(
    (target: string | undefined) => {
      const current = latest.current;
      if (target === undefined) {
        if (current.activeId !== undefined) current.newChat();
      } else if (target !== current.activeId) {
        current.open(target);
      }
      resetToBottom();
    },
    [resetToBottom],
  );
  useEffect(() => {
    // Back and forward are the member's own moves: follow the address bar at
    // once (the router may not have shown the move it is undoing yet), and
    // stop waiting for a move of the page's own.
    const onPopState = () => {
      ownMove.current = null;
      if (!latest.current.enabled) return;
      const target = chatIdFromPath(window.location.pathname);
      if (target !== null) follow(target);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [follow]);
  useEffect(() => {
    if (!enabled || urlId === null) return;
    const pending = ownMove.current;
    if (pending !== null) {
      if (urlId === pending.target) {
        ownMove.current = null;
        return;
      }
      if (Date.now() < pending.until) return;
      ownMove.current = null;
    }
    follow(urlId);
  }, [enabled, follow, urlId]);

  // Conversation → address: a new chat that was just given its id moves the
  // address there in place. Only the step from no conversation to one counts.
  const previousActive = useRef(activeId);
  useEffect(() => {
    const before = previousActive.current;
    previousActive.current = activeId;
    if (!enabled || before !== undefined || activeId === undefined) return;
    // The address bar, not `usePathname`, which may still be catching up with
    // a move made a moment ago (New chat, then a question at once).
    moveTo(`${base}/${activeId}`, 'replace');
  }, [activeId, base, enabled, moveTo]);

  const startNewChat = useCallback(() => {
    newChat();
    resetToBottom();
    composerRef.current?.focus();
  }, [newChat, resetToBottom]);

  const announcement = announcementFor(messages, streaming);

  if (capabilities.status === 'loading') return <ChatSkeleton />;
  if (capabilities.status === 'failed') {
    return (
      <Unavailable title="Ask AI is not available right now">
        <p>
          The CRM could not say whether Ask AI is on for this site. Reload the page to try again.
        </p>
      </Unavailable>
    );
  }
  if (!capabilities.data.available || !enabled) {
    return (
      <Unavailable title="Ask AI is not available for this site">
        <p>
          {!capabilities.data.available
            ? capabilities.data.reason === 'disabled'
              ? 'The owner has switched it off. Ask the owner if you need it.'
              : 'It has not been set up for this site yet. Ask the owner if you need it.'
            : 'Saved conversations are not switched on here yet. You can still ask quick questions from Ask AI in the top bar.'}
        </p>
      </Unavailable>
    );
  }

  if (urlId === null) {
    // `/chat/<not an id>`: the same calm answer a missing conversation gets.
    return (
      <Unavailable title="This conversation is not available">
        <Button
          className="mt-1"
          onClick={() => {
            startNewChat();
            moveTo(base, 'replace');
          }}
        >
          Start a new chat
        </Button>
      </Unavailable>
    );
  }

  const list = (onNavigate?: () => void) => (
    <ConversationList
      hrefFor={(id) => `${base}/${id}`}
      newChatHref={base}
      onOpen={(id) => {
        // The page opens it itself; the address follows.
        conversations.open(id);
        resetToBottom();
        moveTo(`${base}/${id}`, 'push');
        onNavigate?.();
      }}
      onNewChat={() => {
        startNewChat();
        moveTo(base, 'push');
        onNavigate?.();
      }}
      onDeleted={(_id, wasActive) => {
        if (wasActive) {
          moveTo(base, 'replace');
          composerRef.current?.focus();
        }
      }}
    />
  );

  const title = activeId === undefined ? 'New chat' : (conversations.title ?? 'Conversation');
  const canDrop = attachments.settings !== undefined && conversations.load.status === 'idle';

  return (
    <div className={FRAME}>
      <h1 className="sr-only">Ask AI</h1>
      <aside
        aria-label="Your conversations"
        className="hidden min-h-0 flex-col border-r bg-sidebar/60 md:flex"
      >
        {/* Exactly one list at a time: while the phone's drawer shows it, this one is gone. */}
        {drawerOpen ? null : list()}
      </aside>

      <section
        aria-label={title}
        className="relative flex min-h-0 min-w-0 flex-col"
        onDragEnter={(event) => {
          if (!canDrop || !hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!canDrop || !hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          if (!dragging) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          if (!canDrop || !hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          attachments.add(Array.from(event.dataTransfer.files));
          composerRef.current?.focus();
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b bg-crm-header px-2 sm:px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 md:hidden"
            aria-label="Show conversations"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 px-1">
            <h2 className="truncate text-[13px] font-semibold" title={title}>
              {title}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">{siteName}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 md:hidden"
            aria-label="New chat"
            onClick={() => {
              startNewChat();
              moveTo(base, 'push');
            }}
          >
            <SquarePenIcon aria-hidden="true" className="size-4" />
          </Button>
        </header>

        <ChatThread
          scrollRef={scrollRef}
          onScroll={onScroll}
          atBottom={atBottom}
          onJumpToLatest={jumpToLatest}
          onAsk={(question) => composerRef.current?.ask(question)}
          onNewChat={() => {
            startNewChat();
            moveTo(base, 'replace');
          }}
        />
        <ChatComposer ref={composerRef} />

        {dragging ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 text-sm font-medium text-primary"
          >
            <UploadIcon className="size-6" />
            Drop files to attach them to your question
          </div>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </section>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="flex w-[19rem] max-w-[85vw] flex-col gap-0 p-0">
          <SheetTitle className="border-b px-4 py-3 pr-10 text-sm">Your conversations</SheetTitle>
          <SheetDescription className="sr-only">
            Choose a conversation to open it, or start a new chat.
          </SheetDescription>
          {drawerOpen ? list(() => setDrawerOpen(false)) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
