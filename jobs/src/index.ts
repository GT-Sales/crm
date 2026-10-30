import type { AnalyticsSink, EmailAdapter, EmailTemplate } from '@gt-sales/adapters';
import {
  CUSTOMER_EMAIL_JOB_TYPE,
  TRACKING_CODE_JOB_TYPE,
  customerEmailJobPayloadSchema,
  type CustomerEmailJobPayload,
} from '@gt-sales/contracts';
import { z } from 'zod';

export const outboxJobTypes = [
  'order_acknowledgement_email',
  'order_status_email',
  'order_awaiting_customer_email',
  'order_dispatch_email',
  'order_activation_email',
  'abandoned_form_marketing_email',
  // A site-content mail rendered when it was queued; this job only sends it.
  CUSTOMER_EMAIL_JOB_TYPE,
  // A customer's tracking code, rendered only when it is sent (the backend's handler).
  TRACKING_CODE_JOB_TYPE,
  'analytics_order_submitted',
  'analytics_lead_saved',
  // Composed in the backend, which holds the document store.
  'legacy_document_import',
] as const;
export type OutboxJobType = (typeof outboxJobTypes)[number];

const emailJobTypeToTemplate: Record<string, EmailTemplate> = {
  order_acknowledgement_email: 'order_acknowledgement',
  order_status_email: 'order_status',
  order_awaiting_customer_email: 'order_awaiting_customer',
  order_dispatch_email: 'order_dispatch',
  order_activation_email: 'order_activation',
  abandoned_form_marketing_email: 'abandoned_form_marketing',
};

/**
 * Re-checked immediately before every send (REQ 27, IMPLEMENTATION_PLAN.md
 * §9 "Email"): transactional sends only ever consult deliverability
 * suppression; marketing sends additionally require recorded opt-in and
 * re-verify the lead/order hasn't completed, cancelled, or been unsubscribed
 * since the follow-up was scheduled.
 */
export interface EmailEligibilityChecker {
  checkTransactional(input: {
    workspaceId: string;
    actorId: string;
    contactHash: string;
    orderId?: string;
    leadId?: string;
  }): Promise<{ eligible: boolean; reason?: string }>;
  checkMarketing(input: {
    workspaceId: string;
    actorId: string;
    contactHash: string;
    leadId?: string;
    orderId?: string;
  }): Promise<{ eligible: boolean; reason?: string }>;
}

export interface EmailDeliveryRecorder {
  prepare(input: {
    workspaceId: string;
    actorId: string;
    messageId: string;
    contactHash: string;
    template: EmailTemplate;
    /** The site template version the mail was rendered from; absent for built-in copy. */
    templateVersion?: number;
    messageClass: 'transactional' | 'marketing';
    leadId?: string;
    orderId?: string;
  }): Promise<void>;
  recordResult(input: {
    workspaceId: string;
    actorId: string;
    messageId: string;
    result: import('@gt-sales/adapters').ProviderDeliveryResult;
  }): Promise<void>;
}

function emailActor(job: ClaimedJob): string {
  const actor = z.uuid().safeParse(job.actorId);
  if (!actor.success) throw new JobHandlerError('email_actor_missing', false);
  return actor.data;
}

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  jobType: string;
  messageId: string;
  payloadVersion: number;
  payload: unknown;
  /** Attempt number after the atomic claim increment. */
  attempts: number;
  leaseOwnerId: string;
  /** Set by the runner from its verified scheduler identity, never job payload. */
  actorId?: string;
}

export type JobOutcome =
  | { status: 'completed'; providerId: string; detail?: Record<string, unknown> }
  | {
      status: 'retry';
      errorCode: string;
      availableAt: Date;
      /** Nonfailure wait before execution: undo this claim's attempt increment. */
      preserveAttempt?: true;
    }
  | { status: 'failed'; errorCode: string }
  | { status: 'uncertain'; errorCode: string };

export interface OutboxStore {
  claim(input: {
    workspaceId: string;
    actorId: string;
    leaseOwnerId: string;
    limit: number;
    leaseExpiresAt: Date;
    now: Date;
    maxAttempts: number;
  }): Promise<ClaimedJob[]>;
  recordOutcome(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    leaseOwnerId: string;
    outcome: JobOutcome;
    now: Date;
  }): Promise<'recorded' | 'lease_lost'>;
}

export type JobHandlerResult =
  | { status: 'completed'; providerId: string; detail?: Record<string, unknown> }
  | Extract<JobOutcome, { status: 'retry' }>
  | { status: 'uncertain'; errorCode: string };
/**
 * Handlers receive an abort signal for the runner's per-handler timeout. It is
 * optional so existing handlers stay valid; providers that accept an
 * `AbortSignal` should forward it so a timed-out call is actually cancelled.
 */
export type JobHandler = (job: ClaimedJob, signal?: AbortSignal) => Promise<JobHandlerResult>;
export type JobHandlerRegistry = ReadonlyMap<string, JobHandler>;

export class JobHandlerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'JobHandlerError';
  }
}

/** Raised internally when the runner's per-handler timeout fires. */
class HandlerTimeoutError extends Error {
  constructor() {
    super('handler_timeout');
    this.name = 'HandlerTimeoutError';
  }
}

/**
 * A registry whose every registered handler fails permanently with one code.
 * Used when no provider adapter is configured (for example a production
 * deployment without real email/analytics credentials): the job is recorded as
 * failed so it is visible in admin instead of silently invoking a fake.
 */
export function createFailingJobHandlerRegistry(errorCode: string): JobHandlerRegistry {
  const safe = safeErrorCode(errorCode, 'provider_not_configured');
  const handlers: [string, JobHandler][] = outboxJobTypes.map((jobType) => [
    jobType,
    async () => {
      throw new JobHandlerError(safe, false);
    },
  ]);
  return new Map(handlers);
}

const acknowledgementPayloadSchema = z
  .object({
    orderId: z.uuid(),
    reference: z.string().min(1).max(32),
    toAddress: z.string().email(),
    contactHash: z.string().min(1),
  })
  .strict();
const orderSubmittedPayloadSchema = z.object({ orderId: z.uuid() }).strict();
const leadSavedPayloadSchema = z.object({ leadId: z.uuid() }).strict();

const orderEmailPayloadSchema = z
  .object({
    orderId: z.uuid(),
    reference: z.string().min(1).max(32),
    toAddress: z.string().email(),
    contactHash: z.string().min(1),
    variables: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const marketingPayloadSchema = z
  .object({
    leadId: z.uuid(),
    toAddress: z.string().email(),
    contactHash: z.string().min(1),
    unsubscribeUrl: z.string().min(1),
  })
  .strict();

function safeErrorCode(value: string, fallback: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function transactionalEmailHandler(
  email: EmailAdapter,
  eligibility: EmailEligibilityChecker,
  delivery?: EmailDeliveryRecorder,
): JobHandler {
  return async (job) => {
    if (job.payloadVersion !== 1) throw new JobHandlerError('unsupported_payload_version', false);
    const template = emailJobTypeToTemplate[job.jobType];
    const parsed =
      job.jobType === 'order_acknowledgement_email'
        ? acknowledgementPayloadSchema.safeParse(job.payload)
        : orderEmailPayloadSchema.safeParse(job.payload);
    if (!parsed.success || !template) throw new JobHandlerError('invalid_job_payload', false);
    const check = await eligibility.checkTransactional({
      workspaceId: job.workspaceId,
      actorId: emailActor(job),
      contactHash: parsed.data.contactHash,
      orderId: parsed.data.orderId,
    });
    if (!check.eligible) {
      // A hard-bounce/complaint/manual suppression blocks even transactional
      // mail; a marketing-only opt-out never reaches this branch because
      // `checkTransactional` never consults the marketing consent table.
      return {
        status: 'completed',
        providerId: `skipped:${safeErrorCode(check.reason ?? 'suppressed', 'suppressed')}`,
      };
    }
    await delivery?.prepare({
      workspaceId: job.workspaceId,
      actorId: emailActor(job),
      messageId: job.messageId,
      template,
      messageClass: 'transactional',
      contactHash: parsed.data.contactHash,
      orderId: parsed.data.orderId,
    });
    const result = await email.send({
      workspaceId: job.workspaceId,
      messageId: job.messageId,
      template,
      toAddress: parsed.data.toAddress,
      orderId: parsed.data.orderId,
      reference: parsed.data.reference,
      variables:
        'variables' in parsed.data && isStringRecord(parsed.data.variables)
          ? parsed.data.variables
          : undefined,
    });
    await delivery?.recordResult({
      workspaceId: job.workspaceId,
      actorId: emailActor(job),
      messageId: job.messageId,
      result,
    });
    return result.status === 'delivered'
      ? { status: 'completed', providerId: result.providerId }
      : { status: 'uncertain', errorCode: safeErrorCode(result.errorCode, 'provider_uncertain') };
  };
}

/**
 * Sends one rendered customer mail exactly as `payload` carries it: the
 * suppression check, the delivery record (with the template version and the
 * mail's own sender), the send and its result.
 */
export async function sendRenderedCustomerEmail(
  dependencies: {
    email: EmailAdapter;
    eligibility: EmailEligibilityChecker;
    delivery?: EmailDeliveryRecorder;
  },
  job: ClaimedJob,
  payload: CustomerEmailJobPayload,
): Promise<JobHandlerResult> {
  const { leadId, template, templateVersion, toAddress, contactHash, sender, rendered } = payload;
  const actorId = emailActor(job);
  const check = await dependencies.eligibility.checkTransactional({
    workspaceId: job.workspaceId,
    actorId,
    contactHash,
    leadId,
  });
  if (!check.eligible) {
    return {
      status: 'completed',
      providerId: `skipped:${safeErrorCode(check.reason ?? 'suppressed', 'suppressed')}`,
    };
  }
  await dependencies.delivery?.prepare({
    workspaceId: job.workspaceId,
    actorId,
    messageId: job.messageId,
    template,
    templateVersion,
    messageClass: 'transactional',
    contactHash,
    leadId,
  });
  const result = await dependencies.email.send({
    workspaceId: job.workspaceId,
    messageId: job.messageId,
    template,
    toAddress,
    leadId,
    sender,
    rendered,
  });
  await dependencies.delivery?.recordResult({
    workspaceId: job.workspaceId,
    actorId,
    messageId: job.messageId,
    result,
  });
  return result.status === 'delivered'
    ? { status: 'completed', providerId: result.providerId }
    : { status: 'uncertain', errorCode: safeErrorCode(result.errorCode, 'provider_uncertain') };
}

/**
 * A site-content mail to a lead's customer: the backend rendered it and chose
 * its sender when it was queued, so this only checks suppression, records the
 * template version and sends exactly what the payload carries.
 */
function customerEmailHandler(dependencies: {
  email: EmailAdapter;
  eligibility: EmailEligibilityChecker;
  delivery?: EmailDeliveryRecorder;
}): JobHandler {
  return async (job) => {
    if (job.payloadVersion !== 1) throw new JobHandlerError('unsupported_payload_version', false);
    const parsed = customerEmailJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new JobHandlerError('invalid_job_payload', false);
    return sendRenderedCustomerEmail(dependencies, job, parsed.data);
  };
}

/**
 * The complete handler registry (T15 + T18 + T20). Email jobs consult
 * suppression/consent eligibility before sending; analytics conversions are
 * captured too. Commissions and the deletion-ledger publish are composed in the
 * backend provider layer, not here.
 */
export function createJobHandlerRegistry(dependencies: {
  email: EmailAdapter;
  analytics: AnalyticsSink;
  eligibility: EmailEligibilityChecker;
  delivery?: EmailDeliveryRecorder;
}): JobHandlerRegistry {
  return new Map<string, JobHandler>([
    [
      'order_acknowledgement_email',
      transactionalEmailHandler(
        dependencies.email,
        dependencies.eligibility,
        dependencies.delivery,
      ),
    ],
    [
      'order_status_email',
      transactionalEmailHandler(
        dependencies.email,
        dependencies.eligibility,
        dependencies.delivery,
      ),
    ],
    [
      'order_awaiting_customer_email',
      transactionalEmailHandler(
        dependencies.email,
        dependencies.eligibility,
        dependencies.delivery,
      ),
    ],
    [
      'order_dispatch_email',
      transactionalEmailHandler(
        dependencies.email,
        dependencies.eligibility,
        dependencies.delivery,
      ),
    ],
    [
      'order_activation_email',
      transactionalEmailHandler(
        dependencies.email,
        dependencies.eligibility,
        dependencies.delivery,
      ),
    ],
    [CUSTOMER_EMAIL_JOB_TYPE, customerEmailHandler(dependencies)],
    [
      'abandoned_form_marketing_email',
      async (job) => {
        if (job.payloadVersion !== 1)
          throw new JobHandlerError('unsupported_payload_version', false);
        const parsed = marketingPayloadSchema.safeParse(job.payload);
        if (!parsed.success) throw new JobHandlerError('invalid_job_payload', false);
        const check = await dependencies.eligibility.checkMarketing({
          workspaceId: job.workspaceId,
          actorId: emailActor(job),
          contactHash: parsed.data.contactHash,
          leadId: parsed.data.leadId,
        });
        if (!check.eligible) {
          return {
            status: 'completed',
            providerId: `skipped:${safeErrorCode(check.reason ?? 'ineligible', 'ineligible')}`,
          };
        }
        await dependencies.delivery?.prepare({
          workspaceId: job.workspaceId,
          actorId: emailActor(job),
          messageId: job.messageId,
          template: 'abandoned_form_marketing',
          messageClass: 'marketing',
          contactHash: parsed.data.contactHash,
          leadId: parsed.data.leadId,
        });
        const result = await dependencies.email.send({
          workspaceId: job.workspaceId,
          messageId: job.messageId,
          template: 'abandoned_form_marketing',
          toAddress: parsed.data.toAddress,
          leadId: parsed.data.leadId,
          unsubscribeUrl: parsed.data.unsubscribeUrl,
        });
        await dependencies.delivery?.recordResult({
          workspaceId: job.workspaceId,
          actorId: emailActor(job),
          messageId: job.messageId,
          result,
        });
        return result.status === 'delivered'
          ? { status: 'completed', providerId: result.providerId }
          : {
              status: 'uncertain',
              errorCode: safeErrorCode(result.errorCode, 'provider_uncertain'),
            };
      },
    ],
    [
      'analytics_order_submitted',
      async (job) => {
        if (job.payloadVersion !== 1)
          throw new JobHandlerError('unsupported_payload_version', false);
        const parsed = orderSubmittedPayloadSchema.safeParse(job.payload);
        if (!parsed.success) throw new JobHandlerError('invalid_job_payload', false);
        const result = await dependencies.analytics.capture({
          workspaceId: job.workspaceId,
          eventId: job.messageId,
          name: 'order_submitted',
          subjectId: parsed.data.orderId,
        });
        return result.status === 'delivered'
          ? { status: 'completed', providerId: result.providerId }
          : {
              status: 'uncertain',
              errorCode: safeErrorCode(result.errorCode, 'provider_uncertain'),
            };
      },
    ],
    [
      'analytics_lead_saved',
      async (job) => {
        if (job.payloadVersion !== 1)
          throw new JobHandlerError('unsupported_payload_version', false);
        const parsed = leadSavedPayloadSchema.safeParse(job.payload);
        if (!parsed.success) throw new JobHandlerError('invalid_job_payload', false);
        const result = await dependencies.analytics.capture({
          workspaceId: job.workspaceId,
          eventId: job.messageId,
          name: 'lead_saved',
          subjectId: parsed.data.leadId,
        });
        return result.status === 'delivered'
          ? { status: 'completed', providerId: result.providerId }
          : {
              status: 'uncertain',
              errorCode: safeErrorCode(result.errorCode, 'provider_uncertain'),
            };
      },
    ],
  ]);
}

export interface OutboxRunSummary {
  workspaces: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  uncertain: number;
  leaseLost: number;
}

export interface OutboxRunnerOptions {
  store: OutboxStore;
  handlers: JobHandlerRegistry;
  batchSize?: number;
  maxAttempts?: number;
  leaseMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Per-handler abort timeout in milliseconds; `0` disables the bound. */
  handlerTimeoutMs?: number;
  /** Wall-clock budget after which no further jobs are claimed; `0` disables. */
  runDeadlineMs?: number;
  now?: () => Date;
  random?: () => number;
  leaseId?: () => string;
}

/** Pure delay policy: capped exponential backoff with 0.5–1.5x full jitter. */
export function retryDelayMs(
  attempt: number,
  random: () => number,
  baseMs = 5_000,
  capMs = 15 * 60_000,
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(exponential * (0.5 + random())));
}

export class OutboxRunner {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly runDeadlineMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly leaseId: () => string;

  constructor(private readonly options: OutboxRunnerOptions) {
    this.batchSize = options.batchSize ?? 20;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 5_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 30_000;
    this.runDeadlineMs = options.runDeadlineMs ?? 120_000;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.leaseId = options.leaseId ?? (() => crypto.randomUUID());
    if (this.batchSize < 1 || this.batchSize > 100) throw new Error('batchSize must be 1..100');
    if (this.maxAttempts < 1 || this.maxAttempts > 100)
      throw new Error('maxAttempts must be 1..100');
  }

  async run(input: {
    authorizedWorkspaceIds: readonly string[];
    actorId: string;
  }): Promise<OutboxRunSummary> {
    const workspaceIds = [...new Set(input.authorizedWorkspaceIds)];
    const summary: OutboxRunSummary = {
      workspaces: workspaceIds.length,
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      uncertain: 0,
      leaseLost: 0,
    };

    const deadline =
      this.runDeadlineMs > 0 ? this.now().getTime() + this.runDeadlineMs : Number.POSITIVE_INFINITY;

    for (const workspaceId of workspaceIds) {
      for (let processed = 0; processed < this.batchSize; processed += 1) {
        // A job's lease starts immediately before its execution, never while
        // it waits behind other handlers. Keep the existing per-workspace cap.
        if (this.now().getTime() >= deadline) break;
        const claimedAt = this.now();
        const [job] = await this.options.store.claim({
          workspaceId,
          actorId: input.actorId,
          leaseOwnerId: this.leaseId(),
          limit: 1,
          leaseExpiresAt: new Date(claimedAt.getTime() + this.leaseMs),
          now: claimedAt,
          maxAttempts: this.maxAttempts,
        });
        if (!job) break;
        summary.claimed += 1;
        const outcome = await this.handle({ ...job, actorId: input.actorId });
        const recorded = await this.options.store.recordOutcome({
          workspaceId,
          actorId: input.actorId,
          jobId: job.id,
          leaseOwnerId: job.leaseOwnerId,
          outcome,
          now: this.now(),
        });
        if (recorded === 'lease_lost') {
          summary.leaseLost += 1;
        } else {
          summary[outcome.status === 'retry' ? 'retried' : outcome.status] += 1;
        }
      }
    }
    return summary;
  }

  private async handle(job: ClaimedJob): Promise<JobOutcome> {
    const handler = this.options.handlers.get(job.jobType);
    if (!handler) return { status: 'failed', errorCode: 'handler_not_registered' };
    const controller = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new HandlerTimeoutError()), {
        once: true,
      });
    });
    const timer =
      this.handlerTimeoutMs > 0
        ? setTimeout(() => controller.abort(), this.handlerTimeoutMs)
        : undefined;
    try {
      const result = await Promise.race([handler(job, controller.signal), aborted]);
      return result;
    } catch (error) {
      // A timeout means the provider may already have acted, so the safe
      // outcome is uncertain (manual reconciliation), never a silent retry.
      if (error instanceof HandlerTimeoutError) {
        return { status: 'uncertain', errorCode: 'handler_timeout' };
      }
      const known = error instanceof JobHandlerError;
      const errorCode = known ? safeErrorCode(error.code, 'handler_error') : 'provider_error';
      if ((known && !error.retryable) || job.attempts >= this.maxAttempts) {
        return { status: 'failed', errorCode };
      }
      return {
        status: 'retry',
        errorCode,
        availableAt: new Date(
          this.now().getTime() +
            retryDelayMs(job.attempts, this.random, this.baseBackoffMs, this.maxBackoffMs),
        ),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
