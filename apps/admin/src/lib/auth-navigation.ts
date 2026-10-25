'use client';

import type { StaffWorkspace } from '@gt-sales/contracts';

import { getStaffWorkspaces } from './api';
import { getStaffAuth } from './supabase-auth';

export function firstWorkspacePath(workspaces: readonly StaffWorkspace[]): string {
  const first = workspaces[0];
  return first ? `/w/${first.slug}/orders` : '/denied?reason=membership_missing';
}

export async function destinationAfterPrimarySignIn(accessToken: string): Promise<string> {
  const { workspaces } = await getStaffWorkspaces(accessToken);
  const requiresMfa = workspaces.some((workspace) =>
    workspace.roles.some((role) => role === 'owner' || role === 'finance'),
  );
  if (!requiresMfa) return firstWorkspacePath(workspaces);

  const auth = getStaffAuth();
  const assurance = await auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance.error) throw assurance.error;
  if (assurance.data.currentLevel === 'aal2') return firstWorkspacePath(workspaces);

  const factors = await auth.mfa.listFactors();
  if (factors.error) throw factors.error;
  return factors.data.totp.some((factor) => factor.status === 'verified')
    ? '/mfa/challenge'
    : '/mfa/enroll';
}
