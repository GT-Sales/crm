import { describe, expect, it } from 'vitest';

import { countryName } from './countries';

describe('countryName', () => {
  it('reads an ISO code as the country’s English name', () => {
    expect(countryName('IN')).toBe('India');
    expect(countryName('ca')).toBe('Canada');
  });

  it('keeps an unknown or malformed code as given', () => {
    expect(countryName('ZZ')).toBe('ZZ');
    expect(countryName('XQ')).toBe('XQ');
    expect(countryName('India')).toBe('India');
    expect(countryName('')).toBe('');
  });
});
