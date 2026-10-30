'use client';

import { useMemo } from 'react';
import type { ListAutomationsResponse } from '@gt-sales/contracts';

import { listAutomations } from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

/**
 * The site's built-in automation rules from `GET /automations`, with whether
 * the viewer may switch them (`canManage`) and whether the site has a sender
 * (`hasSender`). Until the answer arrives `data` is undefined; when it cannot
 * be read `error` says why.
 */
export function useAutomations(workspaceId: string | undefined): {
  data: ListAutomationsResponse | undefined;
  reload(): Promise<void>;
  error?: string;
} {
  const { accessToken } = useStaffSession();
  const load = useMemo(
    () =>
      accessToken && workspaceId ? () => listAutomations(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const { data, error, reload } = useResource(load);
  return { data, reload, ...(error !== undefined ? { error } : {}) };
}
