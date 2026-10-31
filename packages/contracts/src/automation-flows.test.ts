import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  AUTOMATION_KEY_SHAPE,
  AUTOMATION_REASONS,
  AUTOMATION_REASON_SHAPE,
  BUILT_IN_AUTOMATIONS,
  BUILT_IN_AUTOMATION_KEYS,
  CUSTOM_FLOW_KEY_PATTERN,
  buildPropertyCatalog,
  builtInFlowDefinition,
  builtInFlowName,
  checkFlowAgainstSite,
  durationMs,
  flowDefinitionBytes,
  flowDefinitionSchema,
  flowDefinitionSchemaFor,
  flowDraftSchema,
  flowHasLeadChangingStep,
  generateFlowKey,
  isBuiltInAutomationKey,
  overlappingEmailFlows,
  parseTextVariables,
  timerDueAt,
  triggerLeadTypes,
  triggerMatchesEvent,
  walkSteps,
  type ConditionGroup,
  type FlowDefinition,
  type FlowForOverlap,
  type FlowSite,
  type FlowStep,
  type PropertyRow,
} from './index';

const MEMBER = '28000000-0000-4000-8000-000000008101';
const OTHER_MEMBER = '28000000-0000-4000-8000-000000008102';
const PLAN = '48000000-0000-4000-8000-000000008101';
const MOBILITY_PLAN = '48000000-0000-4000-8000-000000008102';
const SITE_TEMPLATE = 'tpl_abcdefghij012345';

const fullCustomFlow: FlowDefinition = {
  schemaVersion: 1,
  trigger: {
    kind: 'stage_entered',
    leadType: 'sim_order',
    stage: 'verified',
    when: {
      match: 'all',
      items: [
        { kind: 'plan', op: 'in', planIds: [PLAN] },
        {
          match: 'any',
          items: [
            { kind: 'assignee', op: 'none' },
            { kind: 'property', filter: { key: 'delivery', op: 'eq', value: 'esim' } },
          ],
        },
      ],
    },
  },
  steps: [
    {
      id: 's_task0001',
      kind: 'create_task',
      title: 'Call {first name} about {plan}',
      dueInDays: 1,
      assignee: { kind: 'lead_assignee' },
    },
    { id: 's_assign01', kind: 'assign_lead', actorId: MEMBER, reassign: false },
    {
      id: 's_branch01',
      kind: 'if_else',
      condition: { match: 'all', items: [{ kind: 'stage', op: 'in', stages: ['verified'] }] },
      then: [
        { id: 's_wait0001', kind: 'wait', for: { amount: 2, unit: 'days' } },
        { id: 's_mail0001', kind: 'send_email', template: 'dispatched' },
      ],
      else: [
        { id: 's_move0001', kind: 'update_lead', change: { kind: 'stage', stage: 'on_hold' } },
        {
          id: 's_notify01',
          kind: 'notify_staff',
          toAssignee: true,
          actorIds: [OTHER_MEMBER],
          note: 'Look at this one',
        },
      ],
    },
  ],
};

const flowWith = (steps: unknown[], trigger: unknown = fullCustomFlow.trigger) => ({
  schemaVersion: 1,
  trigger,
  steps,
});

const mail = (id: string) => ({ id, kind: 'send_email', template: 'dispatched' });
const wait = (id: string, amount: number, unit: 'hours' | 'days') => ({
  id,
  kind: 'wait',
  for: { amount, unit },
});
const branch = (id: string, then: unknown[], otherwise: unknown[] = []) => ({
  id,
  kind: 'if_else',
  condition: { match: 'all', items: [{ kind: 'assignee', op: 'any' }] },
  then,
  else: otherwise,
});

/** The issue codes (messages) of a refusal, or [] when it parses. */
function refusal(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('flow keys', () => {
  it('generateFlowKey matches the custom pattern and the key shape', () => {
    for (let index = 0; index < 100; index += 1) {
      const key = generateFlowKey();
      expect(key).toMatch(CUSTOM_FLOW_KEY_PATTERN);
      expect(key).toMatch(AUTOMATION_KEY_SHAPE);
      expect(isBuiltInAutomationKey(key)).toBe(false);
    }
    for (const key of BUILT_IN_AUTOMATION_KEYS) {
      expect(key).toMatch(AUTOMATION_KEY_SHAPE);
      expect(isBuiltInAutomationKey(key)).toBe(true);
    }
  });

  it('every reason matches the reason shape', () => {
    for (const reason of AUTOMATION_REASONS) expect(reason).toMatch(AUTOMATION_REASON_SHAPE);
    expect(new Set(AUTOMATION_REASONS).size).toBe(AUTOMATION_REASONS.length);
  });
});

describe('the built-in defaults', () => {
  it('each built-in default parses and keeps phase 4’s trigger and template', () => {
    BUILT_IN_AUTOMATION_KEYS.forEach((key, index) => {
      const definition = builtInFlowDefinition(key);
      const rule = BUILT_IN_AUTOMATIONS[index];
      expect(rule?.key).toBe(key);
      expect(flowDefinitionSchemaFor('builtin').parse(definition)).toEqual(definition);
      expect(definition.trigger).toEqual({ ...rule?.trigger, when: null });
      expect(definition.steps).toEqual([
        { id: 'main', kind: 'send_email', template: rule?.action.template },
      ]);
      expect(builtInFlowName(key)).toBe(rule?.label);
    });
  });

  it('the step main is a built-in’s only', () => {
    const definition = builtInFlowDefinition('sim_order_dispatched');
    expect(refusal(flowDefinitionSchemaFor('custom'), definition).length).toBeGreaterThan(0);
    expect(refusal(flowDefinitionSchema, definition).length).toBeGreaterThan(0);
  });
});

describe('the flow definition schema', () => {
  it('a full custom flow round-trips', () => {
    expect(flowDefinitionSchema.parse(fullCustomFlow)).toEqual(fullCustomFlow);
    expect(flowDraftSchema.parse(fullCustomFlow)).toEqual(fullCustomFlow);
  });

  it('the draft takes nulls the definition refuses', () => {
    const empty = { schemaVersion: 1, trigger: null, steps: [] };
    expect(flowDraftSchema.parse(empty)).toEqual(empty);
    expect(flowDefinitionSchema.safeParse(empty).success).toBe(false);

    const unset = flowWith([{ id: 's_mail0001', kind: 'send_email', template: null }]);
    expect(flowDraftSchema.safeParse(unset).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(unset).success).toBe(false);

    const noStage = flowWith([mail('s_mail0001')], {
      kind: 'stage_entered',
      leadType: 'sim_order',
      stage: null,
      when: null,
    });
    expect(flowDraftSchema.safeParse(noStage).success).toBe(true);
    expect(flowDefinitionSchema.safeParse(noStage).success).toBe(false);
  });

  describe('refuses', () => {
    it('a duplicate step id', () => {
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_a'), mail('s_a')]))).not.toEqual([]);
    });

    it('main in a custom flow', () => {
      expect(refusal(flowDefinitionSchema, flowWith([mail('main')]))).not.toEqual([]);
      expect(refusal(flowDefinitionSchemaFor('builtin'), flowWith([mail('main')]))).toEqual([]);
    });

    it('a step after an if_else', () => {
      expect(
        refusal(flowDefinitionSchema, flowWith([branch('s_b', [mail('s_m')]), mail('s_n')])),
      ).not.toEqual([]);
    });

    it('a stage of another type', () => {
      const trigger = { kind: 'stage_entered', leadType: 'sim_order', stage: 'won', when: null };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger))).toContain(
        'stage_unavailable',
      );
      const update = flowWith([
        { id: 's_u', kind: 'update_lead', change: { kind: 'stage', stage: 'installed' } },
      ]);
      expect(refusal(flowDefinitionSchema, update)).toContain('stage_unavailable');
      const condition = flowWith([mail('s_m')], {
        kind: 'lead_submitted',
        leadTypes: ['sim_order'],
        when: { match: 'all', items: [{ kind: 'stage', op: 'in', stages: ['qualified'] }] },
      });
      expect(refusal(flowDefinitionSchema, condition)).toContain('stage_unavailable');
    });

    it('stage_entered on incomplete', () => {
      const trigger = {
        kind: 'stage_entered',
        leadType: 'sim_order',
        stage: 'incomplete',
        when: null,
      };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger))).toContain(
        'stage_unavailable',
      );
      const time = { ...trigger, kind: 'time_in_stage', after: { amount: 1, unit: 'days' } };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], time))).toContain(
        'stage_unavailable',
      );
    });

    it('a plan condition on contact_message', () => {
      const trigger = {
        kind: 'lead_submitted',
        leadTypes: ['contact_message'],
        when: { match: 'all', items: [{ kind: 'plan', op: 'in', planIds: [PLAN] }] },
      };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger))).toContain(
        'plan_unavailable',
      );
    });

    it('assignee none with an actor', () => {
      const trigger = {
        kind: 'lead_submitted',
        leadTypes: ['sim_order'],
        when: { match: 'all', items: [{ kind: 'assignee', op: 'none', actorId: MEMBER }] },
      };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger))).not.toEqual([]);
    });

    it('the tracking code mail', () => {
      const flow = flowWith([{ id: 's_m', kind: 'send_email', template: 'tracking_code' }]);
      expect(refusal(flowDefinitionSchema, flow)).toContain('template_unavailable');
      expect(refusal(flowDraftSchema, flow)).toContain('template_unavailable');
    });

    it('31 steps', () => {
      const thirty = Array.from({ length: 30 }, (_, index) => mail(`s_${index}`));
      expect(refusal(flowDefinitionSchema, flowWith(thirty))).toEqual([]);
      const nested = [...thirty.slice(0, 28), branch('s_b', [mail('s_x'), mail('s_y')])];
      expect(refusal(flowDefinitionSchema, flowWith(nested))).not.toEqual([]);
      expect(refusal(flowDefinitionSchema, flowWith([...thirty, mail('s_30')]))).not.toEqual([]);
    });

    it('branch depth 4', () => {
      const three = branch('s_1', [branch('s_2', [branch('s_3', [mail('s_m')])])]);
      expect(refusal(flowDefinitionSchema, flowWith([three]))).toEqual([]);
      const four = branch('s_1', [branch('s_2', [branch('s_3', [branch('s_4', [])])])]);
      expect(refusal(flowDefinitionSchema, flowWith([four]))).not.toEqual([]);
    });

    it('6 waits', () => {
      const five = Array.from({ length: 5 }, (_, index) => wait(`s_${index}`, 1, 'hours'));
      expect(refusal(flowDefinitionSchema, flowWith([...five, mail('s_m')]))).toEqual([]);
      expect(
        refusal(flowDefinitionSchema, flowWith([...five, wait('s_5', 1, 'hours')])),
      ).not.toEqual([]);
    });

    it('a 61-day wait', () => {
      expect(refusal(flowDefinitionSchema, flowWith([wait('s_w', 60, 'days')]))).toEqual([]);
      expect(refusal(flowDefinitionSchema, flowWith([wait('s_w', 61, 'days')]))).not.toEqual([]);
    });

    it('two 50-day waits on one path, but not in two branches', () => {
      expect(
        refusal(flowDefinitionSchema, flowWith([wait('s_1', 50, 'days'), wait('s_2', 50, 'days')])),
      ).not.toEqual([]);
      expect(
        refusal(
          flowDefinitionSchema,
          flowWith([wait('s_1', 40, 'days'), branch('s_b', [wait('s_2', 51, 'days')])]),
        ),
      ).not.toEqual([]);
      expect(
        refusal(
          flowDefinitionSchema,
          flowWith([branch('s_b', [wait('s_1', 50, 'days')], [wait('s_2', 50, 'days')])]),
        ),
      ).toEqual([]);
    });

    it('721 hours', () => {
      expect(refusal(flowDefinitionSchema, flowWith([wait('s_w', 720, 'hours')]))).toEqual([]);
      expect(refusal(flowDefinitionSchema, flowWith([wait('s_w', 721, 'hours')]))).not.toEqual([]);
      const trigger = (amount: number, unit: string) => ({
        kind: 'after_submitted',
        leadTypes: ['sim_order'],
        after: { amount, unit },
        when: null,
      });
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger(90, 'days')))).toEqual(
        [],
      );
      expect(
        refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger(91, 'days'))),
      ).not.toEqual([]);
      expect(
        refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger(721, 'hours'))),
      ).not.toEqual([]);
    });

    it('a group of 11', () => {
      const items = Array.from({ length: 11 }, () => ({ kind: 'assignee', op: 'any' }));
      const trigger = {
        kind: 'lead_submitted',
        leadTypes: ['sim_order'],
        when: { match: 'all', items },
      };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger))).not.toEqual([]);
    });

    it('a third group level', () => {
      const leaf = { kind: 'assignee', op: 'any' };
      const when = {
        match: 'all',
        items: [{ match: 'any', items: [{ match: 'all', items: [leaf] }] }],
      };
      const trigger = { kind: 'lead_submitted', leadTypes: ['sim_order'], when };
      expect(refusal(flowDefinitionSchema, flowWith([mail('s_m')], trigger))).not.toEqual([]);
    });

    it('31 conditions', () => {
      const group = (count: number) => ({
        match: 'all',
        items: Array.from({ length: count }, () => ({ kind: 'assignee', op: 'any' })),
      });
      const trigger = (when: unknown) => ({
        kind: 'lead_submitted',
        leadTypes: ['sim_order'],
        when,
      });
      const thirty = flowWith(
        [{ ...branch('s_b', [mail('s_m')]), condition: group(10) }],
        trigger({ match: 'all', items: [group(10), group(10)] }),
      );
      expect(refusal(flowDefinitionSchema, thirty)).toEqual([]);
      const more = flowWith(
        [{ ...branch('s_b', [mail('s_m')]), condition: group(10) }],
        trigger({ match: 'all', items: [group(10), group(10), { kind: 'assignee', op: 'any' }] }),
      );
      expect(refusal(flowDefinitionSchema, more)).not.toEqual([]);
    });

    it('a name in the definition (names are API)', () => {
      expect(
        refusal(flowDefinitionSchema, { ...flowWith([mail('s_m')]), name: 'x'.repeat(81) }),
      ).not.toEqual([]);
      expect(
        refusal(flowDefinitionSchema, { ...flowWith([mail('s_m')]), name: 'Short' }),
      ).not.toEqual([]);
    });

    it('a 65 537-byte definition', () => {
      const sized = (bytes: number): unknown => {
        const strings = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 'x'));
        const build = () =>
          flowWith([mail('s_m')], {
            kind: 'lead_submitted',
            leadTypes: ['sim_order'],
            when: {
              match: 'all',
              items: [0, 1].map((group) => ({
                match: 'all',
                items: strings.slice(group * 10, group * 10 + 10).map((value) => ({
                  kind: 'property',
                  filter: { key: 'custom_note', op: 'in', value },
                })),
              })),
            },
          });
        let remaining = bytes - flowDefinitionBytes(build());
        for (const list of strings) {
          list.forEach((_, index) => {
            const add = Math.min(199, remaining);
            list[index] = 'x'.repeat(1 + add);
            remaining -= add;
          });
        }
        return build();
      };
      const fits = sized(65_536);
      const over = sized(65_537);
      expect(flowDefinitionBytes(fits)).toBe(65_536);
      expect(flowDefinitionBytes(over)).toBe(65_537);
      expect(refusal(flowDefinitionSchema, fits)).toEqual([]);
      expect(refusal(flowDefinitionSchema, over)).not.toEqual([]);
    });

    it('{frist name} in a task title', () => {
      const task = {
        id: 's_t',
        kind: 'create_task',
        title: 'Call {frist name}',
        dueInDays: null,
        assignee: { kind: 'none' },
      };
      expect(refusal(flowDefinitionSchema, flowWith([task]))).toContain('invalid_variable');
      expect(refusal(flowDraftSchema, flowWith([task]))).toContain('invalid_variable');
      const ok = { ...task, title: 'Call { First  Name } on {prop:custom_size}' };
      expect(refusal(flowDefinitionSchema, flowWith([ok]))).toEqual([]);
    });

    it('a notification with no recipient, but not in a draft', () => {
      const notify = { id: 's_n', kind: 'notify_staff', toAssignee: false, actorIds: [], note: '' };
      expect(refusal(flowDefinitionSchema, flowWith([notify]))).not.toEqual([]);
      expect(refusal(flowDraftSchema, flowWith([notify]))).toEqual([]);
    });
  });
});

describe('variables', () => {
  it('parseTextVariables normalizes names and refuses the first unknown one', () => {
    expect(
      parseTextVariables('Hi { First  Name }, {sim number} and {prop:custom_size}', [
        'first name',
        'SIM number',
        'prop:*',
      ]),
    ).toEqual({ ok: true, names: ['first name', 'SIM number', 'prop:custom_size'] });
    expect(parseTextVariables('{frist name} {nope}', ['first name'])).toEqual({
      ok: false,
      name: 'frist name',
    });
    expect(parseTextVariables('{prop:custom_size}', ['first name'])).toEqual({
      ok: false,
      name: 'prop:custom_size',
    });
    expect(parseTextVariables('{prop:Bad Key}', ['prop:*'])).toEqual({
      ok: false,
      name: 'prop:Bad Key',
    });
    expect(parseTextVariables('no braces { here', ['first name'])).toEqual({ ok: true, names: [] });
  });
});

describe('checkFlowAgainstSite', () => {
  const rows: PropertyRow[] = [
    customRow('custom_size', 1, { kind: 'choice' }),
    customRow('custom_secret', 2, { sensitive: true }),
    customRow('custom_staff', 3, { staffOnly: true }),
    customRow('custom_hidden', 4, { hidden: true }),
  ];
  const site = (overrides: Partial<FlowSite> = {}): FlowSite => ({
    templates: new Map([
      ['dispatched', { archived: false, propertyKeys: [] }],
      ['on_hold_note', { archived: false, propertyKeys: [] }],
      [SITE_TEMPLATE, { archived: false, propertyKeys: ['custom_size'] }],
    ]),
    memberIds: new Set([MEMBER, OTHER_MEMBER]),
    plans: new Map([
      [PLAN, { leadType: 'sim_order' }],
      [MOBILITY_PLAN, { leadType: 'mobility' }],
    ]),
    catalog: buildPropertyCatalog(rows),
    ...overrides,
  });

  it('a clean site has no issue', () => {
    expect(checkFlowAgainstSite(fullCustomFlow, site())).toEqual([]);
    for (const key of BUILT_IN_AUTOMATION_KEYS) {
      const templates = new Map(
        BUILT_IN_AUTOMATIONS.map((rule) => [
          rule.action.template,
          { archived: false, propertyKeys: [] },
        ]),
      );
      expect(checkFlowAgainstSite(builtInFlowDefinition(key), site({ templates }))).toEqual([]);
    }
  });

  it('reports each issue with its key', () => {
    const definition = (steps: FlowStep[], when: ConditionGroup | null = null): FlowDefinition => ({
      schemaVersion: 1,
      trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when },
      steps,
    });
    const check = (value: FlowDefinition) =>
      checkFlowAgainstSite(flowDefinitionSchema.parse(value), site());

    expect(
      check(definition([{ id: 's_m', kind: 'send_email', template: 'tpl_zzzzzzzzzzzzzzzz' }])),
    ).toEqual([
      { path: 'steps.0.template', code: 'template_unavailable', ref: 'tpl_zzzzzzzzzzzzzzzz' },
    ]);
    expect(
      checkFlowAgainstSite(
        definition([{ id: 's_m', kind: 'send_email', template: SITE_TEMPLATE }]),
        site({
          templates: new Map([[SITE_TEMPLATE, { archived: true, propertyKeys: [] }]]),
        }),
      ),
    ).toEqual([{ path: 'steps.0.template', code: 'template_unavailable', ref: SITE_TEMPLATE }]);
    expect(
      checkFlowAgainstSite(
        definition([{ id: 's_m', kind: 'send_email', template: SITE_TEMPLATE }]),
        site({
          templates: new Map([
            [SITE_TEMPLATE, { archived: false, propertyKeys: ['custom_staff', 'custom_size'] }],
          ]),
        }),
      ),
    ).toEqual([{ path: 'steps.0.template', code: 'property_unavailable', ref: 'custom_staff' }]);

    expect(
      check(
        definition([mailStep()], {
          match: 'all',
          items: [{ kind: 'property', filter: { key: 'custom_secret', op: 'notEmpty' } }],
        }),
      ),
    ).toEqual([
      { path: 'trigger.when.items.0', code: 'property_unavailable', ref: 'custom_secret' },
    ]);
    expect(
      check(
        definition([
          {
            id: 's_t',
            kind: 'create_task',
            title: 'Size {prop:custom_size}, secret {prop:custom_secret}',
            dueInDays: null,
            assignee: { kind: 'none' },
          },
        ]),
      ),
    ).toEqual([{ path: 'steps.0.title', code: 'property_unavailable', ref: 'custom_secret' }]);
    expect(
      check(
        definition([
          {
            id: 's_u',
            kind: 'update_lead',
            change: { kind: 'property', key: 'custom_hidden', value: 'x' },
          },
        ]),
      ),
    ).toEqual([{ path: 'steps.0.change', code: 'property_unavailable', ref: 'custom_hidden' }]);

    expect(
      check(
        definition([mailStep()], {
          match: 'all',
          items: [{ kind: 'plan', op: 'not_in', planIds: [MOBILITY_PLAN] }],
        }),
      ),
    ).toEqual([{ path: 'trigger.when.items.0', code: 'plan_unavailable', ref: MOBILITY_PLAN }]);

    const gone = '28000000-0000-4000-8000-000000008199';
    expect(
      check(
        definition([
          { id: 's_a', kind: 'assign_lead', actorId: gone, reassign: true },
          {
            id: 's_t',
            kind: 'create_task',
            title: 'Follow up',
            dueInDays: 0,
            assignee: { kind: 'member', actorId: gone },
          },
          { id: 's_n', kind: 'notify_staff', toAssignee: false, actorIds: [gone], note: '' },
        ]),
      ),
    ).toEqual([
      { path: 'steps.0.actorId', code: 'member_unavailable', ref: gone },
      { path: 'steps.1.assignee', code: 'member_unavailable', ref: gone },
      { path: 'steps.2.actorIds.0', code: 'member_unavailable', ref: gone },
    ]);

    // A stage no type lists (removed from the catalogue) is a site issue, not a structure error.
    expect(
      check({
        schemaVersion: 1,
        trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'paid', when: null },
        steps: [mailStep()],
      }),
    ).toEqual([{ path: 'trigger.stage', code: 'stage_unavailable', ref: 'paid' }]);
    expect(
      check({
        schemaVersion: 1,
        trigger: { kind: 'lead_submitted', leadTypes: ['quote_request'], when: null },
        steps: [mailStep()],
      }),
    ).toEqual([
      { path: 'trigger.leadTypes.0', code: 'lead_type_unavailable', ref: 'quote_request' },
    ]);
  });

  it('checks a draft, skipping what is not set yet', () => {
    const draft = flowDraftSchema.parse({
      schemaVersion: 1,
      trigger: null,
      steps: [
        { id: 's_m', kind: 'send_email', template: null },
        {
          id: 's_a',
          kind: 'assign_lead',
          actorId: '28000000-0000-4000-8000-000000008199',
          reassign: false,
        },
      ],
    });
    expect(checkFlowAgainstSite(draft, site())).toEqual([
      {
        path: 'steps.1.actorId',
        code: 'member_unavailable',
        ref: '28000000-0000-4000-8000-000000008199',
      },
    ]);
  });
});

describe('overlappingEmailFlows', () => {
  const custom = (
    key: string,
    name: string,
    definition: FlowDefinition | null,
    enabled = true,
  ): FlowForOverlap => ({ key, name, enabled, definition });
  const dispatched: FlowForOverlap = {
    key: 'sim_order_dispatched',
    name: 'Dispatched email',
    enabled: true,
    definition: builtInFlowDefinition('sim_order_dispatched'),
  };
  const onDelivered = (steps: FlowStep[]): FlowDefinition => ({
    schemaVersion: 1,
    trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered', when: null },
    steps,
  });

  it('warns once per event, naming both', () => {
    const mine = custom('flow_aaaaaaaaaaaaaaaa', 'My dispatch note', onDelivered([mailStep()]));
    expect(overlappingEmailFlows([dispatched, mine])).toEqual([
      {
        event: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered' },
        flows: [
          { key: 'sim_order_dispatched', name: 'Dispatched email' },
          { key: 'flow_aaaaaaaaaaaaaaaa', name: 'My dispatch note' },
        ],
        message:
          'Customers get 2 emails when a SIM order moves to Delivered: Dispatched email, My dispatch note.',
      },
    ]);
  });

  it('a flow that is off, or mails only after a wait, does not count', () => {
    const off = custom('flow_aaaaaaaaaaaaaaaa', 'Off', onDelivered([mailStep()]), false);
    expect(overlappingEmailFlows([dispatched, off])).toEqual([]);
    const later = custom(
      'flow_bbbbbbbbbbbbbbbb',
      'Later',
      onDelivered([{ id: 's_w', kind: 'wait', for: { amount: 1, unit: 'days' } }, mailStep()]),
    );
    expect(overlappingEmailFlows([dispatched, later])).toEqual([]);
    const inBranch = custom(
      'flow_cccccccccccccccc',
      'Branch',
      onDelivered([
        {
          id: 's_b',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'assignee', op: 'any' }] },
          then: [],
          else: [mailStep()],
        },
      ]),
    );
    expect(overlappingEmailFlows([dispatched, inBranch])).toHaveLength(1);
    expect(
      overlappingEmailFlows([dispatched, custom('flow_dddddddddddddddd', 'None', null)]),
    ).toEqual([]);
  });

  it('a submission counts as entering its submitted stage', () => {
    const submitted = custom('flow_aaaaaaaaaaaaaaaa', 'Thanks', {
      schemaVersion: 1,
      trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'], when: null },
      steps: [mailStep()],
    });
    const pending = custom('flow_bbbbbbbbbbbbbbbb', 'Pending note', {
      schemaVersion: 1,
      trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'pending', when: null },
      steps: [mailStep()],
    });
    expect(overlappingEmailFlows([submitted, pending])).toEqual([
      {
        event: { kind: 'lead_submitted', leadType: 'sim_order' },
        flows: [
          { key: 'flow_aaaaaaaaaaaaaaaa', name: 'Thanks' },
          { key: 'flow_bbbbbbbbbbbbbbbb', name: 'Pending note' },
        ],
        message: 'Customers get 2 emails when a SIM order is submitted: Thanks, Pending note.',
      },
    ]);
    const received: FlowForOverlap = {
      key: 'order_received',
      name: 'Order received',
      enabled: true,
      definition: builtInFlowDefinition('order_received'),
    };
    expect(overlappingEmailFlows([received, submitted]).map((w) => w.event)).toEqual([
      { kind: 'lead_submitted', leadType: 'sim_order' },
    ]);
  });
});

describe('timers', () => {
  it('timerDueAt', () => {
    expect(
      timerDueAt(
        {
          kind: 'time_in_stage',
          leadType: 'sim_order',
          stage: 'pending',
          after: { amount: 3, unit: 'days' },
          when: null,
        },
        { eventAt: new Date('2026-11-02T15:00:00Z') },
      )?.toISOString(),
    ).toBe('2026-11-05T15:00:00.000Z');
    const overdue = (after: { amount: number; unit: 'hours' | 'days' } | null) => ({
      kind: 'task_overdue' as const,
      leadTypes: [],
      after,
      when: null,
    });
    const eventAt = new Date('2026-11-03T12:00:00Z');
    expect(timerDueAt(overdue(null), { eventAt, dueDay: '2026-11-03' })?.toISOString()).toBe(
      '2026-11-04T05:00:00.000Z',
    );
    expect(
      timerDueAt(overdue({ amount: 2, unit: 'hours' }), {
        eventAt,
        dueDay: '2026-11-03',
      })?.toISOString(),
    ).toBe('2026-11-04T07:00:00.000Z');
    expect(timerDueAt(overdue(null), { eventAt, dueDay: '2026-03-08' })?.toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    expect(
      timerDueAt(
        { kind: 'stage_entered', leadType: 'sim_order', stage: 'pending', when: null },
        { eventAt },
      ),
    ).toBeNull();
    expect(durationMs({ amount: 2, unit: 'hours' })).toBe(7_200_000);
  });
});

describe('trigger and step helpers', () => {
  it('triggerMatchesEvent', () => {
    const dispatched = builtInFlowDefinition('sim_order_dispatched').trigger;
    expect(
      triggerMatchesEvent(dispatched, {
        kind: 'stage_entered',
        leadType: 'sim_order',
        stage: 'delivered',
      }),
    ).toBe(true);
    expect(
      triggerMatchesEvent(dispatched, {
        kind: 'stage_entered',
        leadType: 'sim_order',
        stage: 'verified',
      }),
    ).toBe(false);
    expect(
      triggerMatchesEvent(dispatched, {
        kind: 'lead_submitted',
        leadType: 'sim_order',
        stage: 'delivered',
      }),
    ).toBe(false);
    const received = builtInFlowDefinition('order_received').trigger;
    expect(
      triggerMatchesEvent(received, { kind: 'lead_submitted', leadType: 'mobility', stage: 'new' }),
    ).toBe(true);
    expect(
      triggerMatchesEvent(received, {
        kind: 'lead_submitted',
        leadType: 'contact_message',
        stage: 'new',
      }),
    ).toBe(false);
    expect(
      triggerMatchesEvent(
        {
          kind: 'after_submitted',
          leadTypes: ['sim_order'],
          after: { amount: 1, unit: 'days' },
          when: null,
        },
        { kind: 'lead_submitted', leadType: 'sim_order', stage: 'pending' },
      ),
    ).toBe(false);
  });

  it('triggerLeadTypes', () => {
    expect(triggerLeadTypes(builtInFlowDefinition('sim_order_dispatched').trigger)).toEqual([
      'sim_order',
    ]);
    expect(
      triggerLeadTypes({ kind: 'task_overdue', leadTypes: [], after: null, when: null }),
    ).toEqual(['internet', 'mobility', 'sim_order', 'partner_application', 'contact_message']);
  });

  it('flowHasLeadChangingStep', () => {
    expect(flowHasLeadChangingStep(builtInFlowDefinition('order_received').steps)).toBe(false);
    expect(flowHasLeadChangingStep(fullCustomFlow.steps)).toBe(true);
    expect(
      flowHasLeadChangingStep([
        {
          id: 's_b',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'assignee', op: 'any' }] },
          then: [],
          else: [{ id: 's_a', kind: 'assign_lead', actorId: MEMBER, reassign: false }],
        },
      ]),
    ).toBe(true);
    expect(
      flowHasLeadChangingStep([
        mailStep(),
        { id: 's_n', kind: 'notify_staff', toAssignee: true, actorIds: [], note: '' },
      ]),
    ).toBe(false);
  });

  it('walkSteps visits in pre-order with paths and depths', () => {
    const seen: string[] = [];
    walkSteps(fullCustomFlow.steps, (step, path, depth) =>
      seen.push(`${step.id}@${path}:${depth}`),
    );
    expect(seen).toEqual([
      's_task0001@steps.0:0',
      's_assign01@steps.1:0',
      's_branch01@steps.2:0',
      's_wait0001@steps.2.then.0:1',
      's_mail0001@steps.2.then.1:1',
      's_move0001@steps.2.else.0:1',
      's_notify01@steps.2.else.1:1',
    ]);
  });
});

function mailStep(): FlowStep {
  return { id: 's_mail0001', kind: 'send_email', template: 'dispatched' };
}

function customRow(
  key: string,
  position: number,
  overrides: Partial<PropertyRow> = {},
): PropertyRow {
  return {
    key,
    object: 'lead',
    origin: 'custom',
    label: key,
    kind: 'text',
    options: [],
    sensitive: false,
    staffOnly: false,
    hidden: false,
    websiteVisible: false,
    leadTypes: [],
    position,
    version: 1,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...overrides,
    ...(overrides.kind === 'choice'
      ? { options: [{ value: 'small', label: 'Small', hidden: false }] }
      : {}),
  };
}
