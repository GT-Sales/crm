import { describe, expect, it } from 'vitest';

import { readableSource } from './source-label';

describe('readableSource', () => {
  it.each([
    ['direct', 'Direct'],
    ['utm:google/cpc', 'Google · paid'],
    ['utm:facebook/paid_social', 'Facebook · paid social'],
    ['utm:newsletter', 'Newsletter'],
    ['utm:partnersite/banner', 'Partnersite · banner'],
    ['referrer:facebook.com', 'facebook.com'],
    ['partner:MAPLE10', 'Partner MAPLE10'],
    ['partner:MAPLE10 (unmatched)', 'Partner MAPLE10 (no match)'],
    ['something-new', 'something-new'],
  ])('reads %s as %s', (source, expected) => {
    expect(readableSource(source)).toBe(expected);
  });
});
