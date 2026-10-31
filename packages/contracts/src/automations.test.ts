import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_AUTOMATIONS,
  BUILT_IN_AUTOMATION_KEYS,
  automationKeySchema,
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
});
