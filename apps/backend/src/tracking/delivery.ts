import type { EmailAdapter } from '@gt-sales/adapters';
import {
  trackingCodeJobPayloadSchema,
  trackingCodeScrubbedPayloadSchema,
  type CustomerEmailJobPayload,
} from '@gt-sales/contracts';
import { withTenantTx, type DatabaseClient } from '@gt-sales/db';
import {
  JobHandlerError,
  sendRenderedCustomerEmail,
  type EmailDeliveryRecorder,
  type EmailEligibilityChecker,
  type JobHandler,
  type JobHandlerResult,
} from '@gt-sales/jobs';
import { z } from 'zod';

import { openTrackingCode } from '../crypto/cipher.js';
import { composeCustomerEmail } from '../email/compose.js';
import type { CustomerEmailEnvironment } from '../email/senders.js';
import { normalizeContactEmail } from '../leads/store.js';
import { codeBindingHash, emailBindingHash, hashesEqual } from './secrets.js';
import { pendingDelivery } from './store.js';

/**
 * The `tracking_code_email` handler (ported from Canadian Plans'
 * `tracking/delivery.ts`). The job carries the code only sealed to its
 * challenge; just before sending, the challenge is re-checked (still pending,
 * unexpired, under five tries, issued for this address and this code), and
 * only then is the code opened and the site's `tracking_code` template
 * rendered. The rendered mail lives only in memory: the outbox never holds the
 * code readable, and the store scrubs the payload to `{ challengeId }` once
 * the job ends.
 */
export function createTrackingCodeHandler(options: {
  email: EmailAdapter;
  eligibility: EmailEligibilityChecker;
  delivery?: EmailDeliveryRecorder;
  environment: CustomerEmailEnvironment;
  secret: string | undefined;
  database?: Pick<DatabaseClient, 'withTenantTx'>;
  now?: () => Date;
}): JobHandler {
  const database = options.database ?? { withTenantTx };
  const skip = (reason: string): JobHandlerResult => ({
    status: 'completed',
    providerId: `skipped:${reason}`,
  });
  return async (job) => {
    if (job.payloadVersion !== 1) throw new JobHandlerError('unsupported_payload_version', false);
    // A finished job keeps only its challenge id; a staff retry of it has no
    // code left to send, and the customer requests a new one instead.
    if (trackingCodeScrubbedPayloadSchema.safeParse(job.payload).success) {
      return skip('tracking_challenge_inactive');
    }
    const parsed = trackingCodeJobPayloadSchema.safeParse(job.payload);
    const actor = z.uuid().safeParse(job.actorId);
    if (!parsed.success || !actor.success) throw new JobHandlerError('invalid_job_payload', false);
    const payload = parsed.data;
    const now = options.now?.() ?? new Date();
    if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
      return skip('tracking_challenge_inactive');
    }
    const secret = options.secret;
    if (!secret) throw new JobHandlerError('tracking_not_configured', false);

    const ready = await database.withTenantTx(
      { workspaceId: job.workspaceId, actorId: actor.data },
      async (tx): Promise<{ mail: CustomerEmailJobPayload } | { skipped: string }> => {
        const inactive = { skipped: 'tracking_challenge_inactive' };
        const current = await pendingDelivery(tx, {
          workspaceId: job.workspaceId,
          challengeId: payload.challengeId,
          now,
        });
        if (!current) return inactive;
        // The queued address must be the one the challenge was issued for.
        const email = normalizeContactEmail(payload.toAddress);
        if (!hashesEqual(current.emailHash, emailBindingHash(secret, job.workspaceId, email))) {
          return inactive;
        }
        if (!options.environment.providerReady) return { skipped: 'no_sender' };
        if (!hashesEqual(options.environment.contactHash(email), payload.contactHash)) {
          return inactive;
        }
        const code = openTrackingCode(
          secret,
          { workspaceId: job.workspaceId, challengeId: payload.challengeId },
          payload.sealedCode,
        );
        if (
          !code ||
          !hashesEqual(current.codeHash, codeBindingHash(secret, job.workspaceId, email, code))
        ) {
          return inactive;
        }
        const composed = await composeCustomerEmail(tx, options.environment, {
          workspaceId: job.workspaceId,
          template: 'tracking_code',
          recipient: { kind: 'tracking_code', toAddress: email, code },
        });
        return composed.kind === 'ready'
          ? { mail: composed.payload }
          : { skipped: composed.reason };
      },
    );
    if ('skipped' in ready) return skip(ready.skipped);
    return sendRenderedCustomerEmail(options, job, ready.mail);
  };
}
