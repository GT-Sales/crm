'use client';

import type { StaffWorkspace } from '@gt-sales/contracts';

import { getStaffWorkspaces } from './api';

export function firstWorkspacePath(workspaces: readonly StaffWorkspace[]): string {
  const first = workspaces[0];
  return first ? `/w/${first.slug}/dashboard` : '/denied?reason=membership_missing';
}

/**
 * Where a staff member lands after signing in: the dashboard of their first
 * site (its follow-ups due first, as in Get Canada Sim's admin), or the
 * denial page when no active membership exists. Owner decision
 * (25 Oct 2026): no authenticator-code step, so sign-in is the only gate.
 */
export async function destinationAfterPrimarySignIn(accessToken: string): Promise<string> {
  const { workspaces } = await getStaffWorkspaces(accessToken);
  return firstWorkspacePath(workspaces);
}
