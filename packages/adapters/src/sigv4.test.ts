import { describe, expect, it } from 'vitest';

import { presignS3Url, signS3Request, type S3SigningConfig } from './sigv4.js';

const config: S3SigningConfig = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  region: 'us-west-002',
  bucket: 'canadian-plans-backup-archive',
};
const now = new Date('2026-09-14T00:00:00.000Z');

describe('presignS3Url', () => {
  it('is deterministic for a fixed clock and signs the exact key/bucket', () => {
    const a = presignS3Url(config, {
      method: 'GET',
      key: 'run-1/manifest.json.age',
      expiresInSeconds: 60,
      now,
    });
    const b = presignS3Url(config, {
      method: 'GET',
      key: 'run-1/manifest.json.age',
      expiresInSeconds: 60,
      now,
    });
    expect(a).toBe(b);
    expect(a).toContain('/canadian-plans-backup-archive/run-1/manifest.json.age');
    expect(a).toContain('X-Amz-Signature=');
  });

  it('changes the signature when the key changes', () => {
    const a = presignS3Url(config, { method: 'GET', key: 'run-1/a', expiresInSeconds: 60, now });
    const b = presignS3Url(config, { method: 'GET', key: 'run-1/b', expiresInSeconds: 60, now });
    expect(a).not.toBe(b);
  });
});

describe('signS3Request', () => {
  it('signs bucket-level (empty key) requests for ListObjectsV2', () => {
    const { url, headers } = signS3Request(config, {
      method: 'GET',
      key: '',
      headers: {},
      query: { 'list-type': '2', prefix: 'run-1/' },
      now,
    });
    expect(url).toBe(
      'https://s3.us-west-002.backblazeb2.com/canadian-plans-backup-archive?list-type=2&prefix=run-1%2F',
    );
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  });

  it('changes the payload hash and signature when the body changes', () => {
    const a = signS3Request(config, {
      method: 'PUT',
      key: 'run-1/data.sql.age',
      headers: {},
      body: new TextEncoder().encode('one'),
      now,
    });
    const b = signS3Request(config, {
      method: 'PUT',
      key: 'run-1/data.sql.age',
      headers: {},
      body: new TextEncoder().encode('two'),
      now,
    });
    expect(a.headers['x-amz-content-sha256']).not.toBe(b.headers['x-amz-content-sha256']);
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it('signs object-lock headers for the ledger writer without altering the URL', () => {
    const { url, headers } = signS3Request(config, {
      method: 'PUT',
      key: 'events/v1/w1/op-1.json.age',
      headers: {
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': '2027-09-14T00:00:00.000Z',
      },
      body: new Uint8Array([1, 2, 3]),
      now,
    });
    expect(url).toBe(
      'https://s3.us-west-002.backblazeb2.com/canadian-plans-backup-archive/events/v1/w1/op-1.json.age',
    );
    expect(headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
  });
});

describe('an endpoint with a path of its own (Supabase Storage)', () => {
  const supabase: S3SigningConfig = {
    endpoint: 'https://ref.storage.supabase.co/storage/v1/s3/',
    region: 'ap-south-1',
    bucket: 'documents',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
  };

  it('signs and requests the whole path, prefix included', () => {
    const { url, headers } = signS3Request(supabase, {
      method: 'GET',
      key: 'workspaces/w1/candidate/f1',
      headers: {},
      now: new Date('2026-11-07T00:00:00Z'),
    });
    expect(url).toBe(
      'https://ref.storage.supabase.co/storage/v1/s3/documents/workspaces/w1/candidate/f1',
    );
    const other = signS3Request(
      { ...supabase, endpoint: 'https://ref.storage.supabase.co' },
      {
        method: 'GET',
        key: 'workspaces/w1/candidate/f1',
        headers: {},
        now: new Date('2026-11-07T00:00:00Z'),
      },
    );
    expect(headers.authorization).not.toBe(other.headers.authorization);
  });

  it('presigns under the prefix too', () => {
    const url = presignS3Url(supabase, {
      method: 'GET',
      key: 'k',
      expiresInSeconds: 60,
      now: new Date('2026-11-07T00:00:00Z'),
    });
    expect(url.startsWith('https://ref.storage.supabase.co/storage/v1/s3/documents/k?')).toBe(true);
  });
});
