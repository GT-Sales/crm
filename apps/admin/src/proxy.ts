import { NextResponse, type NextRequest } from 'next/server';

import { buildContentSecurityPolicy, createNonce } from './lib/csp';

/**
 * Sets the nonce-based Content-Security-Policy on every page (audit M-1). The
 * policy goes on the request too, which is where Next.js reads the nonce to
 * put on its own scripts, and as `x-nonce` for the root layout's inline
 * theme bootstrap. Static assets and prefetches are skipped: they run no
 * inline script.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce, {
    isProduction: process.env.NODE_ENV === 'production',
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
