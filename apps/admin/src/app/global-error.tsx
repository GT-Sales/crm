'use client';

import { useEffect } from 'react';

import { captureException } from '../lib/error-tracking';

/**
 * App Router's client-side error boundary of last resort (REQ 40) — catches
 * a render error the rest of the tree didn't handle. Reports it once per
 * mount via the browser-safe tracker; never renders the error's own message
 * to the staff user, since a thrown value could echo request data.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      requestId: error.digest ?? 'unknown',
      route: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '36rem', padding: '2rem' }}>
          <h1>The CRM could not show this page</h1>
          <p>
            Try again. If it keeps happening, reload the page in a minute, and tell your admin if it
            still fails.
          </p>
          <button type="button" onClick={() => retry()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
