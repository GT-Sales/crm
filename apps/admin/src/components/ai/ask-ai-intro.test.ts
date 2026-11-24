import { describe, expect, it } from 'vitest';

import { askAiIntro } from './ask-ai-intro';

describe('askAiIntro', () => {
  it('is one short line, naming only what the site lets Ask AI draft', () => {
    const none = { actions: false, automations: false };
    expect(askAiIntro('Get Canada Sim’s', none)).toBe(
      'Ask about Get Canada Sim’s leads, orders and follow-ups.',
    );
    expect(askAiIntro('this site’s', { actions: true, automations: false })).toBe(
      'Ask about this site’s leads, orders and follow-ups, or draft a task or a note.',
    );
    expect(askAiIntro('this site’s', { actions: false, automations: true })).toBe(
      'Ask about this site’s leads, orders and follow-ups, or draft an automation.',
    );
    expect(askAiIntro('this site’s', { actions: true, automations: true })).toBe(
      'Ask about this site’s leads, orders and follow-ups, or draft a task, a note or an automation.',
    );
  });
});
