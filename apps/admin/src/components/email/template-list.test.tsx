import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_AUTOMATIONS,
  CUSTOMER_EMAIL_TEMPLATES,
  type CustomerEmailTemplate,
  type EmailTemplate,
} from '@gt-sales/contracts';

import { TemplateList } from './template-list';

function template(key: CustomerEmailTemplate, version = 0): EmailTemplate {
  return {
    key,
    subject: `Subject of ${key}`,
    body: `Body of ${key}`,
    version,
    updatedAt: version === 0 ? null : '2026-10-01T00:00:00.000Z',
    updatedBy: version === 0 ? null : '30000000-0000-4000-8000-000000000001',
  };
}

const templates = CUSTOMER_EMAIL_TEMPLATES.map((key) =>
  template(key, key === 'dispatched' ? 3 : 0),
);

const ruleLabel = (key: string) =>
  BUILT_IN_AUTOMATIONS.find((rule) => rule.key === key)?.label ?? key;

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

  it('links each rule that sends an email to the Automations page', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    const links = within(row('Activated')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      ruleLabel('sim_order_activated'),
      ruleLabel('mobility_activated'),
    ]);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/w/canadawide/automations');
    }
    expect(within(row('Activated')).getAllByText(/Used by:/)).toHaveLength(2);
  });

  it('says who sends the emails no rule sends', () => {
    render(<TemplateList workspaceSlug="canadawide" templates={templates} onEdit={vi.fn()} />);
    expect(
      within(row('SIM number ready')).getByText('Sent by staff from the lead page'),
    ).toBeTruthy();
    expect(within(row('SIM number ready')).queryByRole('link')).toBeNull();
    expect(
      within(row('Tracking code')).getByText('Sent by order tracking (coming next)'),
    ).toBeTruthy();
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
