import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_REASONS,
  type FlowCatalogResponse,
  type FlowRun,
  type FlowStep,
  type FlowSummary,
} from '@gt-sales/contracts';

import {
  describeCondition,
  describeStep,
  describeTrigger,
  flowStatusChip,
  namesFromCatalog,
  namesFromCode,
  reasonText,
  runStatusText,
} from './flow-words';

const SAM = '20000000-0000-4000-8000-000000000001';
const STUDENT = '40000000-0000-4000-8000-000000000001';
const VISITOR = '40000000-0000-4000-8000-000000000002';

const catalog: Omit<FlowCatalogResponse, 'requestId'> = {
  leadTypes: [
    {
      key: 'sim_order',
      label: 'SIM order',
      stages: [
        { key: 'pending', label: 'Pending' },
        { key: 'verified', label: 'Verified' },
        { key: 'delivered', label: 'Delivered' },
        { key: 'activated', label: 'Activated' },
      ],
    },
    { key: 'internet', label: 'Internet', stages: [{ key: 'new', label: 'New' }] },
  ],
  templates: [
    { key: 'dispatched', name: 'Dispatched', builtIn: true, archived: false, fillIns: [] },
    { key: 'activated', name: 'Activated', builtIn: true, archived: false, fillIns: [] },
    {
      key: 'tpl_abcdefghij012345',
      name: 'My note',
      builtIn: false,
      archived: false,
      fillIns: [],
    },
  ],
  members: [{ actorId: SAM, displayName: 'Sam' }],
  plans: [
    { id: STUDENT, name: 'Student', leadType: 'sim_order', active: true },
    { id: VISITOR, name: 'Visitor', leadType: 'sim_order', active: true },
  ],
  properties: [
    {
      key: 'custom_size',
      label: 'Size',
      kind: 'choice',
      options: [{ value: 'large', label: 'Large' }],
      leadTypes: ['sim_order'],
      condition: true,
      update: true,
      taskVariable: true,
      emailVariable: true,
    },
  ],
  taskVariables: [],
};
const names = namesFromCatalog(catalog);

describe('describeTrigger', () => {
  it('words every trigger kind', () => {
    expect(
      describeTrigger(
        { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered', when: null },
        names,
      ),
    ).toBe('A SIM order moves to Delivered');
    expect(
      describeTrigger({ kind: 'lead_submitted', leadTypes: ['sim_order'], when: null }, names),
    ).toBe('A SIM order is submitted');
    expect(
      describeTrigger(
        { kind: 'lead_submitted', leadTypes: ['internet', 'mobility', 'sim_order'], when: null },
        names,
      ),
    ).toBe('An internet lead, a mobility order or a SIM order is submitted');
    expect(
      describeTrigger(
        {
          kind: 'time_in_stage',
          leadType: 'sim_order',
          stage: 'pending',
          after: { amount: 3, unit: 'days' },
          when: null,
        },
        names,
      ),
    ).toBe('A SIM order has been in Pending for 3 days');
    expect(
      describeTrigger({ kind: 'task_overdue', leadTypes: [], after: null, when: null }, names),
    ).toBe('A follow-up task is overdue');
    expect(
      describeTrigger(
        {
          kind: 'task_overdue',
          leadTypes: ['sim_order'],
          after: { amount: 1, unit: 'hours' },
          when: null,
        },
        names,
      ),
    ).toBe('A follow-up task on a SIM order is overdue by 1 hour');
    expect(
      describeTrigger(
        {
          kind: 'after_submitted',
          leadTypes: ['internet'],
          after: { amount: 2, unit: 'days' },
          when: null,
        },
        names,
      ),
    ).toBe('An internet lead was submitted 2 days ago');
  });

  it('names a stage from code alone on the list, and a stage that is gone by its key', () => {
    const code = namesFromCode();
    expect(
      describeTrigger(
        { kind: 'stage_entered', leadType: 'mobility', stage: 'activated', when: null },
        code,
      ),
    ).toBe('A mobility order moves to Activated');
    expect(
      describeTrigger(
        { kind: 'stage_entered', leadType: 'sim_order', stage: 'paid', when: null },
        names,
      ),
    ).toBe('A SIM order moves to paid');
  });
});

describe('describeCondition', () => {
  it('words every condition kind and nested groups', () => {
    const one = (item: Parameters<typeof describeCondition>[0]['items'][number]) =>
      describeCondition({ match: 'all', items: [item] }, names);
    expect(one({ kind: 'plan', op: 'in', planIds: [STUDENT, VISITOR] })).toBe(
      'the plan is Student or Visitor',
    );
    expect(one({ kind: 'plan', op: 'not_in', planIds: [STUDENT] })).toBe('the plan is not Student');
    expect(one({ kind: 'lead_type', in: ['sim_order', 'internet'] })).toBe(
      'the lead type is SIM order or Internet',
    );
    expect(one({ kind: 'stage', op: 'in', stages: ['pending', 'verified'] })).toBe(
      'the stage is Pending or Verified',
    );
    expect(one({ kind: 'stage', op: 'not_in', stages: ['pending'] })).toBe(
      'the stage is not Pending',
    );
    expect(one({ kind: 'assignee', op: 'none' })).toBe('no one owns the lead');
    expect(one({ kind: 'assignee', op: 'any' })).toBe('someone owns the lead');
    expect(one({ kind: 'assignee', op: 'is', actorId: SAM })).toBe('Sam owns the lead');
    expect(
      one({ kind: 'property', filter: { key: 'custom_size', op: 'eq', value: 'large' } }),
    ).toBe('Size is Large');
    expect(one({ kind: 'property', filter: { key: 'custom_size', op: 'empty' } })).toBe(
      'Size is empty',
    );
    expect(one({ kind: 'property', filter: { key: 'custom_size', op: 'notEmpty' } })).toBe(
      'Size is filled in',
    );
    expect(
      describeCondition(
        {
          match: 'all',
          items: [
            { kind: 'assignee', op: 'none' },
            {
              match: 'any',
              items: [
                { kind: 'plan', op: 'in', planIds: [STUDENT] },
                { kind: 'stage', op: 'in', stages: ['pending'] },
              ],
            },
          ],
        },
        names,
      ),
    ).toBe('all of: no one owns the lead; (any of: the plan is Student; the stage is Pending)');
  });
});

describe('describeStep', () => {
  it('words every step kind', () => {
    const steps: [FlowStep, string][] = [
      [{ id: 'a', kind: 'send_email', template: 'dispatched' }, 'Send the Dispatched email'],
      [
        { id: 'b', kind: 'send_email', template: 'tpl_abcdefghij012345' },
        'Send the email "My note"',
      ],
      [{ id: 'c', kind: 'wait', for: { amount: 2, unit: 'days' } }, 'Wait 2 days'],
      [
        {
          id: 'd',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'plan', op: 'in', planIds: [STUDENT] }] },
          then: [],
          else: [],
        },
        'If the plan is Student',
      ],
      [
        {
          id: 'e',
          kind: 'create_task',
          title: 'Call {first name}',
          dueInDays: 2,
          assignee: { kind: 'lead_assignee' },
        },
        'Create the task "Call {first name}" due in 2 days for the lead\'s owner',
      ],
      [
        {
          id: 'f',
          kind: 'create_task',
          title: 'Check',
          dueInDays: 0,
          assignee: { kind: 'member', actorId: SAM },
        },
        'Create the task "Check" due today for Sam',
      ],
      [
        { id: 'g', kind: 'assign_lead', actorId: SAM, reassign: false },
        'Assign the lead to Sam (if no one owns it)',
      ],
      [{ id: 'h', kind: 'assign_lead', actorId: SAM, reassign: true }, 'Assign the lead to Sam'],
      [
        { id: 'i', kind: 'update_lead', change: { kind: 'stage', stage: 'verified' } },
        'Move the lead to Verified',
      ],
      [
        {
          id: 'j',
          kind: 'update_lead',
          change: { kind: 'property', key: 'custom_size', value: 'large' },
        },
        'Set Size to Large',
      ],
      [
        { id: 'k', kind: 'notify_staff', toAssignee: true, actorIds: [SAM], note: '' },
        "Email Sam and the lead's owner",
      ],
    ];
    for (const [step, words] of steps) expect(describeStep(step, names)).toBe(words);
  });
});

describe('reasons, runs and chips', () => {
  it('has words for every reason', () => {
    for (const reason of AUTOMATION_REASONS) {
      expect(reasonText(reason, null), reason).toMatch(/^[a-z]/);
      expect(reasonText(reason, null)).not.toContain(reason);
    }
    expect(reasonText('stage_unavailable', 'paid')).toBe(
      'names a stage that no longer exists (paid)',
    );
    expect(reasonText('flow_switched_off', null)).toBe('the flow was switched off');
  });

  it('words each run status', () => {
    const base: FlowRun = {
      id: '50000000-0000-4000-8000-000000000001',
      leadId: '30000000-0000-4000-8000-000000000001',
      leadName: null,
      status: 'completed',
      reason: null,
      detail: null,
      triggerKind: 'stage_entered',
      version: 1,
      startedAt: '2026-11-01T12:00:00.000Z',
      finishedAt: null,
      resumeAt: null,
      legacy: false,
      steps: [],
    };
    expect(runStatusText(base)).toBe('Completed');
    expect(
      runStatusText({ ...base, status: 'waiting', resumeAt: '2026-11-03T19:00:00.000Z' }),
    ).toBe('Waiting until 3 Nov 14:00');
    expect(runStatusText({ ...base, status: 'skipped', reason: 'no_sender' })).toBe(
      'Skipped: the site has no sender yet',
    );
    expect(
      runStatusText({ ...base, status: 'failed', reason: 'step_failed', detail: 's_mail' }),
    ).toBe('Failed: a step failed (s_mail)');
    expect(runStatusText({ ...base, status: 'cancelled', reason: 'flow_switched_off' })).toBe(
      'Cancelled: the flow was switched off',
    );
  });

  it('puts needs attention before not activated before draft changes', () => {
    const flow: FlowSummary = {
      key: 'flow_abcdefghij012345',
      origin: 'custom',
      name: 'Mine',
      description: null,
      enabled: false,
      archived: false,
      trigger: null,
      activeVersion: 1,
      hasDraft: true,
      lastRunAt: null,
      runCount: 0,
      needsAttention: { path: 'trigger.stage', code: 'stage_unavailable', ref: 'paid' },
    };
    expect(flowStatusChip(flow)).toEqual({
      label: 'Needs attention: names a stage that no longer exists (paid)',
      tone: 'warning',
    });
    expect(
      flowStatusChip({
        ...flow,
        needsAttention: { path: 'definition', code: 'definition_invalid', ref: 'definition' },
      })?.label,
    ).toBe('Needs attention: the flow can no longer be read');
    expect(flowStatusChip({ ...flow, needsAttention: null, activeVersion: null })).toEqual({
      label: 'Not activated',
      tone: 'neutral',
    });
    expect(flowStatusChip({ ...flow, needsAttention: null })).toEqual({
      label: 'Draft changes',
      tone: 'neutral',
    });
    expect(flowStatusChip({ ...flow, needsAttention: null, hasDraft: false })).toBeNull();
  });
});
