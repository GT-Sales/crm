import { describe, expect, it } from 'vitest';

import { checkLeadForm, checkLeadIntake, checkLeadSubmit } from '../src/leads/types.js';

const PLAN = '00000000-0000-4000-8000-000000005301';
const contact = { fullName: 'Nadia Khan', email: 'nadia@example.test' };
const esim = { schemaVersion: 1, payload: { planId: 'unlimited-data-rogers', delivery: 'esim' } };
const order = { planId: PLAN, quantity: 1 };
const complete = {
  leadType: 'sim_order',
  submit: true,
  contact,
  form: esim,
  order,
};

describe('SIM order intake', () => {
  it('saves a draft with only a name, and a draft with part of the form', () => {
    expect(checkLeadIntake({ leadType: 'sim_order', contact: { fullName: 'Nadia Khan' } })).toEqual(
      { ok: true },
    );
    expect(
      checkLeadIntake({
        leadType: 'sim_order',
        contact,
        form: { schemaVersion: 1, payload: { arrivalDate: '2026-11-20' } },
      }),
    ).toEqual({ ok: true });
  });

  it('submits a complete order', () => {
    expect(checkLeadIntake(complete)).toEqual({ ok: true });
    expect(
      checkLeadIntake({
        ...complete,
        form: {
          schemaVersion: 1,
          payload: { delivery: 'pickup', shippingAddress: '12 King St W, Toronto ON' },
        },
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['without an email', { contact: { fullName: 'Nadia Khan' } }, 'contact'],
    ['without a name', { contact: { email: 'nadia@example.test' } }, 'contact'],
    ['with a blank name', { contact: { ...contact, fullName: '   ' } }, 'contact'],
    ['without a plan', { order: undefined }, 'order'],
    ['without a form', { form: undefined }, 'form'],
    ['without a delivery', { form: { schemaVersion: 1, payload: { planId: 'x' } } }, 'form'],
    [
      'for a mailed SIM without a shipping address',
      { form: { schemaVersion: 1, payload: { delivery: 'pickup' } } },
      'form',
    ],
    [
      'for a mailed SIM with a blank shipping address',
      { form: { schemaVersion: 1, payload: { delivery: 'pickup', shippingAddress: '  ' } } },
      'form',
    ],
    [
      'with a SIM number in the form',
      { form: { schemaVersion: 1, payload: { delivery: 'esim', simNumber: '+16475550123' } } },
      'form',
    ],
  ])('refuses a submission %s', (_name, change, problem) => {
    expect(checkLeadIntake({ ...complete, ...change })).toEqual({ ok: false, problem });
  });

  it('checks a submission as the save leaves the lead', () => {
    const lead = { contact, payload: { delivery: 'esim' }, planId: PLAN };
    expect(checkLeadSubmit('sim_order', lead)).toEqual({ ok: true });
    expect(checkLeadSubmit('sim_order', { ...lead, planId: null })).toEqual({
      ok: false,
      problem: 'order',
    });
    expect(checkLeadSubmit('sim_order', { ...lead, payload: null })).toEqual({
      ok: false,
      problem: 'form',
    });
    expect(checkLeadSubmit('sim_order', { ...lead, contact: {} })).toEqual({
      ok: false,
      problem: 'contact',
    });
    // A type with no submit rule is ready as it stands; an unknown type is not.
    expect(
      checkLeadSubmit('contact_message', { contact: {}, payload: null, planId: null }),
    ).toEqual({ ok: true });
    expect(checkLeadSubmit('nope', lead)).toEqual({ ok: false, problem: 'leadType' });
  });

  it("checks a save's form against its type", () => {
    expect(
      checkLeadForm('sim_order', { schemaVersion: 1, payload: { delivery: 'drone' } }),
    ).toEqual({ ok: false, problem: 'form' });
    expect(checkLeadForm('sim_order', { schemaVersion: 2, payload: {} })).toEqual({
      ok: false,
      problem: 'form',
    });
    expect(checkLeadForm('sim_order', { schemaVersion: 1, payload: { delivery: 'esim' } })).toEqual(
      { ok: true },
    );
    expect(checkLeadForm('sim_order', undefined)).toEqual({ ok: true });
    expect(
      checkLeadForm('contact_message', { schemaVersion: 1, payload: { anything: ['at', 'all'] } }),
    ).toEqual({ ok: true });
  });

  it('leaves the CanadaWide forms as they were', () => {
    expect(checkLeadIntake({ leadType: 'internet', submit: true, contact })).toEqual({
      ok: false,
      problem: 'form',
    });
  });
});
