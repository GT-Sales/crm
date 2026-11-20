import { describe, expect, it } from 'vitest';

import { aiCapabilitiesResponseSchema, aiChatRequestSchema } from './ai-assistant';
import {
  AI_MODEL_LIMITS,
  aiModelIdSchema,
  aiModelSettingsResponseSchema,
  updateAiModelSettingsRequestSchema,
  updateAiModelSettingsResponseSchema,
} from './ai-models';
import { createBackendClient } from './client';
import { domainErrorCodeSchema } from './common';
import { endpoints } from './endpoints';

const UUID = '00000000-0000-4000-8000-000000000001';
const SITE = '00000000-0000-4000-8000-000000000002';
const NOW = '2026-11-20T12:00:00.000Z';

const capabilities = {
  available: true,
  site: { id: SITE, slug: 'getcanadasim', name: 'Get Canada Sim' },
  leadTypes: ['sim_order'],
  limits: { maxMessageChars: 2000, maxHistoryMessages: 12, maxConversationChars: 12000 },
  requestId: UUID,
};

describe('a Gateway model id', () => {
  it('takes vendor/model ids and refuses anything that could carry more than an id', () => {
    for (const id of ['vendor-a/model-one', 'vendor_b/model.two-1.5', 'v/m:free'])
      expect(aiModelIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of [
      '',
      'model-without-vendor',
      '/model',
      'vendor/',
      'vendor/model one',
      'vendor/model\n',
      'vendor/model/extra',
      'vendor/<script>',
      `vendor/${'m'.repeat(AI_MODEL_LIMITS.maxIdChars)}`,
    ])
      expect(aiModelIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
  });
});

describe('the owner’s save', () => {
  it('takes 1 to 8 distinct ids and a default among them', () => {
    expect(
      updateAiModelSettingsRequestSchema.parse({
        allowedModels: ['vendor-a/model-one', 'vendor-b/model-two'],
        defaultModel: 'vendor-b/model-two',
      }),
    ).toEqual({
      allowedModels: ['vendor-a/model-one', 'vendor-b/model-two'],
      defaultModel: 'vendor-b/model-two',
    });
    const nine = Array.from({ length: 9 }, (_, index) => `vendor-a/model-${String(index)}`);
    for (const body of [
      { allowedModels: [], defaultModel: 'vendor-a/model-one' },
      { allowedModels: nine, defaultModel: 'vendor-a/model-0' },
      { allowedModels: ['vendor-a/model-one'], defaultModel: 'vendor-b/model-two' },
      {
        allowedModels: ['vendor-a/model-one', 'vendor-a/model-one'],
        defaultModel: 'vendor-a/model-one',
      },
      // Labels come from the catalogue on the server, never from the browser.
      {
        allowedModels: ['vendor-a/model-one'],
        defaultModel: 'vendor-a/model-one',
        labels: { 'vendor-a/model-one': 'Mine' },
      },
    ])
      expect(updateAiModelSettingsRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('capabilities and the chat request', () => {
  it('lists models only as an optional field, which an older admin strips', () => {
    expect(aiCapabilitiesResponseSchema.parse(capabilities)).not.toHaveProperty('models');
    const withModels = aiCapabilitiesResponseSchema.parse({
      ...capabilities,
      models: [
        { id: 'vendor-a/model-one', label: 'Model One' },
        { id: 'vendor-b/model-two', label: 'Model Two' },
      ],
      defaultModel: 'vendor-a/model-one',
    });
    expect(withModels.models).toHaveLength(2);
    expect(withModels.defaultModel).toBe('vendor-a/model-one');
    // One model needs no picker: the backend never sends a list of one.
    expect(
      aiCapabilitiesResponseSchema.safeParse({
        ...capabilities,
        models: [{ id: 'vendor-a/model-one', label: 'Model One' }],
      }).success,
    ).toBe(false);
  });

  it('takes an optional model on the chat request, bounded like an id', () => {
    const request = { requestId: UUID, message: 'How many orders?', history: [] };
    expect(aiChatRequestSchema.parse(request)).not.toHaveProperty('model');
    expect(aiChatRequestSchema.parse({ ...request, model: 'vendor-b/model-two' }).model).toBe(
      'vendor-b/model-two',
    );
    expect(aiChatRequestSchema.safeParse({ ...request, model: 'not an id' }).success).toBe(false);
  });
});

describe('the model settings routes', () => {
  it('registers both under the staff AI path and knows their error code', () => {
    const base = '/api/v1/staff/workspaces/{workspaceId}/ai';
    expect(endpoints.find((entry) => entry.operationId === 'getAiModelSettings')).toMatchObject({
      method: 'GET',
      path: `${base}/model-settings`,
      auth: 'staff',
      successStatus: 200,
    });
    expect(endpoints.find((entry) => entry.operationId === 'updateAiModelSettings')).toMatchObject({
      method: 'PUT',
      path: `${base}/model-settings`,
      auth: 'staff',
      successStatus: 200,
    });
    expect(domainErrorCodeSchema.safeParse('ai_models_unavailable').success).toBe(true);
  });

  it('reads the settings and saves a list through the typed client', async () => {
    const settings = {
      assistant: { enabled: true, configuredModel: 'vendor-a/model-one', highEffortModel: null },
      storage: true,
      providers: [],
      saved: null,
      catalogue: {
        available: true,
        models: [
          {
            id: 'vendor-a/model-one',
            name: 'Model One',
            vendor: 'vendor-a',
            description: null,
            inputPricePerMillion: 0.5,
            outputPricePerMillion: 1.5,
          },
        ],
      },
      maxAllowed: 8,
      requestId: UUID,
    };
    const saved = {
      saved: {
        allowedModels: [{ id: 'vendor-a/model-one', label: 'Model One' }],
        defaultModel: 'vendor-a/model-one',
        updatedAt: NOW,
      },
      requestId: UUID,
    };
    const calls: { url: string; method: string; body: string | undefined }[] = [];
    const answers = [settings, saved];
    const client = createBackendClient({
      baseUrl: 'https://api.example.test',
      credential: 'gtsk_test',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return new Response(JSON.stringify(answers.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(await client.staff.getAiModelSettings(SITE)).toEqual(settings);
    expect(
      await client.staff.updateAiModelSettings(SITE, {
        allowedModels: ['vendor-a/model-one'],
        defaultModel: 'vendor-a/model-one',
      }),
    ).toEqual(saved);
    const url = `https://api.example.test/api/v1/staff/workspaces/${SITE}/ai/model-settings`;
    expect(calls.map(({ url: called, method }) => [called, method])).toEqual([
      [url, 'GET'],
      [url, 'PUT'],
    ]);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      allowedModels: ['vendor-a/model-one'],
      defaultModel: 'vendor-a/model-one',
    });
    // The client refuses a save the server would refuse, before sending it.
    await expect(
      client.staff.updateAiModelSettings(SITE, {
        allowedModels: ['vendor-a/model-one'],
        defaultModel: 'vendor-b/model-two',
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it('refuses a drifted answer', () => {
    expect(
      aiModelSettingsResponseSchema.safeParse({
        assistant: { enabled: true, configuredModel: null, highEffortModel: null },
        storage: true,
        providers: [],
        saved: null,
        catalogue: {
          available: true,
          models: [
            {
              id: 'vendor-a/model-one',
              name: 'Model One',
              vendor: 'vendor-a',
              description: null,
              inputPricePerMillion: -1,
              outputPricePerMillion: null,
            },
          ],
        },
        maxAllowed: 8,
        requestId: UUID,
      }).success,
    ).toBe(false);
    expect(
      updateAiModelSettingsResponseSchema.safeParse({
        saved: { allowedModels: [], defaultModel: 'vendor-a/model-one', updatedAt: NOW },
        requestId: UUID,
      }).success,
    ).toBe(false);
  });
});
