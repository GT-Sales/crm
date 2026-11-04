import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  aiActionDraftSchema,
  aiLeadUpdateContextSchema,
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
    leadUpdateContext: aiLeadUpdateContextSchema.optional(),
    emailContext: z.object({ toAddress: z.email(), fromAddress: z.email() }).strict().optional(),
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
  emailPreview?: (
    leadId: string,
  ) => Promise<{ toAddress: string; fromAddress: string } | undefined>;
  leadUpdatePreview?: (
    leadId: string,
    field: Extract<import('@gt-sales/contracts').AiActionDraft, { kind: 'lead_update' }>['field'],
  ) => Promise<import('../leads/work-store.js').AiLeadUpdatePreview | undefined>;
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
    const emailContext =
      draft.kind === 'email'
        ? await input.emailPreview?.(draft.leadId).catch(() => undefined)
        : undefined;
    if (draft.kind === 'email' && !emailContext)
      return JSON.stringify({
        status: 'not_available',
        message: 'Email cannot be prepared. The Site sender or customer address is unavailable.',
      });
    const leadUpdateContext =
      draft.kind === 'lead_update'
        ? await input.leadUpdatePreview?.(draft.leadId, draft.field)
        : undefined;
    if (draft.kind === 'lead_update') {
      if (!leadUpdateContext) return JSON.stringify({ status: 'not_available' });
      if (
        (draft.field === 'stage' || draft.field === 'assignedActorId') &&
        !leadUpdateContext.choices.some((choice) => choice.value === draft.value)
      )
        return JSON.stringify({
          status: 'not_available',
          message: 'Choose an available stage or active member.',
        });
      if (draft.field !== 'assignedActorId' && draft.value === null)
        return JSON.stringify({ status: 'not_available' });
      if (draft.field === 'phone' && (draft.value?.length ?? 0) > 40)
        return JSON.stringify({ status: 'not_available' });
    }
    const previous = proposals.find((p) => JSON.stringify(p.draft) === JSON.stringify(draft));
    if (previous)
      return JSON.stringify({
        status: 'confirmation_required',
        message: 'A confirmation card for this draft is already prepared.',
      });
    // Parallel calls can all pass the entry guard before their reads finish.
    // Recheck after the final await; checking and appending below are synchronous.
    if (proposals.length >= 3) return JSON.stringify({ status: 'not_available' });
    const id = randomUUID();
    const expiresAt = new Date(input.now().getTime() + TTL_MS).toISOString();
    const token = signAiAction(
      {
        ...input.scope,
        id,
        expiresAt,
        draft,
        ...(emailContext ? { emailContext } : {}),
        ...(leadUpdateContext ? { leadUpdateContext } : {}),
      },
      input.key,
    );
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
        ...(emailContext ? { emailContext } : {}),
        ...(leadUpdateContext ? { leadUpdateContext } : {}),
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
  async function getLeadUpdateOptions({
    leadId,
    field,
  }: {
    leadId: string;
    field: 'stage' | 'assignedActorId';
  }) {
    if (!input.budget.reserveToolCall()) return 'Not available';
    const access = await input.loadAccess();
    if (
      !decideAccess(access, 'lead.manage').allowed ||
      !decideAccess(access, 'workspace.read').allowed
    )
      return 'Not available';
    const preview = await input.leadUpdatePreview?.(leadId, field);
    const result = JSON.stringify({ choices: preview?.choices ?? [] });
    if (
      input.budget.acceptResult({
        bytes: Buffer.byteLength(result, 'utf8'),
        records: preview?.choices.length ?? 0,
      }).rejected
    )
      return 'Too many choices. Use the lead page.';
    return result;
  }
  const definitions: ToolSet = {
    getLeadUpdateOptions: tool({
      description:
        'Read available stage moves or active assignees for one lead before preparing a lead update. Returns choices only, never contact values.',
      inputSchema: z
        .object({ leadId: z.uuid(), field: z.enum(['stage', 'assignedActorId']) })
        .strict(),
      execute: getLeadUpdateOptions,
    }),
    prepareLeadUpdate: tool({
      description:
        'Prepare one explicitly requested stage, assignee, name or phone change. Use getLeadUpdateOptions for stage/member choices first. The person reviews current/proposed values and confirms; no write occurs here.',
      inputSchema: aiActionDraftSchema.options[3].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'lead_update' }),
    }),
    prepareNote: tool({
      description:
        'Prepare a note for an identified lead. Only when the person explicitly asks to add a note. Use their requested text; ask if missing. Does not save: a separate confirmation card is required.',
      inputSchema: aiActionDraftSchema.options[0].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'note' }),
    }),
    prepareEmail: tool({
      description:
        'Draft a customer email only when requested. Resolve the lead first; ask for missing recipient intent or message details. Address is resolved by the server, never provide an address. Plain text subject and body. Does not send: the person reviews and presses Send.',
      inputSchema: aiActionDraftSchema.options[2].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'email' }),
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
      if (name === 'getLeadUpdateOptions') {
        const parsed = z
          .object({ leadId: z.uuid(), field: z.enum(['stage', 'assignedActorId']) })
          .strict()
          .parse(raw);
        return getLeadUpdateOptions(parsed);
      }
      if (name === 'prepareLeadUpdate')
        return prepare({
          kind: 'lead_update',
          ...aiActionDraftSchema.options[3].omit({ kind: true }).parse(raw),
        });
      if (name !== 'prepareNote' && name !== 'prepareTask' && name !== 'prepareEmail')
        throw new Error('unknown action proposal');
      const schema =
        name === 'prepareNote'
          ? aiActionDraftSchema.options[0].omit({ kind: true })
          : name === 'prepareTask'
            ? aiActionDraftSchema.options[1].omit({ kind: true })
            : aiActionDraftSchema.options[2].omit({ kind: true });
      return prepare({
        kind: name === 'prepareNote' ? 'note' : name === 'prepareTask' ? 'task' : 'email',
        ...schema.parse(raw),
      });
    },
  };
}
