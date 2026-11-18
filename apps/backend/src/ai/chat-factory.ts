import { createR2DocumentStoreFromEnv, type R2DocumentStore } from '@gt-sales/adapters';

import { documentBucket } from '../documents/config.js';
import { DatabaseAiAttachmentStore } from './attachment-store.js';
import { AiAttachmentService } from './attachments.js';
import { DatabaseAiChatSchemaProbe, type AiChatSchemaProbe } from './chat-schema.js';
import { parseAttachmentKinds } from './config.js';
import { DatabaseAiConversationStore } from './conversation-store.js';
import { DatabaseAiUsageStore } from './usage-store.js';

/**
 * The saved chat's real dependencies. Attachments need the object store the
 * documents feature uses (the same bucket, `R2_BUCKET`): without one the
 * service is absent and uploads are off whatever `AI_ATTACHMENT_KINDS` says.
 * With one, the service exists even when no kind is enabled, so the sweep
 * still removes files left from before the kinds were switched off.
 */
export function createAiChatDependenciesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  schema: AiChatSchemaProbe = new DatabaseAiChatSchemaProbe(),
) {
  const attachments = createAiAttachmentServiceFromEnv(env);
  return {
    schema,
    conversations: new DatabaseAiConversationStore(),
    usage: new DatabaseAiUsageStore(undefined, schema),
    ...(attachments ? { attachments } : {}),
  };
}

/** The attachment service over the documents' object store; undefined without storage. */
export function createAiAttachmentServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AiAttachmentService | undefined {
  let objects: R2DocumentStore;
  try {
    objects = createR2DocumentStoreFromEnv(env);
  } catch {
    return undefined;
  }
  return new AiAttachmentService(new DatabaseAiAttachmentStore(), objects, {
    bucket: documentBucket(env),
    kinds: parseAttachmentKinds(env['AI_ATTACHMENT_KINDS']),
  });
}
