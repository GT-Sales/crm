import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';

export const adminJobStatusSchema = z.enum(['pending', 'processing', 'failed', 'uncertain']);

export const adminJobSchema = z.object({
  id: z.uuid(),
  jobType: z.string().min(1),
  status: adminJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  availableAt: isoDateTimeSchema,
  leaseExpiresAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const listWorkspaceJobsResponseSchema = z.object({
  /** Most recently updated first, capped at 500; `total` counts every active job. */
  jobs: z.array(adminJobSchema),
  /** Optional only so an admin build tolerates a backend from before REL-20. */
  total: z.number().int().nonnegative().optional(),
  canRetry: z.boolean(),
  requestId: requestIdSchema,
});

export const retryWorkspaceJobResponseSchema = z.object({
  jobId: z.uuid(),
  status: z.literal('pending'),
  requestId: requestIdSchema,
});

/**
 * Staff resolution of an `uncertain` job after checking the provider's own log
 * (REL-20): delivered closes it as completed; not delivered marks it failed so
 * it can be retried.
 */
export const resolveUncertainJobRequestSchema = z.object({ delivered: z.boolean() });

export const resolveUncertainJobResponseSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(['completed', 'failed']),
  requestId: requestIdSchema,
});

export type AdminJob = z.infer<typeof adminJobSchema>;
export type AdminJobStatus = z.infer<typeof adminJobStatusSchema>;
export type ListWorkspaceJobsResponse = z.infer<typeof listWorkspaceJobsResponseSchema>;
export type RetryWorkspaceJobResponse = z.infer<typeof retryWorkspaceJobResponseSchema>;
export type ResolveUncertainJobRequest = z.infer<typeof resolveUncertainJobRequestSchema>;
export type ResolveUncertainJobResponse = z.infer<typeof resolveUncertainJobResponseSchema>;
