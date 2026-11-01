'use client';

import type { JSX } from 'react';
import Link from 'next/link';
import {
  ALWAYS_SENT_TEMPLATES,
  CUSTOMER_EMAIL_TEMPLATE_LABELS,
  customerEmailTemplateSchema,
  isSiteTemplateKey,
  type CustomerEmailTemplate,
  type EmailTemplateKey,
  type SiteEmailTemplate,
  type SiteTemplateKey,
} from '@gt-sales/contracts';
import { Badge, Button } from '@gt-sales/ui';

/** Who sends the emails no automation rule sends. */
const SENT_BY_STAFF: Partial<Record<CustomerEmailTemplate, string>> = {
  sim_number_ready: 'Sent by staff from the lead page',
};

/** When each always-sent email goes out (`ALWAYS_SENT_TEMPLATES`): no rule decides it. */
const ALWAYS_SENT_WHEN: Partial<Record<CustomerEmailTemplate, string>> = {
  tracking_code: 'Always sent: when a customer asks for a code on the tracking page',
  change_approved: "Always sent: when staff approve a customer's change request",
  change_rejected: "Always sent: when staff reject a customer's change request",
};

/**
 * The site's customer emails, in Settings → Email order: the nine built-in
 * templates followed by the site's own (`tpl_…`). Shows each one's label or
 * name, whether it is still the starter text or which saved version it is,
 * what sends it ("Used by" the flows whose active version sends it, each
 * linking to its flow; the always-sent emails say when they go out), Edit, and
 * Archive for site-made templates.
 */
export function TemplateList({
  workspaceSlug,
  templates,
  onEdit,
  onArchive,
  readOnly = false,
}: {
  workspaceSlug: string;
  templates: SiteEmailTemplate[];
  onEdit(key: EmailTemplateKey): void;
  onArchive?(key: SiteTemplateKey): void;
  /** The caller may not change email settings: no Edit or Archive. */
  readOnly?: boolean;
}): JSX.Element {
  return (
    <ul aria-label="Emails" className="divide-y divide-border/70">
      {templates.map((template) => {
        const builtIn = customerEmailTemplateSchema.safeParse(template.key);
        const siteMade = isSiteTemplateKey(template.key) ? template.key : undefined;
        const label = builtIn.success
          ? CUSTOMER_EMAIL_TEMPLATE_LABELS[builtIn.data]
          : template.name;
        const sentBy = builtIn.success
          ? ALWAYS_SENT_TEMPLATES.includes(builtIn.data)
            ? ALWAYS_SENT_WHEN[builtIn.data]
            : SENT_BY_STAFF[builtIn.data]
          : undefined;
        return (
          <li
            key={template.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5 transition-colors hover:bg-muted/20"
          >
            <div className="mr-auto flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-foreground">{label}</h3>
                <Badge variant="secondary" className="text-[11px] font-normal">
                  {template.version === 0 ? 'Starter text' : `Version ${template.version}`}
                </Badge>
                {siteMade ? (
                  <Badge variant="outline" className="text-[11px] font-normal">
                    Custom
                  </Badge>
                ) : null}
              </div>
              {template.usedBy.map((flow) => (
                <p key={flow.key} className="text-xs text-muted-foreground">
                  Used by:{' '}
                  <Link
                    className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
                    href={`/w/${workspaceSlug}/automations/${flow.key}`}
                  >
                    {flow.name}
                  </Link>
                </p>
              ))}
              {sentBy ? <p className="text-xs text-muted-foreground">{sentBy}</p> : null}
            </div>
            {readOnly ? null : (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${label}`}
                  onClick={() => onEdit(template.key)}
                >
                  Edit
                </Button>
                {siteMade && onArchive ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Archive ${label}`}
                    onClick={() => onArchive(siteMade)}
                  >
                    Archive
                  </Button>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
