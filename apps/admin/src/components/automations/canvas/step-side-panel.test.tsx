import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowCatalogResponse, FlowDraftStep } from '@gt-sales/contracts';
import { StepSidePanel } from './step-side-panel';

const catalog: FlowCatalogResponse = {
  leadTypes: [],
  plans: [],
  members: [],
  templates: [],
  taskVariables: [],
  requestId: 'test',
  properties: [
    {
      key: 'custom_yes',
      label: 'Confirmed',
      kind: 'yesNo',
      leadTypes: [],
      condition: true,
      update: true,
      taskVariable: true,
      emailVariable: true,
    },
    {
      key: 'custom_choice',
      label: 'Delivery',
      kind: 'choice',
      options: [{ value: 'pickup', label: 'Collect in store' }],
      leadTypes: [],
      condition: true,
      update: true,
      taskVariable: true,
      emailVariable: true,
    },
  ],
};
function panel(step: FlowDraftStep) {
  const update = vi.fn();
  const close = vi.fn();
  const move = vi.fn();
  render(
    <StepSidePanel
      workspaceSlug="test"
      selectedId={step.id}
      trigger={null}
      step={step}
      issues={[]}
      catalog={catalog}
      readOnly={false}
      onUpdateTrigger={vi.fn()}
      onUpdateStep={update}
      onRemoveStep={vi.fn()}
      onClose={close}
      onMoveStep={move}
      canMoveUp
    />,
  );
  return { update, close, move };
}
describe('step side panel', () => {
  it('labels a boolean selector and writes booleans instead of typed strings', () => {
    const step: FlowDraftStep = {
      id: 's_yes',
      kind: 'update_lead',
      change: { kind: 'property', key: 'custom_yes', value: true },
    };
    const { update } = panel(step);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'false' } });
    expect(update.mock.calls[0]?.[1](step).change.value).toBe(false);
    expect(screen.getByRole('option', { name: 'Yes' })).toBeDefined();
  });
  it('offers choice labels and preserves stored option keys', () => {
    const step: FlowDraftStep = {
      id: 's_choice',
      kind: 'update_lead',
      change: { kind: 'property', key: 'custom_choice', value: null },
    };
    const { update } = panel(step);
    expect(screen.getByRole('option', { name: 'Collect in store' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'pickup' } });
    expect(update.mock.calls[0]?.[1](step).change.value).toBe('pickup');
  });
  it('focuses the heading, closes with Escape, and exposes labelled movement controls', () => {
    const { close, move } = panel({ id: 's_wait', kind: 'wait', for: { amount: 1, unit: 'days' } });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Wait' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(move).toHaveBeenCalledWith('s_wait', 'up');
    expect(screen.getByRole('button', { name: 'Move down' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Wait for'), { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
