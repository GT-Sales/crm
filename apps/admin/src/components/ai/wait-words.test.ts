import { describe, expect, it } from 'vitest';

import { aiErrorText, waitInWords } from './assistant-message';

describe('waitInWords, the one rate-limit wait in words', () => {
  it.each([
    [0.4, '1 second'],
    [1, '1 second'],
    [30, '30 seconds'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [1_490, '25 minutes'],
    [3_599, '60 minutes'],
    [3_600, 'about an hour'],
    [3_700, 'about an hour'],
    [7_200, 'about 2 hours'],
  ])('%s seconds read as "%s"', (seconds, words) => {
    expect(waitInWords(seconds)).toBe(words);
  });

  it('is what both rate-limit sentences say', () => {
    expect(aiErrorText('rate_limited', 30)).toBe(
      'Too many questions right now. Try again in 30 seconds.',
    );
    expect(aiErrorText('high_effort_limited', 3_600)).toBe(
      'You have used High effort a lot in the last hour. Ask at Normal effort, or try again in about an hour.',
    );
    expect(aiErrorText('rate_limited')).toBe(
      'Too many questions right now. Wait a minute and then try again.',
    );
  });
});
