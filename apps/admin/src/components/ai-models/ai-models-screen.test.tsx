import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModelSettingsResponse } from '@gt-sales/contracts';

import { AiModelsScreen, priceText } from './ai-models-screen';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const SAVED_AT = '2026-11-20T12:00:00.000Z';

const mocks = vi.hoisted(() => ({
  getAiModelSettings: vi.fn(),
  updateAiModelSettings: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  getAiModelSettings: mocks.getAiModelSettings,
  updateAiModelSettings: mocks.updateAiModelSettings,
  BackendError: class BackendError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly requestId = '',
      readonly details?: Record<string, unknown>,
    ) {
      super(code);
    }
  },
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

const { BackendError } = await import('../../lib/api');

const catalogue: AiModelSettingsResponse['catalogue']['models'] = [
  {
    id: 'vendor-a/model-one',
    name: 'Model One',
    vendor: 'vendor-a',
    description: 'A fast model.',
    inputPricePerMillion: 0.5,
    outputPricePerMillion: 1.5,
  },
  {
    id: 'vendor-b/model-two',
    name: 'Model Two',
    vendor: 'vendor-b',
    description: null,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
  },
  {
    id: 'vendor-c/model-three',
    name: 'Model Three',
    vendor: 'vendor-c',
    description: 'Thinks harder.',
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
  },
];

function settings(extra: Partial<AiModelSettingsResponse> = {}): AiModelSettingsResponse {
  return {
    assistant: { enabled: true, configuredModel: 'vendor-a/model-one', highEffortModel: null },
    storage: true,
    providers: [],
    saved: null,
    catalogue: { available: true, models: catalogue },
    maxAllowed: 8,
    requestId: REQUEST,
    ...extra,
  };
}

function gatewayList(): HTMLElement {
  return screen.getByRole('list', { name: 'AI Gateway models' });
}

function box(name: string): HTMLElement {
  return within(gatewayList()).getByRole('checkbox', { name: new RegExp(name) });
}

describe('AiModelsScreen', () => {
  beforeEach(() => {
    mocks.getAiModelSettings.mockReset();
    mocks.updateAiModelSettings.mockReset();
  });

  it('shows the deployment’s model while nothing is saved, and what an owner should know', async () => {
    mocks.getAiModelSettings.mockResolvedValue(settings({ providers: ['host-a', 'host-b'] }));
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    expect(
      await screen.findByText('Nothing chosen yet: the deployment’s model answers every question'),
    ).toBeTruthy();
    expect(screen.getByText('vendor-a/model-one')).toBeTruthy();
    expect(screen.getByText(/every model must support them/)).toBeTruthy();
    expect(screen.getByText('host-a')).toBeTruthy();
    expect(screen.getByText(/A model none of them serves fails/)).toBeTruthy();
    expect(mocks.getAiModelSettings).toHaveBeenCalledWith('staff-token', WORKSPACE);
  });

  it('lists the saved models with the default tagged', async () => {
    mocks.getAiModelSettings.mockResolvedValue(
      settings({
        saved: {
          allowedModels: [
            { id: 'vendor-a/model-one', label: 'Model One' },
            { id: 'vendor-b/model-two', label: 'Model Two' },
          ],
          defaultModel: 'vendor-b/model-two',
          updatedAt: SAVED_AT,
        },
      }),
    );
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    const list = await screen.findByRole('list', { name: 'Allowed models' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Model Onevendor-a/model-one',
      'Model TwoDefaultvendor-b/model-two',
    ]);
  });

  it('picks models from a searchable list, marks a default and saves the ids only', async () => {
    mocks.getAiModelSettings.mockResolvedValue(settings());
    mocks.updateAiModelSettings.mockResolvedValue({
      saved: {
        allowedModels: [
          { id: 'vendor-a/model-one', label: 'Model One' },
          { id: 'vendor-c/model-three', label: 'Model Three' },
        ],
        defaultModel: 'vendor-c/model-three',
        updatedAt: SAVED_AT,
      },
      requestId: REQUEST,
    });
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit models' }));
    // The deployment's model starts ticked and as the default.
    expect(box('Model One').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('US$0.50 in · US$1.50 out per million tokens')).toBeTruthy();
    expect(screen.getAllByText('No price listed')).toHaveLength(1);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), {
      target: { value: 'vendor-c' },
    });
    expect(within(gatewayList()).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(box('Model Three'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), {
      target: { value: 'nothing like it' },
    });
    expect(screen.getByText('No model matches the search.')).toBeTruthy();

    const defaults = screen.getByRole('group', { name: 'Default model' });
    fireEvent.click(within(defaults).getByRole('radio', { name: 'Model Three' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
    await screen.findByText('Saved. Members see the new models the next time they open Ask AI.');
    expect(mocks.updateAiModelSettings).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      allowedModels: ['vendor-a/model-one', 'vendor-c/model-three'],
      defaultModel: 'vendor-c/model-three',
    });
    const list = screen.getByRole('list', { name: 'Allowed models' });
    expect(within(list).getByText('Model Three')).toBeTruthy();
  });

  it('stops at the most a site may allow', async () => {
    mocks.getAiModelSettings.mockResolvedValue(settings({ maxAllowed: 2 }));
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit models' }));
    fireEvent.click(box('Model Two'));
    expect(box('Model Three').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('2 of 2 chosen · 3 shown')).toBeTruthy();
    // Unticking the default moves it to the first one left.
    fireEvent.click(box('Model One'));
    const defaults = screen.getByRole('group', { name: 'Default model' });
    expect(
      within(defaults).getByRole<HTMLInputElement>('radio', { name: 'Model Two' }).checked,
    ).toBe(true);
  });

  it('names a model the Gateway stopped offering when the save is refused', async () => {
    mocks.getAiModelSettings.mockResolvedValue(settings());
    mocks.updateAiModelSettings.mockRejectedValue(
      new BackendError('invalid_request', 400, REQUEST, {
        reason: 'model_unavailable',
        modelId: 'vendor-b/model-two',
      }),
    );
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit models' }));
    fireEvent.click(box('Model Two'));
    fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The AI Gateway no longer offers Model Two. Untick it and save again.',
    );
  });

  it('leaves out a saved model the catalogue no longer lists, and says so', async () => {
    mocks.getAiModelSettings.mockResolvedValue(
      settings({
        saved: {
          allowedModels: [
            { id: 'vendor-z/retired', label: 'Retired' },
            { id: 'vendor-b/model-two', label: 'Model Two' },
          ],
          defaultModel: 'vendor-z/retired',
          updatedAt: SAVED_AT,
        },
      }),
    );
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit models' }));
    expect(
      screen.getByText('No longer in the AI Gateway’s list, so left out: vendor-z/retired.'),
    ).toBeTruthy();
    mocks.updateAiModelSettings.mockResolvedValue({
      saved: {
        allowedModels: [{ id: 'vendor-b/model-two', label: 'Model Two' }],
        defaultModel: 'vendor-b/model-two',
        updatedAt: SAVED_AT,
      },
      requestId: REQUEST,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
    await waitFor(() =>
      expect(mocks.updateAiModelSettings).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        allowedModels: ['vendor-b/model-two'],
        defaultModel: 'vendor-b/model-two',
      }),
    );
  });

  it('says model choice is not switched on before migration 0040, and offers no edit', async () => {
    mocks.getAiModelSettings.mockResolvedValue(
      settings({ storage: false, catalogue: { available: false, models: [] } }),
    );
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    expect(
      await screen.findByText(/Model choice is not switched on yet: it needs a database update/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit models' }).hasAttribute('disabled')).toBe(true);
  });

  it('says the catalogue is unavailable, with Try again, and keeps the saved list on screen', async () => {
    mocks.getAiModelSettings
      .mockResolvedValueOnce(settings({ catalogue: { available: false, models: [] } }))
      .mockResolvedValue(settings());
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    expect(await screen.findByText(/list of models could not be loaded just now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit models' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit models' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
  });

  it('says when Ask AI is off for the site, and still lets the owner choose', async () => {
    mocks.getAiModelSettings.mockResolvedValue(
      settings({ assistant: { enabled: false, configuredModel: null, highEffortModel: null } }),
    );
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    expect(await screen.findByText(/Ask AI is off for this site/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit models' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('tells anyone but the owner, and an older backend, what they can do', async () => {
    mocks.getAiModelSettings.mockRejectedValueOnce(
      new BackendError('permission_denied', 403, REQUEST),
    );
    const { unmount } = render(<AiModelsScreen workspaceSlug="canadawide" />);
    expect((await screen.findByRole('alert')).textContent).not.toContain('permission_denied');
    unmount();
    mocks.getAiModelSettings.mockRejectedValueOnce(new BackendError('not_found', 404, REQUEST));
    render(<AiModelsScreen workspaceSlug="canadawide" />);
    expect(
      await screen.findByText(
        'Choosing Ask AI’s models is not available yet. It will appear here once the CRM is updated.',
      ),
    ).toBeTruthy();
  });
});

describe('priceText', () => {
  it('reads a price per million tokens, or that there is none', () => {
    expect(priceText({ inputPricePerMillion: 0.075, outputPricePerMillion: 0.3 })).toBe(
      'US$0.075 in · US$0.30 out per million tokens',
    );
    expect(priceText({ inputPricePerMillion: null, outputPricePerMillion: 1 })).toBe(
      'No price listed',
    );
  });
});
