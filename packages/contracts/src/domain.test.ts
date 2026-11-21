import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCUMENT_TYPE_KEYS, documentChecklistKeySchema } from './domain';

describe('default document types', () => {
  it('keeps the stored keys and their order', () => {
    expect([...DEFAULT_DOCUMENT_TYPE_KEYS]).toEqual([
      'passport',
      'visa',
      'study_permit',
      'work_permit',
      'drivers_licence',
      'provincial_id',
    ]);
  });

  it('are all valid checklist keys', () => {
    for (const key of DEFAULT_DOCUMENT_TYPE_KEYS) {
      expect(documentChecklistKeySchema.safeParse(key).success).toBe(true);
    }
  });
});
