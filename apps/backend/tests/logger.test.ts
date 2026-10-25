import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  FALLBACK_ERROR_CODE,
  isConnectionLevelError,
  logRequestError,
  sanitizeErrorCode,
  sanitizeLogFlag,
  sanitizeLogIdentifier,
} from '../src/http/logger.js';

const REQUEST_ID = '40000000-0000-4000-8000-000000000700';
const WORKSPACE = '10000000-0000-4000-8000-000000000700';

const logRecordSchema = z.object({
  event: z.literal('request_error'),
  requestId: z.string(),
  workspaceId: z.string(),
  route: z.string(),
  code: z.string(),
  flag: z.enum(['retryable', 'not_retryable']),
});

function withCode(code: string): Error {
  return Object.assign(new Error('driver failure'), { code });
}

function parseLogLine(line: unknown): z.infer<typeof logRecordSchema> {
  if (typeof line !== 'string') throw new Error('expected the logger to emit a JSON string');
  return logRecordSchema.parse(JSON.parse(line));
}

describe('sanitizeErrorCode', () => {
  it('keeps a code that already matches the safe pattern', () => {
    expect(sanitizeErrorCode('persistence_unavailable')).toBe('persistence_unavailable');
    expect(sanitizeErrorCode('internal_error')).toBe('internal_error');
    expect(sanitizeErrorCode('a')).toBe('a');
    expect(sanitizeErrorCode('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('replaces a raw error message with the fallback code', () => {
    expect(sanitizeErrorCode('connect ECONNREFUSED 10.0.0.1:5432 for user admin')).toBe(
      FALLBACK_ERROR_CODE,
    );
    expect(sanitizeErrorCode('select * from app.orders')).toBe(FALLBACK_ERROR_CODE);
  });

  it('replaces PII-like text with the fallback code', () => {
    expect(sanitizeErrorCode('customer jane@example.com')).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode('+1-555-0100')).toBe(FALLBACK_ERROR_CODE);
  });

  it('replaces unsafe, out-of-shape or non-string codes', () => {
    expect(sanitizeErrorCode('57P01')).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode('Bad Code')).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode('UPPER_CASE')).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode('1leading_digit')).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode('a'.repeat(65))).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode(undefined)).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode(null)).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode(42)).toBe(FALLBACK_ERROR_CODE);
    expect(sanitizeErrorCode({ code: 'ECONNREFUSED' })).toBe(FALLBACK_ERROR_CODE);
  });
});

describe('sanitizeLogFlag', () => {
  it('keeps a flag from the fixed allowlist', () => {
    expect(sanitizeLogFlag('retryable')).toBe('retryable');
    expect(sanitizeLogFlag('not_retryable')).toBe('not_retryable');
  });

  it('defaults anything outside the allowlist', () => {
    expect(sanitizeLogFlag('RETRYABLE')).toBe('not_retryable');
    expect(sanitizeLogFlag('success')).toBe('not_retryable');
    expect(sanitizeLogFlag(undefined)).toBe('not_retryable');
  });
});

describe('sanitizeLogIdentifier', () => {
  it('keeps a bounded identifier', () => {
    expect(sanitizeLogIdentifier(REQUEST_ID)).toBe(REQUEST_ID);
    expect(sanitizeLogIdentifier('/api/v1/orders')).toBe('/api/v1/orders');
  });

  it('drops free text, PII, SQL and over-long values', () => {
    expect(sanitizeLogIdentifier('jane@example.com')).toBeUndefined();
    expect(sanitizeLogIdentifier('connect ECONNREFUSED')).toBeUndefined();
    expect(sanitizeLogIdentifier('x'.repeat(129))).toBeUndefined();
    expect(sanitizeLogIdentifier(undefined)).toBeUndefined();
  });
});

describe('logRequestError', () => {
  it('emits only the allowlisted fields with a scrubbed code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logRequestError({
      requestId: REQUEST_ID,
      workspaceId: WORKSPACE,
      route: '/api/v1/orders',
      code: 'customer jane@example.com leaked 10.0.0.1',
      flag: 'retryable',
    });

    const line = spy.mock.calls[0]?.[0];
    const record = parseLogLine(line);
    expect(record).toEqual({
      event: 'request_error',
      requestId: REQUEST_ID,
      workspaceId: WORKSPACE,
      route: '/api/v1/orders',
      code: FALLBACK_ERROR_CODE,
      flag: 'retryable',
    });
    expect(JSON.stringify(line)).not.toContain('jane@example.com');
    expect(JSON.stringify(line)).not.toContain('10.0.0.1');
  });

  it('marks an out-of-allowlist flag as not retryable and drops unsafe identifiers', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logRequestError({
      requestId: 'not a request id',
      workspaceId: 'also not an id',
      route: '/api/v1/orders',
      code: 'internal_error',
      flag: 'maybe',
    });

    const record = parseLogLine(spy.mock.calls[0]?.[0]);
    expect(record.requestId).toBe('unknown');
    expect(record.workspaceId).toBe('unknown');
    expect(record.code).toBe('internal_error');
    expect(record.flag).toBe('not_retryable');
  });
});

describe('isConnectionLevelError', () => {
  it('classifies SQLSTATE class 08 and PostgreSQL availability codes as connection-level', () => {
    expect(isConnectionLevelError(withCode('08006'))).toBe(true);
    expect(isConnectionLevelError(withCode('08001'))).toBe(true);
    expect(isConnectionLevelError(withCode('57P01'))).toBe(true);
    expect(isConnectionLevelError(withCode('53300'))).toBe(true);
  });

  it('classifies socket-level failures as connection-level', () => {
    expect(isConnectionLevelError(withCode('ECONNREFUSED'))).toBe(true);
    expect(isConnectionLevelError(withCode('ETIMEDOUT'))).toBe(true);
    expect(isConnectionLevelError(withCode('EPIPE'))).toBe(true);
    expect(isConnectionLevelError(withCode('CONNECT_TIMEOUT'))).toBe(true);
  });

  it('inspects a nested cause, as drizzle wraps the driver error', () => {
    const wrapped = new Error('Failed query', { cause: withCode('08006') });
    expect(isConnectionLevelError(wrapped)).toBe(true);
  });

  it('does not treat a logic error or a non-connection code as connection-level', () => {
    expect(isConnectionLevelError(new Error('snapshot parse failed'))).toBe(false);
    expect(isConnectionLevelError(withCode('23505'))).toBe(false);
    expect(isConnectionLevelError({ code: '42P01' })).toBe(false);
    expect(isConnectionLevelError('ECONNREFUSED')).toBe(false);
    expect(isConnectionLevelError(null)).toBe(false);
    expect(isConnectionLevelError(undefined)).toBe(false);
  });

  it('terminates on a self-referencing cause chain', () => {
    const cyclic = new Error('cyclic');
    cyclic.cause = cyclic;
    expect(isConnectionLevelError(cyclic)).toBe(false);
  });
});
