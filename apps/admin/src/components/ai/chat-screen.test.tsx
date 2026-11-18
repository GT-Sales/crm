import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiCapabilitiesResponse,
  AiChatRequest,
  AiConversation,
  AiStoredMessage,
  AiStreamPart,
  StaffWorkspace,
} from '@gt-sales/contracts';

import { AssistantPanel } from './assistant-panel';
import { AssistantProvider } from './assistant-provider';
import { AssistantTrigger } from './assistant-trigger';
import { ChatScreen } from './chat-screen';
import { useAskAiPageAvailable } from './chat-nav';
import { CONVERSATION_SEARCH_DELAY_MS } from './conversation-list';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const WORKSPACE: StaffWorkspace = {
  id: WORKSPACE_ID,
  slug: 'canadawide',
  name: 'CanadaWide',
  membershipId: '20000000-0000-4000-8000-000000000001',
  roles: ['owner'],
};
const BASE = '/w/canadawide/chat';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * `usePathname` follows the address the way the App Router does: the history
 * API moves it (Next.js patches pushState/replaceState to notify the router).
 */
const navigation = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('next/navigation', () => ({
  usePathname: () =>
    useSyncExternalStore(
      (listener) => {
        navigation.listeners.add(listener);
        return () => navigation.listeners.delete(listener);
      },
      () => window.location.pathname,
    ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

type AskAiFn = (
  accessToken: string,
  workspaceId: string,
  body: AiChatRequest,
  options?: { signal?: AbortSignal },
) => AsyncGenerator<AiStreamPart, void, undefined>;

const mocks = vi.hoisted(() => ({
  getAiCapabilities: vi.fn(),
  askAiAssistant: vi.fn<AskAiFn>(),
  listAiConversations: vi.fn(),
  getAiConversation: vi.fn(),
  renameAiConversation: vi.fn(),
  deleteAiConversation: vi.fn(),
  createAiAttachmentIntent: vi.fn(),
  finalizeAiAttachment: vi.fn(),
  deleteAiAttachment: vi.fn(),
  getAiAttachmentLink: vi.fn(),
  reviseAiAction: vi.fn(),
  confirmAiAction: vi.fn(),
  saveAiAutomation: vi.fn(),
  reviseAiAutomation: vi.fn(),
  simulateAiAutomation: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class BackendError extends Error {
    readonly code: string;
    readonly status: number;
    readonly requestId: string;
    readonly details?: Record<string, unknown>;
    constructor(
      code: string,
      status = 400,
      requestId = 'req-00000000',
      details?: Record<string, unknown>,
    ) {
      super(code);
      this.code = code;
      this.status = status;
      this.requestId = requestId;
      this.details = details;
    }
  },
}));

/** The bytes' PUT and digest are the browser's; the order of the four steps is what is tested. */
const files = vi.hoisted(() => {
  const steps: string[] = [];
  return { steps, put: vi.fn(), hash: vi.fn() };
});
vi.mock('./attachment-files', async (importOriginal) => {
  const original = await importOriginal<typeof import('./attachment-files')>();
  return { ...original, putAttachmentBytes: files.put, sha256Hex: files.hash };
});

const { BackendError } = await import('../../lib/api');

function capabilities(extra: Partial<AiCapabilitiesResponse> = {}): AiCapabilitiesResponse {
  return {
    available: true,
    site: { id: WORKSPACE_ID, slug: 'canadawide', name: 'CanadaWide' },
    leadTypes: ['sim_order', 'internet'],
    limits: { maxMessageChars: 4_000, maxHistoryMessages: 12, maxConversationChars: 16_000 },
    conversations: true,
    requestId: '00000000-0000-4000-8000-000000000001',
    ...extra,
  };
}

const ATTACHMENTS: NonNullable<AiCapabilitiesResponse['attachments']> = {
  kinds: ['image', 'pdf', 'text'],
  accept: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', '.md'],
  maxPerMessage: 4,
  maxImageBytes: 5 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxTextFileBytes: 512 * 1024,
};

function conversation(n: number, title: string, lastMessageAt = new Date()): AiConversation {
  const at = lastMessageAt.toISOString();
  return { id: id(n), title, createdAt: at, updatedAt: at, lastMessageAt: at };
}

function page(items: readonly AiConversation[], nextCursor?: string) {
  return {
    conversations: items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    requestId: 'req',
  };
}

function stored(
  n: number,
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<AiStoredMessage> = {},
): AiStoredMessage {
  return {
    id: id(100 + n),
    role,
    text,
    outcome: 'completed',
    sources: [],
    expiredDrafts: 0,
    createdAt: new Date().toISOString(),
    attachments: [],
    ...extra,
  };
}

function detail(conv: AiConversation, messages: readonly AiStoredMessage[]) {
  return { conversation: conv, messages, requestId: 'req' };
}

function streamOf(parts: readonly AiStreamPart[]): AsyncGenerator<AiStreamPart, void, undefined> {
  return (async function* generate() {
    for (const part of parts) yield part;
  })();
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function go(path: string): void {
  window.history.replaceState(null, '', path);
}

function Screen({
  accessToken = 'staff-token',
  actorIdentity = 'member-1',
}: {
  accessToken?: string;
  actorIdentity?: string;
}) {
  return (
    <AssistantProvider
      workspace={WORKSPACE}
      accessToken={accessToken}
      actorIdentity={actorIdentity}
    >
      <AssistantTrigger />
      <ChatScreen workspaceSlug="canadawide" />
      <AssistantPanel />
    </AssistantProvider>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function composer(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Ask a question' });
}

const originalPush = window.history.pushState.bind(window.history);
const originalReplace = window.history.replaceState.bind(window.history);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  files.steps.length = 0;
  files.put.mockReset();
  files.hash.mockReset();
  window.history.pushState = (...args: Parameters<History['pushState']>) => {
    originalPush(...args);
    for (const listener of navigation.listeners) listener();
  };
  window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
    originalReplace(...args);
    for (const listener of navigation.listeners) listener();
  };
  go(BASE);
  mocks.getAiCapabilities.mockResolvedValue(capabilities());
  mocks.listAiConversations.mockResolvedValue(page([]));
  mocks.deleteAiAttachment.mockResolvedValue({ attachmentId: id(0), requestId: 'req' });
  mocks.getAiAttachmentLink.mockResolvedValue({
    url: 'https://storage.example.test/file',
    expiresAt: '2099-01-01T00:00:00.000Z',
    requestId: 'req',
  });
});

afterEach(() => {
  window.history.pushState = originalPush;
  window.history.replaceState = originalReplace;
  vi.useRealTimers();
});

describe('Ask AI full page: availability', () => {
  it('shows one loading screen while capabilities load, then the new chat', async () => {
    const answer = deferred<AiCapabilitiesResponse>();
    mocks.getAiCapabilities.mockReturnValue(answer.promise);
    render(<Screen />);
    expect(screen.getByRole('status').textContent).toContain('Loading Ask AI…');
    expect(screen.queryByRole('textbox', { name: 'Ask a question' })).toBeNull();
    await act(async () => answer.resolve(capabilities()));
    expect(
      await screen.findByRole('heading', { name: 'What would you like to know?' }),
    ).toBeTruthy();
    expect(
      screen.getByText('Ask about CanadaWide’s leads, orders, follow-ups or sources.'),
    ).toBeTruthy();
  });

  it('says plainly when the site has no Ask AI, never a broken composer', async () => {
    mocks.getAiCapabilities.mockResolvedValue(
      capabilities({ available: false, reason: 'disabled' }),
    );
    render(<Screen />);
    expect(
      await screen.findByRole('heading', { name: 'Ask AI is not available for this site' }),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('with an older backend (no conversations) the page is calm and the panel is exactly as before', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ conversations: undefined }));
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([
        { type: 'text', text: 'Memory answer' },
        { type: 'done', signature: 'a'.repeat(43) },
      ]),
    );
    render(<Screen />);
    expect(
      await screen.findByRole('heading', { name: 'Ask AI is not available for this site' }),
    ).toBeTruthy();
    expect(mocks.listAiConversations).not.toHaveBeenCalled();
    // The header trigger stays (the page did not take over), and its panel has no full page link.
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    expect(within(panel).queryByRole('link', { name: 'Open full page' })).toBeNull();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'First' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await within(panel).findByText('Memory answer');
    await waitFor(() =>
      expect(within(panel).getByRole('textbox').hasAttribute('disabled')).toBe(false),
    );
    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: 'Second' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.askAiAssistant).toHaveBeenCalledTimes(2));
    const second = mocks.askAiAssistant.mock.calls[1]?.[2];
    expect(second?.conversationId).toBeUndefined();
    expect(second?.history).toEqual([
      { role: 'user', text: 'First' },
      { role: 'assistant', text: 'Memory answer', signature: 'a'.repeat(43) },
    ]);
  });

  it('offers the sidebar and Ctrl/Cmd K entry only when conversations are stored', async () => {
    function Probe() {
      return <p>{useAskAiPageAvailable() ? 'page available' : 'no page'}</p>;
    }
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ conversations: undefined }));
    const { unmount } = render(
      <AssistantProvider workspace={WORKSPACE} accessToken="staff-token">
        <Probe />
      </AssistantProvider>,
    );
    await flush();
    expect(screen.getByText('no page')).toBeTruthy();
    unmount();
    mocks.getAiCapabilities.mockResolvedValue(capabilities());
    render(
      <AssistantProvider workspace={WORKSPACE} accessToken="staff-token">
        <Probe />
      </AssistantProvider>,
    );
    expect(await screen.findByText('page available')).toBeTruthy();
  });

  it('keeps the header trigger away on the page, so the panel never covers it', async () => {
    render(<Screen />);
    await screen.findByRole('heading', { name: 'What would you like to know?' });
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });
});

describe('Ask AI full page: the conversation list', () => {
  it('shows a skeleton, then the conversations grouped with the open one marked', async () => {
    const list = deferred<ReturnType<typeof page>>();
    mocks.listAiConversations.mockReturnValue(list.promise);
    const older = new Date(Date.now() - 40 * 86_400_000);
    go(`${BASE}/${id(1)}`);
    mocks.getAiConversation.mockResolvedValue(detail(conversation(1, 'Today’s leads'), []));
    render(<Screen />);
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    expect(within(nav).getByText('Loading your conversations…')).toBeTruthy();
    await act(async () =>
      list.resolve(page([conversation(1, 'Today’s leads'), conversation(2, 'Old one', older)])),
    );
    expect(within(nav).getByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(within(nav).getByRole('heading', { name: 'Older' })).toBeTruthy();
    const active = within(nav).getByRole('link', { name: 'Today’s leads' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.getAttribute('href')).toBe(`${BASE}/${id(1)}`);
    expect(
      within(nav).getByRole('link', { name: 'Old one' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('says when there are no conversations yet', async () => {
    render(<Screen />);
    expect(await screen.findByText('No conversations yet')).toBeTruthy();
  });

  it('shows a failure in plain words with Try again', async () => {
    mocks.listAiConversations
      .mockRejectedValueOnce(new BackendError('internal_error', 500, 'abcdef1234'))
      .mockResolvedValueOnce(page([conversation(1, 'Back again')]));
    render(<Screen />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "The CRM had a problem and couldn't load your conversations. Try again in a minute; if it keeps happening, tell your admin. (Ref: abcdef12)",
    );
    expect(alert.textContent).not.toContain('internal_error');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Back again' })).toBeTruthy();
  });

  it('loads older pages with Load more', async () => {
    mocks.listAiConversations
      .mockResolvedValueOnce(page([conversation(1, 'Newest')], `1700000000000000.${id(1)}`))
      .mockResolvedValueOnce(page([conversation(2, 'Older one')]));
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Older one' })).toBeTruthy();
    expect(mocks.listAiConversations).toHaveBeenLastCalledWith('staff-token', WORKSPACE_ID, {
      cursor: `1700000000000000.${id(1)}`,
    });
    expect(screen.getByRole('link', { name: 'Newest' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('searches titles a moment after typing stops, once', async () => {
    render(<Screen />);
    await screen.findByText('No conversations yet');
    vi.useFakeTimers();
    mocks.listAiConversations.mockResolvedValue(page([conversation(3, 'Google leads')]));
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: 'Goo' } });
    fireEvent.change(search, { target: { value: 'Google' } });
    act(() => vi.advanceTimersByTime(CONVERSATION_SEARCH_DELAY_MS - 1));
    expect(mocks.listAiConversations).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    vi.useRealTimers();
    expect(mocks.listAiConversations).toHaveBeenCalledTimes(2);
    expect(mocks.listAiConversations).toHaveBeenLastCalledWith('staff-token', WORKSPACE_ID, {
      q: 'Google',
    });
    expect(await screen.findByRole('link', { name: 'Google leads' })).toBeTruthy();
  });

  it('renames in place: Enter saves, Escape cancels, a failure puts the old title back', async () => {
    mocks.listAiConversations.mockResolvedValue(page([conversation(1, 'First title')]));
    mocks.renameAiConversation
      .mockResolvedValueOnce({ conversation: conversation(1, 'Second title'), requestId: 'req' })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Screen />);
    const openRename = async (name: string) => {
      const options = await screen.findByRole('button', { name: `Options for ${name}` });
      fireEvent.pointerDown(options, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      return screen.findByRole('textbox', { name: 'Conversation title' });
    };

    let box = await openRename('First title');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Not this' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(await screen.findByRole('link', { name: 'First title' })).toBeTruthy();
    expect(mocks.renameAiConversation).not.toHaveBeenCalled();

    box = await openRename('First title');
    fireEvent.change(box, { target: { value: '  Second   title ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('link', { name: 'Second title' })).toBeTruthy();
    expect(mocks.renameAiConversation).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE_ID,
      id(1),
      'Second title',
    );

    box = await openRename('Second title');
    fireEvent.change(box, { target: { value: 'Third title' } });
    fireEvent.blur(box);
    expect(await screen.findByRole('link', { name: 'Third title' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Second title' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      "Couldn't reach the CRM to rename the conversation. Check your internet connection and try again.",
    );
  });

  it('deletes after a confirmation that says it is for good; a failure keeps the row', async () => {
    mocks.listAiConversations.mockResolvedValue(
      page([conversation(1, 'Keep me'), conversation(2, 'Remove me')]),
    );
    mocks.deleteAiConversation
      .mockRejectedValueOnce(new BackendError('internal_error', 500, '12345678abc'))
      .mockResolvedValueOnce({ conversationId: id(2), requestId: 'req' });
    render(<Screen />);
    const remove = async () => {
      const options = await screen.findByRole('button', { name: 'Options for Remove me' });
      fireEvent.pointerDown(options, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      return screen.findByRole('dialog', { name: 'Delete this conversation?' });
    };
    let dialog = await remove();
    expect(dialog.textContent).toContain(
      '“Remove me” and the files attached to it will be removed for good. This can’t be undone.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      "couldn't delete the conversation",
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('link', { name: 'Remove me' })).toBeTruthy();

    dialog = await remove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Remove me' })).toBeNull());
    expect(screen.getByRole('link', { name: 'Keep me' })).toBeTruthy();
    expect(mocks.deleteAiConversation).toHaveBeenLastCalledWith('staff-token', WORKSPACE_ID, id(2));
  });

  it('deleting the open conversation goes to a new chat', async () => {
    go(`${BASE}/${id(1)}`);
    mocks.listAiConversations.mockResolvedValue(page([conversation(1, 'Open one')]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conversation(1, 'Open one'), [
        stored(1, 'user', 'Question'),
        stored(2, 'assistant', 'Stored answer'),
      ]),
    );
    mocks.deleteAiConversation.mockResolvedValue({ conversationId: id(1), requestId: 'req' });
    render(<Screen />);
    await screen.findByText('Stored answer');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Options for Open one' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this conversation?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByRole('heading', { name: 'What would you like to know?' }),
    ).toBeTruthy();
    expect(screen.queryByText('Stored answer')).toBeNull();
    expect(window.location.pathname).toBe(BASE);
  });
});

describe('Ask AI full page: a stored conversation', () => {
  it('restores each outcome in plain words, the expired drafts line and the files', async () => {
    go(`${BASE}/${id(1)}`);
    mocks.getAiConversation.mockResolvedValue(
      detail(conversation(1, 'Mixed outcomes'), [
        stored(1, 'user', 'With a file', {
          attachments: [
            {
              id: id(901),
              kind: 'pdf',
              mediaType: 'application/pdf',
              fileName: 'statement.pdf',
              byteSize: 2_400_000,
            },
          ],
        }),
        stored(2, 'assistant', 'Here is a draft.', { expiredDrafts: 2 }),
        stored(3, 'user', 'Slow one'),
        stored(4, 'assistant', '', { outcome: 'failed', errorCode: 'timeout' }),
        stored(5, 'user', 'Odd one'),
        stored(6, 'assistant', '', { outcome: 'failed', errorCode: 'some_future_code' }),
        stored(7, 'user', 'Lost one'),
        stored(8, 'assistant', '', { outcome: 'access_lost' }),
        stored(9, 'user', 'Stopped one'),
        stored(10, 'assistant', 'Half an', { outcome: 'cancelled' }),
      ]),
    );
    render(<Screen />);
    const log = await screen.findByRole('log', { name: 'Conversation' });
    await within(log).findByText('Here is a draft.');
    expect(screen.getByRole('heading', { name: 'Mixed outcomes' })).toBeTruthy();
    expect(
      within(log).getByText(
        'The drafts prepared in this answer are no longer available. Ask again for fresh ones.',
      ),
    ).toBeTruthy();
    expect(
      within(log).getByText(
        'That took too long. Ask about a shorter period or one lead at a time.',
      ),
    ).toBeTruthy();
    expect(
      within(log).getByText(
        'Ask AI had a problem and couldn’t answer. Try again; if it keeps happening, tell your admin.',
      ),
    ).toBeTruthy();
    expect(within(log).getByText('You don’t have access to this site’s leads.')).toBeTruthy();
    expect(log.textContent).not.toContain('some_future_code');
    expect(within(log).getByText('Stopped.')).toBeTruthy();
    // Retry only on the last answer, and a stopped one counts in a stored conversation.
    expect(within(log).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    // No action card comes back: its signed token was never kept.
    expect(within(log).queryByRole('button', { name: 'Confirm' })).toBeNull();
    const file = await within(log).findByRole('link', {
      name: 'Open statement.pdf (PDF, 2.3 MB) in a new tab',
    });
    expect(file.getAttribute('href')).toBe('https://storage.example.test/file');
    expect(file.getAttribute('target')).toBe('_blank');
    expect(file.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mocks.getAiAttachmentLink).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, id(901));
  });

  it('a file whose link cannot be had stays a plain chip, not an error', async () => {
    go(`${BASE}/${id(1)}`);
    mocks.getAiAttachmentLink.mockRejectedValue(new BackendError('internal_error', 500, 'req'));
    mocks.getAiConversation.mockResolvedValue(
      detail(conversation(1, 'Photo'), [
        stored(1, 'user', 'What is this?', {
          attachments: [
            {
              id: id(902),
              kind: 'image',
              mediaType: 'image/png',
              fileName: '<b>photo</b>.png',
              byteSize: 2048,
            },
          ],
        }),
        stored(2, 'assistant', 'A letter.'),
      ]),
    );
    render(<Screen />);
    const name = await screen.findByText('<b>photo</b>.png');
    await waitFor(() => expect(mocks.getAiAttachmentLink).toHaveBeenCalled());
    await flush();
    expect(name.closest('a')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a conversation that is not there is a calm state with a way to a new chat', async () => {
    go(`${BASE}/${id(7)}`);
    mocks.getAiConversation.mockRejectedValue(
      new BackendError('conversation_not_found', 404, 'req'),
    );
    render(<Screen />);
    expect(
      await screen.findByRole('heading', { name: 'This conversation is not available' }),
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Ask a question' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    expect(
      await screen.findByRole('heading', { name: 'What would you like to know?' }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(BASE);
  });

  it('ignores a late answer after switching to another conversation', async () => {
    const first = deferred<ReturnType<typeof detail>>();
    mocks.listAiConversations.mockResolvedValue(
      page([conversation(1, 'First'), conversation(2, 'Second')]),
    );
    mocks.getAiConversation.mockImplementation((_token: string, _ws: string, which: string) =>
      which === id(1)
        ? first.promise
        : Promise.resolve(
            detail(conversation(2, 'Second'), [stored(3, 'assistant', 'Second answer')]),
          ),
    );
    render(<Screen />);
    fireEvent.click(await screen.findByRole('link', { name: 'First' }));
    expect(window.location.pathname).toBe(`${BASE}/${id(1)}`);
    fireEvent.click(screen.getByRole('link', { name: 'Second' }));
    await screen.findByText('Second answer');
    await act(async () =>
      first.resolve(detail(conversation(1, 'First'), [stored(1, 'assistant', 'First answer')])),
    );
    expect(screen.queryByText('First answer')).toBeNull();
    expect(screen.getByText('Second answer')).toBeTruthy();
    expect(window.location.pathname).toBe(`${BASE}/${id(2)}`);
  });

  it('a switch while an answer streams stops it first and drops its late parts', async () => {
    mocks.listAiConversations.mockResolvedValue(page([conversation(2, 'Other')]));
    mocks.getAiConversation.mockResolvedValue(detail(conversation(2, 'Other'), []));
    let signal: AbortSignal | undefined;
    const release = deferred<void>();
    mocks.askAiAssistant.mockImplementation(
      (_t: string, _w: string, _b: AiChatRequest, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return (async function* () {
          yield { type: 'text' as const, text: 'Early words' };
          await release.promise;
          yield { type: 'text' as const, text: 'Late words' };
          yield { type: 'done' as const };
        })();
      },
    );
    render(<Screen />);
    await screen.findByRole('link', { name: 'Other' });
    fireEvent.change(composer(), { target: { value: 'Long question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Early words');
    fireEvent.click(screen.getByRole('link', { name: 'Other' }));
    expect(signal?.aborted).toBe(true);
    await act(async () => release.resolve());
    expect(screen.queryByText('Late words')).toBeNull();
    expect(screen.queryByText('Early words')).toBeNull();
  });
});

describe('Ask AI full page: losing access', () => {
  it('access_lost clears the thread and the list, and the page says Ask AI is unavailable', async () => {
    mocks.listAiConversations.mockResolvedValue(page([conversation(1, 'Private title')]));
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([
        { type: 'text', text: 'Private words' },
        { type: 'error', code: 'access_lost', message: 'Access changed' },
      ]),
    );
    render(<Screen />);
    await screen.findByRole('link', { name: 'Private title' });
    fireEvent.change(composer(), { target: { value: 'Private question' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(
      await screen.findByRole('heading', { name: 'Ask AI is not available right now' }),
    ).toBeTruthy();
    expect(screen.queryByText('Private words')).toBeNull();
    expect(screen.queryByText('Private question')).toBeNull();
    expect(screen.queryByText('Private title')).toBeNull();
  });

  it('drops a late list page and a late conversation after the member changes', async () => {
    const list = deferred<ReturnType<typeof page>>();
    const opened = deferred<ReturnType<typeof detail>>();
    mocks.listAiConversations.mockReturnValueOnce(list.promise);
    mocks.getAiConversation.mockReturnValueOnce(opened.promise);
    go(`${BASE}/${id(1)}`);
    const { rerender } = render(<Screen />);
    await waitFor(() => expect(mocks.getAiConversation).toHaveBeenCalled());
    mocks.listAiConversations.mockResolvedValue(page([]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conversation(1, 'Theirs'), [stored(1, 'assistant', 'Their answer')]),
    );
    // The same provider, now another member: everything the first one asked for is stale.
    rerender(<Screen accessToken="other-token" actorIdentity="member-2" />);
    await act(async () => {
      list.resolve(page([conversation(9, 'Old member’s chat')]));
      opened.resolve(detail(conversation(1, 'Old'), [stored(2, 'assistant', 'Old answer')]));
    });
    await screen.findByText('Their answer');
    expect(screen.queryByText('Old answer')).toBeNull();
    expect(screen.queryByText('Old member’s chat')).toBeNull();
  });
});

describe('Ask AI full page: a new chat', () => {
  it('names the conversation, sends no history, moves the address in place and lists it with the server’s title', async () => {
    mocks.listAiConversations.mockResolvedValue(page([conversation(5, 'Earlier chat')]));
    let request: AiChatRequest | undefined;
    mocks.askAiAssistant.mockImplementation((_t: string, _w: string, body: AiChatRequest) => {
      request = body;
      return streamOf([
        {
          type: 'conversation',
          conversationId: body.conversationId ?? '',
          userMessageId: id(300),
          title: 'Lead count for CanadaWide',
          created: true,
        },
        { type: 'text', text: 'Six leads.' },
        { type: 'done', messageId: id(301) },
      ]);
    });
    render(<Screen />);
    await screen.findByRole('link', { name: 'Earlier chat' });
    const thread = screen.getByRole('log', { name: 'Conversation' });
    fireEvent.change(composer(), { target: { value: 'Count all leads' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(await screen.findByText('Six leads.')).toBeTruthy();
    expect(request?.conversationId).toMatch(UUID);
    expect(request?.history).toEqual([]);
    expect(request?.attachmentIds).toBeUndefined();
    expect(window.location.pathname).toBe(`${BASE}/${request?.conversationId}`);
    // Same thread element: the address moved without a remount or a flash.
    expect(screen.getByRole('log', { name: 'Conversation' })).toBe(thread);
    expect(screen.getByRole('heading', { name: 'Lead count for CanadaWide' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const rows = within(nav).getAllByRole('link');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Lead count for CanadaWide',
      'Earlier chat',
    ]);
    expect(rows[0]?.getAttribute('aria-current')).toBe('page');
  });

  it('a second question goes to the same conversation, still with no history', async () => {
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([{ type: 'text', text: 'Answer.' }, { type: 'done' }]),
    );
    render(<Screen />);
    await screen.findByText('No conversations yet');
    fireEvent.change(composer(), { target: { value: 'One' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await screen.findByText('Answer.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    fireEvent.change(composer(), { target: { value: 'Two' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(mocks.askAiAssistant).toHaveBeenCalledTimes(2));
    const [first, second] = mocks.askAiAssistant.mock.calls.map((call) => call[2]);
    expect(second?.conversationId).toBe(first?.conversationId);
    expect(second?.history).toEqual([]);
    // Without a `conversation` part the row still appears, under the opening words.
    expect(screen.getByRole('link', { name: 'One' })).toBeTruthy();
  });

  it('sends nothing while an input method composes, and Shift+Enter is a new line', async () => {
    render(<Screen />);
    await screen.findByText('No conversations yet');
    fireEvent.change(composer(), { target: { value: 'こんにちは' } });
    fireEvent.compositionStart(composer());
    fireEvent.keyDown(composer(), { key: 'Enter' });
    fireEvent.compositionEnd(composer());
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(mocks.askAiAssistant).not.toHaveBeenCalled();
  });

  it('retries a stopped answer by asking again below it, as the server keeps it', async () => {
    let call = 0;
    mocks.askAiAssistant.mockImplementation(
      (_t: string, _w: string, _b: AiChatRequest, options?: { signal?: AbortSignal }) => {
        call += 1;
        if (call === 2) return streamOf([{ type: 'text', text: 'Full answer' }, { type: 'done' }]);
        return (async function* () {
          yield { type: 'text' as const, text: 'Partial' };
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
        })();
      },
    );
    render(<Screen />);
    await screen.findByText('No conversations yet');
    fireEvent.change(composer(), { target: { value: 'Slow question' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await screen.findByText('Partial');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Full answer')).toBeTruthy();
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(within(log).getAllByText('Slow question')).toHaveLength(2);
    expect(within(log).getByText('Partial')).toBeTruthy();
    const retried = mocks.askAiAssistant.mock.calls[1]?.[2];
    const first = mocks.askAiAssistant.mock.calls[0]?.[2];
    expect(retried?.conversationId).toBe(first?.conversationId);
    expect(retried?.requestId).not.toBe(first?.requestId);
    expect(retried?.history).toEqual([]);
  });

  it('a full conversation says to start a new chat, in plain words', async () => {
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('conversation_full', 409, 'req');
    });
    render(<Screen />);
    await screen.findByText('No conversations yet');
    fireEvent.change(composer(), { target: { value: 'One more' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(
      await within(log).findByText(
        'This conversation is as long as it can get. Start a new chat to go on.',
      ),
    ).toBeTruthy();
    // Refused before its stream began: nothing was stored, so nothing is listed.
    expect(screen.queryByRole('link', { name: 'One more' })).toBeNull();
  });
});

describe('Ask AI full page: attachments', () => {
  function png(name = 'scan.png', size = 1024): File {
    return new File([new Uint8Array(size)], name, { type: 'image/png' });
  }

  function attach(...chosen: File[]): void {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('no file input');
    fireEvent.change(input, { target: { files: chosen } });
  }

  function readyUpload(n: number, file: File) {
    mocks.createAiAttachmentIntent.mockImplementationOnce(async () => {
      files.steps.push(`intent ${file.name}`);
      return {
        uploadId: id(700 + n),
        url: `https://storage.example.test/upload/${n}`,
        method: 'PUT',
        headers: { 'content-type': file.type || 'text/markdown' },
        expiresAt: '2099-01-01T00:00:00.000Z',
        requestId: 'req',
      };
    });
  }

  beforeEach(() => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ attachments: ATTACHMENTS }));
    files.put.mockImplementation(async (input: { url: string; onProgress(f: number): void }) => {
      files.steps.push(`put ${input.url}`);
      input.onProgress(0.5);
    });
    files.hash.mockImplementation(async () => {
      files.steps.push('hash');
      return 'a'.repeat(64);
    });
    mocks.finalizeAiAttachment.mockImplementation(
      async (_t: string, _w: string, attachmentId: string, checksum: string) => {
        files.steps.push(`finalize ${attachmentId} ${checksum.slice(0, 4)}`);
        return {
          attachment: {
            id: attachmentId,
            kind: 'image',
            mediaType: 'image/png',
            fileName: 'scan.png',
            byteSize: 1024,
          },
          requestId: 'req',
        };
      },
    );
  });

  it('offers no attach control when the site offers no kinds', async () => {
    mocks.getAiCapabilities.mockResolvedValue(
      capabilities({ attachments: { ...ATTACHMENTS, kinds: [] } }),
    );
    render(<Screen />);
    await screen.findByText('No conversations yet');
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('uploads in order (intent, PUT, hash, finalize), then sends the file with the question', async () => {
    const file = png();
    readyUpload(1, file);
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([{ type: 'text', text: 'It is a scan.' }, { type: 'done' }]),
    );
    render(<Screen />);
    await screen.findByText('No conversations yet');
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker?.getAttribute('accept')).toBe(ATTACHMENTS.accept.join(','));
    attach(file);
    const chips = await screen.findByRole('list', { name: 'Files to send' });
    await within(chips).findByText('Image · 1 KB');
    expect(files.steps).toEqual([
      'intent scan.png',
      'put https://storage.example.test/upload/1',
      'hash',
      `finalize ${id(701)} aaaa`,
    ]);
    expect(mocks.createAiAttachmentIntent).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, {
      fileName: 'scan.png',
      mediaType: 'image/png',
      byteSize: 1024,
    });
    // Files alone do not send: the message needs words.
    expect(screen.getByText('Add a question to send with the files.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(composer(), { target: { value: 'What is this?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('It is a scan.');
    const body = mocks.askAiAssistant.mock.calls[0]?.[2];
    expect(body?.attachmentIds).toEqual([id(701)]);
    expect(body?.history).toEqual([]);
    expect(screen.queryByRole('list', { name: 'Files to send' })).toBeNull();
    const sent = within(screen.getByRole('log', { name: 'Conversation' })).getByRole('list', {
      name: 'Attached files',
    });
    // The sent image shows as a picture through its link, named by its file name.
    expect(await within(sent).findByRole('img', { name: 'scan.png' })).toBeTruthy();
  });

  it('keeps Send disabled while a file uploads, and shows its progress', async () => {
    const file = png();
    readyUpload(1, file);
    const hold = deferred<void>();
    files.put.mockImplementationOnce(async (input: { onProgress(f: number): void }) => {
      input.onProgress(0.4);
      await hold.promise;
    });
    render(<Screen />);
    await screen.findByText('No conversations yet');
    attach(file);
    const bar = await screen.findByRole('progressbar', { name: 'Uploading scan.png' });
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('40'));
    fireEvent.change(composer(), { target: { value: 'What is this?' } });
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Waiting for the files to finish uploading…')).toBeTruthy();
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(mocks.askAiAssistant).not.toHaveBeenCalled();
    await act(async () => hold.resolve());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false),
    );
  });

  it('refuses a type or a size before any request, in plain words on the chip', async () => {
    render(<Screen />);
    await screen.findByText('No conversations yet');
    attach(
      new File(['GIF89a'], 'funny.gif', { type: 'image/gif' }),
      png('huge.png', 6 * 1024 * 1024),
    );
    const chips = await screen.findByRole('list', { name: 'Files to send' });
    expect(
      within(chips).getByText(
        'That kind of file can’t be attached here. Attach an image (PNG, JPEG or WebP), a PDF or a text file (.txt, .csv or .md).',
      ),
    ).toBeTruthy();
    expect(
      within(chips).getByText('That file is too large. An image can be up to 5 MB.'),
    ).toBeTruthy();
    expect(mocks.createAiAttachmentIntent).not.toHaveBeenCalled();
  });

  it('maps a .md file the browser gives no type to text/markdown before asking', async () => {
    const notes = new File(['# Notes'], 'notes.md', { type: '' });
    readyUpload(1, notes);
    render(<Screen />);
    await screen.findByText('No conversations yet');
    attach(notes);
    await waitFor(() => expect(mocks.createAiAttachmentIntent).toHaveBeenCalled());
    expect(mocks.createAiAttachmentIntent.mock.calls[0]?.[2]).toMatchObject({
      fileName: 'notes.md',
      mediaType: 'text/markdown',
    });
  });

  it('takes at most four files and says the rest were left out', async () => {
    for (let n = 1; n <= 4; n += 1) readyUpload(n, png(`p${n}.png`));
    render(<Screen />);
    await screen.findByText('No conversations yet');
    attach(...[1, 2, 3, 4, 5].map((n) => png(`p${n}.png`)));
    expect(
      await screen.findByText(
        'You can attach up to 4 files to one message. The rest were left out.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(mocks.createAiAttachmentIntent).toHaveBeenCalledTimes(4));
    const chips = screen.getByRole('list', { name: 'Files to send' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(4);
    expect(within(chips).queryByText('p5.png')).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach files' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('a refusal by the server shows on the chip; removing a ready file deletes it', async () => {
    const good = png('good.png');
    const bad = png('bad.png');
    readyUpload(1, good);
    readyUpload(2, bad);
    mocks.finalizeAiAttachment
      .mockImplementationOnce(async (_t: string, _w: string, attachmentId: string) => ({
        attachment: {
          id: attachmentId,
          kind: 'image',
          mediaType: 'image/png',
          fileName: 'good.png',
          byteSize: 1024,
        },
        requestId: 'req',
      }))
      .mockRejectedValueOnce(
        new BackendError('attachment_rejected', 400, 'req', { reason: 'unreadable' }),
      );
    render(<Screen />);
    await screen.findByText('No conversations yet');
    attach(good, bad);
    expect(
      await screen.findByText('That file could not be read. Save it again or choose another file.'),
    ).toBeTruthy();
    await screen.findByText('Image · 1 KB');
    fireEvent.click(screen.getByRole('button', { name: 'Remove good.png' }));
    expect(screen.queryByText('good.png')).toBeNull();
    expect(mocks.deleteAiAttachment).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, id(701));
    expect(document.activeElement).toBe(composer());
  });

  it('cancelling an upload drops its late steps and deletes what the server began', async () => {
    const file = png();
    readyUpload(1, file);
    const hold = deferred<void>();
    files.put.mockImplementationOnce(async () => hold.promise);
    render(<Screen />);
    await screen.findByText('No conversations yet');
    attach(file);
    await waitFor(() => expect(files.put).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the upload of scan.png' }));
    expect(mocks.deleteAiAttachment).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, id(701));
    await act(async () => hold.resolve());
    expect(mocks.finalizeAiAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Files to send' })).toBeNull();
  });

  it('a pasted screenshot becomes a file', async () => {
    readyUpload(1, png('image.png'));
    render(<Screen />);
    await screen.findByText('No conversations yet');
    const shot = png('image.png');
    fireEvent.paste(composer(), {
      clipboardData: { files: [shot], getData: () => '' },
    });
    await waitFor(() => expect(mocks.createAiAttachmentIntent).toHaveBeenCalledTimes(1));
  });

  it('files dropped on the chat are attached, with a visible drop target while dragging', async () => {
    readyUpload(1, png());
    render(<Screen />);
    await screen.findByText('No conversations yet');
    const chat = screen.getByRole('region', { name: 'New chat' });
    const dataTransfer = { types: ['Files'], files: [png()], dropEffect: 'none' };
    fireEvent.dragEnter(chat, { dataTransfer });
    expect(screen.getByText('Drop files to attach them to your question')).toBeTruthy();
    fireEvent.drop(chat, { dataTransfer });
    expect(screen.queryByText('Drop files to attach them to your question')).toBeNull();
    await waitFor(() => expect(mocks.createAiAttachmentIntent).toHaveBeenCalledTimes(1));
  });
});

describe('Ask AI side panel with stored conversations', () => {
  function PanelOnly() {
    return (
      <AssistantProvider workspace={WORKSPACE} accessToken="staff-token" actorIdentity="member-1">
        <AssistantTrigger />
        <AssistantPanel />
      </AssistantProvider>
    );
  }

  it('sends into a stored conversation and offers the full page for it', async () => {
    go('/w/canadawide/leads');
    let signal: AbortSignal | undefined;
    const release = deferred<void>();
    mocks.askAiAssistant.mockImplementation(
      (_t: string, _w: string, _b: AiChatRequest, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return (async function* () {
          yield { type: 'text' as const, text: 'Working on it' };
          await release.promise;
          yield { type: 'done' as const };
        })();
      },
    );
    render(<PanelOnly />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    const full = within(panel).getByRole('link', { name: 'Open full page' });
    expect(full.getAttribute('href')).toBe(BASE);
    // No list and no attach control in the panel: it stays the quick-question surface.
    expect(within(panel).queryByRole('navigation')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Attach files' })).toBeNull();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'Quick one' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await within(panel).findByText('Working on it');
    const body = mocks.askAiAssistant.mock.calls[0]?.[2];
    expect(body?.conversationId).toMatch(UUID);
    expect(body?.history).toEqual([]);
    const link = within(panel).getByRole('link', { name: 'Open full page' });
    expect(link.getAttribute('href')).toBe(`${BASE}/${body?.conversationId}`);
    // Opening the full page closes the panel but keeps the answer coming.
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull());
    expect(signal?.aborted).toBe(false);
    await act(async () => release.resolve());
  });
});
