import { describe, expect, it } from 'vitest';
import { EMPTY_FLOW_DRAFT } from '@gt-sales/contracts';

import {
  countNestedSteps,
  findStepById,
  insertStepAt,
  removeStepById,
  updateStepById,
} from './draft-mutations';

describe('draft-mutations', () => {
  it('inserts a step into a sequence and moves trailing steps into Yes when inserting if_else (R7)', () => {
    const first = insertStepAt(EMPTY_FLOW_DRAFT, 'steps', 0, 'send_email');
    expect(first.movedToYesCount).toBe(0);
    expect(first.draft.steps).toHaveLength(1);
    expect(first.draft.steps[0]?.kind).toBe('send_email');

    const second = insertStepAt(first.draft, 'steps', 0, 'if_else');
    expect(second.movedToYesCount).toBe(1);
    expect(second.draft.steps).toHaveLength(1);
    const ifStep = second.draft.steps[0]!;
    expect(ifStep.kind).toBe('if_else');
    if (ifStep.kind === 'if_else') {
      expect(ifStep.then.map((step) => step.id)).toEqual([first.stepId]);
      expect(ifStep.else).toEqual([]);
    }
  });

  it('inserts into nested branches, updates by id, and removes by id', () => {
    const withIf = insertStepAt(EMPTY_FLOW_DRAFT, 'steps', 0, 'if_else');
    const inNo = insertStepAt(withIf.draft, 'steps.0.else', 0, 'create_task');
    const found = findStepById(inNo.draft.steps, inNo.stepId);
    expect(found?.path).toBe('steps.0.else.0');
    expect(found?.depth).toBe(1);

    const updated = updateStepById(inNo.draft, inNo.stepId, (step) =>
      step.kind === 'create_task' ? { ...step, title: 'Call customer' } : step,
    );
    const updatedStep = findStepById(updated.steps, inNo.stepId)?.step;
    expect(updatedStep?.kind === 'create_task' && updatedStep.title).toBe('Call customer');

    const ifStep = updated.steps[0]!;
    expect(countNestedSteps(ifStep)).toBe(1);

    const removed = removeStepById(updated, inNo.stepId);
    expect(findStepById(removed.steps, inNo.stepId)).toBeUndefined();
    expect(countNestedSteps(removed.steps[0]!)).toBe(0);
  });
});
