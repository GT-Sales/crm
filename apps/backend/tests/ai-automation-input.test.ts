import { describe, it, expect } from 'vitest';
import { normalizeAutomationProposal, MemberChoiceError } from '../src/ai/automation-input.js';
const ME = '28000000-0000-4000-8000-000000009401';
const OTHER = '28000000-0000-4000-8000-000000009402';
const members = [
  { actorId: ME, displayName: 'Casey' },
  { actorId: OTHER, displayName: 'Alex' },
];
const proposal = (steps: unknown[]) => ({
  draft: {
    name: 'Assign my SIM orders',
    definition: { trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'] }, steps },
  },
});
describe('model automation proposal normalization', () => {
  it.each(['me', 'myself', 'current_user', 'Casey', ME])(
    'resolves %s without asking the user for IDs',
    (actorId) => {
      const result = normalizeAutomationProposal(
        proposal([{ kind: 'assign_lead', actorId }]),
        ME,
        members,
      );
      expect(result.draft.definition.steps[0]).toMatchObject({
        kind: 'assign_lead',
        actorId: ME,
        reassign: false,
      });
      expect(result.draft.definition.schemaVersion).toBe(1);
      expect(result.draft.definition.trigger?.when).toBeNull();
      expect(result.draft.definition.steps[0]?.id).toMatch(/^s_[a-z0-9]+$/);
    },
  );
  it('resolves named teammates and task/notification recipients against the active catalog', () => {
    const result = normalizeAutomationProposal(
      proposal([
        { kind: 'create_task', title: 'Call', assignee: { kind: 'member', actorId: 'me' } },
        { kind: 'notify_staff', actorIds: ['Alex'] },
      ]),
      ME,
      members,
    );
    expect(result.draft.definition.steps[0]).toMatchObject({
      assignee: { kind: 'member', actorId: ME },
    });
    expect(result.draft.definition.steps[1]).toMatchObject({
      actorIds: [OTHER],
      toAssignee: false,
    });
  });
  it('resolves assignee conditions by name in the trigger and in branches (AUTH-1)', () => {
    const result = normalizeAutomationProposal(
      {
        draft: {
          name: 'Tell me when Alex gets a verified order',
          definition: {
            trigger: {
              kind: 'stage_entered',
              leadType: 'sim_order',
              stage: 'verified',
              when: {
                match: 'all',
                items: [
                  { kind: 'assignee', op: 'is', actorId: 'Alex' },
                  { match: 'any', items: [{ kind: 'assignee', op: 'is', actorId: 'me' }] },
                ],
              },
            },
            steps: [
              {
                kind: 'if_else',
                condition: {
                  match: 'all',
                  items: [{ kind: 'assignee', op: 'is', actorId: 'Casey' }],
                },
                then: [{ kind: 'notify_staff', actorIds: ['me'] }],
                else: [],
              },
            ],
          },
        },
      },
      ME,
      members,
    );
    expect(result.draft.definition.trigger?.when).toEqual({
      match: 'all',
      items: [
        { kind: 'assignee', op: 'is', actorId: OTHER },
        { match: 'any', items: [{ kind: 'assignee', op: 'is', actorId: ME }] },
      ],
    });
    expect(result.draft.definition.steps[0]).toMatchObject({
      condition: { match: 'all', items: [{ kind: 'assignee', op: 'is', actorId: ME }] },
    });
  });
  it('asks for a choice when an assignee condition names nobody on the site', () => {
    expect(() =>
      normalizeAutomationProposal(
        {
          draft: {
            name: 'Unknown teammate',
            definition: {
              trigger: {
                kind: 'lead_submitted',
                leadTypes: ['sim_order'],
                when: { match: 'all', items: [{ kind: 'assignee', op: 'is', actorId: 'Sarah' }] },
              },
              steps: [{ kind: 'notify_staff', actorIds: ['me'] }],
            },
          },
        },
        ME,
        members,
      ),
    ).toThrow(MemberChoiceError);
  });
  it('matches member names as people read them (AUTH-10)', () => {
    const result = normalizeAutomationProposal(
      proposal([{ kind: 'assign_lead', actorId: '  ＡＬＥＸ ' }]),
      ME,
      [...members, { actorId: '28000000-0000-4000-8000-000000009403', displayName: 'José  Silva' }],
    );
    expect(result.draft.definition.steps[0]).toMatchObject({ actorId: OTHER });
    const jose = normalizeAutomationProposal(
      proposal([{ kind: 'assign_lead', actorId: 'jose\u0301 silva' }]),
      ME,
      [...members, { actorId: '28000000-0000-4000-8000-000000009403', displayName: 'José  Silva' }],
    );
    expect(jose.draft.definition.steps[0]).toMatchObject({
      actorId: '28000000-0000-4000-8000-000000009403',
    });
  });
  it('preserves existing step IDs and never defaults reassignment on', () => {
    const result = normalizeAutomationProposal(
      {
        ...proposal([{ id: 'existing_step', kind: 'assign_lead', actorId: 'me', reassign: true }]),
        target: { key: 'flow_abcdefghijklmnop', expectedRevision: 1, base: 'draft' },
      },
      ME,
      members,
    );
    expect(result.draft.definition.steps[0]).toMatchObject({ id: 'existing_step', reassign: true });
  });
  it('asks for names on ambiguous, inactive or unavailable recipients instead of substituting', () => {
    expect(() =>
      normalizeAutomationProposal(proposal([{ kind: 'assign_lead', actorId: 'Alex' }]), ME, [
        ...members,
        { actorId: '28000000-0000-4000-8000-000000009403', displayName: 'Alex' },
      ]),
    ).toThrow(MemberChoiceError);
    expect(() =>
      normalizeAutomationProposal(
        proposal([{ kind: 'assign_lead', actorId: 'Unknown' }]),
        ME,
        members,
      ),
    ).toThrow(MemberChoiceError);
    expect(() =>
      normalizeAutomationProposal(proposal([{ kind: 'assign_lead', actorId: 'me' }]), ME, [
        { actorId: OTHER, displayName: 'Alex' },
      ]),
    ).toThrow(MemberChoiceError);
  });
  it('replaces model-invented identifiers on new steps without changing action settings', () => {
    const result = normalizeAutomationProposal(
      proposal([
        { id: 'step-1', kind: 'assign_lead', actorId: 'me' },
        { id: 'step-1', kind: 'wait', for: { amount: 1, unit: 'days' } },
      ]),
      ME,
      members,
    );
    expect(new Set(result.draft.definition.steps.map((s) => s.id)).size).toBe(2);
    expect(result.draft.definition.steps.every((s) => /^s_[a-z0-9]+$/.test(s.id))).toBe(true);
  });
  it('still rejects unsupported actions, fields and limits at the business schema boundary', () => {
    expect(() =>
      normalizeAutomationProposal(
        proposal([{ kind: 'http_request', url: 'https://example.test' }]),
        ME,
        members,
      ),
    ).toThrow();
    expect(() =>
      normalizeAutomationProposal(
        proposal([{ kind: 'wait', for: { amount: 200, unit: 'days' } }]),
        ME,
        members,
      ),
    ).toThrow();
    expect(() =>
      normalizeAutomationProposal(
        proposal([{ kind: 'assign_lead', actorId: 'me', sql: 'select 1' }]),
        ME,
        members,
      ),
    ).toThrow();
  });
});
