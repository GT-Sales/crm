import { describe, expect, it } from 'vitest';

import { summariseDelivery } from '../src/email/store.js';

describe('delivery summary', () => {
  it('counts each status on its own, with queued mail apart from sent', () => {
    expect(
      summariseDelivery([
        { status: 'queued', count: 3 },
        { status: 'sent', count: 5 },
        { status: 'delivered', count: 7 },
        { status: 'failed', count: 1 },
        { status: 'bounced', count: 2 },
        { status: 'complained', count: 4 },
        { status: 'uncertain', count: 6 },
      ]),
    ).toEqual({ queued: 3, sent: 5, delivered: 7, failed: 7, uncertain: 6 });
  });

  it('does not count a status it does not know as sent', () => {
    expect(summariseDelivery([{ status: 'mystery', count: 9 }])).toEqual({
      queued: 0,
      sent: 0,
      delivered: 0,
      failed: 0,
      uncertain: 0,
    });
  });
});
