import { afterEach, describe, expect, it, vi } from 'vitest';

// Unit test: no database. `postgres` is replaced so the options the runtime
// client passes to the driver can be asserted without opening a socket.
const postgresMock = vi.hoisted(() =>
  vi.fn(() => ({ options: { parsers: {}, serializers: {} }, end: async () => {} })),
);
vi.mock('postgres', () => ({ default: postgresMock }));

const { createDatabaseClient, postgresSsl, runtimePoolMax, sslModeFromEnv } =
  await import('../src/index.js');

afterEach(() => {
  postgresMock.mockClear();
  vi.unstubAllEnvs();
});

describe('runtime pool sizing (DATABASE_POOL_MAX)', () => {
  it('defaults to a small shared pool, not a single connection', () => {
    expect(runtimePoolMax({})).toBe(8);
  });

  it('honours an integer between 1 and 50 and ignores anything else', () => {
    expect(runtimePoolMax({ DATABASE_POOL_MAX: '5' })).toBe(5);
    expect(runtimePoolMax({ DATABASE_POOL_MAX: ' 12 ' })).toBe(12);
    for (const value of ['0', '51', '-3', '2.5', 'eight', '']) {
      expect(runtimePoolMax({ DATABASE_POOL_MAX: value })).toBe(8);
    }
  });

  it('passes the configured size to the driver with prepared statements disabled', () => {
    createDatabaseClient({
      connectionString: 'postgresql://app_runtime:secret@localhost:6543/app',
      ssl: false,
      maxConnections: runtimePoolMax({ DATABASE_POOL_MAX: '5' }),
    });
    expect(postgresMock).toHaveBeenCalledWith(
      'postgresql://app_runtime:secret@localhost:6543/app',
      expect.objectContaining({ max: 5, prepare: false }),
    );
  });
});

describe('database TLS modes', () => {
  it('keeps "require" (encrypted, unverified) as the default for every caller', () => {
    expect(postgresSsl(undefined)).toBe('require');
    expect(sslModeFromEnv('DATABASE_SSL_MODE', undefined)).toBe('require');
  });

  it('verify-full checks the server certificate, with an optional CA', () => {
    expect(postgresSsl('verify-full')).toEqual({ rejectUnauthorized: true });
    expect(postgresSsl('verify-full', ' PEM ')).toEqual({ rejectUnauthorized: true, ca: 'PEM' });
    expect(sslModeFromEnv('DATABASE_SSL_MODE', 'verify-full')).toBe('verify-full');
    expect(sslModeFromEnv('DATABASE_SSL_MODE', 'disable')).toBe(false);
    expect(() => sslModeFromEnv('DATABASE_SSL_MODE', 'prefer')).toThrow(/verify-full/);
  });

  it('passes the verifying object to the driver', () => {
    createDatabaseClient({
      connectionString: 'postgresql://u:p@localhost:6543/app',
      ssl: 'verify-full',
    });
    expect(postgresMock).toHaveBeenLastCalledWith(
      'postgresql://u:p@localhost:6543/app',
      expect.objectContaining({ ssl: expect.objectContaining({ rejectUnauthorized: true }) }),
    );
  });
});
