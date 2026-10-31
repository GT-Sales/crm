import { orderLeadTypes } from '@gt-sales/types';
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_AUTOMATIONS,
  BUILT_IN_AUTOMATION_KEYS,
  automationActionSchema,
  automationKeySchema,
  automationTriggerSchema,
  automationsForMove,
  automationsForSubmit,
  automationsUsingTemplate,
  customerEmailTemplateSchema,
  isLeadStage,
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
