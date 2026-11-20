import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiCapabilitiesResponse,
  AiChatRequest,
  AiConversation,
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

function page(items: readonly AiConversation[], nextCursor?: string) {
  return {
    conversations: items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    requestId: 'req',
  };
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
  window.localStorage.clear();
  window.history.pushState = originalPush;
  window.history.replaceState = originalReplace;
  vi.useRealTimers();
});

const MODELS: Partial<AiCapabilitiesResponse> = {
  models: [
    { id: 'vendor-b/model-two', label: 'Model Two' },
    { id: 'vendor-a/model-one', label: 'Model One' },
    { id: 'vendor-c/model-three', label: 'Model Three' },
  ],
  defaultModel: 'vendor-b/model-two',
};
const KEY = `gt-ai-model:${WORKSPACE_ID}`;

function lastRequest(): AiChatRequest | undefined {
  return mocks.askAiAssistant.mock.calls.at(-1)?.[2];
}

function answerWith(text: string) {
  mocks.askAiAssistant.mockImplementation(() =>
    streamOf([
      { type: 'text', text },
      { type: 'done', messageId: id(900) },
    ]),
  );
}

async function ask(question: string): Promise<void> {
  await waitFor(() => expect(composer().hasAttribute('disabled')).toBe(false));
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.keyDown(composer(), { key: 'Enter' });
}

function picker(scope: HTMLElement = document.body): HTMLSelectElement | null {
  return within(scope).queryByRole('combobox', { name: 'Model' });
}

function options(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.text);
}

describe('model choice: the picker', () => {
  it('is absent with no models (an older backend, before 0040, or one model allowed), and the request carries no model', async () => {
    answerWith('Fine.');
    render(<Screen />);
    await screen.findByRole('heading', { name: 'What would you like to know?' });
    expect(picker()).toBeNull();
    await ask('How many orders?');
    await screen.findByText('Fine.');
    expect(lastRequest()).not.toHaveProperty('model');
  });

  it('is absent while Ask AI is unavailable, whatever the models', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities({ ...MODELS, available: false }));
    render(<Screen />);
    await flush();
    await flush();
    expect(picker()).toBeNull();
  });

  it('lists the site’s models with the default first, tagged Default, and the default chosen', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(MODELS));
    render(<Screen />);
    const select = await waitFor(() => {
      const found = picker();
      if (!found) throw new Error('no picker yet');
      return found;
    });
    expect(options(select)).toEqual(['Model Two · Default', 'Model One', 'Model Three']);
    expect(select.value).toBe('vendor-b/model-two');
  });

  it('sends the chosen model, keeps it in this browser for the site, and sends none for the default', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(MODELS));
    answerWith('First answer.');
    render(<Screen />);
    await waitFor(() => expect(picker()).not.toBeNull());
    await ask('On the default');
    await screen.findByText('First answer.');
    expect(lastRequest()).not.toHaveProperty('model');

    const select = picker();
    if (!select) throw new Error('no picker');
    fireEvent.change(select, { target: { value: 'vendor-a/model-one' } });
    expect(window.localStorage.getItem(KEY)).toBe('vendor-a/model-one');
    answerWith('Second answer.');
    await ask('On model one');
    await screen.findByText('Second answer.');
    expect(lastRequest()?.model).toBe('vendor-a/model-one');

    fireEvent.change(select, { target: { value: 'vendor-b/model-two' } });
    answerWith('Third answer.');
    await ask('Back on the default');
    await screen.findByText('Third answer.');
    expect(lastRequest()).not.toHaveProperty('model');
  });

  it('starts from the remembered pick, and falls back to the default when the site no longer allows it', async () => {
    window.localStorage.setItem(KEY, 'vendor-c/model-three');
    mocks.getAiCapabilities.mockResolvedValue(capabilities(MODELS));
    answerWith('Remembered.');
    const { unmount } = render(<Screen />);
    await waitFor(() => expect(picker()?.value).toBe('vendor-c/model-three'));
    await ask('Remembered pick');
    await screen.findByText('Remembered.');
    expect(lastRequest()?.model).toBe('vendor-c/model-three');
    unmount();
    // A new chat page, as a reload of the address the first answer gave would not be.
    go(BASE);

    window.localStorage.setItem(KEY, 'vendor-z/retired');
    mocks.getAiCapabilities.mockResolvedValue(capabilities(MODELS));
    answerWith('Default now.');
    render(<Screen />);
    await waitFor(() => expect(picker()?.value).toBe('vendor-b/model-two'));
    await ask('Retired pick');
    await screen.findByText('Default now.');
    expect(lastRequest()).not.toHaveProperty('model');
  });

  it('is in the side panel too, and the panel sends the pick', async () => {
    mocks.getAiCapabilities.mockResolvedValue(
      capabilities({ ...MODELS, conversations: undefined }),
    );
    answerWith('Panel answer.');
    go('/w/canadawide/leads');
    render(<Screen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('dialog', { name: 'Ask AI' });
    const select = picker(panel);
    if (!select) throw new Error('no picker in the panel');
    fireEvent.change(select, { target: { value: 'vendor-c/model-three' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Ask a question' }), {
      target: { value: 'Why?' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await within(panel).findByText('Panel answer.');
    expect(lastRequest()?.model).toBe('vendor-c/model-three');
  });

  it('says a model the site stopped allowing is gone, reads the list again, and Retry asks on the default', async () => {
    window.localStorage.setItem(KEY, 'vendor-a/model-one');
    mocks.getAiCapabilities.mockResolvedValueOnce(capabilities(MODELS)).mockResolvedValue(
      capabilities({
        models: [
          { id: 'vendor-b/model-two', label: 'Model Two' },
          { id: 'vendor-c/model-three', label: 'Model Three' },
        ],
        defaultModel: 'vendor-b/model-two',
      }),
    );
    mocks.askAiAssistant.mockImplementationOnce(() => {
      throw new BackendError('invalid_request', 400, 'req-00000002', {
        reason: 'model_unavailable',
      });
    });
    render(<Screen />);
    await waitFor(() => expect(picker()?.value).toBe('vendor-a/model-one'));
    await ask('On a retired model');
    expect(
      await within(screen.getByRole('log', { name: 'Conversation' })).findByText(
        'That model is no longer offered on this site. Press Retry to ask with the site’s default model.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(picker()?.value).toBe('vendor-b/model-two'));
    expect(mocks.getAiCapabilities).toHaveBeenCalledTimes(2);
    expect(mocks.askAiAssistant).toHaveBeenCalledTimes(1);
    answerWith('Default answer.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Default answer.');
    expect(lastRequest()).not.toHaveProperty('model');
  });
});
