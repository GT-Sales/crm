import type { StaffAuthErrorCode } from '@gt-sales/contracts';
import type { Response } from 'express';

const messages: Record<StaffAuthErrorCode, string> = {
  invalid_request: 'The request is invalid.',
  missing_session: 'A staff session is required.',
  invalid_session: 'The staff session is invalid or expired.',
  workspace_not_found: 'The workspace is unavailable.',
  membership_missing: 'No staff membership permits this workspace.',
  membership_pending: 'The staff membership is still pending.',
  membership_revoked: 'The staff membership has been revoked.',
  permission_denied: 'The staff member lacks the required permission.',
  mfa_required: 'A verified multi-factor session is required for this action.',
  membership_not_found: 'The staff membership is unavailable.',
  membership_conflict: 'A matching staff membership already exists.',
  internal_error: 'The request could not be completed.',
};

export function sendStaffAuthError(
  res: Response,
  requestId: string,
  code: StaffAuthErrorCode,
  status: number,
): void {
  res.status(status).json({ error: { code, message: messages[code], requestId } });
}
