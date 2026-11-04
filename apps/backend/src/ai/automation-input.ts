import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiAutomationProposalInputSchema,
  aiAutomationTargetSchema,
  conditionGroupSchema,
  STEP_ID_PATTERN,
  type AiAutomationProposalInput,
} from '@gt-sales/contracts';

const duration = z.object({ amount: z.int().positive(), unit: z.enum(['hours', 'days']) }).strict();
const reference = z
  .string()
  .min(1)
  .max(160)
  .describe(
    'Use me for the signed-in person, a catalog member ID, or an exact staff display name. Never ask the user for an ID.',
  );
const step: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      kind: z.enum([
        'send_email',
        'create_task',
        'assign_lead',
        'update_lead',
        'notify_staff',
        'if_else',
        'wait',
      ]),
      id: z
        .string()
        .optional()
        .describe(
          'Preserve existing IDs when editing. Omit for new steps; the server creates IDs.',
        ),
      template: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      dueInDays: z.int().nullable().optional(),
      assignee: z
        .object({
          kind: z.enum(['lead_assignee', 'member', 'none']),
          actorId: reference.optional(),
        })
        .strict()
        .optional(),
      actorId: reference.nullable().optional(),
      reassign: z.boolean().optional(),
      toAssignee: z.boolean().optional(),
      actorIds: z.array(reference).optional(),
      note: z.string().optional(),
      condition: conditionGroupSchema.nullable().optional(),
      then: z.array(step).optional(),
      else: z.array(step).optional(),
      for: duration.nullable().optional(),
      change: z
        .object({
          kind: z.enum(['stage', 'property']),
          stage: z.string().optional(),
          key: z.string().optional(),
          value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict(),
);
export const automationModelProposalSchema = z
  .object({
    draft: z
      .object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional(),
        definition: z
          .object({
            schemaVersion: z.literal(1).optional(),
            trigger: z
              .object({
                kind: z.enum([
                  'lead_submitted',
                  'stage_entered',
                  'time_in_stage',
                  'task_overdue',
                  'after_submitted',
                ]),
                leadTypes: z.array(z.string()).optional(),
                leadType: z.string().nullable().optional(),
                stage: z.string().nullable().optional(),
                after: duration.nullable().optional(),
                when: conditionGroupSchema.nullable().optional(),
              })
              .strict()
              .nullable(),
            steps: z.array(step).max(30),
          })
          .strict(),
      })
      .strict(),
    target: aiAutomationTargetSchema.optional(),
  })
  .strict();
const record = z.record(z.string(), z.unknown());
export class MemberChoiceError extends Error {
  constructor(readonly choices: readonly string[]) {
    super('Choose one available staff member by name. No UUID is needed.');
  }
}
export function normalizeAutomationProposal(
  raw: unknown,
  actorId: string,
  members: readonly { actorId: string; displayName: string | null }[],
): AiAutomationProposalInput {
  const input = automationModelProposalSchema.parse(raw);
  function member(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') return value;
    if (['me', 'myself', 'current_user'].includes(value.toLowerCase())) {
      if (members.some((m) => m.actorId === actorId)) return actorId;
      throw new MemberChoiceError(members.map((m) => m.displayName ?? 'Unnamed member'));
    }
    const matches = members.filter(
      (m) =>
        m.actorId === value || m.displayName?.trim().toLowerCase() === value.trim().toLowerCase(),
    );
    if (matches.length !== 1)
      throw new MemberChoiceError(
        matches.length
          ? matches.map((m) => m.displayName ?? 'Unnamed member')
          : members.map((m) => m.displayName ?? 'Unnamed member'),
      );
    return matches[0]?.actorId;
  }
  function normalizeStep(rawStep: Record<string, unknown>): Record<string, unknown> {
    const s: Record<string, unknown> = {
      ...rawStep,
      id:
        input.target && typeof rawStep.id === 'string' && STEP_ID_PATTERN.test(rawStep.id)
          ? rawStep.id
          : 's_' + randomUUID().replaceAll('-', '').slice(0, 20),
    };
    const base = { kind: s.kind, id: s.id };
    switch (s.kind) {
      case 'assign_lead':
        return { ...base, actorId: member(s.actorId ?? null), reassign: s.reassign ?? false };
      case 'create_task': {
        const assignee = s.assignee === undefined ? { kind: 'none' } : record.parse(s.assignee);
        return {
          ...base,
          title: s.title ?? null,
          dueInDays: s.dueInDays ?? null,
          assignee:
            assignee.kind === 'member'
              ? { ...assignee, actorId: member(assignee.actorId) }
              : assignee,
        };
      }
      case 'send_email':
        return { ...base, template: s.template ?? null };
      case 'notify_staff':
        return {
          ...base,
          toAssignee: s.toAssignee ?? false,
          actorIds: Array.isArray(s.actorIds) ? s.actorIds.map(member) : [],
          note: s.note ?? '',
        };
      case 'if_else':
        return {
          ...base,
          condition: s.condition ?? null,
          then: Array.isArray(s.then) ? s.then.map((x) => normalizeStep(record.parse(x))) : [],
          else: Array.isArray(s.else) ? s.else.map((x) => normalizeStep(record.parse(x))) : [],
        };
      case 'wait':
        return { ...base, for: s.for ?? null };
      case 'update_lead':
        return { ...base, change: s.change ?? null };
      default:
        return s;
    }
  }
  const definition = input.draft.definition;
  const t = definition.trigger;
  const when = t?.when ?? null;
  const trigger = !t
    ? null
    : t.kind === 'lead_submitted'
      ? { kind: t.kind, leadTypes: t.leadTypes ?? [], when }
      : t.kind === 'stage_entered'
        ? { kind: t.kind, leadType: t.leadType ?? null, stage: t.stage ?? null, when }
        : t.kind === 'time_in_stage'
          ? {
              kind: t.kind,
              leadType: t.leadType ?? null,
              stage: t.stage ?? null,
              after: t.after ?? null,
              when,
            }
          : { kind: t.kind, leadTypes: t.leadTypes ?? [], after: t.after ?? null, when };
  return aiAutomationProposalInputSchema.parse({
    ...input,
    draft: {
      ...input.draft,
      description: input.draft.description ?? '',
      definition: {
        ...definition,
        schemaVersion: definition.schemaVersion ?? 1,
        trigger,
        steps: definition.steps.map(normalizeStep),
      },
    },
  });
}
