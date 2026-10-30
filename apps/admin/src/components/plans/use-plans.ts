'use client';

import { useMemo } from 'react';
import type { Plan } from '@gt-sales/contracts';

import { listPlans } from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

const NO_PLANS: readonly Plan[] = [];

/**
 * The site's plans from `GET /plans`, in the order the backend lists them
 * (lead type, position, name). Inactive plans come only when asked for
 * (`includeInactive`), which the settings screen does. Until the answer
 * arrives, or when it cannot be read, `plans` is empty (`loaded` false) and
 * `error` says why.
 */
export function usePlans(
  workspaceId: string | undefined,
  options: { includeInactive?: boolean } = {},
): { plans: Plan[]; loaded: boolean; reload(): Promise<void>; error?: string } {
  const { accessToken } = useStaffSession();
  const includeInactive = options.includeInactive === true;

  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () =>
            includeInactive
              ? listPlans(accessToken, workspaceId, { includeInactive: 'true' })
              : listPlans(accessToken, workspaceId)
        : undefined,
    [accessToken, workspaceId, includeInactive],
  );
  const { data, error, reload } = useResource(load);
  const loaded = data !== undefined;
  const plans = useMemo(() => [...(data?.plans ?? NO_PLANS)], [data]);

  return { plans, loaded, reload, ...(error !== undefined ? { error } : {}) };
}
