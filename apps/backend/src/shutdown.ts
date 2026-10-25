/**
 * Graceful shutdown for the long-lived Railway deployment.
 *
 * Railway sends `SIGTERM` and by default allows zero seconds before `SIGKILL`
 * (the service sets `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` so the platform
 * waits). Without this sequence an in-flight order submission, or a claimed
 * outbox job holding a live lease, would be killed mid-flight. The steps are
 * ordered: stop accepting connections and let the scheduler's in-flight run
 * finish (concurrently — neither waits on the other), then close the database
 * pool. A run longer than the hard timeout is still cut off; that is safe
 * because the outbox claims work under a lease that simply expires and is
 * reclaimed, but it is not a full drain.
 *
 * The handler is dependency-injected so it can be tested without spawning a
 * process or registering real signals.
 */

export interface ShutdownServer {
  close(callback: (error?: Error) => void): void;
}

export interface ShutdownScheduler {
  stop(): Promise<void>;
}

export interface ShutdownDependencies {
  server: ShutdownServer;
  scheduler?: ShutdownScheduler | undefined;
  closeDatabase: () => Promise<void>;
  /** Called exactly once, either on completion or when the hard timeout fires. */
  exit: (code: number) => void;
  /** Hard deadline after which a stuck handler is abandoned and the process exits. */
  timeoutMs?: number;
}

/**
 * Builds an idempotent shutdown handler. A second signal is ignored rather than
 * starting a concurrent teardown, and the hard timeout guarantees the process
 * still exits if a socket or handler refuses to finish.
 */
export function createShutdownHandler(dependencies: ShutdownDependencies): () => Promise<void> {
  let started = false;
  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    dependencies.exit(code);
  };
  return async () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => finish(0), dependencies.timeoutMs ?? 25_000);
    try {
      // HTTP draining and scheduler draining are independent, so they run
      // concurrently. Node's `server.close()` resolves only once every keep-alive
      // connection has idled out (5s by default) and that must not eat into the
      // scheduler's share of the shutdown budget, which is already shorter than a
      // runner's own 120s deadline. Both use the database, so the pool is closed
      // only after both have finished.
      await Promise.all([
        new Promise<void>((resolve) => dependencies.server.close(() => resolve())),
        dependencies.scheduler ? dependencies.scheduler.stop() : Promise.resolve(),
      ]);
      await dependencies.closeDatabase();
    } finally {
      clearTimeout(timer);
    }
    finish(0);
  };
}

/** Wires the handler to `SIGTERM` and `SIGINT`. */
export function registerShutdownHandlers(handler: () => Promise<void>): void {
  const onSignal = (): void => {
    void handler();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
