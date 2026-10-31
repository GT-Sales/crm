import { orderLeadTypes } from '@gt-sales/types';

import type { CustomerEmailTemplate } from './customer-email';
import type { BuiltInAutomationKey } from './automation-keys';

export {
  BUILT_IN_AUTOMATION_KEYS,
  automationKeySchema,
  type AutomationKey,
} from './automation-keys';

/**
 * The six built-in rules as phase 4 defined them. Automation flows replaced
 * them at run time; they remain only as the seed for each built-in flow's
 * version-1 definition and default name (`builtInFlowDefinition`,
 * `builtInFlowName` in `automation-flows.ts`).
 */

/** When a rule fires: a website submits a lead of one of `leadTypes`, or staff move a lead into `stage`. */
export type AutomationTrigger =
  | { readonly kind: 'lead_submitted'; readonly leadTypes: readonly string[] }
  | { readonly kind: 'stage_entered'; readonly leadType: string; readonly stage: string };

/** What a rule does: queue the template to the lead's customer. */
export type AutomationAction = {
  readonly kind: 'send_email';
  readonly template: CustomerEmailTemplate;
};

export interface BuiltInAutomation {
  readonly key: BuiltInAutomationKey;
  /** The rule in the owner's words, as the Automations page lists it. */
  readonly label: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
}

const sendEmail = (template: CustomerEmailTemplate): AutomationAction => ({
  kind: 'send_email',
  template,
});

/** The built-in rules, in `BUILT_IN_AUTOMATION_KEYS` order. */
export const BUILT_IN_AUTOMATIONS: readonly BuiltInAutomation[] = [
  {
    key: 'order_received',
    label: 'When an order is submitted on the website → send the Order received email',
    trigger: { kind: 'lead_submitted', leadTypes: [...orderLeadTypes] },
    action: sendEmail('order_received'),
  },
  {
    key: 'sim_order_information_needed',
    label: 'When a SIM order moves to On hold → send the Information needed email',
    trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'on_hold' },
    action: sendEmail('information_needed'),
  },
  {
    key: 'sim_order_dispatched',
    label: 'When a SIM order moves to Delivered → send the Dispatched email',
    trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered' },
    action: sendEmail('dispatched'),
  },
  {
    key: 'sim_order_activated',
    label: 'When a SIM order moves to Activated → send the Activated email',
    trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'activated' },
    action: sendEmail('activated'),
  },
  {
    key: 'sim_order_cancelled',
    label: 'When a SIM order moves to Cancelled → send the Cancelled email',
    trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'cancelled' },
    action: sendEmail('cancelled'),
  },
  {
    key: 'mobility_activated',
    label: 'When a mobility order moves to Activated → send the Activated email',
    trigger: { kind: 'stage_entered', leadType: 'mobility', stage: 'activated' },
    action: sendEmail('activated'),
  },
];
