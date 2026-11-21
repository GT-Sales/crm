import { DEFAULT_DOCUMENT_TYPE_KEYS } from '@gt-sales/contracts';
import { describe, expect, it } from 'vitest';

import { PLAN_DOCUMENT_TYPES, documentTypeLabel } from './document-types';

describe('plan document types', () => {
  it('offers the contract keys, in order, each with a written label', () => {
    expect([...PLAN_DOCUMENT_TYPES]).toEqual([...DEFAULT_DOCUMENT_TYPE_KEYS]);
    expect(PLAN_DOCUMENT_TYPES.map(documentTypeLabel)).toEqual([
      'Passport',
      'Visa',
      'Study permit',
      'Work permit',
      "Driver's licence",
      'Provincial ID',
    ]);
  });
});
