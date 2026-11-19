import { decideAccess, type StaffAccessSnapshot } from './authorization.js';

/**
 * Who sees what of a lead, decided once for the staff routes and Ask AI.
 *
 * The lead page shows a lead's contact, form, custom values and order
 * (price, currency, payment status and the carrier commission's state) to the
 * roles that work leads or money: `lead.manage`, `order.manage` or
 * `financial.read`. A commission's amount (a plan's or a frozen plan's
 * `commission`) and every revenue figure need `revenue.view` on top. Ask AI's
 * tools read the same answer from the same snapshot, so the assistant never
 * shows more, or less, money than the admin does.
 */

/** The actions that let a member see a lead's personal details. */
export const LEAD_DETAIL_ACTIONS = ['lead.manage', 'order.manage', 'financial.read'] as const;

/** Whether this member sees a lead's contact, form, custom values, notes, tasks and order. */
export function canSeeLeadDetails(access: StaffAccessSnapshot | undefined): boolean {
  return LEAD_DETAIL_ACTIONS.some((action) => decideAccess(access, action).allowed);
}

export interface MoneyVisibility {
  /** Price, currency, payment status and commission state on a lead's order. */
  readonly orderMoney: boolean;
  /** Commission amounts and revenue figures (`revenue.view`). */
  readonly revenue: boolean;
}

/** The one money rule, for every route and every Ask AI tool. */
export function moneyVisibilityOf(access: StaffAccessSnapshot | undefined): MoneyVisibility {
  return {
    orderMoney: canSeeLeadDetails(access),
    revenue: decideAccess(access, 'revenue.view').allowed,
  };
}
