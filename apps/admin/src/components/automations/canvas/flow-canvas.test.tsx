import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { EMPTY_FLOW_DRAFT } from '@gt-sales/contracts';
import { FlowCanvas } from './flow-canvas';
import { namesFromCode } from '../flow-words';

it('moves focus through the step menu with arrows and returns it on Escape', async () => {
  render(
    <FlowCanvas
      definition={EMPTY_FLOW_DRAFT}
      names={namesFromCode()}
      selectedId={undefined}
      onSelectNode={vi.fn()}
      onAddStep={vi.fn()}
    />,
  );
  const add = await screen.findByRole('button', { name: 'Add first step' });
  expect(add.closest('.react-flow__node')).toHaveProperty('style.pointerEvents', 'all');
  expect(add.closest('.react-flow__node')?.getAttribute('tabindex')).toBeNull();
  fireEvent.click(add);
  const email = await screen.findByRole('menuitem', { name: 'Send email' });
  await waitFor(() => expect(document.activeElement).toBe(email));
  expect(add.closest('.react-flow__node')).toHaveProperty('style.zIndex', '1000');
  fireEvent.keyDown(email, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Create task' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(add);
  expect(screen.queryByRole('menu')).toBeNull();
});
