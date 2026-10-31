import { describe, expect, it } from 'vitest';

import { isClosingStage } from '../src/leads/work-store.js';

describe('isClosingStage', () => {
  it('names the stages that close an unsubmitted lead without rescuing it', () => {
    expect(isClosingStage('sim_order', 'cancelled')).toBe(true);
    expect(isClosingStage('internet', 'lost')).toBe(true);
    expect(isClosingStage('internet', 'non_serviceable_address')).toBe(true);
    expect(isClosingStage('mobility', 'lost')).toBe(true);
    expect(isClosingStage('partner_application', 'declined')).toBe(true);
    expect(isClosingStage('contact_message', 'closed')).toBe(true);
  });

  it('treats every other stage as a rescue', () => {
    expect(isClosingStage('sim_order', 'pending')).toBe(false);
    expect(isClosingStage('internet', 'contacted')).toBe(false);
    expect(isClosingStage('contact_message', 'replied')).toBe(false);
    expect(isClosingStage('unknown_type', 'closed')).toBe(false);
  });
});
