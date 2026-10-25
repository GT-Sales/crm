import type { Request, Response } from 'express';
import { healthResponseSchema, type HealthResponse } from '@gt-sales/contracts';

export function getHealth(req: Request, res: Response): void {
  const body: HealthResponse = { ok: true, requestId: req.id };

  // Validates the response against the published contract before sending —
  // catches drift between this handler and @gt-sales/contracts early.
  healthResponseSchema.parse(body);

  res.status(200).json(body);
}
