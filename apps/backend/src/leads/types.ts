import {
  internetLeadPayloadSchema,
  leadTypeCatalog,
  mobilityLeadPayloadSchema,
  simOrderLeadPayloadSchema,
  type LeadContact,
  type LeadForm,
  type LeadOrderIntake,
} from '@gt-sales/contracts';
import type { z } from 'zod';

/**
 * The lead-type registry (docs/PLAN.md §5.3): what each website form is, which
 * fields it must carry, and how intake treats it. A new form is a new entry
 * here and in the contracts catalogue (`leadTypeCatalog`: label and working
 * stages, shared with the admin) plus a scope on the site's credential;
 * intake refuses any type that is not listed.
 *
 * A type with a `payload` schema is modelled: its `form.payload` is validated
 * strictly, on a create and on every website save, and nothing unmodelled is
 * stored. A type without one is planned but not yet modelled (Get Canada
 * Sim's partner applications and contact messages) and keeps the old
 * behaviour of accepting any object.
 */
export interface LeadTypeDefinition {
  payload?: z.ZodType;
  /**
   * Created complete in a single request (`submit: true`). Such a lead has no
   * draft grant, so it can never be resumed or edited from the website.
   */
  oneShot: boolean;
  /** Contact fields the type cannot be stored without. */
  requiredContact: readonly (keyof Pick<LeadContact, 'fullName' | 'email' | 'phone'>)[];
  /**
   * What a submission must carry beyond `requiredContact`; undefined = ready.
   * A type with one may save a draft with no form at all: the check decides,
   * at submission, whether the form it holds is enough.
   */
  submitCheck?: (lead: SubmittableLead) => LeadIntakeProblem | undefined;
}

/**
 * A lead as a submission would leave it: on a create, the request; on a
 * website save, the incoming contact over the stored one, the incoming form
 * else the stored payload, and the incoming plan else the draft's.
 */
export interface SubmittableLead {
  contact: LeadContact;
  /** The form's `payload`, or null when the lead has no form. */
  payload: Readonly<Record<string, unknown>> | null;
  planId: string | null;
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/**
 * A Get Canada Sim order is worked by the person, the plan and how the SIM
 * reaches them; a mailed SIM (`pickup`) needs the address it goes to. The
 * payload's shape is already checked, so only presence is decided here.
 */
function simOrderSubmitCheck(lead: SubmittableLead): LeadIntakeProblem | undefined {
  if (!filled(lead.contact.fullName) || !filled(lead.contact.email)) return 'contact';
  if (lead.planId === null) return 'order';
  const delivery = lead.payload?.['delivery'];
  if (delivery !== 'esim' && delivery !== 'pickup') return 'form';
  if (delivery === 'pickup' && !filled(lead.payload?.['shippingAddress'])) return 'form';
  return undefined;
}

export const leadTypes = {
  internet: {
    payload: internetLeadPayloadSchema,
    oneShot: true,
    requiredContact: ['fullName', 'email', 'phone'],
  },
  mobility: {
    payload: mobilityLeadPayloadSchema,
    oneShot: true,
    requiredContact: ['fullName', 'email', 'phone'],
  },
  sim_order: {
    payload: simOrderLeadPayloadSchema,
    oneShot: false,
    requiredContact: [],
    submitCheck: simOrderSubmitCheck,
  },
  partner_application: { oneShot: false, requiredContact: [] },
  contact_message: { oneShot: false, requiredContact: [] },
} as const satisfies Record<keyof typeof leadTypeCatalog, LeadTypeDefinition>;

export type RegisteredLeadType = keyof typeof leadTypes;

const registry: ReadonlyMap<string, LeadTypeDefinition> = new Map(Object.entries(leadTypes));

export function leadTypeDefinition(leadType: string): LeadTypeDefinition | undefined {
  return registry.get(leadType);
}

/**
 * Which part of a website request the registry refused; never a field value.
 * `order`: a submission of an order type that names no plan.
 */
export type LeadIntakeProblem = 'leadType' | 'submit' | 'form' | 'contact' | 'order';

export type LeadIntakeCheck = { ok: true } | { ok: false; problem: LeadIntakeProblem };

const OK: LeadIntakeCheck = { ok: true };
const refused = (problem: LeadIntakeProblem): LeadIntakeCheck => ({ ok: false, problem });

function formFits(definition: LeadTypeDefinition, form: LeadForm): boolean {
  if (!definition.payload) return true;
  return form.schemaVersion === 1 && definition.payload.safeParse(form.payload).success;
}

/**
 * A website save's form against its lead's type (`PATCH`): a modelled type's
 * form must be its schema's; no form, or a type that is not modelled, is
 * fine. An unknown type is refused.
 */
export function checkLeadForm(leadType: string, form: LeadForm | undefined): LeadIntakeCheck {
  const definition = leadTypeDefinition(leadType);
  if (!definition) return refused('leadType');
  if (form !== undefined && !formFits(definition, form)) return refused('form');
  return OK;
}

/** Whether a lead, as a submission would leave it, carries what its type needs to be worked. */
export function checkLeadSubmit(leadType: string, lead: SubmittableLead): LeadIntakeCheck {
  const definition = leadTypeDefinition(leadType);
  if (!definition) return refused('leadType');
  if (definition.requiredContact.some((field) => !lead.contact[field])) return refused('contact');
  const problem = definition.submitCheck?.(lead);
  return problem === undefined ? OK : refused(problem);
}

/**
 * Checks a create request against the registry before anything is stored,
 * and, when it submits, the lead it would make (`checkLeadSubmit`). Field
 * values never appear in the result, so it is safe to return to the caller
 * and to log.
 */
export function checkLeadIntake(input: {
  leadType: string;
  submit?: boolean;
  contact?: LeadContact;
  form?: LeadForm;
  order?: LeadOrderIntake;
}): LeadIntakeCheck {
  const definition = leadTypeDefinition(input.leadType);
  if (!definition) return refused('leadType');
  if (definition.oneShot && input.submit !== true) return refused('submit');
  if (definition.payload) {
    // A type with a submit rule may save a draft with no form yet.
    if (!input.form && !definition.submitCheck) return refused('form');
    if (input.form && !formFits(definition, input.form)) return refused('form');
  }
  if (definition.requiredContact.some((field) => !input.contact?.[field])) {
    return refused('contact');
  }
  if (input.submit !== true) return OK;
  return checkLeadSubmit(input.leadType, {
    contact: input.contact ?? {},
    payload: input.form?.payload ?? null,
    planId: input.order?.planId ?? null,
  });
}
