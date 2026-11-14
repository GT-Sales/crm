import { describe, expect, it } from 'vitest';

import { readableSource } from './source-label';

describe('readableSource', () => {
  it.each([
    ['direct', 'Direct'],
    ['utm:google/cpc', 'Google · paid'],
    ['utm:facebook/paid_social', 'Facebook · paid social'],
    ['utm:newsletter', 'Newsletter'],
    ['utm:partnersite/banner', 'Partnersite · banner'],
    ['referrer:facebook.com', 'Facebook'],
    // A click out of the Facebook or Instagram app arrives from Meta's link shim.
    ['referrer:l.facebook.com', 'Facebook'],
    ['referrer:l.instagram.com', 'Instagram'],
    ['referrer:www.google.com', 'Google · search'],
    ['referrer:notfacebook.com', 'notfacebook.com'],
    ['referrer:some.example', 'some.example'],
    ['partner:MAPLE10', 'Partner MAPLE10'],
    ['partner:MAPLE10 (unmatched)', 'Partner MAPLE10 (no match)'],
    ['something-new', 'something-new'],
  ])('reads %s as %s', (source, expected) => {
    expect(readableSource(source)).toBe(expected);
  });
});
