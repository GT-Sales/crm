import { describe, expect, it } from 'vitest';

import {
  OutboxRunner,
  type ClaimedJob,
  type JobHandlerRegistry,
  type JobOutcome,
  type OutboxStore,
} from '../src/index';

const ACTOR = '20000000-0000-4000-8000-000000000902';
const SITES = [
  '10000000-0000-4000-8000-000000000a01',
  '10000000-0000-4000-8000-000000000a02',
  '10000000-0000-4000-8000-000000000a03',
] as const;

/** Each site holds a queue of waiting jobs; claiming takes the next one. */
function setup(jobsPerSite: number, runDeadlineMs: number, batchSize = 5) {
  const waiting = new Map<string, number>(SITES.map((site) => [site, jobsPerSite]));
  const handled: string[] = [];
  const recorded: { workspaceId: string; outcome: JobOutcome['status'] }[] = [];
  let clock = 0;
  const store: OutboxStore = {
    async claim(input) {
      const left = waiting.get(input.workspaceId) ?? 0;
      if (left === 0) return [];
      waiting.set(input.workspaceId, left - 1);
      const job: ClaimedJob = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        jobType: 'slow',
        messageId: crypto.randomUUID(),
        payloadVersion: 1,
        payload: {},
        attempts: 1,
        leaseOwnerId: input.leaseOwnerId,
      };
      return [job];
    },
    async recordOutcome(input) {
      recorded.push({ workspaceId: input.workspaceId, outcome: input.outcome.status });
      return 'recorded';
    },
  };
  // A handler takes one second of the shared budget.
  const handlers: JobHandlerRegistry = new Map([
    [
      'slow',
      async (job) => {
        handled.push(job.workspaceId);
        clock += 1_000;
        return { status: 'completed', providerId: 'p' };
      },
    ],
  ]);
  const runner = new OutboxRunner({
    store,
    handlers,
    batchSize,
    runDeadlineMs,
    handlerTimeoutMs: 0,
    now: () => new Date(clock),
  });
  const run = () => runner.run({ authorizedWorkspaceIds: SITES, actorId: ACTOR });
  return { run, handled, recorded, waiting };
}

describe('OutboxRunner fairness across sites', () => {
  it('lets every site make progress when slow handlers use the whole budget each run', async () => {
    // Five jobs fit in a run (the cap per site is five), so without rotation
    // the third site would never be reached while the first two have work.
    const { run, handled } = setup(50, 5_000);
    const perRun: string[][] = [];
    for (let index = 0; index < 3; index += 1) {
      const before = handled.length;
      await run();
      perRun.push(handled.slice(before));
    }
    const everyRun = new Set(perRun.flat());
    expect(everyRun.size).toBe(SITES.length);
    // The site cut off in one run leads the next.
    expect(perRun[1]?.[0]).not.toBe(perRun[0]?.[0]);
    for (const site of SITES) expect(handled).toContain(site);
  });

  it('keeps the per-site cap and the deadline, and still drains when there is time', async () => {
    const { run, handled, recorded, waiting } = setup(3, 0, 2);
    const summary = await run();
    // Two jobs a site at most, all sites served, every outcome recorded.
    expect(summary.claimed).toBe(6);
    expect(handled).toHaveLength(6);
    expect(recorded.every((entry) => entry.outcome === 'completed')).toBe(true);
    expect(Object.fromEntries(waiting)).toEqual(Object.fromEntries(SITES.map((site) => [site, 1])));
  });

  it('works a single site and an empty list as before', async () => {
    const runner = new OutboxRunner({
      store: {
        claim: async () => [],
        recordOutcome: async () => 'recorded',
      },
      handlers: new Map(),
    });
    expect(await runner.run({ authorizedWorkspaceIds: [], actorId: ACTOR })).toMatchObject({
      workspaces: 0,
      claimed: 0,
    });
    expect(await runner.run({ authorizedWorkspaceIds: [SITES[0]], actorId: ACTOR })).toMatchObject({
      workspaces: 1,
      claimed: 0,
    });
  });
});
