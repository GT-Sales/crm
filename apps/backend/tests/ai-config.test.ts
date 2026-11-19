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

  it('switches Ask AI off with a secret that is set but too short (audit B6)', () => {
    for (const secret of ['short', 's'.repeat(31), ` ${'s'.repeat(31)} `]) {
      const config = loadAiAssistantConfig({ ...ON, AI_ACTION_SIGNING_SECRET: secret });
      expect(config, secret).toMatchObject({
        enabled: false,
        reason: 'not_configured',
        signingSecretInvalid: true,
      });
      expect(config.signingKey).toBeUndefined();
      expect(config.signingKeySource).toBeUndefined();
      expect(config.apiKey).toBeUndefined();
      expect(config.modelId).toBeUndefined();
      expect(config.highEffort).toBeUndefined();
    }
    // Exactly the minimum is accepted; blank is unset (the Gateway key).
    expect(
      loadAiAssistantConfig({ ...ON, AI_ACTION_SIGNING_SECRET: 's'.repeat(32) }),
    ).toMatchObject({ enabled: true, signingKeySource: 'dedicated' });
    expect(loadAiAssistantConfig({ ...ON, AI_ACTION_SIGNING_SECRET: '  ' })).toMatchObject({
      enabled: true,
      signingKeySource: 'gateway',
    });
  });

  it('never leaves an enabled assistant without a signing key', () => {
    for (const secret of [undefined, '', 'x', 'y'.repeat(31), 'z'.repeat(32), 'w'.repeat(80)]) {
      const config = loadAiAssistantConfig({
        ...ON,
        ...(secret === undefined ? {} : { AI_ACTION_SIGNING_SECRET: secret }),
      });
      if (config.enabled) expect(config.signingKey, String(secret)).toBeTruthy();
    }
  });

  it('never exposes a key while the assistant is off', () => {
    const config = loadAiAssistantConfig({ AI_ACTION_SIGNING_SECRET: SECRET });
    expect(config.enabled).toBe(false);
    expect(config.signingKey).toBeUndefined();
  });
});

describe('the Gateway host pin', () => {
  it('lets the Gateway choose when unset', () => {
    expect(loadAiAssistantConfig(ON).providers).toBeUndefined();
  });

  it('keeps valid hosts in order, trimmed and de-duplicated', () => {
    expect(
      loadAiAssistantConfig({ ...ON, AI_GATEWAY_PROVIDERS: ' baseten, azure ,baseten' }).providers,
    ).toEqual(['baseten', 'azure']);
  });

  it('drops malformed entries and never yields an empty list', () => {
    expect(
      loadAiAssistantConfig({ ...ON, AI_GATEWAY_PROVIDERS: 'base ten, ../x, 9x' }).providers,
    ).toBeUndefined();
    expect(
      loadAiAssistantConfig({ ...ON, AI_GATEWAY_PROVIDERS: 'bad host,azure' }).providers,
    ).toEqual(['azure']);
  });
});

describe('High effort', () => {
  it('is off unless AI_HIGH_EFFORT_ENABLED is exactly true', () => {
    expect(loadAiAssistantConfig(ON).highEffort).toBeUndefined();
    for (const value of ['1', 'TRUE', 'yes', ' true', '']) {
      expect(
        loadAiAssistantConfig({ ...ON, AI_HIGH_EFFORT_ENABLED: value }).highEffort,
        value,
      ).toBeUndefined();
    }
  });

  it('serves High with the normal model unless AI_GATEWAY_MODEL_HIGH names one', () => {
    expect(loadAiAssistantConfig({ ...ON, AI_HIGH_EFFORT_ENABLED: 'true' }).highEffort).toEqual({
      modelId: 'provider/model',
    });
    expect(
      loadAiAssistantConfig({
        ...ON,
        AI_HIGH_EFFORT_ENABLED: 'true',
        AI_GATEWAY_MODEL_HIGH: ' provider/thinker ',
      }).highEffort,
    ).toEqual({ modelId: 'provider/thinker' });
    // Blank is unset.
    expect(
      loadAiAssistantConfig({ ...ON, AI_HIGH_EFFORT_ENABLED: 'true', AI_GATEWAY_MODEL_HIGH: '  ' })
        .highEffort,
    ).toEqual({ modelId: 'provider/model' });
  });

  it('is off with a High model id that fails the model id check, never the normal model instead', () => {
    expect(
      loadAiAssistantConfig({
        ...ON,
        AI_HIGH_EFFORT_ENABLED: 'true',
        AI_GATEWAY_MODEL_HIGH: 'x'.repeat(121),
      }).highEffort,
    ).toBeUndefined();
  });

  it('is never on while the assistant is off or not configured', () => {
    expect(
      loadAiAssistantConfig({ AI_HIGH_EFFORT_ENABLED: 'true', AI_GATEWAY_MODEL_HIGH: 'p/m' })
        .highEffort,
    ).toBeUndefined();
    expect(
      loadAiAssistantConfig({
        AI_ASSISTANT_ENABLED: 'true',
        AI_GATEWAY_API_KEY: 'k',
        AI_HIGH_EFFORT_ENABLED: 'true',
        AI_GATEWAY_MODEL_HIGH: 'p/m',
      }).highEffort,
    ).toBeUndefined();
  });

  it('reads AI_HIGH_EFFORT_REASONING as one of the SDK’s reasoning words, else asks for none', () => {
    const high = { ...ON, AI_HIGH_EFFORT_ENABLED: 'true' };
    for (const word of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(loadAiAssistantConfig({ ...high, AI_HIGH_EFFORT_REASONING: word }).highEffort).toEqual(
        { modelId: 'provider/model', reasoning: word },
      );
    }
    expect(
      loadAiAssistantConfig({ ...high, AI_HIGH_EFFORT_REASONING: ' Medium ' }).highEffort
        ?.reasoning,
    ).toBe('medium');
    // `none` and `provider-default` are not a way to think harder; nonsense is ignored.
    for (const value of ['none', 'provider-default', '12000', 'extreme', '']) {
      expect(
        loadAiAssistantConfig({ ...high, AI_HIGH_EFFORT_REASONING: value }).highEffort,
        value,
      ).toEqual({ modelId: 'provider/model' });
    }
    // Without High it sends nothing at all.
    expect(
      loadAiAssistantConfig({ ...ON, AI_HIGH_EFFORT_REASONING: 'high' }).highEffort,
    ).toBeUndefined();
  });

  it('leaves the normal configuration exactly as it was', () => {
    const { highEffort: _high, ...withHigh } = loadAiAssistantConfig({
      ...ON,
      AI_HIGH_EFFORT_ENABLED: 'true',
      AI_GATEWAY_MODEL_HIGH: 'provider/thinker',
      AI_HIGH_EFFORT_REASONING: 'high',
    });
    expect(withHigh).toEqual(loadAiAssistantConfig(ON));
  });
});
