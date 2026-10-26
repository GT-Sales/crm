import {
  internetLeadPayloadSchema,
  mobilityLeadPayloadSchema,
  type LeadContact,
  type LeadForm,
} from '@gt-sales/contracts';
import type { z } from 'zod';

/**
 * The lead-type registry (docs/PLAN.md §5.3): what each website form is, which
 * fields it must carry, and the working statuses staff move it through. A new
 * form is a new entry here plus a scope on the site's credential; intake
 * refuses any type that is not listed.
 *
 * A type with a `payload` schema is modelled: its `form.payload` is validated
 * strictly and nothing unmodelled is stored. A type without one is planned
 * but not yet modelled (Get Canada Sim's forms arrive in phase 3) and keeps
 * the old behaviour of accepting any object.
 */
export interface LeadTypeDefinition {
  label: string;
  payload?: z.ZodType;
  /**
   * Created complete in a single request (`submit: true`). Such a lead has no
   * draft grant, so it can never be resumed or edited from the website.
   */
  oneShot: boolean;
  /** Contact fields the type cannot be stored without. */
  requiredContact: readonly (keyof Pick<LeadContact, 'fullName' | 'email' | 'phone'>)[];
  /** Working statuses for the phase 2 screens; `new` first. */
  statuses: readonly string[];
}

export const leadTypes = {
  internet: {
    label: 'Internet order',
    payload: internetLeadPayloadSchema,
    oneShot: true,
    requiredContact: ['fullName', 'email', 'phone'],
    statuses: [
      'new',
      'contacted',
      'qualified',
      'existing_shaw',
      'non_serviceable_address',
      'old_due',
      'installed',
      'won',
      'lost',
    ],
  },
  mobility: {
    label: 'Mobile plan order',
    payload: mobilityLeadPayloadSchema,
    oneShot: true,
    requiredContact: ['fullName', 'email', 'phone'],
    statuses: ['new', 'contacted', 'qualified', 'activated', 'won', 'lost'],
  },
  sim_order: {
    label: 'SIM order',
    oneShot: false,
    requiredContact: [],
    statuses: ['incomplete', 'submitted'],
  },
  partner_application: {
    label: 'Partner application',
    oneShot: false,
    requiredContact: [],
    statuses: ['new', 'contacted', 'approved', 'declined'],
  },
  contact_message: {
    label: 'Contact message',
    oneShot: false,
    requiredContact: [],
    statuses: ['new', 'replied', 'closed'],
  },
} as const satisfies Record<string, LeadTypeDefinition>;

export type RegisteredLeadType = keyof typeof leadTypes;

const registry: ReadonlyMap<string, LeadTypeDefinition> = new Map(Object.entries(leadTypes));

export function leadTypeDefinition(leadType: string): LeadTypeDefinition | undefined {
  return registry.get(leadType);
}

/** Which part of a create request the registry refused; never a field value. */
export type LeadIntakeProblem = 'leadType' | 'submit' | 'form' | 'contact';

export type LeadIntakeCheck = { ok: true } | { ok: false; problem: LeadIntakeProblem };

/**
 * Checks a create request against the registry before anything is stored.
 * Field values never appear in the result, so it is safe to return to the
 * caller and to log.
 */
export function checkLeadIntake(input: {
  leadType: string;
  submit?: boolean;
  contact?: LeadContact;
  form?: LeadForm;
}): LeadIntakeCheck {
  const definition = leadTypeDefinition(input.leadType);
  if (!definition) return { ok: false, problem: 'leadType' };
  if (definition.oneShot && input.submit !== true) return { ok: false, problem: 'submit' };
  if (definition.payload) {
    if (!input.form || input.form.schemaVersion !== 1) return { ok: false, problem: 'form' };
    if (!definition.payload.safeParse(input.form.payload).success) {
      return { ok: false, problem: 'form' };
    }
  }
  if (definition.requiredContact.some((field) => !input.contact?.[field])) {
    return { ok: false, problem: 'contact' };
  }
  return { ok: true };
}
