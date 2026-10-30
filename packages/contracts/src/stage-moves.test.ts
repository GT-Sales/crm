import { describe, expect, it, test } from 'vitest';

import { allowedStageMoves, isStageMoveAllowed, leadTypeCatalog, stageGates } from './index';

const stageKeys = (leadType: keyof typeof leadTypeCatalog): string[] =>
  leadTypeCatalog[leadType].stages.map((stage) => stage.key);

describe('allowed stage moves', () => {
  test.each([
    ['incomplete', ['pending', 'cancelled']],
    ['pending', ['verified', 'on_hold', 'cancelled']],
    ['verified', ['on_hold', 'delivered', 'cancelled']],
    ['on_hold', ['pending', 'verified', 'cancelled']],
    ['delivered', ['on_hold', 'activated', 'cancelled']],
    ['activated', ['completed', 'cancelled']],
    ['completed', []],
    ['cancelled', ['pending']],
  ])('a SIM order at %s may move to %j', (from, expected) => {
    expect(allowedStageMoves('sim_order', from)).toEqual(expected);
    for (const to of stageKeys('sim_order')) {
      expect(isStageMoveAllowed('sim_order', from, to), `${from} → ${to}`).toBe(
        expected.includes(to),
      );
    }
  });

  it('refuses skipping a SIM order past its checks', () => {
    expect(isStageMoveAllowed('sim_order', 'pending', 'delivered')).toBe(false);
  });

  it('lets every other type move to any other stage, never to its own', () => {
    expect(allowedStageMoves('internet', 'new')).toEqual(
      stageKeys('internet').filter((key) => key !== 'new'),
    );
    expect(allowedStageMoves('internet', 'new')).toHaveLength(8);
    expect(isStageMoveAllowed('internet', 'new', 'new')).toBe(false);
    expect(isStageMoveAllowed('contact_message', 'closed', 'new')).toBe(true);
  });

  it('lets a lead at a stage its type does not list move to any listed stage', () => {
    expect(allowedStageMoves('sim_order', 'paid')).toEqual(stageKeys('sim_order'));
    expect(isStageMoveAllowed('sim_order', 'paid', 'completed')).toBe(true);
  });

  it('never allows a stage the type does not list, nor any move of an unknown type', () => {
    expect(isStageMoveAllowed('sim_order', 'pending', 'paid')).toBe(false);
    expect(allowedStageMoves('unknown_type', 'new')).toEqual([]);
    expect(isStageMoveAllowed('unknown_type', 'new', 'won')).toBe(false);
  });
});

describe('stage gates', () => {
  it('ask for dispatch or activation details and the documents on the order stages', () => {
    expect(stageGates('sim_order', 'delivered')).toEqual(['dispatch', 'documents']);
    expect(stageGates('sim_order', 'activated')).toEqual(['activation', 'documents']);
    expect(stageGates('mobility', 'activated')).toEqual(['activation', 'documents']);
  });

  it('ask nothing anywhere else', () => {
    expect(stageGates('internet', 'installed')).toEqual([]);
    expect(stageGates('sim_order', 'verified')).toEqual([]);
    expect(stageGates('unknown_type', 'activated')).toEqual([]);
  });
});
