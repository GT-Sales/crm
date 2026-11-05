import { describe, expect, it } from 'vitest';

import { loadAiAssistantConfig } from '../src/ai/config.js';

const ON = {
  AI_ASSISTANT_ENABLED: 'true',
  AI_GATEWAY_API_KEY: 'gateway-key',
  AI_GATEWAY_MODEL: 'provider/model',
};
const SECRET = 's'.repeat(32);

describe('the AI signing key', () => {
  it('uses the dedicated secret when it is set', () => {
    expect(loadAiAssistantConfig({ ...ON, AI_ACTION_SIGNING_SECRET: ` ${SECRET} ` })).toMatchObject(
      {
        apiKey: 'gateway-key',
        signingKey: SECRET,
        signingKeySource: 'dedicated',
      },
    );
  });

  it('falls back to the Gateway key until the secret is configured', () => {
    expect(loadAiAssistantConfig(ON)).toMatchObject({
      signingKey: 'gateway-key',
      signingKeySource: 'gateway',
    });
  });

  it('signs nothing with a secret that is set but too short', () => {
    const config = loadAiAssistantConfig({ ...ON, AI_ACTION_SIGNING_SECRET: 'short' });
    expect(config.enabled).toBe(true);
    expect(config.signingKey).toBeUndefined();
    expect(config.signingKeySource).toBeUndefined();
  });

  it('never exposes a key while the assistant is off', () => {
    const config = loadAiAssistantConfig({ AI_ACTION_SIGNING_SECRET: SECRET });
    expect(config.enabled).toBe(false);
    expect(config.signingKey).toBeUndefined();
  });
});
