import { createHash } from 'node:crypto';
import type { AiSource } from '@gt-sales/contracts';

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
    const created: AiSource = {
      ...source,
      label: source.label.slice(0, SourceRegistry.MAX_LABEL),
      scope: source.scope.slice(0, 300),
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
    return this.add({
      id: `lead-${leadId}`,
      kind: 'lead',
      label,
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}/leads/${leadId}`,
      scope,
    });
  }

  /** Reports → Sources: the report page never claims to reproduce an AI filter. */
  sourceReport(label: string, scope: string): AiSource {
    return this.add({
      id: `report-sources-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}`,
      kind: 'report',
      label: `Open report · ${label}`,
      href: `/w/${encodeURIComponent(this.context.workspaceSlug)}/reports/sources`,
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
