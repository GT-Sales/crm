import { describe, expect, it } from 'vitest';

import { envFlag, optionalEnv, optionalPositiveInteger, requiredEnv } from '../src/archive/env.js';

describe('requiredEnv', () => {
  it('returns a set value', () => {
    expect(requiredEnv('B2_ARCHIVE_BUCKET', { B2_ARCHIVE_BUCKET: 'gt-sales-archive' })).toBe(
      'gt-sales-archive',
    );
  });

  it.each([undefined, '', '   '])('throws NAME is required when the value is %j', (value) => {
    expect(() => requiredEnv('B2_ARCHIVE_BUCKET', { B2_ARCHIVE_BUCKET: value })).toThrow(
      'B2_ARCHIVE_BUCKET is required',
    );
  });
});

describe('optionalEnv', () => {
  it('returns the trimmed value, or undefined when unset or blank', () => {
    expect(optionalEnv('BACKUP_RUN_ID', { BACKUP_RUN_ID: ' run-1 ' })).toBe('run-1');
    expect(optionalEnv('BACKUP_RUN_ID', {})).toBeUndefined();
    expect(optionalEnv('BACKUP_RUN_ID', { BACKUP_RUN_ID: '  ' })).toBeUndefined();
  });
});

describe('optionalPositiveInteger', () => {
  it('returns undefined when unset or blank', () => {
    expect(optionalPositiveInteger('BACKUP_MAX_SNAPSHOT_BYTES', {})).toBeUndefined();
    expect(
      optionalPositiveInteger('BACKUP_MAX_SNAPSHOT_BYTES', { BACKUP_MAX_SNAPSHOT_BYTES: '' }),
    ).toBeUndefined();
  });

  it('parses a positive whole number', () => {
    expect(
      optionalPositiveInteger('BACKUP_MAX_SNAPSHOT_BYTES', { BACKUP_MAX_SNAPSHOT_BYTES: '2048' }),
    ).toBe(2048);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'throws NAME must be a positive whole number for %j',
    (value) => {
      expect(() =>
        optionalPositiveInteger('BACKUP_MAX_SNAPSHOT_BYTES', { BACKUP_MAX_SNAPSHOT_BYTES: value }),
      ).toThrow('BACKUP_MAX_SNAPSHOT_BYTES must be a positive whole number');
    },
  );
});

describe('envFlag', () => {
  it.each(['1', 'true', 'YES'])('is true for %j', (value) => {
    expect(envFlag('RETENTION_DRY_RUN', { RETENTION_DRY_RUN: value })).toBe(true);
  });

  it.each([undefined, '0', 'false', 'no'])('is false for %j', (value) => {
    expect(envFlag('RETENTION_DRY_RUN', { RETENTION_DRY_RUN: value })).toBe(false);
  });
});
