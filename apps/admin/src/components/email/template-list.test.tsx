import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_AUTOMATIONS,
  CUSTOMER_EMAIL_TEMPLATES,
  emailTemplateLabel,
  type SiteEmailTemplate,
} from '@gt-sales/contracts';

import { TemplateList } from './template-list';

const ruleLabel = (key: string) =>
  BUILT_IN_AUTOMATIONS.find((rule) => rule.key === key)?.label ?? key;

/** The flows each template is sent by, as the backend answers `usedBy`. */
const SENT_BY: Partial<Record<string, SiteEmailTemplate['usedBy']>> = {
  dispatched: [{ key: 'sim_order_dispatched', name: 'Dispatched email' }],
  activated: [
    { key: 'sim_order_activated', name: ruleLabel('sim_order_activated') },
    { key: 'mobility_activated', name: ruleLabel('mobility_activated') },
  ],
};

function template(key: string, version = 0): SiteEmailTemplate {
  return {
    key,
    name: emailTemplateLabel(key, key.startsWith('tpl_') ? 'Site note' : null),
    subject: `Subject of ${key}`,
    body: `Body of ${key}`,
    version,
    updatedAt: version === 0 ? null : '2026-10-01T00:00:00.000Z',
    updatedBy: version === 0 ? null : '30000000-0000-4000-8000-000000000001',
    archived: false,
    usedBy: SENT_BY[key] ?? [],
  };
}

const templates = [
  ...CUSTOMER_EMAIL_TEMPLATES.map((key) => template(key, key === 'dispatched' ? 3 : 0)),
  // Site-made templates are listed in a later release.
  template('tpl_abcdefghij012345', 1),
];

function row(label: string) {
  const item = screen
    .getAllByRole('listitem')
    .find((entry) => within(entry).queryByRole('heading', { name: label }) !== null);
  if (!item) throw new Error(`no row ${label}`);
  return item;
}

describe('TemplateList', () => {
  it('lists the nine emails by label, with no on/off switch', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    const list = screen.getByRole('list', { name: 'Emails' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    for (const label of [
      'Tracking code',
      'Order received',
      'Information needed',
      'Dispatched',
      'Activated',
      'Cancelled',
      'SIM number ready',
      'Change approved',
      'Change rejected',
    ]) {
      expect(within(list).getByRole('heading', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('reads Starter text for version 0 and the version otherwise', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    expect(within(row('Dispatched')).getByText('Version 3')).toBeTruthy();
    expect(within(row('Cancelled')).getByText('Starter text')).toBeTruthy();
  });

  it('links each flow that sends an email to its page, from usedBy', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    const links = within(row('Activated')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      ruleLabel('sim_order_activated'),
      ruleLabel('mobility_activated'),
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/w/canadawide/automations/sim_order_activated',
      '/w/canadawide/automations/mobility_activated',
    ]);
    expect(within(row('Activated')).getAllByText(/Used by:/)).toHaveLength(2);
    expect(within(row('Dispatched')).getByText(/Used by:/).textContent).toBe(
      'Used by: Dispatched email',
    );
    expect(within(row('Cancelled')).queryByText(/Used by:/)).toBeNull();
  });

  it('shows the nine built-ins and no site-made row', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.queryByRole('heading', { name: 'Site note' })).toBeNull();
  });

  it('says who sends the emails no rule sends', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    expect(
      within(row('SIM number ready')).getByText('Sent by staff from the lead page'),
    ).toBeTruthy();
    expect(within(row('SIM number ready')).queryByRole('link')).toBeNull();
  });

  it('says when the three always-sent emails go out, with no rule and no switch', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    const lines: Record<string, string> = {
      'Tracking code': 'Always sent: when a customer asks for a code on the tracking page',
      'Change approved': "Always sent: when staff approve a customer's change request",
      'Change rejected': "Always sent: when staff reject a customer's change request",
    };
    for (const [label, line] of Object.entries(lines)) {
      expect(within(row(label)).getByText(line)).toBeTruthy();
      expect(within(row(label)).queryByRole('link')).toBeNull();
      expect(within(row(label)).queryByText(/Used by/)).toBeNull();
    }
    expect(screen.queryByText(/coming next/)).toBeNull();
    // The emails a rule sends do not claim to be always sent.
    expect(within(row('Dispatched')).queryByText(/Always sent/)).toBeNull();
    expect(screen.getAllByText(/^Always sent:/)).toHaveLength(3);
  });

  it('opens an email for editing', () => {
    const onEdit = vi.fn();
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Dispatched' }));
    expect(onEdit).toHaveBeenCalledWith('dispatched');
  });

  it('hides Edit when the page is read-only', () => {
    render(
      <TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} readOnly />,
    );
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });
});
