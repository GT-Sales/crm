import { describe, expect, test } from 'vitest';

import { requiredEnv } from './env.js';

describe('requiredEnv', () => {
  test('trims a value pasted with a trailing newline', () => {
    expect(requiredEnv('KEY', { KEY: '  https://s3.example.com\n' })).toBe(
      'https://s3.example.com',
    );
  });

  test('names a missing or blank variable without its value', () => {
    expect(() => requiredEnv('KEY', {})).toThrow('KEY is required');
    expect(() => requiredEnv('KEY', { KEY: ' \n' })).toThrow('KEY is required');
  });
});
