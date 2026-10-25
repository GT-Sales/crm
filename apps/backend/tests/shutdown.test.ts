import { afterEach, describe, expect, it, vi } from 'vitest';

import { createShutdownHandler } from '../src/shutdown.js';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('createShutdownHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('awaits an in-flight scheduler run before closing the database and exiting', async () => {
    const calls: string[] = [];
    let releaseScheduler: () => void = () => undefined;
    const inFlightRun = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const handler = createShutdownHandler({
      server: {
        close: (callback) => {
          calls.push('close');
          callback();
        },
      },
      scheduler: {
        stop: () => {
          calls.push('stop');
          return inFlightRun;
        },
      },
      closeDatabase: async () => {
        calls.push('closeDatabase');
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });

    const running = handler();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['close', 'stop']);
    expect(calls).not.toContain('exit:0');

    releaseScheduler();
    await running;
    expect(calls).toEqual(['close', 'stop', 'closeDatabase', 'exit:0']);
  });

  it('drains the scheduler without waiting for HTTP connections to close', async () => {
    const calls: string[] = [];
    let releaseServer: () => void = () => undefined;
    const schedulerStopped = createDeferred();

    const handler = createShutdownHandler({
      // A keep-alive connection that has not idled out yet: Node holds the
      // close callback until it does. The scheduler must not wait on this.
      server: {
        close: (callback) => {
          calls.push('close:start');
          releaseServer = () => callback();
        },
      },
      scheduler: {
        stop: async () => {
          calls.push('stop');
          schedulerStopped.resolve();
        },
      },
      closeDatabase: async () => {
        calls.push('closeDatabase');
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });

    const running = handler();
    // The scheduler finishes while the server is still draining.
    await schedulerStopped.promise;
    expect(calls).toEqual(['close:start', 'stop']);
    // The pool must still be open until HTTP has drained too.
    expect(calls).not.toContain('closeDatabase');

    releaseServer();
    await running;
    expect(calls).toEqual(['close:start', 'stop', 'closeDatabase', 'exit:0']);
  });

  it('runs the sequence once when signalled twice', async () => {
    const exit = vi.fn();
    const closeDatabase = vi.fn(async () => undefined);
    const handler = createShutdownHandler({
      server: { close: (callback) => callback() },
      closeDatabase,
      exit,
    });

    await Promise.all([handler(), handler()]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('continues shutdown when the server reports a close error', async () => {
    const calls: string[] = [];
    const handler = createShutdownHandler({
      server: {
        close: (callback) => {
          calls.push('close');
          callback(new Error('connection still open'));
        },
      },
      closeDatabase: async () => {
        calls.push('closeDatabase');
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });

    await handler();
    expect(calls).toEqual(['close', 'closeDatabase', 'exit:0']);
  });

  it('force-exits after the hard timeout when a run never finishes', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const closeDatabase = vi.fn(async () => undefined);
    const handler = createShutdownHandler({
      server: { close: (callback) => callback() },
      scheduler: { stop: () => new Promise<void>(() => undefined) },
      closeDatabase,
      exit,
      timeoutMs: 25_000,
    });

    void handler();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(exit).toHaveBeenCalledWith(0);
    expect(closeDatabase).not.toHaveBeenCalled();
  });
});
