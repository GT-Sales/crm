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
}: {
  error: Error & { digest?: string };
  reset: () => void;
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
        <p>Something went wrong. Please refresh the page.</p>
      </body>
    </html>
  );
}
