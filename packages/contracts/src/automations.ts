import { z } from 'zod';

import { orderLeadTypes } from '@gt-sales/types';

import { customerEmailTemplateSchema, type CustomerEmailTemplate } from './customer-email';
import { leadTypeSchema } from './leads';
import { leadStageSchema } from './workspace-leads';

/**
 * Automation rules (spec §15): a trigger and an action. Phase 4 ships the
 * built-in rules below, each switched on or off per site (`app.automations`,
 * off until the owner switches it on); a firing is a run
 * (`app.automation_runs`). The keys are also a CHECK constraint in the
 * database, so a rule is added here and in a migration together.
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

export const automationTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('lead_submitted'), leadTypes: z.array(leadTypeSchema).min(1) })
    .strict(),
  z
    .object({ kind: z.literal('stage_entered'), leadType: leadTypeSchema, stage: leadStageSchema })
    .strict(),
]);

export const automationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send_email'), template: customerEmailTemplateSchema }).strict(),
]);

export const BUILT_IN_AUTOMATION_KEYS = [
  'order_received',
  'sim_order_information_needed',
  'sim_order_dispatched',
  'sim_order_activated',
  'sim_order_cancelled',
  'mobility_activated',
] as const;
export const automationKeySchema = z.enum(BUILT_IN_AUTOMATION_KEYS);
export type AutomationKey = z.infer<typeof automationKeySchema>;

export interface BuiltInAutomation {
  readonly key: AutomationKey;
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

/** The built-in rules a move of a `leadType` lead into stage `to` fires, in key order. */
export function automationsForMove(leadType: string, to: string): readonly BuiltInAutomation[] {
  return BUILT_IN_AUTOMATIONS.filter(
    ({ trigger }) =>
      trigger.kind === 'stage_entered' && trigger.leadType === leadType && trigger.stage === to,
  );
}

/** The built-in rules a website's submission of a `leadType` lead fires, in key order. */
export function automationsForSubmit(leadType: string): readonly BuiltInAutomation[] {
  return BUILT_IN_AUTOMATIONS.filter(
    ({ trigger }) => trigger.kind === 'lead_submitted' && trigger.leadTypes.includes(leadType),
  );
}

/** The built-in rules that send `template`, for its settings card. */
export function automationsUsingTemplate(
  template: CustomerEmailTemplate,
): readonly BuiltInAutomation[] {
  return BUILT_IN_AUTOMATIONS.filter(({ action }) => action.template === template);
}
