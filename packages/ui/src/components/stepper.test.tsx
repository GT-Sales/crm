import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Stepper, type StepperStep } from './stepper';

const steps: readonly StepperStep[] = [
  { id: 'plan', label: 'Choose a plan' },
  { id: 'details', label: 'Your details' },
  { id: 'review', label: 'Review and submit' },
];

/** Mirrors the `as const` step list a client component passes (T13 order form). */
const readonlySteps: readonly [
  { readonly id: 'plan'; readonly label: 'Plan' },
  { readonly id: 'details'; readonly label: 'Details' },
  { readonly id: 'review'; readonly label: 'Review' },
] = [
  { id: 'plan', label: 'Plan' },
  { id: 'details', label: 'Details' },
  { id: 'review', label: 'Review' },
];

function stepItems(): HTMLElement[] {
  const list = screen.getByRole('list', { name: 'Order progress' });
  return within(list).getAllByRole('listitem');
}

describe('Stepper', () => {
  it('labels every step and marks only the current one with aria-current="step"', () => {
    render(<Stepper steps={steps} currentStepId="details" />);

    const items = stepItems();
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual([
      'Completed: Choose a plan',
      '2Your details',
      '3Review and submit',
    ]);

    const current = screen
      .getByRole('list', { name: 'Order progress' })
      .querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('2Your details');
  });

  it('derives complete, current and upcoming states from the step order', () => {
    render(<Stepper steps={steps} currentStepId="details" />);

    expect(stepItems().map((item) => item.getAttribute('data-state'))).toEqual([
      'complete',
      'current',
      'upcoming',
    ]);
    expect(stepItems().map((item) => item.getAttribute('aria-current'))).toEqual([
      null,
      'step',
      null,
    ]);
  });

  it('renders a check icon for completed steps only', () => {
    render(<Stepper steps={steps} currentStepId="details" />);

    const items = stepItems();
    expect(items[0]?.querySelector('svg')).toBeTruthy();
    expect(items[1]?.querySelector('svg')).toBeNull();
    expect(items[2]?.querySelector('svg')).toBeNull();
  });

  it('accepts the readonly literal step list a client component passes', () => {
    render(<Stepper steps={readonlySteps} currentStepId="details" />);

    expect(stepItems().map((item) => item.getAttribute('data-state'))).toEqual([
      'complete',
      'current',
      'upcoming',
    ]);
  });

  it('marks every other step upcoming when the first step is current', () => {
    render(<Stepper steps={steps} currentStepId="plan" />);

    expect(stepItems().map((item) => item.getAttribute('data-state'))).toEqual([
      'current',
      'upcoming',
      'upcoming',
    ]);
    expect(
      screen.getByRole('list', { name: 'Order progress' }).querySelectorAll('svg'),
    ).toHaveLength(0);
  });
});
