import type { NextConfig } from 'next';

import { originOf } from './src/lib/csp';

/**
 * Security response headers for the staff admin (REQ 37, §16 gate 12). Admin
 * authenticates to the backend with a Supabase access token sent as an
 * `Authorization: Bearer` header (held in the browser, never an ambient cookie),
 * so it is not exposed to CSRF; these headers add transport hardening and
 * clickjacking protection. The Content-Security-Policy is set per request with
 * a nonce by `src/proxy.ts` (src/lib/csp.ts), since a nonce cannot be static.
 */
const apiOrigin = originOf(process.env.NEXT_PUBLIC_API_BASE_URL);
const supabaseOrigin = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);

// With connect-src pinned to these origins, a production deployment missing
// either would silently block the API or sign-in at runtime: fail the build.
if (process.env.VERCEL_ENV === 'production' && (!apiOrigin || !supabaseOrigin)) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE_URL and NEXT_PUBLIC_SUPABASE_URL must be set for the production CSP',
  );
}

// CQ-01: the browser-test session seam must never reach a deployment.
if (process.env.NEXT_PUBLIC_E2E_STAFF_BEARER && (process.env.VERCEL || process.env.VERCEL_ENV)) {
  throw new Error('NEXT_PUBLIC_E2E_STAFF_BEARER is for the local/CI e2e build only');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The e2e build (scripts/test-e2e-orders.mjs) writes to its own folder so it
  // never replaces the normal build the shell journeys test.
  distDir: process.env.ADMIN_DIST_DIR || '.next',
  // Always inlined, as '' when unset, so a normal build compiles the seam out
  // entirely instead of leaving a runtime lookup behind.
  env: { NEXT_PUBLIC_E2E_STAFF_BEARER: process.env.NEXT_PUBLIC_E2E_STAFF_BEARER ?? '' },
  transpilePackages: ['@gt-sales/contracts', '@gt-sales/types', '@gt-sales/ui'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
