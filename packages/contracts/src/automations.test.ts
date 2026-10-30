import { orderLeadTypes } from '@gt-sales/types';
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_AUTOMATIONS,
  BUILT_IN_AUTOMATION_KEYS,
  automationActionSchema,
  automationKeySchema,
  automationResponseSchema,
  automationRunSchema,
  automationSchema,
  automationTriggerSchema,
  automationsForMove,
  automationsForSubmit,
  automationsUsingTemplate,
  customerEmailTemplateSchema,
  isLeadStage,
  listAutomationRunsResponseSchema,
  listAutomationsResponseSchema,
  updateAutomationRequestSchema,
} from './index';

const keys = (automations: readonly { readonly key: string }[]) =>
  automations.map((automation) => automation.key);

describe('built-in automations', () => {
  it('are the six, in key order, each key once', () => {
    expect(BUILT_IN_AUTOMATIONS).toHaveLength(6);
    expect(keys(BUILT_IN_AUTOMATIONS)).toEqual([...BUILT_IN_AUTOMATION_KEYS]);
    expect(new Set(keys(BUILT_IN_AUTOMATIONS)).size).toBe(6);
    expect(automationKeySchema.safeParse('custom_x').success).toBe(false);
  });

  it('each send a known template on a trigger its type can fire', () => {
    for (const automation of BUILT_IN_AUTOMATIONS) {
      expect(customerEmailTemplateSchema.safeParse(automation.action.template).success).toBe(true);
      expect(automationTriggerSchema.safeParse(automation.trigger).success).toBe(true);
      expect(automationActionSchema.safeParse(automation.action).success).toBe(true);
      if (automation.trigger.kind === 'stage_entered') {
        expect(
          isLeadStage(automation.trigger.leadType, automation.trigger.stage),
          automation.key,
        ).toBe(true);
      }
    }
  });

  it('say what they do in the owner’s words', () => {
    const dispatched = BUILT_IN_AUTOMATIONS.find((a) => a.key === 'sim_order_dispatched');
    expect(dispatched?.label).toBe(
      'When a SIM order moves to Delivered → send the Dispatched email',
    );
    expect(BUILT_IN_AUTOMATIONS[0]?.label).toBe(
      'When an order is submitted on the website → send the Order received email',
    );
  });

  it('fire on the stage a move enters', () => {
    expect(keys(automationsForMove('sim_order', 'delivered'))).toEqual(['sim_order_dispatched']);
    expect(keys(automationsForMove('sim_order', 'on_hold'))).toEqual([
      'sim_order_information_needed',
    ]);
    expect(keys(automationsForMove('sim_order', 'cancelled'))).toEqual(['sim_order_cancelled']);
    expect(keys(automationsForMove('mobility', 'activated'))).toEqual(['mobility_activated']);
    expect(automationsForMove('sim_order', 'verified')).toEqual([]);
    expect(automationsForMove('contact_message', 'closed')).toEqual([]);
  });

  it('fire on a submitted order of any order type, nothing else', () => {
    for (const leadType of orderLeadTypes) {
      expect(keys(automationsForSubmit(leadType))).toEqual(['order_received']);
    }
    expect(keys(automationsForSubmit('internet'))).toEqual(['order_received']);
    expect(automationsForSubmit('contact_message')).toEqual([]);
  });

  it('name the rules that use a template', () => {
    expect(keys(automationsUsingTemplate('activated'))).toEqual([
      'sim_order_activated',
      'mobility_activated',
    ]);
    expect(automationsUsingTemplate('sim_number_ready')).toEqual([]);
  });

  it('refuse a trigger or action of an unknown shape', () => {
    expect(automationTriggerSchema.safeParse({ kind: 'stage_left', leadType: 'x' }).success).toBe(
      false,
    );
    expect(
      automationTriggerSchema.safeParse({ kind: 'stage_entered', leadType: 'sim_order' }).success,
    ).toBe(false);
    expect(
      automationActionSchema.safeParse({ kind: 'send_email', template: 'order_status' }).success,
    ).toBe(false);
  });
});

describe('automation API shapes', () => {
  const UUID = '00000000-0000-4000-8000-000000000001';
  const rule = (index: number) => {
    const builtIn = BUILT_IN_AUTOMATIONS[index];
    if (!builtIn) throw new Error('built-in automation missing');
    return {
      key: builtIn.key,
      label: builtIn.label,
      trigger: builtIn.trigger,
      action: builtIn.action,
      enabled: index % 2 === 0,
      lastRunAt: index === 0 ? '2026-10-30T12:00:00.000Z' : null,
      runCount: index,
    };
  };
  const all = BUILT_IN_AUTOMATIONS.map((_, index) => rule(index));

  it('describes a rule with its trigger, action and run history', () => {
    expect(automationSchema.parse(rule(0))).toEqual(rule(0));
    expect(automationSchema.safeParse({ ...rule(0), runCount: -1 }).success).toBe(false);
    expect(automationSchema.safeParse({ ...rule(0), key: 'custom_x' }).success).toBe(false);
  });

  it('lists the six rules with whether the caller may switch them and the site can send', () => {
    const response = { automations: all, canManage: true, hasSender: false, requestId: UUID };
    expect(listAutomationsResponseSchema.parse(response)).toEqual(response);
    expect(
      listAutomationsResponseSchema.safeParse({ ...response, automations: all.slice(1) }).success,
    ).toBe(false);
    const { canManage: _canManage, ...withoutCanManage } = response;
    expect(listAutomationsResponseSchema.safeParse(withoutCanManage).success).toBe(false);
    const { hasSender: _hasSender, ...withoutHasSender } = response;
    expect(listAutomationsResponseSchema.safeParse(withoutHasSender).success).toBe(false);
  });

  it('switches a rule with exactly one key', () => {
    expect(updateAutomationRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateAutomationRequestSchema.safeParse({ enabled: true, label: 'x' }).success).toBe(
      false,
    );
    expect(updateAutomationRequestSchema.safeParse({}).success).toBe(false);
    expect(
      automationResponseSchema.safeParse({ automation: rule(1), requestId: UUID }).success,
    ).toBe(true);
  });

  it('records a run as queued or skipped, with a lead name only when the caller may see it', () => {
    const run = {
      id: UUID,
      leadId: UUID,
      leadName: 'Ann Lee',
      outcome: 'skipped',
      reason: 'no_customer_email',
      createdAt: '2026-10-30T12:00:00.000Z',
    };
    expect(automationRunSchema.parse(run)).toEqual(run);
    expect(automationRunSchema.safeParse({ ...run, leadName: null, reason: null }).success).toBe(
      true,
    );
    expect(automationRunSchema.safeParse({ ...run, outcome: 'sent' }).success).toBe(false);
    expect(automationRunSchema.safeParse({ ...run, reason: 'other' }).success).toBe(false);
    const runs = Array.from({ length: 51 }, () => run);
    expect(
      listAutomationRunsResponseSchema.safeParse({ runs: runs.slice(0, 50), requestId: UUID })
        .success,
    ).toBe(true);
    expect(listAutomationRunsResponseSchema.safeParse({ runs, requestId: UUID }).success).toBe(
      false,
    );
  });
});
