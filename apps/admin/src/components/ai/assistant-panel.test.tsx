import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiCapabilitiesResponse,
  AiChatRequest,
  AiSource,
  AiStreamPart,
  StaffWorkspace,
} from '@gt-sales/contracts';

import { AssistantPanel } from './assistant-panel';
import { AssistantProvider } from './assistant-provider';
import { AssistantTrigger } from './assistant-trigger';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const LEAD_ID = '90000000-0000-4000-8000-000000000001';

const WORKSPACE: StaffWorkspace = {
  id: WORKSPACE_ID,
  slug: 'canadawide',
  name: 'CanadaWide',
  membershipId: '20000000-0000-4000-8000-000000000001',
  roles: ['owner'],
};

type CapabilitiesFn = (accessToken: string, workspaceId: string) => Promise<AiCapabilitiesResponse>;

type AskAiFn = (
  accessToken: string,
  workspaceId: string,
  body: AiChatRequest,
  options?: { signal?: AbortSignal },
) => AsyncGenerator<AiStreamPart, void, undefined>;

const mocks = vi.hoisted(() => ({
  getAiCapabilities: vi.fn<CapabilitiesFn>(),
  askAiAssistant: vi.fn<AskAiFn>(),
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class BackendError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

function capabilities(available = true): AiCapabilitiesResponse {
  return {
    available,
    ...(available ? {} : { reason: 'disabled' }),
    site: { id: WORKSPACE_ID, slug: 'canadawide', name: 'CanadaWide' },
    leadTypes: ['sim_order', 'internet'],
    limits: {
      maxMessageChars: 4_000,
      maxHistoryMessages: 12,
      maxConversationChars: 16_000,
    },
    requestId: '00000000-0000-4000-8000-000000000001',
  };
}

function streamOf(parts: readonly AiStreamPart[]): AsyncGenerator<AiStreamPart, void, undefined> {
  return (async function* generate() {
    for (const part of parts) yield part;
  })();
}

function Harness({
  accessToken = 'staff-token',
  activeLeadId,
}: {
  accessToken?: string;
  activeLeadId?: string;
}) {
  return (
    <AssistantProvider workspace={WORKSPACE} accessToken={accessToken} activeLeadId={activeLeadId}>
      <AssistantTrigger />
      <AssistantPanel />
    </AssistantProvider>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
  return screen.getByRole('dialog', { name: 'Ask AI' });
}

function ask(question: string): void {
  const composer = screen.getByRole('textbox', { name: 'Ask a question' });
  fireEvent.change(composer, { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('Ask AI trigger', () => {
  beforeEach(() => {
    mocks.getAiCapabilities.mockReset();
    mocks.askAiAssistant.mockReset();
  });

  it('stays hidden while the capability is loading and when it is unavailable', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities(false));
    render(<Harness />);
    // Never a flashing enabled button: nothing before the answer arrives.
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    await flush();
    expect(mocks.getAiCapabilities).toHaveBeenCalledWith('staff-token', WORKSPACE_ID);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  it('appears only once the capability says the assistant is available', async () => {
    mocks.getAiCapabilities.mockResolvedValue(capabilities());
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    const trigger = await screen.findByRole('button', { name: 'Ask AI' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('stays hidden when the capability call fails', async () => {
    mocks.getAiCapabilities.mockRejectedValue(new Error('offline'));
    render(<Harness />);
    await flush();
    expect(mocks.getAiCapabilities).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });
});

describe('Ask AI panel', () => {
  beforeEach(() => {
    mocks.getAiCapabilities.mockReset();
    mocks.askAiAssistant.mockReset();
    mocks.getAiCapabilities.mockResolvedValue(capabilities());
  });

  it('focuses the composer when it opens and sends nothing on an empty submit', async () => {
    render(<Harness />);
    await openPanel();
    const composer = screen.getByRole('textbox', { name: 'Ask a question' });
    expect(document.activeElement).toBe(composer);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(mocks.askAiAssistant).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    render(<Harness />);
    const trigger = await screen.findByRole('button', { name: 'Ask AI' });
    fireEvent.click(trigger);
    const composer = screen.getByRole('textbox', { name: 'Ask a question' });
    expect(document.activeElement).toBe(composer);

    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('retries the failed user turn without duplicating it', async () => {
    let call = 0;
    mocks.askAiAssistant.mockImplementation(() => {
      call += 1;
      return call === 1
        ? streamOf([{ type: 'error', code: 'internal_error', message: 'not now' }])
        : streamOf([{ type: 'text', text: 'Recovered.' }, { type: 'done' }]);
    });
    render(<Harness />);
    await openPanel();
    ask('What is due?');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Recovered.')).toBeTruthy();
    expect(screen.getAllByText('What is due?')).toHaveLength(1);
    const retried = mocks.askAiAssistant.mock.calls[1]?.[2];
    expect(retried?.message).toBe('What is due?');
    expect(retried?.history).toEqual([]);
  });

  it('streams the answer into the conversation', async () => {
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([
        { type: 'progress', label: 'Checking leads' },
        { type: 'text', text: 'Two leads are due today.' },
        { type: 'done' },
      ]),
    );
    render(<Harness />);
    await openPanel();
    ask('What is due?');

    expect(await screen.findByText('Two leads are due today.')).toBeTruthy();
    const [token, workspaceId, body, options] = mocks.askAiAssistant.mock.calls[0] ?? [];
    expect(token).toBe('staff-token');
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(body?.message).toBe('What is due?');
    expect(body?.history).toEqual([]);
    expect(body?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(options?.signal?.aborted).toBe(false);
  });

  it('shows and sends the open lead as context', async () => {
    mocks.askAiAssistant.mockImplementation(() => streamOf([{ type: 'done' }]));
    render(<Harness activeLeadId={LEAD_ID} />);
    await openPanel();
    expect(screen.getByText('Asking about the open lead')).toBeTruthy();

    ask('How is this lead?');
    await waitFor(() => expect(mocks.askAiAssistant).toHaveBeenCalled());
    expect(mocks.askAiAssistant.mock.calls[0]?.[2].context).toEqual({ leadId: LEAD_ID });
  });

  it('turns a sources part into a safe internal link and leaves model URLs as text', async () => {
    const source: AiSource = {
      id: 'lead-1',
      kind: 'lead',
      label: 'Avery Example (MS-101)',
      href: `/w/canadawide/leads/${LEAD_ID}`,
      asOf: '2026-11-01T12:00:00.000Z',
      scope: '1 lead, last 30 days',
    };
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([
        { type: 'text', text: 'Read more at https://evil.example/steal' },
        { type: 'sources', sources: [source] },
        { type: 'done' },
      ]),
    );
    render(<Harness />);
    await openPanel();
    ask('Which lead?');

    const link = await screen.findByRole('link', { name: 'Avery Example (MS-101)' });
    expect(link.getAttribute('href')).toBe(`/w/canadawide/leads/${LEAD_ID}`);
    expect(screen.getByText('Sources checked')).toBeTruthy();

    const answer = screen.getByText(/https:\/\/evil\.example\/steal/);
    expect(answer.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /evil\.example/ })).toBeNull();
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log.querySelectorAll('a[href^="http"]').length).toBe(0);
  });

  it('stops a streaming answer by aborting its signal', async () => {
    mocks.askAiAssistant.mockImplementation((_token, _workspaceId, _body, options) => {
      async function* slow(): AsyncGenerator<AiStreamPart, void, undefined> {
        yield { type: 'progress', label: 'Checking leads' };
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();
            return;
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return slow();
    });
    render(<Harness />);
    await openPanel();
    ask('What is due?');
    expect(await screen.findByText('Checking leads')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await flush();

    const signal = mocks.askAiAssistant.mock.calls[0]?.[3]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText('Stopped.')).toBeTruthy();
  });

  it('clears the conversation with New chat', async () => {
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([{ type: 'text', text: 'Two leads are due today.' }, { type: 'done' }]),
    );
    render(<Harness />);
    await openPanel();
    ask('What is due?');
    await screen.findByText('Two leads are due today.');

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('Two leads are due today.')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Summarize leads from the last 30 days' }),
    ).toBeTruthy();
  });

  it('clears the conversation synchronously when the access token changes', async () => {
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([{ type: 'text', text: 'Two leads are due today.' }, { type: 'done' }]),
    );
    const { rerender } = render(<Harness />);
    await openPanel();
    ask('What is due?');
    await screen.findByText('Two leads are due today.');

    rerender(<Harness accessToken="other-token" />);
    expect(screen.queryByText('Two leads are due today.')).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.getAiCapabilities).toHaveBeenCalledWith('other-token', WORKSPACE_ID),
    );
  });

  it('offers only the suggested questions its lead types support', async () => {
    mocks.getAiCapabilities.mockResolvedValue({
      ...capabilities(),
      leadTypes: ['internet'],
    });
    render(<Harness />);
    await openPanel();
    expect(
      screen.getByRole('button', { name: 'Summarize leads from the last 30 days' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'How are SIM orders distributed by stage?' }),
    ).toBeNull();
  });

  it('becomes a full-width sheet on a phone with the composer fixed in place', async () => {
    const realMatchMedia = window.matchMedia;
    const realWidth = window.innerWidth;
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    );
    try {
      render(<Harness />);
      const dialog = await openPanel();
      expect(dialog.className).toContain('w-full');
      expect(screen.getByRole('textbox', { name: 'Ask a question' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close Ask AI' }));
    } finally {
      vi.stubGlobal('matchMedia', realMatchMedia);
      vi.stubGlobal('innerWidth', realWidth);
    }
  });
});
