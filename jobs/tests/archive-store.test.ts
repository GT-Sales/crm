import type { S3SigningConfig } from '@gt-sales/adapters';
import { describe, expect, it } from 'vitest';

import {
  ArchiveCredentialDeniedError,
  InMemoryArchiveBackend,
  S3ArchiveReader,
  S3ArchiveRetentionAdmin,
  S3ArchiveWriter,
} from '../src/archive/archive-store.js';

describe('InMemoryArchiveBackend role separation', () => {
  it('the writer facade can put and list but get and delete throw credential_denied', async () => {
    const backend = new InMemoryArchiveBackend();
    const writer = backend.asWriter();
    expect(
      (await writer.putObject('run-1/manifest.json.age', new Uint8Array([1, 2, 3]))).versionId,
    ).toBeDefined();
    expect(await writer.listObjects('run-1/')).toHaveLength(1);
    // A facade exposes all four methods at runtime so this test can prove the
    // denial; only the ArchiveWriter type hides get and delete from callers.
    const writerCapabilities = backend.scoped(['put', 'list']);
    await expect(writerCapabilities.getObject('run-1/manifest.json.age')).rejects.toThrow(
      new ArchiveCredentialDeniedError('get'),
    );
    await expect(writerCapabilities.deleteObject('run-1/manifest.json.age')).rejects.toThrow(
      'credential_denied:delete',
    );
    expect(backend.size()).toBe(1);
  });

  it('the reader facade can list and get but put and delete throw credential_denied', async () => {
    const backend = new InMemoryArchiveBackend();
    await backend.asWriter().putObject('run-1/data.sql.age', new Uint8Array([9]));
    const reader = backend.asReader();
    expect(await reader.listObjects('run-1/')).toHaveLength(1);
    expect(await reader.getObject('run-1/data.sql.age')).toEqual(new Uint8Array([9]));
    const readerCapabilities = backend.scoped(['list', 'get']);
    await expect(readerCapabilities.putObject('run-1/x', new Uint8Array())).rejects.toBeInstanceOf(
      ArchiveCredentialDeniedError,
    );
    await expect(readerCapabilities.putObject('run-1/x', new Uint8Array())).rejects.toThrow(
      'credential_denied:put',
    );
    await expect(readerCapabilities.deleteObject('run-1/data.sql.age')).rejects.toThrow(
      'credential_denied:delete',
    );
    expect(backend.size()).toBe(1);
  });

  it('the retention admin can list, get and delete but not put', async () => {
    const backend = new InMemoryArchiveBackend();
    await backend.asWriter().putObject('run-1/x', new Uint8Array([1]));
    const admin = backend.asRetentionAdmin();
    expect(await admin.listObjects('run-1/')).toHaveLength(1);
    expect(await admin.getObject('run-1/x')).toEqual(new Uint8Array([1]));
    await admin.deleteObject('run-1/x');
    expect(await backend.asReader().getObject('run-1/x')).toBeUndefined();
    expect(backend.size()).toBe(0);
    await expect(
      backend.scoped(['list', 'get', 'delete']).putObject('run-2/x', new Uint8Array([1])),
    ).rejects.toThrow('credential_denied:put');
  });

  it('lists only the requested prefix and stamps the upload time', async () => {
    const uploadedAt = new Date('2026-10-29T06:17:00.000Z');
    const backend = new InMemoryArchiveBackend(() => uploadedAt);
    const writer = backend.asWriter();
    await writer.putObject('run-1/a', new Uint8Array([1, 2]));
    await writer.putObject('run-2/a', new Uint8Array([1]));
    expect(await writer.listObjects('run-1/')).toEqual([
      { key: 'run-1/a', sizeBytes: 2, versionId: 'v1', lastModified: uploadedAt },
    ]);
  });

  it('getObject on a missing key returns undefined, not an error', async () => {
    const backend = new InMemoryArchiveBackend();
    expect(await backend.asReader().getObject('does/not/exist')).toBeUndefined();
  });
});

const config: S3SigningConfig = {
  accessKeyId: 'k',
  secretAccessKey: 's',
  endpoint: 'https://s3.us-west-002.backblazeb2.com',
  region: 'us-west-002',
  bucket: 'gt-sales-backup-archive',
};

function listPage(keys: readonly string[], continuation = ''): string {
  const contents = keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`);
  return `<ListBucketResult>${contents.join('')}${continuation}</ListBucketResult>`;
}

describe('S3ArchiveWriter / S3ArchiveReader / S3ArchiveRetentionAdmin', () => {
  it('S3ArchiveWriter.listObjects follows IsTruncated/NextContinuationToken and rejects a repeated token', async () => {
    const requests: URL[] = [];
    const twoPages: typeof fetch = async (url) => {
      requests.push(new URL(String(url)));
      return new Response(
        requests.length === 1
          ? listPage(
              ['run-1/1'],
              '<IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b+==</NextContinuationToken>',
            )
          : listPage(['run-1/2'], '<IsTruncated>false</IsTruncated>'),
      );
    };
    expect(await new S3ArchiveWriter(config, twoPages).listObjects('run-1/')).toEqual([
      { key: 'run-1/1', sizeBytes: 1 },
      { key: 'run-1/2', sizeBytes: 1 },
    ]);
    expect(requests.map((url) => url.searchParams.get('prefix'))).toEqual(['run-1/', 'run-1/']);
    expect(requests[0]?.searchParams.get('continuation-token')).toBeNull();
    expect(requests[1]?.searchParams.get('continuation-token')).toBe('a&b+==');

    let calls = 0;
    const repeatingToken: typeof fetch = async () => {
      calls += 1;
      const token = calls === 2 ? 'second' : 'first';
      return new Response(
        listPage(
          [`run-1/${calls}`],
          `<IsTruncated>true</IsTruncated><NextContinuationToken>${token}</NextContinuationToken>`,
        ),
      );
    };
    await expect(new S3ArchiveWriter(config, repeatingToken).listObjects('run-1/')).rejects.toThrow(
      'archive_list_invalid_continuation',
    );
    expect(calls).toBe(3);
  });

  it('fails closed when a truncated listing carries no continuation token', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(listPage([], '<IsTruncated>true</IsTruncated>'));
    await expect(new S3ArchiveReader(config, fakeFetch).listObjects('')).rejects.toThrow(
      'archive_list_invalid_continuation',
    );
  });

  it.each([S3ArchiveWriter, S3ArchiveReader, S3ArchiveRetentionAdmin])(
    '%s throws archive_list_failed:<status> on a failed listing',
    async (Store) => {
      const fakeFetch: typeof fetch = async () => new Response('denied', { status: 401 });
      await expect(new Store(config, fakeFetch).listObjects('run-1/')).rejects.toThrow(
        'archive_list_failed:401',
      );
    },
  );

  it('the writer PUTs the object and parses ListObjectsV2 sizes and upload times', async () => {
    const requests: { method: string; url: string }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, url: String(url) });
      if (method === 'PUT') {
        return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'v1' } });
      }
      return new Response(
        '<?xml version="1.0"?><ListBucketResult><Contents><Key>run-1/data.sql.age</Key><LastModified>2026-10-29T06:17:03.000Z</LastModified><Size>42</Size></Contents></ListBucketResult>',
      );
    };
    const writer = new S3ArchiveWriter(config, fakeFetch);
    expect(await writer.putObject('run-1/data.sql.age', new Uint8Array([1, 2]))).toEqual({
      versionId: 'v1',
    });
    expect(await writer.listObjects('run-1/')).toEqual([
      {
        key: 'run-1/data.sql.age',
        sizeBytes: 42,
        lastModified: new Date('2026-10-29T06:17:03.000Z'),
      },
    ]);
    expect(requests.map((request) => request.method)).toEqual(['PUT', 'GET']);
    expect(new URL(requests[0]?.url ?? '').pathname).toBe(
      '/gt-sales-backup-archive/run-1/data.sql.age',
    );
  });

  it('the writer throws archive_put_failed:<status> when the upload is refused', async () => {
    const fakeFetch: typeof fetch = async () => new Response(null, { status: 403 });
    await expect(
      new S3ArchiveWriter(config, fakeFetch).putObject('run-1/x', new Uint8Array([1])),
    ).rejects.toThrow('archive_put_failed:403');
  });

  it('S3ArchiveReader.getObject returns undefined on 404 and throws archive_get_failed:<status> otherwise', async () => {
    const missing: typeof fetch = async () => new Response(null, { status: 404 });
    expect(await new S3ArchiveReader(config, missing).getObject('missing')).toBeUndefined();

    const denied: typeof fetch = async () => new Response('denied', { status: 403 });
    await expect(new S3ArchiveReader(config, denied).getObject('x')).rejects.toThrow(
      'archive_get_failed:403',
    );

    const found: typeof fetch = async () => new Response(new Uint8Array([7, 8]));
    expect(await new S3ArchiveReader(config, found).getObject('x')).toEqual(new Uint8Array([7, 8]));
  });

  it('S3ArchiveRetentionAdmin.deleteObject treats 404 as success', async () => {
    const methods: string[] = [];
    const statuses = [204, 404, 500];
    const fakeFetch: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return new Response(null, { status: statuses[methods.length - 1] });
    };
    const admin = new S3ArchiveRetentionAdmin(config, fakeFetch);
    await admin.deleteObject('run-1/old');
    await admin.deleteObject('run-1/already-gone');
    await expect(admin.deleteObject('run-1/x')).rejects.toThrow('archive_delete_failed:500');
    expect(methods).toEqual(['DELETE', 'DELETE', 'DELETE']);
  });
});
