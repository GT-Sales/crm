import { describe, expect, test } from 'vitest';
import { DEFAULT_LEAD_ORDER, type LeadOrder, type LeadOrderEdit } from '@gt-sales/contracts';

import { planStageMove, todayInToronto } from '../src/leads/stage-move.js';

const TODAY = '2026-10-30';

const move = (
  from: string,
  to: string,
  edit?: LeadOrderEdit,
  current: Partial<LeadOrder> = {},
  leadType = 'sim_order',
) =>
  planStageMove({
    leadType,
    from,
    to,
    current: { ...DEFAULT_LEAD_ORDER, ...current },
    edit,
    today: TODAY,
  });

describe('planStageMove', () => {
  test('a move the type does not allow is refused with the moves it does', () => {
    expect(move('pending', 'delivered')).toEqual({
      ok: false,
      refusal: {
        status: 'illegal_stage_move',
        from: 'pending',
        to: 'delivered',
        allowed: ['verified', 'on_hold', 'cancelled'],
      },
    });
    expect(move('completed', 'cancelled')).toMatchObject({
      ok: false,
      refusal: { status: 'illegal_stage_move', allowed: [] },
    });
  });

  test('a move with no gate keeps the edit as given', () => {
    expect(move('pending', 'verified', { quantity: 2 })).toEqual({
      ok: true,
      gates: [],
      order: { quantity: 2 },
    });
    expect(move('pending', 'verified')).toEqual({ ok: true, gates: [], order: undefined });
  });

  test('delivered needs a courier, in the edit or stored', () => {
    expect(move('verified', 'delivered')).toEqual({
      ok: false,
      refusal: { status: 'dispatch_details_required' },
    });
    expect(move('verified', 'delivered', { courier: null }, { courier: 'Canada Post' })).toEqual({
      ok: false,
      refusal: { status: 'dispatch_details_required' },
    });
    expect(move('verified', 'delivered', { courier: '   ' })).toEqual({
      ok: false,
      refusal: { status: 'dispatch_details_required' },
    });
  });

  test('a courier in the edit gains today as the dispatch date', () => {
    expect(move('verified', 'delivered', { courier: 'Canada Post' })).toEqual({
      ok: true,
      gates: ['dispatch', 'documents'],
      order: { courier: 'Canada Post', dispatchedAt: TODAY },
    });
    expect(
      move('verified', 'delivered', { courier: 'Canada Post', dispatchedAt: '2026-10-29' }),
    ).toMatchObject({ ok: true, order: { courier: 'Canada Post', dispatchedAt: '2026-10-29' } });
  });

  test('a stored courier satisfies the dispatch details', () => {
    expect(move('verified', 'delivered', undefined, { courier: 'Purolator' })).toEqual({
      ok: true,
      gates: ['dispatch', 'documents'],
      order: { dispatchedAt: TODAY },
    });
    // A dispatch date already stored is kept.
    expect(
      move('verified', 'delivered', undefined, {
        courier: 'Purolator',
        dispatchedAt: '2026-10-28',
      }),
    ).toEqual({ ok: true, gates: ['dispatch', 'documents'], order: undefined });
  });

  test('activated defaults its date to today and refuses only an explicit null', () => {
    expect(move('delivered', 'activated')).toEqual({
      ok: true,
      gates: ['activation', 'documents'],
      order: { activatedAt: TODAY },
    });
    expect(move('delivered', 'activated', { activationNumber: '6475550123' })).toEqual({
      ok: true,
      gates: ['activation', 'documents'],
      order: { activationNumber: '6475550123', activatedAt: TODAY },
    });
    expect(move('delivered', 'activated', { activatedAt: null })).toEqual({
      ok: false,
      refusal: { status: 'activation_details_required' },
    });
    expect(move('new', 'activated', undefined, {}, 'mobility')).toMatchObject({
      ok: true,
      gates: ['activation', 'documents'],
      order: { activatedAt: TODAY },
    });
  });

  test('internet moves anywhere with no gates', () => {
    for (const [from, to] of [
      ['new', 'installed'],
      ['installed', 'new'],
      ['lost', 'won'],
    ] as const) {
      expect(move(from, to, undefined, {}, 'internet')).toEqual({
        ok: true,
        gates: [],
        order: undefined,
      });
    }
  });

  test('a lead on a stage its type no longer lists may move to any listed one', () => {
    expect(move('paid', 'pending')).toEqual({ ok: true, gates: [], order: undefined });
    expect(move('cancelled', 'pending')).toEqual({ ok: true, gates: [], order: undefined });
  });
});

describe('todayInToronto', () => {
  test('is the calendar day in Toronto, not in UTC', () => {
    expect(todayInToronto(new Date('2026-11-01T03:30:00Z'))).toBe('2026-10-31');
    expect(todayInToronto(new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
  });
});
