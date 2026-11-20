import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AutomationsPage from './page';

vi.mock('../../../../components/automations/automations-list', () => ({
  SiteAutomations: ({ workspaceSlug }: { workspaceSlug: string }) => (
    <p>flows for {workspaceSlug}</p>
  ),
}));

describe('AutomationsPage', () => {
  it('has the shared header with a one-line description, then the flows', async () => {
    render(await AutomationsPage({ params: Promise.resolve({ workspace: 'canadawide' }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Automations' })).toBeTruthy();
    expect(
      screen.getByText('Flows this site runs on its own when leads arrive, move or wait.'),
    ).toBeTruthy();
    expect(screen.getByText('flows for canadawide')).toBeTruthy();
    expect(screen.queryByText(/Integrations permission/)).toBeNull();
  });
});
