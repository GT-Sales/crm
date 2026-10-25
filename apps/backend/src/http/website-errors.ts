import type { WebsiteAuthErrorCode } from '@gt-sales/contracts';
import type { Response } from 'express';

const messages: Record<WebsiteAuthErrorCode, string> = {
  missing_credential: 'A website service credential is required.',
  invalid_credential: 'The website service credential is invalid.',
  credential_revoked: 'The website service credential has been revoked.',
  credential_not_found: 'The service credential does not exist in this workspace.',
  scope_denied: 'The website credential lacks the required scope.',
  caller_forbidden: 'This endpoint is not available to a website credential.',
  rate_limited: 'Too many requests. Retry later.',
  payload_too_large: 'The request body is too large.',
  machine_unknown: 'The machine identity is unknown or revoked.',
  machine_signature_invalid: 'The machine request signature or secret is invalid.',
  machine_account_mismatch: 'The machine request does not match its registered provider account.',
  machine_workspace_mismatch: 'The machine identity does not match the requested workspace.',
};

export function sendWebsiteError(
  res: Response,
  requestId: string,
  code: WebsiteAuthErrorCode,
  status: number,
  headers?: Record<string, string>,
): void {
  if (headers) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }
  res.status(status).json({ error: { code, message: messages[code], requestId } });
}
