import { describe, expect, it, vi } from 'vitest';

import { alertOnce } from '../src/automations/tick.js';

const SITE = '18000000-0000-4000-8000-000000008699';

describe('automation tick alerts', () => {
  it('remembers a site only once its alert was delivered, so a failed delivery is retried', async () => {
    const delivered: string[] = [];
    let attempts = 0;
    const alerts = {
      send: vi.fn(async (alert: { detail: string }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('provider down');
        delivered.push(alert.detail);
      }),
    };
    const dependencies = { alerts };
    const seen = new Set<string>();
    const tick = () => alertOnce(dependencies, seen, SITE, 'automation_backlog', `site:${SITE}`);

    await tick();
    expect(delivered).toEqual([]);
    expect(seen.has(SITE)).toBe(false);
    await tick();
    expect(delivered).toEqual([`site:${SITE}`]);
    expect(seen.has(SITE)).toBe(true);
    await tick();
    expect(delivered).toHaveLength(1);
  });
});
