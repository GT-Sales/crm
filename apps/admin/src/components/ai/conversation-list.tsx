'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  EllipsisIcon,
  MessagesSquareIcon,
  PencilIcon,
  SearchIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { AI_CHAT_LIMITS, type AiConversation } from '@gt-sales/contracts';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Skeleton,
} from '@gt-sales/ui';

import { useAssistant } from './assistant-provider';
import { groupConversations } from './conversation-groups';
import { isPlainClick } from './chat-links';

export { CONVERSATION_SEARCH_DELAY_MS } from './assistant-provider';

function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" className="flex flex-col gap-1 px-2 py-2">
      <span className="sr-only">Loading your conversations…</span>
      <Skeleton aria-hidden="true" className="mx-2 mt-1 mb-2 h-3 w-14" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          aria-hidden="true"
          className={cn(
            'mx-2 my-1.5 h-4',
            index % 3 === 0 ? 'w-4/5' : index % 3 === 1 ? 'w-3/5' : 'w-2/3',
          )}
        />
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  href,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  conversation: AiConversation;
  href: string;
  active: boolean;
  onOpen(id: string): void;
  onRename(title: string): void;
  onDelete(trigger: HTMLElement | null): void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  // Set while the menu closes into the rename box, so the menu's focus return
  // does not blur (and so commit) the box it just opened.
  const renamingRef = useRef(false);
  const doneRef = useRef(false);
  // Set when the edit ends by Enter or Escape: the row takes focus back.
  const refocusRef = useRef(false);

  useEffect(() => {
    if (editing) {
      const input = inputRef.current;
      input?.focus();
      input?.select();
      return;
    }
    // In the commit that puts the row back, never a frame later: a deferred
    // focus could land after the member's next action (an opened menu closes
    // when focus leaves it).
    if (!refocusRef.current) return;
    refocusRef.current = false;
    linkRef.current?.focus();
  }, [editing]);

  function startEditing(): void {
    renamingRef.current = true;
    doneRef.current = false;
    setValue(conversation.title);
    setEditing(true);
  }

  /**
   * Ends the edit. Enter and Escape leave focus on the row; a click elsewhere
   * (the box's blur) leaves it wherever the member clicked.
   */
  function finish(commit: boolean, refocus: boolean): void {
    if (doneRef.current) return;
    doneRef.current = true;
    refocusRef.current = refocus;
    setEditing(false);
    if (commit) onRename(value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false, true);
    }
  }

  return (
    <li className="group/row relative">
      {editing ? (
        <Input
          ref={inputRef}
          aria-label="Conversation title"
          value={value}
          maxLength={AI_CHAT_LIMITS.maxTitleChars}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => finish(true, false)}
          className="h-9 rounded-lg bg-background px-2.5 text-[13px] md:text-[13px]"
        />
      ) : (
        <Link
          ref={linkRef}
          href={href}
          aria-current={active ? 'page' : undefined}
          onClick={(event) => {
            // A new tab or window opens the address; a plain click opens it here.
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onOpen(conversation.id);
          }}
          title={conversation.title}
          className={cn(
            'flex h-9 min-w-0 items-center rounded-lg px-2.5 pr-9 text-[13px] text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
            active && 'bg-accent text-accent-foreground hover:bg-accent',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
        </Link>
      )}
      {editing ? null : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              ref={menuRef}
              type="button"
              aria-label={`Options for ${conversation.title}`}
              className={cn(
                'absolute top-1 right-1 grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-background data-[state=open]:opacity-100',
                // Always there on touch screens; on a desktop it shows with the row.
                'md:opacity-0 md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100',
                active && 'md:opacity-100',
              )}
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onCloseAutoFocus={(event) => {
              if (renamingRef.current) {
                event.preventDefault();
                renamingRef.current = false;
              }
            }}
          >
            <DropdownMenuItem onSelect={startEditing}>
              <PencilIcon aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={() => onDelete(menuRef.current)}
            >
              <Trash2Icon aria-hidden="true" className="text-destructive" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

function DeleteConversationDialog({
  conversation,
  onCancel,
  onDeleted,
  returnFocus,
}: {
  conversation: AiConversation | undefined;
  onCancel(): void;
  onDeleted(id: string, wasActive: boolean): void;
  returnFocus(): void;
}) {
  const { conversations } = useAssistant();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const shown = useRef<AiConversation | undefined>(undefined);
  if (conversation !== undefined) shown.current = conversation;
  const target = conversation ?? shown.current;

  useEffect(() => {
    if (conversation === undefined) return;
    setPending(false);
    setError(undefined);
  }, [conversation]);

  async function confirm(): Promise<void> {
    if (target === undefined || pending) return;
    setPending(true);
    setError(undefined);
    const wasActive = target.id === conversations.activeId;
    const result = await conversations.remove(target.id);
    setPending(false);
    if (result.ok) onDeleted(target.id, wasActive);
    else setError(result.message);
  }

  return (
    <Dialog
      open={conversation !== undefined}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete this conversation?</DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">
            “{target?.title}” and the files attached to it will be removed for good. This can’t be
            undone.
          </DialogDescription>
        </DialogHeader>
        {error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The member's saved conversations: New chat, a title search, the list in
 * date groups with the open one marked, a menu per row to rename (in place)
 * or delete (after a confirmation), and Load more for older pages. Rows are
 * links, so the address is always the open conversation.
 */
export function ConversationList({
  hrefFor,
  newChatHref,
  onOpen,
  onNewChat,
  onDeleted,
  now,
}: {
  hrefFor(id: string): string;
  newChatHref: string;
  /** A row was chosen with a plain click: open it in this page. */
  onOpen(id: string): void;
  /** New chat was chosen with a plain click. */
  onNewChat(): void;
  onDeleted(id: string, wasActive: boolean): void;
  /** For tests: the moment the groups are counted from. */
  now?: Date;
}) {
  const { conversations } = useAssistant();
  const { list, activeId, loadList, loadMore, rename, dismissNotice } = conversations;
  const searchId = useId();
  const query = list.search;
  const setQuery = conversations.setSearch;
  const [deleting, setDeleting] = useState<AiConversation>();
  const focusAfterDelete = useRef<HTMLElement | null>(null);
  const newChatRef = useRef<HTMLAnchorElement>(null);
  const groups = useMemo(() => groupConversations(list.items, now), [list.items, now]);
  const term = query.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1 p-2 pb-1">
        <p className="px-2.5 pt-1 pb-1 text-xs font-medium text-muted-foreground">Actions</p>
        <Button
          asChild
          variant="ghost"
          className="h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-[13px] font-medium"
        >
          <Link
            ref={newChatRef}
            href={newChatHref}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onNewChat();
            }}
          >
            <SquarePenIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            New chat
          </Link>
        </Button>
        {/* The section label and the title search share a line, as the reference's Chats row does. */}
        <div className="mt-2 flex items-center gap-2 px-2.5">
          <p className="text-xs font-medium text-muted-foreground">Chats</p>
          <div className="relative min-w-0 flex-1">
            <label htmlFor={searchId} className="sr-only">
              Search conversations
            </label>
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              maxLength={AI_CHAT_LIMITS.maxTitleChars}
              placeholder="Search titles"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query.length > 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }
              }}
              className="h-7 rounded-md border-transparent bg-transparent pr-7 pl-7 text-xs shadow-none hover:bg-accent/50 focus-visible:bg-background md:text-xs [&::-webkit-search-cancel-button]:hidden"
            />
            {query.length > 0 ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-0.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {list.notice === undefined ? null : (
        <div
          role="alert"
          className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1">{list.notice}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissNotice}
            className="grid size-5 shrink-0 place-items-center rounded outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </button>
        </div>
      )}

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {list.status === 'idle' || (list.status === 'loading' && list.items.length === 0) ? (
          <ListSkeleton />
        ) : list.status === 'error' ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p role="alert" className="text-sm text-muted-foreground">
              {list.error}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => loadList(term)}>
              Try again
            </Button>
          </div>
        ) : list.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <MessagesSquareIcon aria-hidden="true" className="size-6 text-muted-foreground" />
            {list.query.length === 0 ? (
              <>
                <p className="text-sm font-medium">No conversations yet</p>
                <p className="text-xs text-muted-foreground">
                  Your questions and answers are saved here, for you only.
                </p>
              </>
            ) : (
              <p className="text-sm break-words text-muted-foreground [overflow-wrap:anywhere]">
                No conversation title matches “{list.query}”.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-2 py-2">
            {groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h3 className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="flex flex-col gap-px">
                  {group.items.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      href={hrefFor(conversation.id)}
                      active={conversation.id === activeId}
                      onOpen={onOpen}
                      onRename={(title) => void rename(conversation.id, title)}
                      onDelete={(trigger) => {
                        focusAfterDelete.current = trigger;
                        setDeleting(conversation);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {list.nextCursor !== undefined || list.moreError !== undefined ? (
              <div className="flex flex-col items-stretch gap-2 px-1 pb-2">
                {list.moreError === undefined ? null : (
                  <p role="alert" className="px-1 text-xs text-destructive">
                    {list.moreError}
                  </p>
                )}
                {list.nextCursor === undefined ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={list.loadingMore}
                    onClick={loadMore}
                  >
                    {list.loadingMore
                      ? 'Loading…'
                      : list.moreError === undefined
                        ? 'Load more'
                        : 'Try again'}
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </nav>
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Only you can see your conversations.
      </p>

      <DeleteConversationDialog
        conversation={deleting}
        onCancel={() => setDeleting(undefined)}
        onDeleted={(id, wasActive) => {
          setDeleting(undefined);
          // The row is gone: focus goes to New chat rather than to nowhere.
          focusAfterDelete.current = newChatRef.current;
          onDeleted(id, wasActive);
        }}
        returnFocus={() => {
          const target = focusAfterDelete.current;
          focusAfterDelete.current = null;
          if (target?.isConnected) target.focus();
          else newChatRef.current?.focus();
        }}
      />
    </div>
  );
}
