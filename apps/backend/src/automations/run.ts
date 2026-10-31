import { and, eq } from 'drizzle-orm';
import { leads, type TenantTransaction } from '@gt-sales/db';
import { isOrderLeadType, leadFormSchema } from '@gt-sales/contracts';
import { z } from 'zod';

import type { FillInLead } from '../email/fill-in-values.js';
import { toLeadOrder } from '../leads/order.js';

/** A lead's stored custom values: an object of values by property key. */
const storedValuesSchema = z.record(z.string(), z.unknown());

/**
 * The lead a flow works on, as stored: its fill-ins, its address and whether
 * the customer submitted it. The flow engine itself is `engine.ts`.
 */

/** The lead a flow writes to: its fill-ins, its address and whether the customer submitted it. */
export type AutomationLead = FillInLead & {
  id: string;
  email: string | null;
  submitted: boolean;
  /** Who works the lead now; null when nobody does. */
  assignedActorId: string | null;
};

/** The fill-in lead of a stored lead row: its form's values and, for an order type, its order. */
export function automationLeadOf(row: {
  id: string;
  leadType: string;
  status: string;
  fullName: string | null;
  email: string | null;
  externalRef: string | null;
  payload: unknown;
  customValues: unknown;
  orderDetails: unknown;
  assignedActorId?: string | null;
}): AutomationLead {
  const form = leadFormSchema.safeParse(row.payload);
  const customValues = storedValuesSchema.safeParse(row.customValues);
  return {
    id: row.id,
    leadType: row.leadType,
    fullName: row.fullName,
    externalRef: row.externalRef,
    customValues: customValues.success ? customValues.data : {},
    email: row.email,
    submitted: row.status !== 'incomplete',
    assignedActorId: row.assignedActorId ?? null,
    form: form.success ? form.data.payload : {},
    order: isOrderLeadType(row.leadType) ? toLeadOrder(row.orderDetails) : null,
  };
}

/** The lead as stored now, read in the caller's transaction. */
export async function readAutomationLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<AutomationLead> {
  const [row] = await tx
    .select({
      id: leads.id,
      leadType: leads.leadType,
      status: leads.status,
      fullName: leads.fullName,
      email: leads.email,
      externalRef: leads.externalRef,
      payload: leads.payload,
      customValues: leads.customValues,
      orderDetails: leads.orderDetails,
      assignedActorId: leads.assignedActorId,
    })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .limit(1);
  if (!row) throw new Error('lead vanished inside its own transaction');
  return automationLeadOf(row);
}
