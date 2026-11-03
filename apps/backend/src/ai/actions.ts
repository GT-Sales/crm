import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  aiActionDraftSchema,
  aiActionProposalSchema,
  leadTypeLabel,
  type AiActionProposal,
} from '@gt-sales/contracts';
import type { Scope } from '../tenant-scope.js';
import type { AiReadService } from './read-service.js';
import { decideAccess, type StaffAccessSnapshot } from '../staff/authorization.js';
import { TurnBudget } from './limits.js';

const signedActionSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    expiresAt: z.iso.datetime(),
    draft: aiActionDraftSchema,
  })
  .strict();
export type SignedAiAction = z.infer<typeof signedActionSchema>;
const TTL_MS = 10 * 60 * 1000;

// Domain-separated signing key; rotation of the Gateway key invalidates old cards.
function signature(payload: string, key: string): Buffer {
  const derived = createHmac('sha256', key).update('gt-sales/ai-action/v1').digest();
  return createHmac('sha256', derived).update(payload).digest();
}

export function signAiAction(action: SignedAiAction, key: string): string {
  const payload = Buffer.from(JSON.stringify(signedActionSchema.parse(action))).toString(
    'base64url',
  );
  return `${payload}.${signature(payload, key).toString('base64url')}`;
}

export function verifyAiAction(
  token: string,
  key: string,
  scope: Scope,
  now: Date,
): SignedAiAction | undefined {
  try {
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra !== undefined || token.length > 40000) return undefined;
    const supplied = Buffer.from(mac, 'base64url');
    const expected = signature(payload, key);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return undefined;
    const parsed = signedActionSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return undefined;
    const action = parsed.data;
    const remaining = Date.parse(action.expiresAt) - now.getTime();
    if (
      action.actorId !== scope.actorId ||
      action.workspaceId !== scope.workspaceId ||
      remaining <= 0 ||
      remaining > TTL_MS
    )
      return undefined;
    return action;
  } catch {
    return undefined;
  }
}

/** These tools only prepare cards. The model has no reference to a write store. */
export function createActionProposalTools(input: {
  scope: Scope;
  site: { name: string; slug: string };
  key: string;
  reads: AiReadService;
  loadAccess(): Promise<StaffAccessSnapshot | undefined>;
  now(): Date;
  budget: TurnBudget;
}) {
  const proposals: AiActionProposal[] = [];
  async function prepare(raw: unknown): Promise<string> {
    if (!input.budget.reserveToolCall() || proposals.length >= 3)
      return JSON.stringify({ status: 'not_available' });
    const access = await input.loadAccess().catch(() => null);
    if (access === null)
      return JSON.stringify({
        status: 'temporary_failure',
        message: 'Access could not be checked.',
      });
    if (
      !decideAccess(access, 'workspace.read').allowed ||
      !decideAccess(access, 'lead.manage').allowed
    )
      return JSON.stringify({ status: 'not_available' });
    const draft = aiActionDraftSchema.parse(raw);
    const lead = await input.reads.leadHint(input.scope, draft.leadId).catch(() => null);
    if (lead === null)
      return JSON.stringify({
        status: 'temporary_failure',
        message: 'The lead could not be checked.',
      });
    if (!lead || lead.leadId !== draft.leadId) return JSON.stringify({ status: 'not_available' });
    const previous = proposals.find((p) => JSON.stringify(p.draft) === JSON.stringify(draft));
    if (previous)
      return JSON.stringify({
        status: 'confirmation_required',
        message: 'A confirmation card for this draft is already prepared.',
      });
    const id = randomUUID();
    const expiresAt = new Date(input.now().getTime() + TTL_MS).toISOString();
    const token = signAiAction({ ...input.scope, id, expiresAt, draft }, input.key);
    const result = JSON.stringify({
      status: 'confirmation_required',
      message: 'Draft prepared. Nothing saved. The person must press Confirm in the card.',
    });
    if (
      input.budget.acceptResult({ bytes: Buffer.byteLength(result, 'utf8'), records: 1 }).rejected
    )
      return JSON.stringify({ status: 'not_available' });
    proposals.push(
      aiActionProposalSchema.parse({
        id,
        token,
        expiresAt,
        draft,
        siteName: input.site.name,
        leadLabel:
          `${lead.reference || lead.name || 'Lead'} · ${leadTypeLabel(lead.leadType)}`.slice(
            0,
            160,
          ),
        leadHref: `/w/${encodeURIComponent(input.site.slug)}/leads/${lead.leadId}`,
      }),
    );
    // Never send the bearer confirmation token to the model.
    return result;
  }
  const definitions: ToolSet = {
    prepareNote: tool({
      description:
        'Prepare a note for an identified lead. Only when the person explicitly asks to add a note. Use their requested text; ask if missing. Does not save: a separate confirmation card is required.',
      inputSchema: aiActionDraftSchema.options[0].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'note' }),
    }),
    prepareTask: tool({
      description:
        'Prepare a follow-up task for an identified lead, only when explicitly requested. Use a calendar dueDate (YYYY-MM-DD) or null; ask if ambiguous. Assignee me assigns the asking person, none leaves it unassigned. Does not save until the person confirms the card.',
      inputSchema: aiActionDraftSchema.options[1].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'task' }),
    }),
  };
  return {
    definitions,
    proposals,
    execute(name: string, raw: unknown) {
      if (name !== 'prepareNote' && name !== 'prepareTask')
        throw new Error('unknown action proposal');
      const schema =
        name === 'prepareNote'
          ? aiActionDraftSchema.options[0].omit({ kind: true })
          : aiActionDraftSchema.options[1].omit({ kind: true });
      return prepare({ kind: name === 'prepareNote' ? 'note' : 'task', ...schema.parse(raw) });
    },
  };
}
