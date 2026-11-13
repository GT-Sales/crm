import { z } from 'zod';

/**
 * Response contract for GET /api/v1/health. The backend validates its own
 * response against this before sending it — a cheap DRY check that the
 * implementation and the published contract never drift.
 */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.uuid(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Response contract for GET /api/v1/ready (audit L-7): 200 only once the
 * runtime role answers a `select 1`. Railway's deploy health check points
 * here, so a release with a wrong `DATABASE_URL` never replaces a working
 * one. A failure is 503 with the same shape and `ok: false`.
 */
export const readyResponseSchema = z.object({
  ok: z.boolean(),
  requestId: z.uuid(),
  code: z.enum(['database_unreachable']).optional(),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
