import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AssistantMarkdown } from './assistant-markdown';

describe('formatted assistant replies', () => {
  it('renders the count and stage breakdown as semantic text, lists and a table', () => {
    const { container } = render(
      <AssistantMarkdown
        text={
          '## SIM orders\n\n- **Total received:** **23** orders\n- Period: last 30 days\n\n| Stage | Count |\n| --- | ---: |\n| Pending | 8 |\n| Verified | 5 |\n\n*Counts include drafts.*'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'SIM orders' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('23').tagName).toBe('STRONG');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    expect(within(table).getByRole('cell', { name: 'Pending' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Answer table' }).className).toContain(
      'overflow-x-auto',
    );
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('| ---');
  });

  it('never turns model links, images or HTML into active content', () => {
    const { container } = render(
      <AssistantMarkdown
        text={
          '[External](https://attacker.invalid) [Internal](/w/other/leads)\n\nhttps://attacker.invalid\n\n![Tracking pixel](https://attacker.invalid/pixel)\n\n<script>alert(1)</script>\n<iframe src="https://attacker.invalid"></iframe>\n\n<img src="x" onerror="alert(1)">'
        }
      />,
    );
    expect(screen.getByText('External')).toBeTruthy();
    expect(container.textContent).toContain('https://attacker.invalid');
    expect(container.querySelector('a, img, script, iframe')).toBeNull();
  });

  it('updates incomplete streamed formatting without losing the answer', () => {
    const { rerender } = render(<AssistantMarkdown text="There are **23" />);
    expect(screen.getByText(/There are/)).toBeTruthy();
    rerender(<AssistantMarkdown text="There are **23 orders**." />);
    expect(screen.getByText('23 orders').tagName).toBe('STRONG');
  });
});
