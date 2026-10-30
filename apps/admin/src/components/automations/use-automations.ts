'use client';

import { useCallback, useMemo } from 'react';
import type { Automation, ListAutomationsResponse } from '@gt-sales/contracts';

import { listAutomations } from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

/**
 * The site's built-in automation rules from `GET /automations`, with whether
 * the viewer may switch them (`canManage`) and whether the site has a sender
 * (`hasSender`). Until the answer arrives `data` is undefined; when it cannot
 * be read `error` says why. `replace` puts a rule the backend has just
 * confirmed (a switch's answer) in place of the loaded one.
 */
export function useAutomations(workspaceId: string | undefined): {
  data: ListAutomationsResponse | undefined;
  reload(): Promise<void>;
  replace(automation: Automation): void;
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
    (automation: Automation) =>
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
