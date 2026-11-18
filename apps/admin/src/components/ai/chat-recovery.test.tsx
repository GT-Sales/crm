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
    readonly retryAfterSeconds?: number;
    constructor(
      code: string,
      status = 400,
      requestId = 'req-00000000',
      details?: Record<string, unknown>,
      retryAfterSeconds?: number,
    ) {
      super(code);
      this.code = code;
      this.status = status;
      this.requestId = requestId;
      this.details = details;
      this.retryAfterSeconds = retryAfterSeconds;
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

function lastRequest(): AiChatRequest | undefined {
  return mocks.askAiAssistant.mock.calls.at(-1)?.[2];
}

function answerWith(text: string) {
  mocks.askAiAssistant.mockImplementation(() =>
    streamOf([
      { type: 'progress', label: 'Getting ready' },
      { type: 'text', text },
      { type: 'done', messageId: id(900) },
    ]),
  );
}

async function ready(): Promise<void> {
  await waitFor(() => expect(composer().hasAttribute('disabled')).toBe(false));
}

async function ask(question: string): Promise<void> {
  await ready();
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.keyDown(composer(), { key: 'Enter' });
}

/** A stream that stays open until the test releases it. */
function heldStream() {
  const release = deferred<void>();
  mocks.askAiAssistant.mockImplementation(
    (_token: string, _ws: string, _body: AiChatRequest, options?: { signal?: AbortSignal }) =>
      (async function* generate(): AsyncGenerator<AiStreamPart, void, undefined> {
        yield { type: 'progress', label: 'Getting ready' };
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) =>
            options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
          ),
        ]);
        if (options?.signal?.aborted) return;
        yield { type: 'text', text: 'The held answer.' };
        yield { type: 'done', messageId: id(902) };
      })(),
  );
  return release;
}

describe('D1: losing the sign-in or access, or capabilities failing', () => {
  it.each([
    [
      'an expired sign-in',
      new BackendError('invalid_session', 401, 'req-1'),
      'Your sign-in has expired',
      'Your sign-in has expired. Sign in again to continue.',
    ],
    [
      'access removed',
      new BackendError('membership_revoked', 403, 'req-1'),
      'Your access to this site changed',
      'Your access to this site was removed. Ask the owner if you need it back.',
    ],
    [
      'a CRM failure',
      new BackendError('internal_error', 500, 'req-1'),
      'Ask AI is not available right now',
      'The CRM could not say whether Ask AI is on for this site. Try again in a moment.',
    ],
    [
      'no connection',
      new TypeError('Failed to fetch'),
      'Ask AI is not available right now',
      'The CRM could not say whether Ask AI is on for this site. Try again in a moment.',
    ],
  ])('says %s plainly, and Try again asks again', async (_label, error, title, text) => {
    mocks.getAiCapabilities.mockRejectedValueOnce(error).mockResolvedValue(capabilities());
    render(<Screen />);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(document.body.textContent).not.toMatch(
      /invalid_session|membership_revoked|internal_error|Reload the page/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'What would you like to know?' }),
    ).toBeTruthy();
    expect(mocks.getAiCapabilities).toHaveBeenCalledTimes(2);
  });

  it('an expired sign-in on send clears the chat and says so, not "not available"', async () => {
    mocks.listAiConversations.mockResolvedValue(page([conversation(1, 'Private title')]));
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('invalid_session', 401, 'req-2');
    });
    render(<Screen />);
    await screen.findByRole('link', { name: 'Private title' });
    await ask('Private question');
    expect(await screen.findByRole('heading', { name: 'Your sign-in has expired' })).toBeTruthy();
    expect(screen.queryByText('Private question')).toBeNull();
    expect(screen.queryByText('Private title')).toBeNull();
  });

  it('a 403 on the conversation list clears it and names the permission, never a raw code', async () => {
    mocks.listAiConversations.mockRejectedValue(
      new BackendError('permission_denied', 403, 'req-3'),
    );
    render(<Screen />);
    expect(
      await screen.findByRole('heading', { name: 'Your access to this site changed' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      "You don't have permission to use Ask AI. Ask the owner to give your role access.",
    );
  });

  it('the side panel stays open and says the sign-in expired', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ conversations: undefined }));
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('invalid_session', 401, 'req-4');
    });
    go('/w/canadawide/leads');
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'Panel question' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    expect(await within(panel).findByText('Your sign-in has expired')).toBeTruthy();
    expect(within(panel).getByRole('alert').textContent).toBe(
      'Your sign-in has expired. Sign in again to continue.',
    );
    expect(within(panel).queryByText('Panel question')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Ask AI' })).toBeTruthy();
  });
});

describe('D2: a double-click on Send', () => {
  it('does not stop the answer it started; a later click or a key press does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const release = heldStream();
    render(<Screen />);
    await ready();
    fireEvent.change(composer(), { target: { value: 'Double-clicked question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }), { detail: 1 });
    // The second click of the double-click lands on Stop, in the same place.
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }), { detail: 2 });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await act(async () => release.resolve());
    expect(await screen.findByText('The held answer.')).toBeTruthy();
    expect(screen.queryByText('Stopped.')).toBeNull();

    // A deliberate single click on Stop works at once, however soon.
    heldStream();
    fireEvent.change(composer(), { target: { value: 'Second question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }), { detail: 1 });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }), { detail: 1 });
    expect(await screen.findByText('Stopped.')).toBeTruthy();

    // A multi-click on Stop well after the send is a Stop too.
    heldStream();
    fireEvent.change(composer(), { target: { value: 'Late double-click' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }), { detail: 1 });
    vi.setSystemTime(Date.now() + 700);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }), { detail: 2 });
    await waitFor(() => expect(screen.getAllByText('Stopped.')).toHaveLength(2));

    // A keyboard press on Stop (a click with no pointer detail) is never held back.
    heldStream();
    await ask('Third question');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }), { detail: 0 });
    await waitFor(() => expect(screen.getAllByText('Stopped.')).toHaveLength(3));
  });

  it('holds in the side panel too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ conversations: undefined }));
    const release = heldStream();
    go('/w/canadawide/leads');
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'Panel double-click' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }), { detail: 1 });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Stop' }), { detail: 2 });
    await act(async () => release.resolve());
    expect(await within(panel).findByText('The held answer.')).toBeTruthy();
  });

  it('binds a first message stopped early to the conversation the server stored', async () => {
    // Nothing arrives before the Stop: the server has not named the conversation yet.
    mocks.askAiAssistant.mockImplementation(
      (_token: string, _ws: string, _body: AiChatRequest, options?: { signal?: AbortSignal }) =>
        // eslint-disable-next-line require-yield
        (async function* generate(): AsyncGenerator<AiStreamPart, void, undefined> {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
        })(),
    );
    render(<Screen />);
    await ask('Stopped before anything came');
    const stop = await screen.findByRole('button', { name: 'Stop' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent = lastRequest();
    const conversationId = sent?.conversationId ?? '';
    const made = conversation(0, 'Stopped before anything came');
    mocks.getAiConversation.mockResolvedValue(detail({ ...made, id: conversationId }, []));
    // The server has it now; a list read from here on shows it.
    mocks.listAiConversations.mockResolvedValue(page([{ ...made, id: conversationId }]));
    fireEvent.click(stop, { detail: 0 });
    expect(window.location.pathname).toBe(BASE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    await waitFor(() => expect(window.location.pathname).toBe(`${BASE}/${conversationId}`));
    expect(mocks.getAiConversation).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE_ID,
      conversationId,
    );
    expect(
      await screen.findByRole('heading', { name: 'Stopped before anything came' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Stopped before anything came' })).toBeTruthy();
  });
});

describe('D3: only a first message creates a conversation', () => {
  it('sends newConversation with the first message only, and on its retry', async () => {
    mocks.askAiAssistant.mockImplementationOnce(() => {
      throw new BackendError('internal_error', 500, 'req-5');
    });
    render(<Screen />);
    await ask('First question');
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(lastRequest()?.newConversation).toBe(true);
    const firstId = lastRequest()?.conversationId;
    answerWith('First answer.');
    fireEvent.click(retry);
    await screen.findByText('First answer.');
    expect(lastRequest()?.newConversation).toBe(true);
    answerWith('Second answer.');
    await ask('Second question');
    await screen.findByText('Second answer.');
    expect(lastRequest()).not.toHaveProperty('newConversation');
    expect(lastRequest()?.conversationId).toBe(
      mocks.askAiAssistant.mock.calls.at(-2)?.[2].conversationId,
    );
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a question into a conversation deleted elsewhere leaves no stale thread', async () => {
    const conv = conversation(3, 'Deleted elsewhere');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conv, [stored(1, 'user', 'Old question'), stored(2, 'assistant', 'Old answer')]),
    );
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('conversation_not_found', 404, 'req-6');
    });
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    await screen.findByText('Old answer');
    await ask('Still there?');
    expect(lastRequest()).not.toHaveProperty('newConversation');
    expect(
      await screen.findByRole('heading', { name: 'This conversation is not available' }),
    ).toBeTruthy();
    expect(screen.queryByText('Old answer')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Deleted elsewhere' })).toBeNull();
    expect(composer().hasAttribute('disabled')).toBe(true);
  });
});

describe('D4: a conversation read while its last answer was being written', () => {
  it('shows the turn as stopped with Retry at once, then the stored answer, reading once more only', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const conv = conversation(4, 'Reloaded mid-answer');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation
      .mockResolvedValueOnce(detail(conv, [stored(1, 'user', 'Asked just before the reload')]))
      .mockResolvedValue(
        detail(conv, [
          stored(1, 'user', 'Asked just before the reload'),
          stored(2, 'assistant', 'Partial words', { outcome: 'cancelled' }),
        ]),
      );
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    const log = await screen.findByRole('log', { name: 'Conversation' });
    expect(await within(log).findByText('Stopped.')).toBeTruthy();
    expect(within(log).getByRole('button', { name: 'Retry' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(await within(log).findByText('Partial words')).toBeTruthy();
    expect(mocks.getAiConversation).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.getAiConversation).toHaveBeenCalledTimes(2);
  });

  it('keeps the stopped turn when the answer has still not arrived, and never loops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const conv = conversation(5, 'Still unanswered');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(detail(conv, [stored(1, 'user', 'Never answered')]));
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    const log = await screen.findByRole('log', { name: 'Conversation' });
    await within(log).findByText('Stopped.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.getAiConversation).toHaveBeenCalledTimes(2);
    expect(within(log).getByText('Stopped.')).toBeTruthy();
    answerWith('Answered now.');
    fireEvent.click(within(log).getByRole('button', { name: 'Retry' }));
    expect(await within(log).findByText('Answered now.')).toBeTruthy();
    expect(lastRequest()?.message).toBe('Never answered');
  });
});

describe('D5: a reloaded answer that prepared drafts', () => {
  it('says what is true whether or not the draft was confirmed, with the lead when the answer named it', async () => {
    const conv = conversation(6, 'A note');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(
      detail(conv, [
        stored(1, 'user', 'Add a note: called'),
        stored(2, 'assistant', 'Draft ready for confirmation. Nothing has been saved.', {
          expiredDrafts: 1,
          sources: [
            {
              id: 'lead-1',
              kind: 'lead',
              label: 'MS-101',
              href: '/w/canadawide/leads/40000000-0000-4000-8000-000000000001',
              asOf: '2026-11-18T12:00:00.000Z',
              scope: 'one lead',
            },
          ],
        }),
      ]),
    );
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    const line = await screen.findByText(
      /^This answer prepared a draft\. Drafts are not kept in the conversation: if you confirmed it, it was saved on the lead; if not, ask again\./,
    );
    expect(within(line).getByRole('link', { name: 'Open MS-101' }).getAttribute('href')).toBe(
      '/w/canadawide/leads/40000000-0000-4000-8000-000000000001',
    );
    expect(screen.queryByText(/no longer available/)).toBeNull();
  });
});

describe('D6: a provider failure', () => {
  it('reads as a failure to answer, and only the real unavailable case as unavailable', async () => {
    mocks.askAiAssistant
      .mockImplementationOnce(() =>
        streamOf([{ type: 'error', code: 'provider_unavailable', message: 'x' }]),
      )
      .mockImplementationOnce(() => {
        throw new BackendError('ai_unavailable', 503, 'req-7');
      });
    render(<Screen />);
    await ask('First');
    const log = await screen.findByRole('log', { name: 'Conversation' });
    expect(
      await within(log).findByText(
        'Ask AI had a problem and couldn’t answer. Try again; if it keeps happening, tell your admin.',
      ),
    ).toBeTruthy();
    expect(within(log).queryByText(/isn’t available for this site/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0] ?? document.body);
    await ask('Second');
    expect(
      await within(screen.getByRole('log', { name: 'Conversation' })).findByText(
        'Ask AI isn’t available for this site right now.',
      ),
    ).toBeTruthy();
  });
});

describe('a rate limit’s wait in words', () => {
  it.each([
    [30, 'Too many questions right now. Try again in 30 seconds.'],
    [1, 'Too many questions right now. Try again in 1 second.'],
    [90, 'Too many questions right now. Try again in 2 minutes.'],
    [3_600, 'Too many questions right now. Try again in about an hour.'],
    [3_700, 'Too many questions right now. Try again in about an hour.'],
    [undefined, 'Too many questions right now. Wait a minute and then try again.'],
  ])('retry-after %s', async (seconds, sentence) => {
    mocks.askAiAssistant.mockImplementation(() => {
      throw new BackendError('ai_rate_limited', 429, 'req-8', undefined, seconds);
    });
    render(<Screen />);
    await ask('Too fast');
    expect(
      await within(screen.getByRole('log', { name: 'Conversation' })).findByText(sentence),
    ).toBeTruthy();
  });
});

describe('the composer’s limits', () => {
  it('says when a pasted text was cut at the message limit', async () => {
    render(<Screen />);
    await ready();
    fireEvent.change(composer(), { target: { value: 'a'.repeat(4_100) } });
    expect(screen.getByText('Only the first 4,000 characters were kept.')).toBeTruthy();
    expect(composer()).toHaveProperty('value', 'a'.repeat(4_000));
    fireEvent.change(composer(), { target: { value: 'short' } });
    expect(screen.queryByText('Only the first 4,000 characters were kept.')).toBeNull();
  });

  it('says so in the panel too', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ conversations: undefined }));
    go('/w/canadawide/leads');
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'b'.repeat(4_001) },
    });
    expect(within(panel).getByText('Only the first 4,000 characters were kept.')).toBeTruthy();
  });

  it('a conversation at its message limit takes nothing more and offers a new chat', async () => {
    const conv = conversation(7, 'Full one');
    mocks.listAiConversations.mockResolvedValue(page([conv]));
    mocks.getAiConversation.mockResolvedValue(
      detail(
        conv,
        Array.from({ length: 200 }, (_, index) =>
          stored(index, index % 2 === 0 ? 'user' : 'assistant', `Message ${String(index)}`),
        ),
      ),
    );
    go(`${BASE}/${conv.id}`);
    render(<Screen />);
    await screen.findByText('Message 199');
    expect(
      screen.getByText('This conversation is as long as it can get. Start a new chat to go on.'),
    ).toBeTruthy();
    expect(composer().hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    expect(
      await screen.findByRole('heading', { name: 'What would you like to know?' }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(BASE);
    await ready();
  });
});
