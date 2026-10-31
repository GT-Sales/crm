import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  activateFlowRequestSchema,
  builtInFlowDefinition,
  createFlowRequestSchema,
  flowCatalogResponseSchema,
  flowDetailResponseSchema,
  flowListQuerySchema,
  flowListResponseSchema,
  flowRunResponseSchema,
  flowRunSchema,
  flowToggleResponseSchema,
  flowVersionResponseSchema,
  listFlowRunsQuerySchema,
  listFlowRunsResponseSchema,
  saveFlowDraftRequestSchema,
  toggleFlowRequestSchema,
  updateFlowDetailsRequestSchema,
  type FlowSummary,
} from './index';

const UUID = '00000000-0000-4000-8000-000000000001';
const AT = '2026-10-31T12:00:00.000Z';
const FLOW = 'flow_abcdefghij012345';

const summary = (key: string, origin: 'builtin' | 'custom' = 'custom'): FlowSummary => ({
  key,
  origin,
  name: origin === 'builtin' ? 'Dispatched email' : 'My flow',
  description: null,
  enabled: false,
  archived: false,
  trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered', when: null },
  activeVersion: 1,
  hasDraft: false,
  lastRunAt: null,
  runCount: 0,
  needsAttention: null,
});

const run = {
  id: UUID,
  leadId: UUID,
  leadName: null,
  status: 'completed',
  reason: null,
  detail: null,
  triggerKind: 'stage_entered',
  version: 1,
  startedAt: AT,
  finishedAt: AT,
  resumeAt: null,
  legacy: false,
  steps: [
    {
      stepId: 'main',
      stepKind: 'send_email',
      outcome: 'done',
      branch: null,
      reason: null,
      detail: null,
      at: AT,
    },
  ],
};

/** Parses `value` and expects it back unchanged. */
function roundTrips(schema: z.ZodType, value: unknown) {
  expect(schema.parse(value)).toEqual(value);
}

describe('flow API shapes', () => {
  it('every response round-trips a full example', () => {
    roundTrips(flowListResponseSchema, {
      automations: [
        summary('sim_order_dispatched', 'builtin'),
        {
          ...summary(FLOW),
          enabled: true,
          hasDraft: true,
          lastRunAt: AT,
          runCount: 3,
          needsAttention: { path: 'steps.0.template', code: 'template_unavailable', ref: 'tpl_x' },
        },
      ],
      warnings: [
        {
          event: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered' },
          flows: [
            { key: 'sim_order_dispatched', name: 'Dispatched email' },
            { key: FLOW, name: 'My flow' },
          ],
          message:
            'Customers get 2 emails when a SIM order moves to Delivered: Dispatched email, My flow.',
        },
      ],
      nextBefore: null,
      canManage: true,
      hasSender: false,
      limit: 50,
      requestId: UUID,
    });
    const builtIn = builtInFlowDefinition('sim_order_dispatched');
    roundTrips(flowDetailResponseSchema, {
      automation: summary('sim_order_dispatched', 'builtin'),
      revision: 2,
      draft: {
        version: 2,
        definition: builtIn,
        issues: [{ path: 'steps.0.template', code: 'template_unavailable', ref: 'dispatched' }],
      },
      active: { version: 1, definition: builtIn },
      versions: [
        { version: 2, status: 'draft', activatedAt: null, activatedBy: null },
        { version: 1, status: 'active', activatedAt: AT, activatedBy: null },
      ],
      canManage: false,
      requestId: UUID,
    });
    roundTrips(flowDetailResponseSchema, {
      automation: { ...summary(FLOW), trigger: null, activeVersion: null, hasDraft: true },
      revision: 0,
      draft: { version: 1, definition: { schemaVersion: 1, trigger: null, steps: [] }, issues: [] },
      active: null,
      versions: [{ version: 1, status: 'draft', activatedAt: null, activatedBy: null }],
      canManage: true,
      requestId: UUID,
    });
    roundTrips(flowToggleResponseSchema, { automation: summary(FLOW), requestId: UUID });
    roundTrips(flowVersionResponseSchema, {
      version: {
        version: 1,
        status: 'retired',
        activatedAt: AT,
        activatedBy: UUID,
        definition: { anything: 'as stored' },
      },
      requestId: UUID,
    });
    roundTrips(listFlowRunsResponseSchema, { runs: [run], nextBefore: UUID, requestId: UUID });
    roundTrips(flowRunResponseSchema, {
      run: {
        ...run,
        status: 'waiting',
        finishedAt: null,
        resumeAt: AT,
        steps: [
          { ...run.steps[0], stepId: 's_b', stepKind: 'if_else', branch: 'yes' },
          { ...run.steps[0], stepId: 's_w', stepKind: 'wait', outcome: 'waiting' },
        ],
      },
      requestId: UUID,
    });
    roundTrips(flowRunSchema, {
      ...run,
      status: 'skipped',
      reason: 'no_sender',
      triggerKind: null,
      version: null,
      legacy: true,
    });
    roundTrips(flowCatalogResponseSchema, {
      leadTypes: [
        { key: 'sim_order', label: 'SIM order', stages: [{ key: 'pending', label: 'Pending' }] },
      ],
      templates: [
        {
          key: 'dispatched',
          name: 'Dispatched',
          builtIn: true,
          archived: false,
          fillIns: ['first name', 'order number'],
        },
        {
          key: 'tpl_abcdefghij012345',
          name: 'My note',
          builtIn: false,
          archived: false,
          fillIns: ['first name', 'prop:custom_size'],
        },
      ],
      members: [{ actorId: UUID, displayName: null }],
      plans: [{ id: UUID, name: 'Basic', leadType: 'sim_order', active: true }],
      properties: [
        {
          key: 'custom_size',
          label: 'Size',
          kind: 'choice',
          options: [{ value: 'small', label: 'Small' }],
          leadTypes: ['sim_order'],
          condition: true,
          update: true,
          taskVariable: true,
          emailVariable: true,
        },
      ],
      taskVariables: ['first name', 'order number'],
      requestId: UUID,
    });
  });

  it('the list takes more than six flows', () => {
    const flows = [
      ...['order_received', 'sim_order_dispatched'].map((key) => summary(key, 'builtin')),
      ...Array.from({ length: 5 }, (_, index) => summary(`flow_abcdefghij01234${index}`)),
    ];
    expect(
      flowListResponseSchema.safeParse({
        automations: flows,
        nextBefore: null,
        warnings: [],
        canManage: true,
        hasSender: true,
        limit: 50,
        requestId: UUID,
      }).success,
    ).toBe(true);
    expect(flowListQuerySchema.parse({ archived: '1' })).toEqual({ archived: '1' });
    expect(flowListQuerySchema.safeParse({ archived: 'yes' }).success).toBe(false);
    // The archived list is paged by the key its last page ended with.
    expect(flowListQuerySchema.parse({ archived: '1', before: FLOW })).toEqual({
      archived: '1',
      before: FLOW,
    });
    expect(flowListQuerySchema.safeParse({ archived: '1', before: 'order_received' }).success).toBe(
      false,
    );
  });

  it('a detail serves a stored definition that no longer parses as null', () => {
    roundTrips(flowDetailResponseSchema, {
      automation: {
        ...summary(FLOW),
        trigger: null,
        activeVersion: 2,
        needsAttention: { path: 'definition', code: 'definition_invalid', ref: 'definition' },
      },
      revision: 4,
      draft: {
        version: 3,
        definition: null,
        issues: [{ path: 'definition', code: 'definition_invalid', ref: 'definition' }],
      },
      active: { version: 2, definition: null },
      versions: [],
      canManage: true,
      requestId: UUID,
    });
  });

  it('create trims and refuses an 81-character name and an extra key', () => {
    expect(createFlowRequestSchema.parse({ name: '  Follow up ', description: ' Why ' })).toEqual({
      name: 'Follow up',
      description: 'Why',
    });
    expect(createFlowRequestSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(createFlowRequestSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(createFlowRequestSchema.safeParse({ name: 'Ok', key: FLOW }).success).toBe(false);
    expect(
      updateFlowDetailsRequestSchema.parse({ expectedRevision: 0, description: null }),
    ).toEqual({ expectedRevision: 0, description: null });
    expect(toggleFlowRequestSchema.safeParse({ enabled: true, name: 'x' }).success).toBe(false);
    expect(activateFlowRequestSchema.safeParse({ expectedRevision: -1 }).success).toBe(false);
  });

  it('a draft save takes the empty draft and a built-in’s', () => {
    expect(
      saveFlowDraftRequestSchema.parse({
        expectedRevision: 3,
        definition: { schemaVersion: 1, trigger: null, steps: [] },
      }),
    ).toEqual({ expectedRevision: 3, definition: { schemaVersion: 1, trigger: null, steps: [] } });
    expect(
      saveFlowDraftRequestSchema.safeParse({
        expectedRevision: 3,
        definition: builtInFlowDefinition('order_received'),
      }).success,
    ).toBe(true);
    expect(
      saveFlowDraftRequestSchema.safeParse({
        expectedRevision: 3,
        definition: { schemaVersion: 2, trigger: null, steps: [] },
      }).success,
    ).toBe(false);
  });

  it('a run refuses an unknown reason and an unknown status', () => {
    expect(flowRunSchema.safeParse({ ...run, reason: 'because' }).success).toBe(false);
    expect(flowRunSchema.safeParse({ ...run, status: 'queued' }).success).toBe(false);
    expect(listFlowRunsQuerySchema.safeParse({ before: 'not-a-uuid' }).success).toBe(false);
  });
});
