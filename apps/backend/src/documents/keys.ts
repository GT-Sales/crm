import { randomUUID, randomBytes } from 'node:crypto';

import type { DocumentMediaType } from '@gt-sales/adapters';

/**
 * Server-generated, non-guessable object keys (REQ 22/23: random object
 * identifiers that reveal nothing about the customer). Keys are namespaced by
 * workspace and stage; the uploader only ever receives the staging key.
 */
export function stagingKey(workspaceId: string): string {
  return `staging/${workspaceId}/${randomToken()}`;
}

export function candidateKey(workspaceId: string): string {
  return `candidate/${workspaceId}/${randomToken()}`;
}

function randomToken(): string {
  return `${randomUUID()}-${randomBytes(8).toString('hex')}`;
}

const EXTENSIONS: Record<DocumentMediaType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * A sanitized attachment filename for downloads. It never contains the original
 * client filename (which could carry PII or path/quoting tricks); it is derived
 * from the checklist type, a short opaque id, and the verified extension.
 */
export function sanitizedDownloadFilename(
  documentType: string,
  fileId: string,
  contentType: DocumentMediaType,
): string {
  const safeType = documentType.replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'document';
  const shortId = fileId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  return `${safeType}-${shortId}.${EXTENSIONS[contentType]}`;
}
