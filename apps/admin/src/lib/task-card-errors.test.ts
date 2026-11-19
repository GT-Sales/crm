import { describe, expect, it } from 'vitest';
import { BackendError } from '@gt-sales/contracts';

import { describeError } from './error-text';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const conflict = (reason?: string) =>
  new BackendError('conflict', 409, REQUEST_ID, reason === undefined ? undefined : { reason });

describe('a refused revision of a task card says why', () => {
  it('says the task is already in that stage', () => {
    expect(describeError(conflict('already_in_stage'), 'update the draft')).toBe(
      'The task is already in that stage. Pick another stage.',
    );
  });

  it('says the task cannot be moved from here when its lead is archived', () => {
    expect(describeError(conflict('task_unavailable'), 'update the draft')).toBe(
      'This task can no longer be changed from Ask AI. Check it on the Tasks page.',
    );
  });

  it('says the task could not be checked just now', () => {
    expect(describeError(conflict('temporary_failure'), 'update the draft')).toBe(
      'The task could not be checked just now. Try again in a moment.',
    );
  });

  it('says a task that is gone is gone, and keeps the other conflicts as they were', () => {
    expect(
      describeError(new BackendError('task_not_found', 404, REQUEST_ID), 'update the draft'),
    ).toBe('This task no longer exists. Reload the page to see the latest, then try again.');
    expect(describeError(conflict(), 'save the change')).toBe(
      'Something else changed at the same time. Reload the page to see the latest, then try again.',
    );
  });
});
