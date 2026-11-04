import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiCapabilitiesResponse,
  AiChatRequest,
  AiSource,
  AiStreamPart,
  StaffWorkspace,
  AiActionProposal,
  AiActionDraft,
  ConfirmAiActionResponse,
} from '@gt-sales/contracts';
import { BackendError } from '../../lib/api';

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
  reviseAiAction:
    vi.fn<
      (
        token: string,
        workspaceId: string,
        proposalToken: string,
        draft: AiActionDraft,
      ) => Promise<AiActionProposal>
    >(),
  confirmAiAction:
    vi.fn<
      (
        token: string,
        workspaceId: string,
        proposalToken: string,
      ) => Promise<ConfirmAiActionResponse>
    >(),
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
    mocks.confirmAiAction.mockReset();
    mocks.reviseAiAction.mockReset();
  });

  const proposal: AiActionProposal = {
    id: '70000000-0000-4000-8000-000000000001',
    token: 'signed-proposal',
    expiresAt: '2099-11-05T12:00:00.000Z',
    siteName: 'CanadaWide',
    leadLabel: 'MS-101',
    leadHref: `/w/canadawide/leads/${LEAD_ID}`,
    draft: { kind: 'note', leadId: LEAD_ID, body: 'Customer asked for a callback.' },
  };
  function propose(action = proposal) {
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([
        { type: 'text', text: 'Draft ready.' },
        { type: 'actions', actions: [action] },
        { type: 'done' },
      ]),
    );
  }

  it('reviews current/proposed lead values and edits before confirmation', async () => {
    const update: AiActionProposal = {
      ...proposal,
      draft: { kind: 'lead_update', leadId: LEAD_ID, field: 'fullName', value: 'New name' },
      leadUpdateContext: {
        version: 'v1',
        before: 'Old name',
        beforeLabel: 'Old name',
        choices: [],
      },
    };
    propose(update);
    mocks.reviseAiAction.mockResolvedValue({
      ...update,
      id: '70000000-0000-4000-8000-000000000003',
      token: 'edited-lead-token',
      draft: {
        ...update.draft,
        kind: 'lead_update',
        leadId: LEAD_ID,
        field: 'fullName',
        value: 'Reviewed name',
      },
    });
    render(<Harness />);
    await openPanel();
    ask('Update the name');
    const region = await screen.findByRole('region', { name: 'Confirm lead update' });
    expect(within(region).getByText('Old name')).toBeTruthy();
    expect(mocks.confirmAiAction).not.toHaveBeenCalled();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Proposed value' }), {
      target: { value: 'Reviewed name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    await screen.findByText('Reviewed name');
    expect(mocks.reviseAiAction).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, proposal.token, {
      kind: 'lead_update',
      leadId: LEAD_ID,
      field: 'fullName',
      value: 'Reviewed name',
    });
  });

  it('edits a note into a fresh signed draft before confirming', async () => {
    propose();
    const revised = {
      ...proposal,
      id: '70000000-0000-4000-8000-000000000002',
      token: 'revised-token',
      draft: { kind: 'note' as const, leadId: LEAD_ID, body: 'Edited note' },
    };
    mocks.reviseAiAction.mockResolvedValue(revised);
    mocks.confirmAiAction.mockResolvedValue({
      status: 'saved',
      actionId: revised.id,
      recordId: revised.id,
      kind: 'note',
      requestId: revised.id,
    });
    render(<Harness />);
    await openPanel();
    ask('Add a note');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note text' }), {
      target: { value: 'Edited note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    await screen.findByText('Edited note');
    expect(mocks.confirmAiAction).not.toHaveBeenCalled();
    expect(mocks.reviseAiAction).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE_ID,
      proposal.token,
      revised.draft,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Note added.');
    expect(mocks.confirmAiAction).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, revised.token);
  });

  it('sends a guided choice with its question preserved in history', async () => {
    let turn = 0;
    mocks.askAiAssistant.mockImplementation(() =>
      ++turn === 1
        ? streamOf([
            {
              type: 'follow_up',
              followUp: {
                question: 'When should this be due?',
                choices: ['Tomorrow', 'No due date'],
              },
            },
            { type: 'done' },
          ])
        : streamOf([{ type: 'text', text: 'Draft next' }, { type: 'done' }]),
    );
    render(<Harness />);
    await openPanel();
    ask('Create a follow-up');
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow' }));
    await screen.findByText('Draft next');
    expect(mocks.askAiAssistant.mock.calls[1]?.[2].message).toBe('Tomorrow');
    expect(
      mocks.askAiAssistant.mock.calls[1]?.[2].history.some((entry) =>
        entry.text.includes('When should this be due?'),
      ),
    ).toBe(true);
  });

  it('shows an email draft and queues it only after Send', async () => {
    const email: AiActionProposal = {
      ...proposal,
      draft: {
        kind: 'email',
        leadId: LEAD_ID,
        subject: 'Your appointment',
        body: 'Please call us tomorrow.',
      },
    };
    propose(email);
    mocks.confirmAiAction.mockResolvedValue({
      status: 'saved',
      actionId: email.id,
      recordId: email.id,
      kind: 'email',
      requestId: email.id,
    });
    render(<Harness />);
    await openPanel();
    ask('Draft an email');
    const region = await screen.findByRole('region', { name: 'Review email' });
    const sendEmail = within(region).getByRole('button', { name: /^Send$/ });
    expect(mocks.confirmAiAction).not.toHaveBeenCalled();
    fireEvent.click(sendEmail);
    await screen.findByText('Email queued for delivery.');
    expect(mocks.confirmAiAction).toHaveBeenCalledTimes(1);
  });

  it('requires Confirm before saving and retains the saved receipt after reopening', async () => {
    propose();
    mocks.confirmAiAction.mockResolvedValue({
      status: 'saved',
      actionId: proposal.id,
      recordId: proposal.id,
      kind: 'note',
      requestId: proposal.id,
    });
    render(<Harness />);
    await openPanel();
    ask('Add a note');
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect(screen.getByText('Customer asked for a callback.')).toBeTruthy();
    expect(mocks.confirmAiAction).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText('Note added.');
    expect(mocks.confirmAiAction).toHaveBeenCalledTimes(1);
    expect(mocks.confirmAiAction).toHaveBeenCalledWith('staff-token', WORKSPACE_ID, proposal.token);
    fireEvent.click(screen.getByRole('button', { name: 'Close Ask AI' }));
    await openPanel();
    expect(screen.getByText('Note added.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('cancels without a write and shows the exact task, due date and assignee', async () => {
    propose({
      ...proposal,
      draft: {
        kind: 'task',
        leadId: LEAD_ID,
        title: 'Call the customer',
        dueDate: '2026-11-05',
        assignee: 'me',
      },
    });
    render(<Harness />);
    await openPanel();
    ask('Create a follow-up');
    await screen.findByRole('region', { name: 'Confirm task' });
    await screen.findByRole('button', { name: 'Confirm' });
    expect(screen.getByText('Call the customer')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Cancelled. Nothing was saved.')).toBeTruthy();
    expect(mocks.confirmAiAction).not.toHaveBeenCalled();
  });

  it('retries the same signed card after an uncertain save, without making a fresh proposal', async () => {
    propose();
    mocks.confirmAiAction
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({
        status: 'saved',
        actionId: proposal.id,
        recordId: proposal.id,
        kind: 'note',
        requestId: proposal.id,
      });
    render(<Harness />);
    await openPanel();
    ask('Add a note');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry save' }));
    await screen.findByText('Note added.');
    expect(mocks.askAiAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.confirmAiAction.mock.calls.map((call) => call[2])).toEqual([
      proposal.token,
      proposal.token,
    ]);
  });

  it('clears private chat when confirmation is denied after a permission change', async () => {
    propose();
    mocks.confirmAiAction.mockRejectedValue(
      new BackendError('permission_denied', 403, proposal.id),
    );
    render(<Harness />);
    await openPanel();
    ask('Add a note');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  it('keeps an in-flight save receipt when the person asks a follow-up question', async () => {
    mocks.askAiAssistant
      .mockImplementationOnce(() =>
        streamOf([{ type: 'actions', actions: [proposal] }, { type: 'done' }]),
      )
      .mockImplementationOnce(() =>
        streamOf([{ type: 'text', text: 'Five leads.' }, { type: 'done' }]),
      );
    let finish: (value: ConfirmAiActionResponse) => void = () => {};
    mocks.confirmAiAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    await openPanel();
    ask('Add a note');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(screen.getByText('Saving…')).toBeTruthy();
    ask('How many leads?');
    await screen.findByText('Five leads.');
    await act(async () => {
      finish({
        status: 'saved',
        actionId: proposal.id,
        recordId: proposal.id,
        kind: 'note',
        requestId: proposal.id,
      });
    });
    expect(await screen.findByText('Note added.')).toBeTruthy();
  });

  it('does not restore old action receipts after the member changes', async () => {
    propose();
    let finish: (value: ConfirmAiActionResponse) => void = () => {};
    mocks.confirmAiAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<Harness />);
    await openPanel();
    ask('Add a note');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    rerender(<Harness accessToken="other-member" />);
    await act(async () => {
      finish({
        status: 'saved',
        actionId: proposal.id,
        recordId: proposal.id,
        kind: 'note',
        requestId: proposal.id,
      });
    });
    expect(screen.queryByText('Note added.')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
  });

  it('does not claim nothing was saved when an uncertain save is dismissed', async () => {
    propose();
    mocks.confirmAiAction.mockRejectedValue(new Error('network'));
    render(<Harness />);
    await openPanel();
    ask('Add a note');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(
      screen.getByText('Dismissed. Check the lead if a save was already attempted.'),
    ).toBeTruthy();
    expect(screen.queryByText('Cancelled. Nothing was saved.')).toBeNull();
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

  it.each(['error', 'disconnect', 'stop'] as const)(
    'keeps completed history but excludes the partial answer after %s',
    async (failure) => {
      let call = 0;
      mocks.askAiAssistant.mockImplementation((_token, _workspace, _body, options) => {
        call += 1;
        if (call !== 2)
          return streamOf([{ type: 'text', text: 'Completed answer' }, { type: 'done' }]);
        return (async function* () {
          yield { type: 'text' as const, text: 'Unfinished answer' };
          if (failure === 'stop') {
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve();
              else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          } else if (failure === 'error') {
            yield {
              type: 'error' as const,
              code: 'provider_unavailable' as const,
              message: 'Failed',
            };
          }
        })();
      });
      render(<Harness />);
      await openPanel();
      ask('First question');
      await screen.findByText('Completed answer');
      await waitFor(() => expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false));
      ask('Second question');
      await screen.findByText('Unfinished answer');
      if (failure === 'stop') fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false));
      ask('Follow-up');
      await waitFor(() => expect(mocks.askAiAssistant).toHaveBeenCalledTimes(3));
      expect(mocks.askAiAssistant.mock.calls[2]?.[2].history).toEqual([
        { role: 'user', text: 'First question' },
        { role: 'assistant', text: 'Completed answer' },
        { role: 'user', text: 'Second question' },
      ]);
    },
  );

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
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
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
  it('removes all private messages and disables the trigger on access_lost', async () => {
    mocks.askAiAssistant.mockImplementation(() =>
      streamOf([
        { type: 'text', text: 'Private fixture answer' },
        { type: 'error', code: 'access_lost', message: 'Access changed' },
        { type: 'text', text: 'Late private data' },
      ]),
    );
    render(<Harness />);
    await openPanel();
    ask('Private fixture question');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull());
    expect(screen.queryByText('Private fixture answer')).toBeNull();
    expect(screen.queryByText('Private fixture question')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  it('removes the visible lead context before sending the next question', async () => {
    mocks.askAiAssistant.mockImplementation(() => streamOf([{ type: 'done' }]));
    render(<Harness activeLeadId={LEAD_ID} />);
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Remove lead context' }));
    ask('Count leads');
    await waitFor(() => expect(mocks.askAiAssistant).toHaveBeenCalled());
    expect(mocks.askAiAssistant.mock.calls[0]?.[2].context).toBeUndefined();
  });
});
