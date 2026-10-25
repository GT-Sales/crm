import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts a well-formed health response', () => {
    const result = healthResponseSchema.safeParse({
      ok: true,
      requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a response with ok: false', () => {
    const result = healthResponseSchema.safeParse({
      ok: false,
      requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a response missing requestId', () => {
    const result = healthResponseSchema.safeParse({ ok: true });

    expect(result.success).toBe(false);
  });

  it('rejects a requestId that is not a UUID', () => {
    const result = healthResponseSchema.safeParse({ ok: true, requestId: 'not-a-uuid' });

    expect(result.success).toBe(false);
  });
});
