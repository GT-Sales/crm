'use client';

import type { JSX } from 'react';
import Link from 'next/link';
import {
  CUSTOMER_EMAIL_TEMPLATE_LABELS,
  automationsUsingTemplate,
  type CustomerEmailTemplate,
  type EmailTemplate,
} from '@gt-sales/contracts';
import { Button } from '@gt-sales/ui';

/** Who sends the emails no automation rule sends. */
const SENT_WITHOUT_A_RULE: Partial<Record<CustomerEmailTemplate, string>> = {
  sim_number_ready: 'Sent by staff from the lead page',
  tracking_code: 'Sent by order tracking (coming next)',
};

/**
 * The site's seven customer emails, in Settings → Email order: each one's
 * label, whether it is still the starter text or which saved version it is,
 * what sends it ("Used by" the automation rules that name it, linking to the
 * Automations page) and Edit. Whether an email is sent is up to those rules,
 * so the list has no on/off switch.
 */
export function TemplateList({
  workspaceSlug,
  templates,
  onEdit,
  readOnly = false,
}: {
  workspaceSlug: string;
  templates: EmailTemplate[];
  onEdit(key: CustomerEmailTemplate): void;
  /** The caller may not change email settings: no Edit. */
  readOnly?: boolean;
}): JSX.Element {
  const automationsHref = `/w/${workspaceSlug}/automations`;
  return (
    <ul aria-label="Emails" className="divide-y rounded-md border">
      {templates.map((template) => {
        const label = CUSTOMER_EMAIL_TEMPLATE_LABELS[template.key];
        const rules = automationsUsingTemplate(template.key);
        const sentBy = SENT_WITHOUT_A_RULE[template.key];
        return (
          <li key={template.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <div className="mr-auto flex min-w-0 flex-col gap-0.5">
              <h3 className="text-sm font-medium">{label}</h3>
              <p className="text-xs text-muted-foreground">
                {template.version === 0 ? 'Starter text' : `Version ${template.version}`}
              </p>
              {rules.map((rule) => (
                <p key={rule.key} className="text-xs text-muted-foreground">
                  Used by:{' '}
                  <Link className="underline" href={automationsHref}>
                    {rule.label}
                  </Link>
                </p>
              ))}
              {sentBy ? <p className="text-xs text-muted-foreground">{sentBy}</p> : null}
            </div>
            {readOnly ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Edit ${label}`}
                onClick={() => onEdit(template.key)}
              >
                Edit
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
