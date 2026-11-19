import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  aiActionDraftSchema,
  aiActionProposalSchema,
  aiCapabilitiesResponseSchema,
  aiStreamPartSchema,
  confirmAiActionResponseSchema,
} from './ai-assistant';
import { domainErrorCodeSchema } from './common';
import {
  createPlainTaskRequestSchema,
  createLeadTaskRequestSchema,
  leadTaskSchema,
  listWorkspaceTasksQuerySchema,
  listWorkspaceTasksResponseSchema,
  workspaceTaskSchema,
} from './lead-work';

const ID = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-19T12:00:00.000Z';

const plainTask = {
  id: ID(1),
  leadId: null,
  title: 'Call the supplier',
  dueAt: AT,
  assignedActorId: null,
  status: 'open',
  completedAt: null,
  createdBy: ID(2),
  createdAt: AT,
  updatedAt: AT,
} as const;

const leadTask = {
  ...plainTask,
  id: ID(3),
  leadId: ID(4),
  lead: {
    id: ID(4),
    leadType: 'internet',
    stage: 'new',
    contact: { fullName: 'Robin Example' },
    externalRef: null,
  },
};

describe('plain tasks on the task contracts', () => {
  it('a task may have no lead, and a workspace task then has no lead summary', () => {
    expect(leadTaskSchema.parse(plainTask).leadId).toBeNull();
    expect(workspaceTaskSchema.parse({ ...plainTask, lead: null }).lead).toBeNull();
    expect(workspaceTaskSchema.parse(leadTask).lead?.id).toBe(ID(4));
    // A missing lead summary is not a plain task: the key is always sent.
    expect(workspaceTaskSchema.safeParse(plainTask).success).toBe(false);
  });

  it('creates a plain task with exactly the lead task form’s fields and checks', () => {
    expect(createPlainTaskRequestSchema).toBe(createLeadTaskRequestSchema);
    expect(
      createPlainTaskRequestSchema.parse({ title: '  Order more SIM cards  ', dueAt: AT }),
    ).toEqual({ title: 'Order more SIM cards', dueAt: AT });
    for (const bad of [
      { title: '' },
      { title: ' ' },
      { title: 'x'.repeat(201) },
      { title: 'Call', dueAt: '2026-11-19' },
      { title: 'Call', assignedActorId: 'me' },
      { title: 'Call', leadId: ID(4) },
    ])
      expect(createPlainTaskRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('lists plain tasks only for a caller that asks for them by `plain=include`', () => {
    expect(listWorkspaceTasksQuerySchema.parse({ plain: 'include' }).plain).toBe('include');
    expect(listWorkspaceTasksQuerySchema.parse({}).plain).toBeUndefined();
    expect(listWorkspaceTasksQuerySchema.safeParse({ plain: 'yes' }).success).toBe(false);
  });

  it('an older admin’s list schema would refuse a whole page holding one plain task', () => {
    // The list item as it was before plain tasks: a lead id and a lead summary required.
    const olderList = z.object({
      tasks: z.array(
        leadTaskSchema.extend({
          leadId: z.uuid(),
          lead: z.object({ id: z.uuid() }).loose(),
        }),
      ),
    });
    const page = { tasks: [leadTask, { ...plainTask, lead: null }] };
    expect(olderList.safeParse(page).success).toBe(false);
    // Which is why the backend leaves plain tasks out unless `plain=include` asked.
    expect(olderList.safeParse({ tasks: [leadTask] }).success).toBe(true);
    expect(
      listWorkspaceTasksResponseSchema.safeParse({
        ...page,
        page: { page: 1, pageSize: 50, total: 2 },
        access: { contacts: true, manage: true },
        requestId: ID(9),
      }).success,
    ).toBe(true);
  });

  it('has its own error code for a database without migration 0038', () => {
    expect(domainErrorCodeSchema.safeParse('plain_tasks_unavailable').success).toBe(true);
  });
});

describe('Ask AI cards for plain tasks and task moves', () => {
  const taskCard = { kind: 'task', title: 'Call the supplier', dueDate: '2026-11-20' } as const;

  it('a task card without a lead is a plain task; a null lead is not accepted', () => {
    expect(aiActionDraftSchema.parse({ ...taskCard, assignee: 'none' })).toEqual({
      ...taskCard,
      assignee: 'none',
    });
    expect(
      aiActionDraftSchema.safeParse({ ...taskCard, assignee: 'me', leadId: null }).success,
    ).toBe(false);
    expect(
      aiActionDraftSchema.safeParse({ ...taskCard, assignee: 'me', leadId: ID(4) }).success,
    ).toBe(true);
  });

  it('a task move names the task and one of its four stages, nothing else', () => {
    for (const status of ['open', 'in_progress', 'done', 'cancelled'])
      expect(
        aiActionDraftSchema.safeParse({ kind: 'task_update', taskId: ID(1), status }).success,
      ).toBe(true);
    for (const bad of [
      { kind: 'task_update', taskId: ID(1), status: 'waiting' },
      { kind: 'task_update', taskId: ID(1) },
      { kind: 'task_update', taskId: ID(1), status: 'done', title: 'Renamed' },
      { kind: 'task_update', taskId: ID(1), status: 'done', leadId: ID(4) },
    ])
      expect(aiActionDraftSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('a card about no lead carries no lead label or link; a move carries the task’s context', () => {
    const base = {
      id: ID(5),
      token: 'opaque',
      expiresAt: AT,
      siteName: 'Get Canada Sim',
    };
    expect(
      aiActionProposalSchema.safeParse({
        ...base,
        draft: { ...taskCard, assignee: 'me' },
      }).success,
    ).toBe(true);
    const move = aiActionProposalSchema.parse({
      ...base,
      draft: { kind: 'task_update', taskId: ID(1), status: 'done' },
      taskUpdateContext: {
        version: '1795054241116000',
        title: 'Call the supplier',
        before: 'in_progress',
        leadId: null,
      },
    });
    expect(move.taskUpdateContext?.before).toBe('in_progress');
    expect(
      aiActionProposalSchema.safeParse({
        ...base,
        draft: { kind: 'task_update', taskId: ID(1), status: 'done' },
        taskUpdateContext: { version: 'v', title: 'x', before: 'started', leadId: null },
      }).success,
    ).toBe(false);
    expect(aiStreamPartSchema.safeParse({ type: 'actions', actions: [move] }).success).toBe(true);
    expect(
      confirmAiActionResponseSchema.safeParse({
        status: 'saved',
        actionId: ID(5),
        kind: 'task_update',
        recordId: ID(1),
        requestId: ID(6),
      }).success,
    ).toBe(true);
  });

  it('an older admin would drop the whole actions part holding a new card, never the stream', () => {
    // The card as an older admin parses it: a task names its lead, the label and link are required.
    const olderProposal = aiActionProposalSchema.extend({
      leadLabel: z.string().min(1),
      leadHref: z.string().min(1),
      draft: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('task'),
            leadId: z.uuid(),
            title: z.string(),
            dueDate: z.iso.date().nullable(),
            assignee: z.enum(['me', 'none']),
          })
          .strict(),
      ]),
    });
    const olderPart = z.object({ type: z.literal('actions'), actions: z.array(olderProposal) });
    const plainCard = {
      id: ID(5),
      token: 'opaque',
      expiresAt: AT,
      siteName: 'Get Canada Sim',
      draft: { ...taskCard, assignee: 'me' },
    };
    expect(olderPart.safeParse({ type: 'actions', actions: [plainCard] }).success).toBe(false);
  });

  it('keeps the capability `actions` list as older admins parse it and adds `taskActions` beside it', () => {
    const base = {
      available: true,
      site: { id: ID(7), slug: 'getcanadasim', name: 'Get Canada Sim' },
      leadTypes: ['sim_order'],
      limits: { maxMessageChars: 4000, maxHistoryMessages: 12, maxConversationChars: 16000 },
      requestId: ID(8),
    };
    // An older admin's enum knows four kinds: a fifth would refuse the whole document.
    expect(
      aiCapabilitiesResponseSchema.safeParse({
        ...base,
        actions: ['task', 'note', 'email', 'lead_update', 'task_update'],
      }).success,
    ).toBe(false);
    const current = aiCapabilitiesResponseSchema.parse({
      ...base,
      actions: ['task', 'note', 'email', 'lead_update'],
      taskActions: ['plain_task', 'task_update'],
    });
    expect(current.taskActions).toEqual(['plain_task', 'task_update']);
    // And an older backend's document (no `taskActions`) still parses.
    expect(
      aiCapabilitiesResponseSchema.parse({ ...base, actions: ['task'] }).taskActions,
    ).toBeUndefined();
  });
});
