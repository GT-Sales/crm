'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ListWorkspaceJobsResponse } from '@gt-sales/contracts';
import { Badge, Button } from '@gt-sales/ui';

import { listWorkspaceJobs, resolveUncertainWorkspaceJob, retryWorkspaceJob } from '../lib/api';
import { describeError } from '../lib/error-text';
import { useStaffSession } from './staff-session-provider';
import { LoadingSkeleton } from './crm/loading-skeleton';

function time(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export function JobsStatus({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const [result, setResult] = useState<ListWorkspaceJobsResponse>();
  const [message, setMessage] = useState<string>();
  const [busyJobId, setBusyJobId] = useState<string>();

  const refresh = useCallback(async () => {
    if (!staff.accessToken || !workspaceId) return;
    setMessage(undefined);
    try {
      const jobs = await listWorkspaceJobs(staff.accessToken, workspaceId);
      setResult(jobs);
    } catch (error) {
      setMessage(describeError(error, 'load the jobs'));
    }
  }, [staff.accessToken, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(jobId: string, run: () => Promise<unknown>, action: string) {
    if (!staff.accessToken || !workspaceId || busyJobId) return;
    setBusyJobId(jobId);
    setMessage(undefined);
    try {
      await run();
      await refresh();
    } catch (error) {
      setMessage(describeError(error, action));
    } finally {
      setBusyJobId(undefined);
    }
  }

  function retry(jobId: string) {
    const token = staff.accessToken;
    if (!token || !workspaceId) return;
    void act(jobId, () => retryWorkspaceJob(token, workspaceId, jobId), 'retry the job');
  }

  function resolve(jobId: string, delivered: boolean) {
    const token = staff.accessToken;
    if (!token || !workspaceId) return;
    void act(
      jobId,
      () => resolveUncertainWorkspaceJob(token, workspaceId, jobId, delivered),
      'record the outcome',
    );
  }

  if (!result && !message) return <LoadingSkeleton label="Loading…" variant="list" />;
  if (!result && message) return <p role="status">{message}</p>;
  if (!result) return null;

  const pending = result.jobs.filter(
    (job) => job.status === 'pending' || job.status === 'processing',
  );
  const failed = result.jobs.filter((job) => job.status === 'failed' || job.status === 'uncertain');
  const hasUncertain = failed.some((job) => job.status === 'uncertain');

  return (
    <section className="flex flex-col gap-6">
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      {result.total !== undefined && result.total > result.jobs.length ? (
        <p className="text-xs text-muted-foreground">
          Showing the {result.jobs.length} most recently updated of {result.total} active jobs.
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border/80 bg-card/30">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">Pending</h2>
            <Badge variant="secondary" className="text-xs font-normal">
              {pending.length}
            </Badge>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
        {pending.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No jobs are waiting or processing.
          </p>
        ) : (
          <JobTable jobs={pending} />
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border/80 bg-card/30">
        <div className="flex flex-col gap-1 border-b border-border/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">Failed</h2>
            <Badge
              variant={failed.length > 0 ? 'destructive' : 'secondary'}
              className="text-xs font-normal"
            >
              {failed.length}
            </Badge>
          </div>
          {hasUncertain ? (
            <p className="text-xs text-muted-foreground">
              An uncertain job may already have reached the provider. Check the provider&apos;s log
              first, then mark it delivered, or not delivered to make it retryable.
            </p>
          ) : null}
        </div>
        {failed.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No failed jobs.</p>
        ) : (
          <JobTable
            jobs={failed}
            action={(job) =>
              job.status === 'failed' && result.canRetry ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyJobId !== undefined}
                  onClick={() => retry(job.id)}
                >
                  {busyJobId === job.id ? 'Retrying…' : 'Retry'}
                </Button>
              ) : job.status === 'uncertain' && result.canRetry ? (
                <span className="inline-flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyJobId !== undefined}
                    onClick={() => resolve(job.id, true)}
                  >
                    Mark delivered
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyJobId !== undefined}
                    onClick={() => resolve(job.id, false)}
                  >
                    Mark not delivered
                  </Button>
                </span>
              ) : job.status === 'uncertain' ? (
                <span className="text-xs text-muted-foreground">Reconcile before retry</span>
              ) : null
            }
          />
        )}
      </div>
    </section>
  );
}

function JobTable({
  jobs,
  action,
}: {
  jobs: ListWorkspaceJobsResponse['jobs'];
  action?: (job: ListWorkspaceJobsResponse['jobs'][number]) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border/70 bg-muted/20 text-left text-xs font-medium text-muted-foreground">
            <th className="px-5 py-2.5">Type</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">Attempts</th>
            <th className="px-4 py-2.5">Next attempt / lease</th>
            <th className="px-4 py-2.5">Error</th>
            {action ? (
              <th className="px-5 py-2.5 text-right">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {jobs.map((job) => (
            <tr key={job.id} className="transition-colors hover:bg-muted/20">
              <td className="px-5 py-3">
                <code className="font-mono text-xs text-foreground">{job.jobType}</code>
              </td>
              <td className="px-4 py-3">
                <Badge variant="secondary" className="text-xs font-normal">
                  {job.status}
                </Badge>
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{job.attempts}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {time(job.leaseExpiresAt ?? job.availableAt)}
              </td>
              <td className="px-4 py-3">
                <code className="font-mono text-xs text-muted-foreground">
                  {job.lastErrorCode ?? '—'}
                </code>
              </td>
              {action ? <td className="px-5 py-3 text-right">{action(job)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
