import { MAX_DOCUMENT_BYTES } from '@gt-sales/contracts';

/**
 * T17 document configuration. The size ceiling is the recorded 10 MB decision
 * (shared from contracts). Signed-URL lifetimes follow IMPLEMENTATION_PLAN.md §8:
 * a 5-minute upload PUT and a 2-minute download GET, both short-lived bearer
 * capabilities. The bucket name comes from the environment; nothing hardcodes a
 * production value.
 */
export const MAX_DOCUMENT_UPLOAD_BYTES = MAX_DOCUMENT_BYTES;
export const UPLOAD_INTENT_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_LINK_TTL_SECONDS = 2 * 60;

/** Grace period before an abandoned staging object / rejected file is cleaned up. */
export const CLEANUP_GRACE_SECONDS = 24 * 60 * 60;

export function documentBucket(env: NodeJS.ProcessEnv = process.env): string {
  return env.R2_BUCKET ?? 'documents';
}
