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

const EFFORTS: Partial<AiCapabilitiesResponse> = { efforts: ['normal', 'high'] };
const ONLY_NORMAL: Partial<AiCapabilitiesResponse> = { efforts: ['normal'] };

function lastRequest(): AiChatRequest | undefined {
  return mocks.askAiAssistant.mock.calls.at(-1)?.[2];
}

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

function effortGroup(scope: HTMLElement = document.body) {
  return within(scope).queryByRole('radiogroup', { name: 'Effort' });
}

describe('effort levels: the control', () => {
  it.each([
    ['no efforts (an older backend, or High off)', {}],
    ['only Normal', ONLY_NORMAL],
  ])('is absent with %s, and the request carries no effort', async (_label, extra) => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(extra));
    answerWith('Fine.');
    render(<Screen />);
    await screen.findByRole('heading', { name: 'What would you like to know?' });
    expect(effortGroup()).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    await ask('How many orders?');
    await screen.findByText('Fine.');
    expect(lastRequest()).not.toHaveProperty('effort');
    expect(screen.queryByText('High effort')).toBeNull();
  });

  it('is absent from an older backend’s memory-only panel too', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ conversations: undefined }));
    go('/w/canadawide/leads');
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    expect(effortGroup(panel)).toBeNull();
    expect(within(panel).getByText('Enter to send · Shift+Enter for a new line')).toBeTruthy();
  });

  it('offers Normal and High beside Send, Normal by default, as a keyboard radio group', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(EFFORTS));
    render(<Screen />);
    const group = await screen.findByRole('radiogroup', { name: 'Effort' });
    const normal = within(group).getByRole('radio', { name: 'Normal' });
    const high = within(group).getByRole('radio', { name: 'High' });
    expect(normal.getAttribute('aria-checked')).toBe('true');
    expect(high.getAttribute('aria-checked')).toBe('false');
    expect(normal.tabIndex).toBe(0);
    expect(high.tabIndex).toBe(-1);
    // The one-line hint names what High is for.
    const hintId = high.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toBe(
      'Takes longer. For harder questions.',
    );
    fireEvent.keyDown(normal, { key: 'ArrowRight' });
    expect(high.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(high);
    expect(high.tabIndex).toBe(0);
    expect(screen.getByText('High effort. Takes longer. For harder questions.')).toBeTruthy();
    fireEvent.keyDown(high, { key: 'ArrowLeft' });
    expect(normal.getAttribute('aria-checked')).toBe('true');
  });

  it('is in the side panel too, and the panel sends High', async () => {
    mocks.getAiCapabilities.mockResolvedValue(
      capabilities({ ...EFFORTS, conversations: undefined }),
    );
    answerWith('Panel answer.');
    go('/w/canadawide/leads');
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    const group = effortGroup(panel);
    if (group === null) throw new Error('no effort control in the panel');
    fireEvent.click(within(group).getByRole('radio', { name: 'High' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'Why?' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await within(panel).findByText('Panel answer.');
    expect(lastRequest()?.effort).toBe('high');
    expect(within(panel).getByText('High effort')).toBeTruthy();
  });
});

describe('effort levels: sending', () => {
  it('sends High only once chosen, and keeps the choice across messages and new chats without storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const openDb = vi.fn();
    vi.stubGlobal('indexedDB', { open: openDb });
    try {
      mocks.getAiCapabilities.mockResolvedValue(capabilities(EFFORTS));
      answerWith('First answer.');
      render(<Screen />);
      await screen.findByRole('radiogroup', { name: 'Effort' });
      await ask('Normal question');
      await screen.findByText('First answer.');
      expect(lastRequest()).not.toHaveProperty('effort');

      fireEvent.click(screen.getByRole('radio', { name: 'High' }));
      answerWith('Second answer.');
      await ask('Hard question');
      await screen.findByText('Second answer.');
      expect(lastRequest()?.effort).toBe('high');

      answerWith('Third answer.');
      await ask('Another hard one');
      await screen.findByText('Third answer.');
      expect(lastRequest()?.effort).toBe('high');

      // A new conversation keeps the level the member chose.
      const [newChat] = screen.getAllByRole('button', { name: 'New chat' });
      if (!newChat) throw new Error('no New chat button');
      fireEvent.click(newChat);
      await screen.findByRole('heading', { name: 'What would you like to know?' });
      expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true');
      answerWith('Fourth answer.');
      await ask('In a new chat');
      await screen.findByText('Fourth answer.');
      expect(lastRequest()?.effort).toBe('high');
      expect(lastRequest()?.conversationId).not.toBe(
        mocks.askAiAssistant.mock.calls[0]?.[2].conversationId,
      );

      expect(setItem).not.toHaveBeenCalled();
      expect(openDb).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    } finally {
      setItem.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('shows the server’s Thinking while a High turn reasons, with Stop available throughout', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(EFFORTS));
    const release = deferred<void>();
    mocks.askAiAssistant.mockImplementation(() =>
      (async function* generate(): AsyncGenerator<AiStreamPart, void, undefined> {
        yield { type: 'progress', label: 'Getting ready' };
        yield { type: 'progress', label: 'Thinking' };
        await release.promise;
        yield { type: 'text', text: 'Thought it through.' };
        yield { type: 'done', messageId: id(901) };
      })(),
    );
    render(<Screen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'High' }));
    await ask('Why did orders drop?');
    expect(await screen.findByText('Thinking…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await act(async () => release.resolve());
    await screen.findByText('Thought it through.');
    expect(screen.getByText('High effort')).toBeTruthy();
  });

  it('retries a failed High question at High', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(EFFORTS));
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([{ type: 'error', code: 'provider_unavailable', message: 'x' }]),
    );
    render(<Screen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'High' }));
    await ask('Hard question');
    const retry = await screen.findByRole('button', { name: 'Retry' });
    // The control moved on to Normal meanwhile: the retry keeps the question's level.
    fireEvent.click(screen.getByRole('radio', { name: 'Normal' }));
    answerWith('Recovered.');
    fireEvent.click(retry);
    await screen.findByText('Recovered.');
    expect(mocks.askAiAssistant).toHaveBeenCalledTimes(2);
    expect(lastRequest()?.effort).toBe('high');
  });
});

describe('effort levels: after the answer', () => {
  it('tags a High answer after a reload, from the stored level, and never a Normal one', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(EFFORTS));
    const conv = conversation(1, 'Orders');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conv, [
        stored(1, 'user', 'Normal question', { effort: 'normal' }),
        stored(2, 'assistant', 'Normal answer', { effort: 'normal' }),
        stored(3, 'user', 'Hard question', { effort: 'high' }),
        stored(4, 'assistant', 'High answer', { effort: 'high' }),
        stored(5, 'user', 'Old question'),
        stored(6, 'assistant', 'Old answer'),
      ]),
    );
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    await screen.findByText('High answer');
    expect(screen.getAllByText('High effort')).toHaveLength(1);
    const tag = screen.getByText('High effort');
    expect(tag.closest('div')?.textContent).toContain('Copy');
  });

  it('tags a reloaded High answer even where High is no longer offered', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities());
    const conv = conversation(2, 'Orders');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conv, [
        stored(1, 'user', 'Hard question', { effort: 'high' }),
        stored(2, 'assistant', 'High answer', { effort: 'high' }),
      ]),
    );
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    await screen.findByText('High answer');
    expect(screen.getByText('High effort')).toBeTruthy();
    expect(effortGroup()).toBeNull();
  });

  it('says High’s own limit was reached, and how long to wait', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(EFFORTS));
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('ai_rate_limited', 429, 'req-00000001', {
        reason: 'high_effort',
        retryAfterSeconds: 1_490,
      });
    });
    render(<Screen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'High' }));
    await ask('Hard question');
    const sentence =
      'You have used High effort a lot in the last hour. Ask at Normal effort, or try again in 25 minutes.';
    expect(
      await within(screen.getByRole('log', { name: 'Conversation' })).findByText(sentence),
    ).toBeTruthy();
    // The status region says it too.
    expect(screen.getAllByText(sentence)).toHaveLength(2);
  });

  it('drops the control when the site stopped offering High, and asks at Normal only on Retry', async () => {
    mocks.getAiCapabilities
      .mockResolvedValueOnce(capabilities(EFFORTS))
      .mockResolvedValue(capabilities());
    mocks.askAiAssistant.mockImplementationOnce(() => {
      throw new BackendError('invalid_request', 400, 'req-00000002', {
        reason: 'effort_unavailable',
      });
    });
    render(<Screen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'High' }));
    await ask('Hard question');
    expect(
      await within(screen.getByRole('log', { name: 'Conversation' })).findByText(
        'High effort is no longer offered on this site. Press Retry to ask at Normal effort.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(effortGroup()).toBeNull());
    expect(mocks.getAiCapabilities).toHaveBeenCalledTimes(2);
    // Never asked again by itself.
    await flush();
    expect(mocks.askAiAssistant).toHaveBeenCalledTimes(1);
    answerWith('Normal answer.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Normal answer.');
    expect(mocks.askAiAssistant).toHaveBeenCalledTimes(2);
    expect(lastRequest()).not.toHaveProperty('effort');
    expect(screen.queryByText('High effort')).toBeNull();
  });
});
