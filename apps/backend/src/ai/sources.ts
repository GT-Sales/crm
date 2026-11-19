import { createHash } from 'node:crypto';
import type { AiSource, LeadPropertyFilter } from '@gt-sales/contracts';

import { inertRecordText } from './record-text.js';

/**
 * The source cards one turn may show.
 *
 * A card is created only here, only after a successful authorized read, and
 * only from identifiers the backend verified — the model never supplies a
 * label, a link or an id. The href is always site-relative, so a card cannot
 * navigate off the CRM even if a record's text looks like a URL.
 */
export interface SourceContext {
  readonly workspaceSlug: string;
  /** The instant every card reports as its as-of time. */
  readonly asOf: Date;
  /**
   * Told of every lead a card is made for, past the card cap too: the turn
   * keeps them for the mention check of email and note cards (B1).
   */
  readonly onLead?: (leadId: string) => void;
}

export class SourceRegistry {
  /** The contract caps one `sources` part at 20 cards; the registry does too. */
  static readonly MAX_SOURCES = 20;
  /** The contract caps a label at 120 characters. */
  static readonly MAX_LABEL = 120;

  private readonly byId = new Map<string, AiSource>();

  constructor(private readonly context: SourceContext) {}

  private add(source: Omit<AiSource, 'asOf'>): AiSource {
    const existing = this.byId.get(source.id);
    if (existing) return existing;
    // A label or scope may carry a lead's name or a filter's words: cleaned
    // like every other record text before it reaches the model or the card.
    const created: AiSource = {
      ...source,
      label: inertRecordText(source.label, SourceRegistry.MAX_LABEL) ?? 'Record',
      scope: inertRecordText(source.scope, 300) ?? 'This site',
      asOf: this.context.asOf.toISOString(),
    };
    // Past the cap the card is described to the caller but never published, so
    // a page of ten leads still yields a valid `sources` frame.
    if (this.byId.size >= SourceRegistry.MAX_SOURCES) return created;
    this.byId.set(created.id, created);
    return created;
  }

  /** The lead page, from a lead id the query just returned. */
  lead(leadId: string, label: string, scope: string): AiSource {
    this.context.onLead?.(leadId);
    return this.add({
      id: `lead-${leadId}`,
      kind: 'lead',
      label,
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}/leads/${leadId}`,
      scope,
    });
  }

  /** Dashboard → sources card → full table: it never claims to reproduce an AI filter. */
  sourceReport(label: string, scope: string): AiSource {
    return this.add({
      id: `report-sources-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}`,
      kind: 'report',
      label: `Open report · ${label}`,
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}/dashboard?report=sources`,
      scope,
    });
  }

  /** The leads inbox, filtered only as far as its URL can actually reproduce. */
  leadsInbox(scope: string): AiSource {
    return this.add({
      id: `overview-leads-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}`,
      kind: 'overview',
      label: 'Leads inbox',
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}/leads`,
      scope,
    });
  }

  /**
   * The leads inbox with the filters its URL can reproduce (`inbox-query.ts`
   * in the admin): the archive, one type, a stage of that type, the assignee,
   * due today or earlier, and property filters. Every value was validated by
   * the tool before it gets here (lead type and stage against the catalogue,
   * property filters with the staff route's own validator); the model never
   * supplies a URL, only the filters the server already checked.
   */
  leadsInboxFiltered(
    filters: {
      readonly archived: boolean;
      readonly leadType?: string;
      readonly stage?: string;
      readonly assignee?: string;
      readonly dueToday: boolean;
      readonly where?: readonly LeadPropertyFilter[];
    },
    scope: string,
  ): AiSource {
    const params = new URLSearchParams();
    if (filters.archived) params.set('archived', '1');
    else if (filters.leadType !== undefined) params.set('type', filters.leadType);
    if (filters.dueToday && !filters.archived) params.set('due', '1');
    if (filters.stage !== undefined && filters.leadType !== undefined && !filters.archived)
      params.set('stage', filters.stage);
    if (filters.assignee !== undefined) params.set('assignee', filters.assignee);
    if (filters.where !== undefined && filters.where.length > 0 && !filters.archived)
      params.set('where', JSON.stringify(filters.where));
    const query = params.toString();
    const href = `/w/${encodeURIComponent(this.context.workspaceSlug)}/leads${query === '' ? '' : `?${query}`}`;
    return this.add({
      id: `inbox-${createHash('sha256').update(href).digest('hex').slice(0, 8)}`,
      kind: 'overview',
      label: 'Open in the leads inbox',
      // The contract caps a link at 400 characters; a longer one is the plain inbox.
      href:
        href.length <= 400 ? href : `/w/${encodeURIComponent(this.context.workspaceSlug)}/leads`,
      scope,
    });
  }

  /**
   * One admin screen, from a fixed list of site-relative paths in code (see
   * `ADMIN_SCREENS`). This is how Ask AI points to a screen for the things a
   * person does there themselves; the path never comes from the model.
   */
  screen(screen: AdminScreen, scope: string): AiSource {
    const entry = ADMIN_SCREENS[screen];
    return this.add({
      id: `screen-${screen.replace(/_/g, '-')}`,
      kind: entry.kind,
      label: entry.label,
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}${entry.path}`,
      scope,
    });
  }

  /** Follow-ups, shown on the tasks page. */
  tasks(scope: string): AiSource {
    return this.add({
      id: `tasks-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}`,
      kind: 'tasks',
      label: 'Follow-ups',
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}/tasks`,
      scope,
    });
  }

  list(): AiSource[] {
    return [...this.byId.values()];
  }
}

/**
 * The admin screens Ask AI may link to, by a fixed name. Paths are the
 * admin's own routes (`apps/admin/src/app/w/[workspace]/…`); a screen is
 * linked only after the tool that names it has run its access check.
 */
export const ADMIN_SCREENS = {
  plans: { path: '/settings/plans', label: 'Settings → Plans', kind: 'overview' },
  properties: {
    path: '/settings/properties',
    label: 'Settings → Fields and layouts',
    kind: 'overview',
  },
  analytics: { path: '/analytics', label: 'Analytics', kind: 'report' },
  dashboard: { path: '/dashboard', label: 'Dashboard', kind: 'report' },
  // Documents are reviewed on each lead's page; there is no Documents page.
  documents: { path: '/leads', label: 'Leads', kind: 'overview' },
  mail: { path: '/mail', label: 'Mail', kind: 'overview' },
  jobs: { path: '/settings/jobs', label: 'Settings → Background jobs', kind: 'overview' },
  team: { path: '/settings/team', label: 'Settings → Team', kind: 'overview' },
  email_settings: { path: '/settings/email', label: 'Settings → Email', kind: 'overview' },
  automations: { path: '/automations', label: 'Automations', kind: 'overview' },
  integrations: {
    path: '/settings/integrations',
    label: 'Settings → Integrations',
    kind: 'overview',
  },
} as const satisfies Record<
  string,
  { readonly path: string; readonly label: string; readonly kind: AiSource['kind'] }
>;

export type AdminScreen = keyof typeof ADMIN_SCREENS;
