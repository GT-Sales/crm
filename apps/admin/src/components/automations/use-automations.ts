'use client';

import { useCallback, useMemo } from 'react';
import type { FlowListResponse, FlowSummary } from '@gt-sales/contracts';

import { listAutomations } from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

/**
 * The site's flows from `GET /automations` (the six built-ins seeded first),
 * with the overlap warnings, whether the viewer may change them
 * (`canManage`) and whether the site has a sender (`hasSender`). Until the
 * answer arrives `data` is undefined; when it cannot be read `error` says why.
 * `replace` puts a flow the backend has just confirmed (a switch's answer) in
 * place of the loaded one.
 */
export function useAutomations(workspaceId: string | undefined): {
  data: FlowListResponse | undefined;
  reload(): Promise<void>;
  replace(automation: FlowSummary): void;
  error?: string;
} {
  const { accessToken } = useStaffSession();
  const load = useMemo(
    () =>
      accessToken && workspaceId ? () => listAutomations(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const { data, error, reload, mutate } = useResource(load);
  const replace = useCallback(
    (automation: FlowSummary) =>
      mutate((current) => ({
        ...current,
        automations: current.automations.map((entry) =>
          entry.key === automation.key ? automation : entry,
        ),
      })),
    [mutate],
  );
  return { data, reload, replace, ...(error !== undefined ? { error } : {}) };
}
