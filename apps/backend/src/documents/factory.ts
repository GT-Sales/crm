import { createR2DocumentStoreFromEnv } from '@gt-sales/adapters';
import { isBackupInProgress } from '@gt-sales/db';

import { DatabaseDocumentContextResolver } from './resolver.js';
import { DatabaseDocumentStore } from './store.js';
import { DocumentService } from './service.js';

/**
 * Builds the real document service from environment configuration. Returns
 * `undefined` when R2 is not yet configured (the current infra state — the
 * scoped R2 token/CORS are provisioned by the owner in the Cloudflare
 * dashboard), so the backend still boots and document endpoints report
 * `feature_not_ready` instead of crashing at startup.
 */
export function createDocumentServiceFromEnv(): DocumentService | undefined {
  let r2;
  try {
    r2 = createR2DocumentStoreFromEnv();
  } catch {
    return undefined;
  }
  return new DocumentService(
    new DatabaseDocumentStore(),
    r2,
    new DatabaseDocumentContextResolver(),
    // REL-18: the expired-upload sweep waits while a backup is copying objects.
    { backupLease: { isActive: isBackupInProgress } },
  );
}
