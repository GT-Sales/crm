import { describe, expect, it } from 'vitest';

import { stagePath } from './stage-path';

const passport = (decision: 'approved' | 'rejected' | null) => ({
  documentType: 'passport',
  review: decision === null ? null : { decision, at: '2026-11-04T12:00:00.000Z' },
});

describe('stagePath', () => {
  it('marks where a SIM order stands and offers the next move with nothing asked', () => {
    const path = stagePath({ leadType: 'sim_order', stage: 'pending', documents: [] });
    expect(path?.steps.map((step) => `${step.label}:${step.state}`)).toEqual([
      'Incomplete:done',
      'Pending:current',
      'Verified:upcoming',
      'Delivered:upcoming',
      'Activated:upcoming',
      'Completed:upcoming',
    ]);
    expect(path?.offPath).toBeUndefined();
    expect(path?.next).toEqual({ key: 'verified', label: 'Verified', needs: [], blocked: false });
  });

  it('says a dispatch asks for the courier and that unapproved documents block it', () => {
    const order = { courier: null, plan: { requiredDocuments: ['passport', 'work_permit'] } };
    const path = stagePath({
      leadType: 'sim_order',
      stage: 'verified',
      order,
      documents: [passport('approved')],
    });
    expect(path?.next).toEqual({
      key: 'delivered',
      label: 'Delivered',
      needs: ['asks for the courier', 'needs work permit approved'],
      blocked: true,
    });
    const ready = stagePath({
      leadType: 'sim_order',
      stage: 'verified',
      order: { courier: 'Canada Post', plan: { requiredDocuments: ['passport'] } },
      documents: [passport('approved')],
    });
    expect(ready?.next).toMatchObject({ needs: [], blocked: false });
    // A rejected passport is not an approved one.
    expect(
      stagePath({
        leadType: 'sim_order',
        stage: 'verified',
        order: { courier: 'Canada Post', plan: { requiredDocuments: ['passport'] } },
        documents: [passport('rejected')],
      })?.next?.blocked,
    ).toBe(true);
  });

  it('asks for the activation date on a mobility activation', () => {
    expect(
      stagePath({ leadType: 'mobility', stage: 'qualified', documents: [] })?.next,
    ).toMatchObject({ key: 'activated', needs: ['asks for the activation date'], blocked: false });
  });

  it('offers nothing at the end of the path or off it, and names the side stage', () => {
    expect(stagePath({ leadType: 'sim_order', stage: 'completed', documents: [] })?.next).toBe(
      undefined,
    );
    const held = stagePath({ leadType: 'sim_order', stage: 'on_hold', documents: [] });
    expect(held?.offPath).toBe('On hold');
    expect(held?.next).toBeUndefined();
    expect(held?.steps.every((step) => step.state === 'upcoming')).toBe(true);
  });

  it('has no path for a type it does not know', () => {
    expect(stagePath({ leadType: 'unknown', stage: 'new', documents: [] })).toBeUndefined();
  });
});
