import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultWebsiteRouteDependencies,
  websiteBotCheckMode,
} from '../src/routes/website.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Runs the wired bot check against a real Express request carrying no Turnstile token. */
async function admits(): Promise<boolean> {
  const { auth } = createDefaultWebsiteRouteDependencies();
  const app = express();
  app.get('/', async (req, res) => {
    res.json({ admitted: await auth.botCheck(req, 'lead-save') });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address: AddressInfo | string | null = server.address();
    if (!address || typeof address === 'string') throw new Error('server has no port');
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const body: unknown = await response.json();
    return (
      typeof body === 'object' && body !== null && 'admitted' in body && body.admitted === true
    );
  } finally {
    server.close();
  }
}

describe('website bot check mode', () => {
  it('delegates only on the exact opt-in value', () => {
    expect(websiteBotCheckMode({ WEBSITE_BOT_CHECK: 'delegated' })).toBe('delegated');
    for (const value of [undefined, '', 'off', 'DELEGATED', 'turnstile']) {
      expect(websiteBotCheckMode({ WEBSITE_BOT_CHECK: value })).toBe('turnstile');
    }
  });

  it('refuses every write when Turnstile is the mode and is not configured', async () => {
    vi.stubEnv('WEBSITE_BOT_CHECK', '');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await admits()).toBe(false);
      const codes = logged.mock.calls.map(([line]) => JSON.parse(String(line)).code);
      expect(codes).toContain('bot_check_unconfigured');
    } finally {
      logged.mockRestore();
    }
  });

  it('admits writes in delegated mode without asking for a token or logging an error', async () => {
    vi.stubEnv('WEBSITE_BOT_CHECK', 'delegated');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await admits()).toBe(true);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
