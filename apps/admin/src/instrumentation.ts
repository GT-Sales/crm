/**
 * Next.js server-side error hook (REQ 40). Runs for an error thrown in a
 * server component, route handler, or server action — the cases a client
 * error boundary (`src/app/global-error.tsx`) cannot see. Never logs the
 * request URL/headers/body; only a fresh request id and the route. It must live
 * in `src/` (beside `app/`): Next only registers an instrumentation file found
 * next to the app directory, so at the package root it was silently ignored.
 */
export async function onRequestError(error: unknown, request: { path?: string }): Promise<void> {
  const { captureException } = await import('./lib/error-tracking');
  captureException(error, {
    // Web Crypto works in both the Node.js and Edge runtimes this hook compiles for.
    requestId: globalThis.crypto.randomUUID(),
    route: request.path,
  });
}
