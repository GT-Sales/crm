import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnswerBlocks } from './answer-blocks';

const LEAD = '11111111-1111-4111-8111-111111111111';

describe('AnswerBlocks', () => {
  it('lists leads with links, stages and how many more there are', () => {
    render(
      <AnswerBlocks
        blocks={[
          {
            kind: 'leads',
            title: 'Leads',
            rows: [
              {
                label: 'Ada Lovelace',
                stage: 'Pending',
                fact: 'Unassigned',
                href: `/w/gcs/leads/${LEAD}`,
              },
              // A link that could leave the admin is shown as text.
              { label: 'MS-2', stage: null, fact: null, href: '//elsewhere.example' },
            ],
            more: 12,
          },
        ]}
      />,
    );
    const block = screen.getByRole('region', { name: 'Leads' });
    expect(within(block).getByRole('link', { name: 'Ada Lovelace' }).getAttribute('href')).toBe(
      `/w/gcs/leads/${LEAD}`,
    );
    expect(within(block).queryByRole('link', { name: 'MS-2' })).toBeNull();
    expect(within(block).getByText('MS-2')).toBeTruthy();
    expect(within(block).getByText('Pending')).toBeTruthy();
    expect(within(block).getByText('And 12 more.')).toBeTruthy();
  });

  it('shows figures with their change against the period before', () => {
    render(
      <AnswerBlocks
        blocks={[
          {
            kind: 'stats',
            title: 'Last 30 days',
            tiles: [
              { label: 'New leads', value: 40, previous: 32 },
              { label: 'Paid', value: 4, previous: 6 },
              { label: 'Won', value: 9, previous: 9 },
              { label: 'Overdue', value: 1, previous: null },
            ],
          },
        ]}
      />,
    );
    const block = screen.getByRole('region', { name: 'Last 30 days' });
    expect(within(block).getByText('+8 vs before')).toBeTruthy();
    expect(within(block).getByText('−2 vs before')).toBeTruthy();
    expect(within(block).getByText('Same as before')).toBeTruthy();
    // No comparison: the figure alone.
    const overdue = within(block).getByText('Overdue').parentElement;
    expect(overdue?.textContent).toBe('Overdue1');
  });

  it('ranks rows with bars sized against the largest', () => {
    render(
      <AnswerBlocks
        blocks={[
          {
            kind: 'ranking',
            title: 'Leads by source',
            rows: [
              { label: 'google', value: 20 },
              { label: 'facebook', value: 5 },
            ],
          },
        ]}
      />,
    );
    const items = within(screen.getByRole('region', { name: 'Leads by source' })).getAllByRole(
      'listitem',
    );
    const width = (item: HTMLElement | undefined) =>
      item?.querySelector<HTMLElement>('[style]')?.style.width;
    expect(width(items[0])).toBe('100%');
    expect(width(items[1])).toBe('25%');
  });

  it('draws nothing without blocks', () => {
    const { container } = render(<AnswerBlocks blocks={[]} />);
    expect(container.textContent).toBe('');
  });
});
