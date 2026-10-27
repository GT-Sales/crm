import { describe, expect, it } from 'vitest';
import { leadActivitySchema, type LeadActivity } from '@gt-sales/contracts';

import { changeRequestText, pendingChangeRequest } from './lead-timeline';

const LEGACY = '00000000-0000-4000-8000-00000000a001';

/** A change event as the backend sends it, checked by the contract itself. */
function change(event: string, requestNo: number, extra: Record<string, unknown> = {}) {
  return leadActivitySchema.parse({
    id: `92000000-0000-4000-8000-${event === 'change_requested' ? 'c' : 'd'}${String(requestNo).padStart(11, '0')}`,
    actorId: LEGACY,
    createdAt: `2026-09-0${requestNo}T10:00:00.000Z`,
    kind: 'system',
    event,
    requestNo,
    ...extra,
  });
}

function system(activity: LeadActivity) {
  if (activity.kind !== 'system') throw new Error('expected a system entry');
  return activity;
}

describe('change requests', () => {
  it('finds the newest undecided request, and none once each is decided', () => {
    const newer = change('change_requested', 2);
    const older = change('change_requested', 1);
    expect(pendingChangeRequest([newer, older])?.requestNo).toBe(2);
    const rejected = change('change_rejected', 2);
    expect(pendingChangeRequest([rejected, newer, older])?.requestNo).toBe(1);
    const approved = change('change_approved', 1);
    expect(pendingChangeRequest([rejected, approved, newer, older])).toBeUndefined();
  });

  it('names fields and documents, or the order when it names neither', () => {
    const documentsOnly = system(change('change_requested', 3, { documents: ['passport'] }));
    expect(changeRequestText(documentsOnly, 'sim_order')).toBe('sent a new passport (request #3)');
    const bare = system(change('change_requested', 4));
    expect(changeRequestText(bare, 'sim_order')).toBe('asked to change their order (request #4)');
  });
});
