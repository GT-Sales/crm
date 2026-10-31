import { and, eq, like } from 'drizzle-orm';
import { emailTemplates, memberships, type TenantTransaction } from '@gt-sales/db';
import {
  CUSTOMER_EMAIL_TEMPLATES,
  isSiteTemplateKey,
  type FlowSite,
  type FlowSiteTemplate,
  type PropertyCatalog,
} from '@gt-sales/contracts';

import { templatePropertyKeys } from '../email/markup.js';
import { loadPropertyCatalog } from '../properties/catalog.js';
import { loadPlanOptions } from '../plans/options.js';

/**
 * What a site has now, for `checkFlowAgainstSite` (spec §3): every template
 * it can send (the nine built-ins, never archived and with no `{prop:…}`, and
 * its own `tpl_` ones with whether they are archived and the properties they
 * show), the actor ids of its active staff, every plan (inactive ones
 * included) with its type, and its property catalogue. Read in the caller's
 * tenant transaction; writes nothing.
 */
export async function loadFlowSite(
  tx: TenantTransaction,
  workspaceId: string,
  catalog?: PropertyCatalog,
): Promise<FlowSite> {
  const templates = new Map<string, FlowSiteTemplate>(
    CUSTOMER_EMAIL_TEMPLATES.map((key) => [key, { archived: false, propertyKeys: [] }]),
  );
  const siteMade = await tx
    .select({
      key: emailTemplates.key,
      subject: emailTemplates.subject,
      body: emailTemplates.body,
      archivedAt: emailTemplates.archivedAt,
    })
    .from(emailTemplates)
    .where(and(eq(emailTemplates.workspaceId, workspaceId), like(emailTemplates.key, 'tpl\\_%')));
  for (const row of siteMade) {
    if (!isSiteTemplateKey(row.key)) continue;
    templates.set(row.key, {
      archived: row.archivedAt !== null,
      propertyKeys: templatePropertyKeys(row.subject, row.body),
    });
  }

  const members = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.membershipType, 'staff'),
        eq(memberships.status, 'active'),
      ),
    );
  const memberIds = new Set(members.flatMap((row) => (row.userId === null ? [] : [row.userId])));

  const plans = await loadPlanOptions(tx);
  return {
    templates,
    memberIds,
    plans: new Map(plans.map((plan) => [plan.id, { leadType: plan.leadType }])),
    catalog: catalog ?? (await loadPropertyCatalog(tx, 'lead', { plans })),
  };
}
