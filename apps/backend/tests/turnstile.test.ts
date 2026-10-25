import { describe, expect, it, vi } from 'vitest';
import { createTurnstileVerifier } from '../src/website/turnstile.js';

const config = { secret: 'synthetic-secret', hostname: 'shop.example', action: 'lead-submit' };
const valid = { success: true, hostname: config.hostname, action: config.action };

describe('Turnstile server verification', () => {
  it('verifies each token with the provider, including replay attempts', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(valid))
      .mockResolvedValueOnce(
        Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
      );
    const verify = createTurnstileVerifier(config, request);
    expect(await verify('challenge')).toBe(true);
    expect(await verify('challenge')).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      secret: config.secret,
      response: 'challenge',
    });
  });

  it.each([
    { success: false },
    { ...valid, hostname: 'foreign.example' },
    { ...valid, action: 'login' },
    { success: true },
    { ...valid, success: 'true' },
  ])('denies invalid provider result %j', async (body) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    expect(await createTurnstileVerifier(config, request)('challenge')).toBe(false);
  });

  it('denies missing/oversize tokens and incomplete configuration without network calls', async () => {
    const request = vi.fn<typeof fetch>();
    expect(await createTurnstileVerifier(config, request)(undefined)).toBe(false);
    expect(await createTurnstileVerifier(config, request)('x'.repeat(2049))).toBe(false);
    expect(await createTurnstileVerifier({ action: 'lead-submit' }, request)('challenge')).toBe(
      false,
    );
    expect(
      await createTurnstileVerifier(
        { ...config, secret: '1x0000000000000000000000000000000AA' },
        request,
      )('challenge'),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on network, HTTP and malformed JSON errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('invalid JSON'));
    const verify = createTurnstileVerifier(config, request);
    expect(await verify('challenge')).toBe(false);
    expect(await verify('challenge')).toBe(false);
    expect(await verify('challenge')).toBe(false);
  });
  it('reports why it denied, as a bounded code, without changing the fail-closed result', async () => {
    const onFailure = vi.fn();
    const silent = vi.fn<typeof fetch>();
    expect(
      await createTurnstileVerifier({ action: 'lead-submit', onFailure }, silent)('challenge'),
    ).toBe(false);
    expect(onFailure).toHaveBeenLastCalledWith('unconfigured');
    expect(silent).not.toHaveBeenCalled();

    const unreachable = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network'));
    expect(await createTurnstileVerifier({ ...config, onFailure }, unreachable)('challenge')).toBe(
      false,
    );
    expect(onFailure).toHaveBeenLastCalledWith('provider_unreachable');

    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...valid, hostname: 'other.example' }));
    expect(await createTurnstileVerifier({ ...config, onFailure }, rejected)('challenge')).toBe(
      false,
    );
    expect(onFailure).toHaveBeenLastCalledWith('provider_rejected');

    // A missing token is the visitor's problem, not an outage: not reported.
    onFailure.mockClear();
    expect(await createTurnstileVerifier({ ...config, onFailure }, silent)(undefined)).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('accepts only configured exact hostnames and the route-owned action', async () => {
    const request = vi.fn<typeof fetch>();
    const verify = createTurnstileVerifier(
      {
        secret: 'synthetic-secret',
        hostnames: ['canadianplans.com', 'www.canadianplans.com'],
        action: 'order-submit',
      },
      request,
    );
    for (const hostname of ['canadianplans.com', 'www.canadianplans.com']) {
      request.mockResolvedValueOnce(
        Response.json({ success: true, hostname, action: 'order-submit' }),
      );
      expect(await verify('fresh-proof')).toBe(true);
    }
    request.mockResolvedValueOnce(
      Response.json({ success: true, hostname: 'foreign.example', action: 'order-submit' }),
    );
    expect(await verify('fresh-proof')).toBe(false);
    request.mockResolvedValueOnce(
      Response.json({ success: true, hostname: 'canadianplans.com', action: 'lead-save' }),
    );
    expect(await verify('fresh-proof')).toBe(false);
  });
});
