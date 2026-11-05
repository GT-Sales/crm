import type { Response } from 'express';

import type { UpdateLeadWorkOutcome } from '../leads/work-store.js';
import { sendDomainError } from './domain-errors.js';

/** Every outcome of a lead update except success. */
export type LeadUpdateRefusal = Exclude<UpdateLeadWorkOutcome, { status: 'updated' }>;

/**
 * The one mapping from a refused lead update to its HTTP answer, shared by the
 * staff edit (`PATCH …/leads/:leadId`) and the AI-confirmed update, so a gate
 * says the same thing whichever screen asked: which moves are allowed, which
 * detail is missing, or which documents still need approval. Details name keys
 * and document types only, never a value.
 */
export function sendLeadUpdateRefusal(
  res: Response,
  requestId: string,
  outcome: LeadUpdateRefusal,
): void {
  switch (outcome.status) {
    case 'illegal_stage_move':
      sendDomainError(res, requestId, 'illegal_stage_move', 409, {
        from: outcome.from,
        to: outcome.to,
        allowed: outcome.allowed,
      });
      return;
    case 'dispatch_details_required':
      sendDomainError(res, requestId, 'dispatch_details_required', 400, { field: 'courier' });
      return;
    case 'activation_details_required':
      sendDomainError(res, requestId, 'activation_details_required', 400, {
        field: 'activatedAt',
      });
      return;
    case 'documents_incomplete':
      sendDomainError(res, requestId, 'documents_incomplete', 409, { missing: outcome.missing });
      return;
    case 'document_override_reason_required':
      sendDomainError(res, requestId, 'document_override_reason_required', 400);
      return;
    case 'invalid_field':
      sendDomainError(res, requestId, 'validation_error', 400, { field: outcome.field });
      return;
    case 'not_found':
      sendDomainError(res, requestId, 'lead_not_found', 404);
      return;
    case 'trashed':
      sendDomainError(res, requestId, 'lead_trashed', 409);
      return;
    case 'invalid_stage':
      sendDomainError(res, requestId, 'validation_error', 400, { field: 'stage' });
      return;
    case 'assignee_not_found':
      sendDomainError(res, requestId, 'assignee_not_found', 422);
      return;
    default: {
      // A new outcome fails typecheck here; at runtime it answers 500, never hangs.
      const _unhandled: never = outcome;
      throw new Error('unhandled lead update outcome');
    }
  }
}
