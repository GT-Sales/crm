import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, createNonce } from './csp';

const env = {
  isProduction: true,
  apiBaseUrl: 'https://api.example.test/v1',
  supabaseUrl: 'https://abcdef.supabase.co',
  sentryDsn: 'https://key@o1.ingest.sentry.io/2',
};

function directive(csp: string, name: string): string[] {
  const found = csp.split('; ').find((part) => part.startsWith(`${name} `));
  return found ? found.split(' ').slice(1) : [];
}

// Audit M-1: scripts run only with this response's nonce.
describe('admin Content-Security-Policy', () => {
  it('allows scripts by nonce only in production, never inline', () => {
    const csp = buildContentSecurityPolicy('bm9uY2U=', env);
    expect(directive(csp, 'script-src')).toEqual([
      "'self'",
      "'nonce-bm9uY2U='",
      "'strict-dynamic'",
    ]);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('adds eval for React in development only', () => {
    expect(
      directive(buildContentSecurityPolicy('n', { ...env, isProduction: false }), 'script-src'),
    ).toContain("'unsafe-eval'");
  });

  it('keeps connect-src to the API, Supabase and Sentry, and frames/images to Storage', () => {
    const csp = buildContentSecurityPolicy('n', env);
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'https://api.example.test',
      'https://abcdef.supabase.co',
      'https://o1.ingest.sentry.io',
    ]);
    expect(directive(csp, 'frame-src')).toEqual(["'self'", 'https://abcdef.storage.supabase.co']);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('makes a fresh nonce each time', () => {
    const a = createNonce();
    expect(a).not.toBe(createNonce());
    expect(a.length).toBeGreaterThanOrEqual(24);
  });
});
