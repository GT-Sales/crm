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
