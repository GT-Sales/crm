import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryR2DocumentStore, detectDocumentType, sha256Hex } from './r2.js';
import { presignUrl, S3R2DocumentStore, type R2Config } from './r2-s3.js';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const HTML = new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45]);
const config: R2Config = {
  accountId: 'acct',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  bucket: 'docs',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
};

describe('S3R2DocumentStore customer erasure', () => {
  it.each([204, 404])('signs a workspace-scoped DELETE and accepts status %s', async (status) => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status }));
    await new S3R2DocumentStore(config, request).deleteObject({
      workspaceId: 'w1',
      bucket: 'docs',
      objectKey: 'original/a b.pdf',
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://acct.r2.cloudflarestorage.com/docs/workspaces/w1/original/a%20b.pdf',
    );
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//,
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps provider failure retryable without exposing the response body', async () => {
    const request: typeof fetch = async () =>
      new Response('private provider details', { status: 503 });
    await expect(
      new S3R2DocumentStore(config, request).deleteObject({
        workspaceId: 'w1',
        bucket: 'docs',
        objectKey: 'original/a',
      }),
    ).rejects.toThrow('r2_cleanup_failed');
  });

  it.each(['../other', 'a/../b', '/other', 'a//b', 'a\\b', ''])(
    'rejects unsafe object key %s without a provider request',
    async (objectKey) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        new S3R2DocumentStore(config, request).deleteObject({
          workspaceId: 'w1',
          bucket: 'docs',
          objectKey,
        }),
      ).rejects.toThrow('r2_cleanup_key_invalid');
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('refuses a different bucket', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      new S3R2DocumentStore(config, request).deleteObject({
        workspaceId: 'w1',
        bucket: 'other',
        objectKey: 'a',
      }),
    ).rejects.toThrow('r2_cleanup_bucket_mismatch');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('S3R2DocumentStore upload bounds', () => {
  const input = {
    workspaceId: 'w1',
    stagingKey: 'staging/abc',
    candidateKey: 'candidate/xyz',
    maxBytes: PDF.byteLength,
    expectedChecksumSha256: sha256Hex(PDF),
  };

  it('binds the exact body size into the PUT signature without setting forbidden browser headers', async () => {
    const store = new S3R2DocumentStore(config);
    const upload = await store.createUpload({
      ...input,
      declaredContentType: 'application/pdf',
      declaredSizeBytes: PDF.byteLength,
      expiresInSeconds: 60,
    });
    expect(new URL(upload.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(upload.headers).toEqual({ 'content-type': 'application/pdf' });
    const signing = { method: 'PUT', key: 'key', expiresInSeconds: 60, now: new Date(0) } as const;
    expect(presignUrl(config, { ...signing, contentLength: 8 })).not.toBe(
      presignUrl(config, { ...signing, contentLength: 9 }),
    );
    await expect(
      store.createUpload({
        ...input,
        declaredContentType: 'application/pdf',
        declaredSizeBytes: PDF.byteLength + 1,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow('invalid upload size');
  });

  it('rejects an oversized private candidate before downloading its body', async () => {
    const methods: (string | undefined)[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      methods.push(init?.method);
      if (init?.method === 'PUT') return new Response(null);
      if (init?.method === 'HEAD')
        return new Response(null, { headers: { 'content-length': '9' } });
      throw new Error('oversized body must not be requested');
    };
    expect(await new S3R2DocumentStore(config, fetchImpl).verifyUpload(input)).toEqual({
      status: 'rejected',
      reason: 'too_large',
    });
    expect(methods).toEqual(['PUT', 'HEAD']);
  });

  it.each([undefined, '1'])(
    'cancels on stream overflow with metadata length %s',
    async (length) => {
      let reads = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads += 1;
            controller.enqueue(reads === 1 ? PDF : new Uint8Array([0]));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (init?.method === 'PUT') return new Response(null);
        if (init?.method === 'HEAD')
          return new Response(null, { headers: length ? { 'content-length': length } : {} });
        return new Response(body);
      };
      expect(await new S3R2DocumentStore(config, fetchImpl).verifyUpload(input)).toEqual({
        status: 'rejected',
        reason: 'too_large',
      });
      expect(reads).toBe(2);
      expect(cancelled).toBe(true);
    },
  );

  it('verifies a valid candidate at the exact limit and retains checksum/signature rejection', async () => {
    let bytes = PDF;
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      paths.push(String(url));
      if (init?.method === 'PUT') return new Response(null);
      if (init?.method === 'HEAD')
        return new Response(null, { headers: { 'content-length': String(bytes.byteLength) } });
      return new Response(bytes);
    };
    const store = new S3R2DocumentStore(config, fetchImpl);
    expect(await store.verifyUpload(input)).toMatchObject({
      status: 'verified',
      candidateKey: input.candidateKey,
      sizeBytes: PDF.byteLength,
    });
    expect(paths.every((path) => path.endsWith('/workspaces/w1/candidate/xyz'))).toBe(true);
    expect(await store.verifyUpload({ ...input, expectedChecksumSha256: sha256Hex(PNG) })).toEqual({
      status: 'rejected',
      reason: 'checksum_mismatch',
    });
    bytes = HTML;
    expect(await store.verifyUpload({ ...input, maxBytes: HTML.byteLength })).toEqual({
      status: 'rejected',
      reason: 'unsupported_signature',
    });
  });
});

describe('detectDocumentType', () => {
  it('recognises PDF/JPEG/PNG by signature, ignoring declared type', () => {
    expect(detectDocumentType(PDF)).toBe('application/pdf');
    expect(detectDocumentType(JPEG)).toBe('image/jpeg');
    expect(detectDocumentType(PNG)).toBe('image/png');
  });

  it('rejects anything else', () => {
    expect(detectDocumentType(HTML)).toBeUndefined();
    expect(detectDocumentType(new Uint8Array())).toBeUndefined();
  });
});

describe('InMemoryR2DocumentStore.verifyUpload', () => {
  const base = {
    workspaceId: 'w1',
    stagingKey: 'staging/abc',
    candidateKey: 'candidate/xyz',
    maxBytes: 1024,
  };

  it('verifies a well-formed staged object against its checksum', async () => {
    const store = new InMemoryR2DocumentStore();
    store.putStagingObject(base.stagingKey, PDF);
    const result = await store.verifyUpload({ ...base, expectedChecksumSha256: sha256Hex(PDF) });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') throw new Error('unreachable');
    expect(result.detectedMediaType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(PDF.byteLength);
    expect(result.checksumSha256).toBe(sha256Hex(PDF));
    // The verified candidate object exists and equals the staged bytes.
    expect(store.getObject(result.candidateKey)).toEqual(PDF);
  });

  it('rejects a mislabelled type by signature (declared PDF, bytes are HTML)', async () => {
    const store = new InMemoryR2DocumentStore();
    store.putStagingObject(base.stagingKey, HTML);
    const result = await store.verifyUpload({ ...base, expectedChecksumSha256: sha256Hex(HTML) });
    expect(result).toEqual({ status: 'rejected', reason: 'unsupported_signature' });
  });

  it('rejects an oversize object', async () => {
    const store = new InMemoryR2DocumentStore();
    const big = new Uint8Array(2048);
    big.set(PNG);
    store.putStagingObject(base.stagingKey, big);
    const result = await store.verifyUpload({ ...base, expectedChecksumSha256: sha256Hex(big) });
    expect(result).toEqual({ status: 'rejected', reason: 'too_large' });
  });

  it('rejects a checksum mismatch', async () => {
    const store = new InMemoryR2DocumentStore();
    store.putStagingObject(base.stagingKey, PNG);
    const result = await store.verifyUpload({ ...base, expectedChecksumSha256: sha256Hex(PDF) });
    expect(result).toEqual({ status: 'rejected', reason: 'checksum_mismatch' });
  });

  it('rejects when staging is missing', async () => {
    const store = new InMemoryR2DocumentStore();
    const result = await store.verifyUpload({ ...base, expectedChecksumSha256: sha256Hex(PDF) });
    expect(result).toEqual({ status: 'rejected', reason: 'staging_missing' });
  });

  it('freezes the verified bytes: swapping staging after the copy cannot change the candidate', async () => {
    const store = new InMemoryR2DocumentStore();
    store.putStagingObject(base.stagingKey, PDF);
    const result = await store.verifyUpload({ ...base, expectedChecksumSha256: sha256Hex(PDF) });
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') throw new Error('unreachable');

    // Attacker overwrites the staging object with malicious bytes after the check.
    store.overwriteStaging(base.stagingKey, HTML);

    // The candidate — the object that becomes available and is served — is unchanged.
    const served = store.getObject(result.candidateKey);
    expect(served).toEqual(PDF);
    expect(sha256Hex(served ?? new Uint8Array())).toBe(result.checksumSha256);
  });
});

describe('presignUrl (SigV4 query signing)', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');

  it('produces a deterministic, fully-signed URL with the expected structure', () => {
    const url = presignUrl(config, { method: 'GET', key: 'a/b.pdf', expiresInSeconds: 120, now });
    expect(url).toContain('https://acct.r2.cloudflarestorage.com/docs/a/b.pdf?');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Expires=120');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    // Same inputs → same signature (deterministic).
    expect(presignUrl(config, { method: 'GET', key: 'a/b.pdf', expiresInSeconds: 120, now })).toBe(
      url,
    );
    // A different key changes the signature.
    expect(
      presignUrl(config, { method: 'GET', key: 'a/c.pdf', expiresInSeconds: 120, now }),
    ).not.toBe(url);
  });

  // Supabase Storage serves S3 under a path; the signature must cover it.
  const supabase: R2Config = {
    ...config,
    endpoint: 'https://ref.storage.supabase.co/storage/v1/s3',
    region: 'ap-south-1',
  };

  it('signs an endpoint path as part of the request path (Supabase Storage)', () => {
    const url = presignUrl(supabase, { method: 'GET', key: 'a/b.pdf', expiresInSeconds: 120, now });
    expect(url.startsWith('https://ref.storage.supabase.co/storage/v1/s3/docs/a/b.pdf?')).toBe(
      true,
    );

    // Recompute SigV4 by hand over the full path, from the URL's own query.
    const parsed = new URL(url);
    const signature = parsed.searchParams.get('X-Amz-Signature');
    parsed.searchParams.delete('X-Amz-Signature');
    const query = [...parsed.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    const canonicalRequest = [
      'GET',
      '/storage/v1/s3/docs/a/b.pdf',
      query,
      'host:ref.storage.supabase.co\n',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const sha = (data: string) => createHash('sha256').update(data).digest('hex');
    const mac = (key: Buffer | string, data: string) =>
      createHmac('sha256', key).update(data).digest();
    const scope = '20260920/ap-south-1/s3/aws4_request';
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20260920T120000Z',
      scope,
      sha(canonicalRequest),
    ].join('\n');
    let key: Buffer = mac(`AWS4${supabase.secretAccessKey}`, '20260920');
    for (const part of ['ap-south-1', 's3', 'aws4_request']) key = mac(key, part);
    expect(signature).toBe(mac(key, stringToSign).toString('hex'));

    // A trailing slash on the endpoint is the same endpoint.
    expect(
      presignUrl(
        { ...supabase, endpoint: `${supabase.endpoint}/` },
        { method: 'GET', key: 'a/b.pdf', expiresInSeconds: 120, now },
      ),
    ).toBe(url);
  });

  it('sends header-signed requests to the endpoint path too', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await new S3R2DocumentStore(supabase, request).deleteObject({
      workspaceId: 'w1',
      bucket: 'docs',
      objectKey: 'original/a.pdf',
    });
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://ref.storage.supabase.co/storage/v1/s3/docs/workspaces/w1/original/a.pdf',
    );
    expect(new Headers(init?.headers).get('host')).toBe('ref.storage.supabase.co');
  });
});

describe('S3R2DocumentStore copies into another bucket', () => {
  const storage: R2Config = {
    ...config,
    endpoint: 'https://ref.storage.supabase.co/storage/v1/s3',
    region: 'ap-south-1',
  };

  it('copies a scoped object to an exact key in the other bucket, server side', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await new S3R2DocumentStore(storage, request).copyToBucket({
      workspaceId: 'w1',
      objectKey: 'candidate/c1',
      destinationBucket: 'mobility-ids',
      destinationKey: 'lead-1/file-1.jpg',
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://ref.storage.supabase.co/storage/v1/s3/mobility-ids/lead-1/file-1.jpg',
    );
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('x-amz-copy-source')).toBe(
      '/docs/workspaces/w1/candidate/c1',
    );
  });

  it('deletes such a copy by its exact key, a missing one included', async () => {
    for (const status of [204, 404]) {
      const request = vi.fn<typeof fetch>(async () => new Response(null, { status }));
      await new S3R2DocumentStore(storage, request).deleteFromBucket({
        bucket: 'mobility-ids',
        key: 'lead-1/file-1.jpg',
      });
      const [url, init] = request.mock.calls[0]!;
      expect(String(url)).toBe(
        'https://ref.storage.supabase.co/storage/v1/s3/mobility-ids/lead-1/file-1.jpg',
      );
      expect(init?.method).toBe('DELETE');
    }
    const failing: typeof fetch = async () => new Response('boom', { status: 500 });
    await expect(
      new S3R2DocumentStore(storage, failing).deleteFromBucket({
        bucket: 'mobility-ids',
        key: 'lead-1/file-1.jpg',
      }),
    ).rejects.toThrow('r2_bucket_delete_failed');
  });

  it('never addresses the documents bucket or a key that climbs out', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const store = new S3R2DocumentStore(storage, request);
    await expect(store.deleteFromBucket({ bucket: 'docs', key: 'a/b.jpg' })).rejects.toThrow(
      'r2_copy_same_bucket',
    );
    await expect(
      store.copyToBucket({
        workspaceId: 'w1',
        objectKey: 'candidate/c1',
        destinationBucket: 'docs',
        destinationKey: 'a/b.jpg',
      }),
    ).rejects.toThrow('r2_copy_same_bucket');
    for (const key of ['../b.jpg', 'a//b.jpg', 'a\\b.jpg', 'a/./b.jpg']) {
      await expect(store.deleteFromBucket({ bucket: 'mobility-ids', key })).rejects.toThrow(
        'r2_copy_key_invalid',
      );
    }
    expect(request).not.toHaveBeenCalled();
  });
});
