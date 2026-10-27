import { createR2DocumentStoreFromEnv } from '@gt-sales/adapters';

import { documentBucket } from './config.js';
import { DatabaseDocumentContextResolver } from './resolver.js';
import { DatabaseDocumentStore } from './store.js';
import { DocumentService } from './service.js';

/**
 * Builds the real document service from environment configuration. Returns
 * `undefined` when the S3-compatible object store (Supabase Storage's S3
 * endpoint) is not yet configured, so the backend still boots and document
 * endpoints report `feature_not_ready` instead of crashing at startup.
 */
export function createDocumentServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DocumentService | undefined {
  let r2;
  try {
    r2 = createR2DocumentStoreFromEnv(env);
  } catch {
    return undefined;
  }
  return new DocumentService(
    new DatabaseDocumentStore(),
    r2,
    new DatabaseDocumentContextResolver(),
    { bucket: documentBucket(env) },
  );
}
