'use client';

import { useEffect } from 'react';
import { Button } from '@gt-sales/ui';

import { captureException } from '../../../lib/error-tracking';
import { describeError } from '../../../lib/error-text';

/**
 * A screen of a site that failed while it was being shown. The site's shell
 * (sidebar, top bar) stays, since `error.tsx` sits inside the segment's
 * layout; only the page is replaced by this message and a retry. The thrown
 * value's own message is never shown: it could echo request data.
 */
export default function WorkspaceError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    captureException(error, {
      requestId:
        error instanceof Error && 'digest' in error && typeof error.digest === 'string'
          ? error.digest
          : 'unknown',
      route: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <div role="alert" className="flex max-w-prose flex-col items-start gap-3 py-10">
      <h1 className="text-xl font-semibold">This page could not be shown</h1>
      <p className="text-sm text-muted-foreground">{describeError(error, 'show this page')}</p>
      <Button type="button" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
