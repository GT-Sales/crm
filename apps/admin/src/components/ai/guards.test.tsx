import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { ERASED_MESSAGE_TEXT, FILE_LIMIT_TEXT } from './assistant-message';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const WORKSPACE: StaffWorkspace = {
  id: WORKSPACE_ID,
  slug: 'canadawide',
  name: 'CanadaWide',
  membershipId: '20000000-0000-4000-8000-000000000001',
  roles: ['owner'],
};
const BASE = '/w/canadawide/chat';

const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * `usePathname` follows the address the way the App Router does: the history
 * API moves it (Next.js patches pushState/replaceState to notify the router).
 * With `lag` on, the router shows each move only when the test says so, as a
 * busy App Router does (it may even show an older address first).
 */
const navigation = vi.hoisted(() => {
  const queue: string[] = [];
  return { listeners: new Set<() => void>(), shown: '/', lag: false, queue };
});
vi.mock('next/navigation', () => ({
  usePathname: () =>
    useSyncExternalStore(
      (listener) => {
        navigation.listeners.add(listener);
        return () => navigation.listeners.delete(listener);
      },
      () => navigation.shown,
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
  navigation.lag = false;
  navigation.queue.length = 0;
  const follow = () => {
    const path = window.location.pathname;
    if (navigation.lag) navigation.queue.push(path);
    else {
      navigation.shown = path;
      for (const listener of navigation.listeners) listener();
    }
  };
  window.history.pushState = (...args: Parameters<History['pushState']>) => {
    originalPush(...args);
    follow();
  };
  window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
    originalReplace(...args);
    follow();
  };
  go(BASE);
  mocks.getAiCapabilities.mockResolvedValue(capabilities());
  mocks.listAiConversations.mockResolvedValue(page([]));
  mocks.deleteAiAttachment.mockResolvedValue({ attachmentId: id(0), requestId: 'req' });
  // A link lives two minutes by the server's clock, as the real one does.
  mocks.getAiAttachmentLink.mockImplementation(async () => ({
    url: 'https://storage.example.test/file',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    requestId: 'req',
  }));
});

afterEach(() => {
  window.history.pushState = originalPush;
  window.history.replaceState = originalReplace;
  vi.useRealTimers();
});

function answerWith(text: string, extra: readonly AiStreamPart[] = []) {
  mocks.askAiAssistant.mockImplementation(() =>
    streamOf([...extra, { type: 'text', text }, { type: 'done', messageId: id(900) }]),
  );
}

async function ask(question: string): Promise<void> {
  await waitFor(() => expect(composer().hasAttribute('disabled')).toBe(false));
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.keyDown(composer(), { key: 'Enter' });
}

const log = () => within(screen.getByRole('log', { name: 'Conversation' }));

describe('Ask AI guards in the chat (audit B2, B7)', () => {
  it('shows a turn emptied by a customer’s erasure as one plain line', async () => {
    const conv = conversation(1, 'Chat with a removed message');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conv, [
        stored(1, 'user', '', { erased: true }),
        stored(2, 'assistant', '', { erased: true }),
        stored(3, 'user', 'And the other order?'),
        stored(4, 'assistant', 'It shipped.'),
      ]),
    );
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    await screen.findByText('It shipped.');
    expect(log().getAllByText(ERASED_MESSAGE_TEXT)).toHaveLength(1);
    expect(log().queryByText('No answer came back. Try asking in another way.')).toBeNull();
    expect(log().getByText('And the other order?')).toBeTruthy();
    // The emptied answer offers nothing to copy: only the other answer does.
    expect(log().getAllByRole('button', { name: 'Copy answer' })).toHaveLength(1);
  });

  it('says the day’s file limit is used up when the answer’s stream says so', async () => {
    answerWith('Answered without the files.', [
      { type: 'notice', code: 'attachment_budget_spent' },
    ]);
    render(<Screen />);
    await screen.findByRole('heading', { name: 'What would you like to know?' });
    await ask('What does the PDF say?');
    await log().findByText('Answered without the files.');
    expect(log().getByText(FILE_LIMIT_TEXT)).toBeTruthy();
    expect(FILE_LIMIT_TEXT).toBe(
      'Today’s file limit for Ask AI is used up. Files will be read again tomorrow.',
    );
  });

  it('says nothing about files on an ordinary answer', async () => {
    answerWith('Fine.');
    render(<Screen />);
    await screen.findByRole('heading', { name: 'What would you like to know?' });
    await ask('How many orders?');
    await log().findByText('Fine.');
    expect(screen.queryByText(FILE_LIMIT_TEXT)).toBeNull();
  });

  it('tells the person to delete old chats when they have as many as Ask AI keeps', async () => {
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('conversation_limit_reached', 409, 'req-00000003', { limit: 500 });
    });
    render(<Screen />);
    await screen.findByRole('heading', { name: 'What would you like to know?' });
    await ask('A new question');
    const sentence =
      'You have 500 saved chats on this site, the most Ask AI keeps. Delete old chats to start a new one.';
    expect(await log().findByText(sentence)).toBeTruthy();
    // Asking the same again can only fail again: no Retry.
    expect(log().queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
