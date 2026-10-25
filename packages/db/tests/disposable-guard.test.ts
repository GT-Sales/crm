import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertDisposableDatabaseName, assertDisposableDatabaseUrl } from '../src/test-helpers.js';

afterEach(() => vi.unstubAllEnvs());

describe('destructive test setup guard', () => {
  it('allows localhost and databases named *_test / *_e2e', () => {
    expect(() =>
      assertDisposableDatabaseUrl('postgresql://postgres:p@localhost:5432/anything'),
    ).not.toThrow();
    expect(() =>
      assertDisposableDatabaseUrl('postgresql://u:p@ci.example.test:5432/canadian_plans_e2e_test'),
    ).not.toThrow();
    expect(() => assertDisposableDatabaseName('canadian_plans_test')).not.toThrow();
  });

  it('refuses a hosted database such as Supabase production', () => {
    expect(() =>
      assertDisposableDatabaseUrl('postgresql://u:p@db.ref.supabase.co:5432/postgres'),
    ).toThrow(/Refusing destructive test setup/);
    expect(() => assertDisposableDatabaseName('postgres')).toThrow(/postgres/);
  });

  it('honours only the exact override value', () => {
    vi.stubEnv('E2E_ALLOW_REMOTE_DATABASE', 'yes');
    expect(() => assertDisposableDatabaseName('postgres')).toThrow();
    vi.stubEnv('E2E_ALLOW_REMOTE_DATABASE', 'yes-i-understand');
    expect(() => assertDisposableDatabaseName('postgres')).not.toThrow();
  });
});
