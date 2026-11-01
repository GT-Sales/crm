import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_MAX_STEPS,
  EMPTY_FLOW_DRAFT,
  type FlowDefinition,
  type FlowDraft,
  type FlowDraftStep,
} from '@gt-sales/contracts';

import {
  ADD_BUTTON_SIZE,
  CARD_HEIGHT,
  CARD_WIDTH,
  layoutFlow,
  type FlowCanvasNode,
} from './layout-flow';

function boundingBox(node: FlowCanvasNode) {
  const isAdd = node.type === 'add_step';
  const width = isAdd ? ADD_BUTTON_SIZE : CARD_WIDTH;
  const height = isAdd ? ADD_BUTTON_SIZE : CARD_HEIGHT;
  return {
    id: node.id,
    left: node.position.x,
    right: node.position.x + width,
    top: node.position.y,
    bottom: node.position.y + height,
  };
}

function assertNoOverlaps(nodes: readonly FlowCanvasNode[]) {
  const boxes = nodes.map(boundingBox);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlapsX = a.left < b.right && a.right > b.left;
      const overlapsY = a.top < b.bottom && a.bottom > b.top;
      expect(overlapsX && overlapsY, `nodes ${a.id} and ${b.id} overlap`).toBe(false);
    }
  }
}

describe('layoutFlow', () => {
  it('lays out an empty draft with an incomplete trigger and one add button', () => {
    const result = layoutFlow(EMPTY_FLOW_DRAFT);
    expect(result.totalSteps).toBe(0);
    expect(result.nodes.map((node) => node.id)).toEqual(['trigger', 'add:steps.0']);
    expect(result.nodes[0]?.data).toMatchObject({
      kind: 'trigger',
      incomplete: true,
      summary: 'Choose when this flow runs',
    });
    expect(result.edges).toEqual([
      {
        id: 'edge:trigger->add:steps.0',
        source: 'trigger',
        target: 'add:steps.0',
        type: 'smoothstep',
      },
    ]);
    assertNoOverlaps(result.nodes);
  });

  it('lays out a linear sequence of steps top to bottom', () => {
    const flow: FlowDefinition = {
      schemaVersion: 1,
      trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'], when: null },
      steps: [
        { id: 's_wait', kind: 'wait', for: { amount: 2, unit: 'days' } },
        { id: 's_mail', kind: 'send_email', template: 'order_received' },
      ],
    };
    const result = layoutFlow(flow);
    expect(result.nodes.map((node) => node.id)).toEqual([
      'trigger',
      'add:steps.0',
      's_wait',
      'add:steps.1',
      's_mail',
      'add:steps.2',
    ]);
    for (let i = 1; i < result.nodes.length; i += 1) {
      expect(result.nodes[i]!.position.y).toBeGreaterThan(result.nodes[i - 1]!.position.y);
    }
    assertNoOverlaps(result.nodes);
  });

  it('splits if_else into left (Yes) and right (No) branches in pre-order, with no overlapping nodes up to depth 3', () => {
    const nested: FlowDraft = {
      schemaVersion: 1,
      trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when: null },
      steps: [
        {
          id: 'if_d1',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'lead_type', in: ['sim_order'] }] },
          then: [
            {
              id: 'if_d2',
              kind: 'if_else',
              condition: { match: 'all', items: [{ kind: 'lead_type', in: ['sim_order'] }] },
              then: [
                {
                  id: 'if_d3',
                  kind: 'if_else',
                  condition: { match: 'all', items: [{ kind: 'lead_type', in: ['sim_order'] }] },
                  then: [{ id: 's_deep_yes', kind: 'send_email', template: 'activated' }],
                  else: [{ id: 's_deep_no', kind: 'wait', for: { amount: 1, unit: 'days' } }],
                },
              ],
              else: [{ id: 's_d2_no', kind: 'send_email', template: 'dispatched' }],
            },
          ],
          else: [{ id: 's_d1_no', kind: 'send_email', template: 'cancelled' }],
        },
      ],
    };

    const result = layoutFlow(nested);
    assertNoOverlaps(result.nodes);

    const stepIds = result.nodes
      .filter((node) => node.type === 'if_else' || node.type === 'step')
      .map((node) => node.id);
    // Pre-order: then branch completely before else branch at every level
    expect(stepIds).toEqual([
      'if_d1',
      'if_d2',
      'if_d3',
      's_deep_yes',
      's_deep_no',
      's_d2_no',
      's_d1_no',
    ]);

    const deepYes = result.nodes.find((node) => node.id === 's_deep_yes')!;
    const deepNo = result.nodes.find((node) => node.id === 's_deep_no')!;
    expect(deepYes.position.x).toBeLessThan(deepNo.position.x);

    // Wrapping an existing depth-three subtree must also be refused.
    expect(result.nodes.find((node) => node.id === 'add:steps.0')?.data).toMatchObject({
      canAddIfElse: false,
    });
    expect(result.nodes.find((node) => node.id === 'add:steps.0.then.0')?.data).toMatchObject({
      canAddIfElse: false,
    });
    // At depth 3, nested add_step buttons disallow further if_else nesting
    const depth3Add = result.nodes.find((node) => node.id === 'add:steps.0.then.0.then.0.then.0')!;
    expect(depth3Add.data).toMatchObject({
      kind: 'add_step',
      depth: 3,
      canAddIfElse: false,
      branchLabel: 'Yes',
    });
  });

  it('maps issues to the exact card at fault and disables add buttons at 30 steps', () => {
    const thirtySteps: FlowDraftStep[] = Array.from({ length: AUTOMATION_MAX_STEPS }, (_, idx) => ({
      id: `s_${idx}`,
      kind: 'send_email',
      template: 'order_received',
    }));
    const draft: FlowDraft = {
      schemaVersion: 1,
      trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when: null },
      steps: thirtySteps,
    };
    const result = layoutFlow(draft, {
      issues: [
        { path: 'trigger.stage', code: 'stage_unavailable', ref: 'verified' },
        { path: 'steps.2.template', code: 'template_unavailable', ref: 'order_received' },
      ],
    });
    expect(result.totalSteps).toBe(AUTOMATION_MAX_STEPS);
    const trigger = result.nodes.find((node) => node.id === 'trigger')!;
    expect(trigger.data.kind === 'trigger' && trigger.data.issues).toHaveLength(1);
    const step2 = result.nodes.find((node) => node.id === 's_2')!;
    expect(step2.data.kind === 'step' && step2.data.issues).toHaveLength(1);
    const step0 = result.nodes.find((node) => node.id === 's_0')!;
    expect(step0.data.kind === 'step' && step0.data.issues).toHaveLength(0);

    for (const node of result.nodes) {
      if (node.data.kind === 'add_step') {
        expect(node.data.disabled).toBe(true);
      }
    }
  });

  it('omits add_step nodes in readOnly mode', () => {
    const flow: FlowDefinition = {
      schemaVersion: 1,
      trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'], when: null },
      steps: [{ id: 'main', kind: 'send_email', template: 'order_received' }],
    };
    const result = layoutFlow(flow, { readOnly: true });
    expect(result.nodes.map((node) => node.id)).toEqual(['trigger', 'main']);
  });
});
