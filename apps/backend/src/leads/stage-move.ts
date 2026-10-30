import {
  allowedStageMoves,
  isStageMoveAllowed,
  stageGates,
  type LeadOrder,
  type LeadOrderEdit,
  type StageGate,
} from '@gt-sales/contracts';

/**
 * Whether staff may move a lead from one stage to another, and what the move
 * asks of its order first (`leadTypeCatalog`'s `moves` and `gates`). Pure: the
 * `documents` gate needs the lead's files, so it is returned for the caller
 * to check (`findMissingDocuments`) rather than decided here.
 */

export type StageMoveRefusal =
  | { status: 'illegal_stage_move'; from: string; to: string; allowed: readonly string[] }
  | { status: 'dispatch_details_required' }
  | { status: 'activation_details_required' };

export type StageMovePlan =
  | {
      ok: true;
      /** Every gate of the target stage, in check order; `dispatch` and `activation` are already met. */
      gates: readonly StageGate[];
      /** The order edit to write with the move: the one given, with the dates the gates default. */
      order: LeadOrderEdit | undefined;
    }
  | { ok: false; refusal: StageMoveRefusal };

const isBlank = (value: string | null | undefined): boolean => !value || value.trim() === '';

/**
 * Plans the move of a lead of `leadType` from `from` to `to`. A move the type
 * does not allow is refused with the moves it does. `dispatch` needs a
 * courier, in the edit or already stored (a blank or null one in the edit is
 * refused), and dates the dispatch `today` unless the edit or the stored
 * order has a date. `activation` refuses only an explicit `activatedAt: null`
 * and otherwise dates the activation the same way.
 */
export function planStageMove(input: {
  leadType: string;
  from: string;
  to: string;
  current: LeadOrder;
  edit: LeadOrderEdit | undefined;
  today: string;
}): StageMovePlan {
  const { leadType, from, to, current, edit, today } = input;
  if (!isStageMoveAllowed(leadType, from, to)) {
    return {
      ok: false,
      refusal: {
        status: 'illegal_stage_move',
        from,
        to,
        allowed: allowedStageMoves(leadType, from),
      },
    };
  }
  const gates = stageGates(leadType, to);
  let order = edit;
  for (const gate of gates) {
    if (gate === 'dispatch') {
      const courier = edit?.courier !== undefined ? edit.courier : current.courier;
      if (isBlank(courier)) return { ok: false, refusal: { status: 'dispatch_details_required' } };
      // A dispatch always carries a date: one given, else the one stored, else today.
      const dispatchedAt =
        edit?.dispatchedAt !== undefined ? edit.dispatchedAt : current.dispatchedAt;
      if (dispatchedAt === null) order = { ...order, dispatchedAt: today };
    } else if (gate === 'activation') {
      if (edit?.activatedAt === null) {
        return { ok: false, refusal: { status: 'activation_details_required' } };
      }
      if ((edit?.activatedAt ?? current.activatedAt) === null) {
        order = { ...order, activatedAt: today };
      }
    }
  }
  return { ok: true, gates, order };
}

const TORONTO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar day `now` falls on in Toronto, `YYYY-MM-DD`: the default dispatch and activation date. */
export function todayInToronto(now: Date): string {
  const parts = TORONTO_DAY.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
