import type { ErrorTracker } from '@gt-sales/adapters';

/**
 * Last-resort process handlers (audit L-6). Without them a stray rejection
 * outside a request exits Node, and after Railway's restart cap the service
 * stays down.
 *
 * - An unhandled rejection is logged by a fixed code and reported to the
 *   tracker (whose event scrubs the message); the process keeps serving,
 *   since the failed promise's work is already lost either way.
 * - An uncaught exception leaves the process in an unknown state: it is
 *   logged and reported the same way, then the graceful shutdown runs and the
 *   process exits non-zero so the platform restarts it.
 */
export interface ProcessHandlerDependencies {
  tracker: ErrorTracker;
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  on?: (
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (error: unknown) => void,
  ) => void;
}

function codeOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'unknown';
}

export function registerProcessHandlers(dependencies: ProcessHandlerDependencies): void {
  const on =
    dependencies.on ??
    ((event: 'unhandledRejection' | 'uncaughtException', listener: (error: unknown) => void) => {
      process.on(event, listener);
    });
  const report = (event: string, error: unknown) => {
    console.error(JSON.stringify({ event, code: codeOf(error) }));
    try {
      dependencies.tracker.captureException(error, {
        requestId: event,
        route: 'process',
        release: process.env['RELEASE_SHA'] ?? 'unknown',
        environment: process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'],
      });
    } catch {
      // Reporting must never be what takes the process down.
    }
  };
  on('unhandledRejection', (reason) => report('unhandled_rejection', reason));
  let crashing = false;
  on('uncaughtException', (error) => {
    report('uncaught_exception', error);
    if (crashing) return;
    crashing = true;
    void dependencies.shutdown().finally(() => dependencies.exit(1));
  });
}
