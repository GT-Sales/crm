import type { Request } from 'express';
import type { LeadAccess } from '@gt-sales/contracts';

import type { VerifiedStaffSession } from '../auth/session.js';
import type { WebAnalyticsReader } from '../analytics/web-analytics.js';
import type { ReplyAddressing } from '../email/reply-address.js';
import type { PropertyStore } from '../properties/store.js';
import {
  decideAccess,
  type AuthorizationDecision,
  type StaffAccessSnapshot,
  type StaffAction,
} from '../staff/authorization.js';
import { canSeeLeadDetails } from '../staff/lead-visibility.js';
import type { StaffRouteDependencies } from './staff.js';

/**
 * What the staff router shares with the route modules it is split into
 * (`staff-leads.ts`, `staff-site.ts`, `staff-files.ts`): the injected
 * dependencies and the helpers every handler uses.
 */
export interface StaffRouteContext {
  dependencies: StaffRouteDependencies;
  /** A decision for an actor and action, with no request at hand. */
  authorize: (request: {
    actorId: string;
    workspaceId: string;
    action: StaffAction;
  }) => Promise<AuthorizationDecision>;
  /** One live authorization decision for this actor and workspace. */
  decide: (
    req: Request,
    workspaceId: string,
    action: StaffAction,
  ) => Promise<{ actor: VerifiedStaffSession; decision: AuthorizationDecision }>;
  /** Every handler's last-resort failure path (log + error tracker). */
  reportFailure: (req: Request, error: unknown) => void;
  /** The site's property definitions, or the stand-in that fails when none is configured. */
  propertyStore: PropertyStore;
  /** Whether a site's customers' replies come back to the CRM (email/reply-address.ts). */
  replyAddressing: ReplyAddressing | undefined;
  /** The process's one website-traffic reader, used when none is injected. */
  defaultWebAnalytics: WebAnalyticsReader;
}

export function session(req: Request) {
  const value = req.staffSession;
  if (!value) throw new Error('staff session middleware did not run');
  return value;
}

/**
 * Whether this actor may see a lead's name, email and phone. Only roles that
 * work leads or money see contact details; read-only roles get leads without
 * them. Decided from the access snapshot the request's own authorization
 * already loaded, so it adds no database round trips: three extra membership
 * reads here were most of the leads inbox's latency.
 */
export function canSeeContacts(access: StaffAccessSnapshot): boolean {
  return canSeeLeadDetails(access);
}

export function leadAccessOf(access: StaffAccessSnapshot): LeadAccess {
  return {
    contacts: canSeeContacts(access),
    manage: decideAccess(access, 'lead.manage').allowed,
    revealSensitive: decideAccess(access, 'sensitive.reveal').allowed,
    export: decideAccess(access, 'lead.export').allowed,
    revenue: decideAccess(access, 'revenue.view').allowed,
  };
}
