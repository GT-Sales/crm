import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AttachmentUploadError,
  isUploadTarget,
  attachmentMediaTypeOf,
  checkAttachmentFile,
  fileSizeLabel,
  putAttachmentBytes,
  sha256Hex,
  type AttachmentSettings,
} from './attachment-files';

const SETTINGS: AttachmentSettings = {
  kinds: ['image', 'pdf', 'text'],
  accept: ['image/png', 'application/pdf', '.md'],
  maxPerMessage: 4,
  maxImageBytes: 5 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxTextFileBytes: 512 * 1024,
};

describe('attachmentMediaTypeOf', () => {
  it('takes an accepted type the browser reports', () => {
    expect(attachmentMediaTypeOf({ name: 'scan', type: 'image/png' })).toBe('image/png');
    expect(attachmentMediaTypeOf({ name: 'x', type: 'text/plain; charset=utf-8' })).toBe(
      'text/plain',
    );
  });

  it('maps by extension when the browser gives no type or a spreadsheet’s', () => {
    expect(attachmentMediaTypeOf({ name: 'notes.MD', type: '' })).toBe('text/markdown');
    expect(attachmentMediaTypeOf({ name: 'leads.csv', type: 'application/vnd.ms-excel' })).toBe(
      'text/csv',
    );
    expect(attachmentMediaTypeOf({ name: 'photo.jpeg', type: '' })).toBe('image/jpeg');
  });

  it('knows nothing else', () => {
    expect(attachmentMediaTypeOf({ name: 'movie.gif', type: 'image/gif' })).toBeUndefined();
    expect(attachmentMediaTypeOf({ name: 'README', type: '' })).toBeUndefined();
  });
});

describe('checkAttachmentFile', () => {
  it('accepts a file of an offered kind within its size', () => {
    expect(checkAttachmentFile({ name: 'a.pdf', type: '', size: 1000 }, SETTINGS)).toEqual({
      ok: true,
      mediaType: 'application/pdf',
      kind: 'pdf',
    });
  });

  it('refuses a type the site does not offer, naming what may be attached', () => {
    const result = checkAttachmentFile(
      { name: 'a.pdf', type: 'application/pdf', size: 10 },
      { ...SETTINGS, kinds: ['image', 'text'] },
    );
    expect(result).toEqual({
      ok: false,
      kind: undefined,
      message:
        'That kind of file can’t be attached here. Attach an image (PNG, JPEG or WebP) or a text file (.txt, .csv or .md).',
    });
  });

  it('refuses an empty file and one over its kind’s limit, in plain words', () => {
    expect(checkAttachmentFile({ name: 'a.txt', type: '', size: 0 }, SETTINGS)).toMatchObject({
      ok: false,
      message: 'That file is empty. Choose another file.',
    });
    expect(
      checkAttachmentFile({ name: 'a.png', type: 'image/png', size: 6 * 1024 * 1024 }, SETTINGS),
    ).toMatchObject({
      ok: false,
      kind: 'image',
      message: 'That file is too large. An image can be up to 5 MB.',
    });
  });
});

describe('fileSizeLabel', () => {
  it('says sizes the way people do', () => {
    expect(fileSizeLabel(1)).toBe('1 byte');
    expect(fileSizeLabel(800)).toBe('800 bytes');
    expect(fileSizeLabel(512 * 1024)).toBe('512 KB');
    expect(fileSizeLabel(2.4 * 1024 * 1024)).toBe('2.4 MB');
    expect(fileSizeLabel(15 * 1024 * 1024)).toBe('15 MB');
  });
});

describe('sha256Hex', () => {
  it('is the lower-case hex digest of the bytes', async () => {
    const blob = new Blob(['abc']);
    expect(await sha256Hex(blob)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

class FakeRequest {
  static last: FakeRequest | undefined;
  method = '';
  url = '';
  withCredentials = true;
  headers: Record<string, string> = {};
  status = 0;
  body: unknown;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeRequest.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}

describe('isUploadTarget', () => {
  it('takes HTTPS, and plain HTTP only to this machine', () => {
    expect(isUploadTarget('https://ref.storage.supabase.co/storage/v1/s3/x?sig=1')).toBe(true);
    expect(isUploadTarget('http://127.0.0.1:4100/upload')).toBe(true);
    expect(isUploadTarget('http://localhost:9000/upload')).toBe(true);
    expect(isUploadTarget('http://storage.example.test/upload')).toBe(false);
    expect(isUploadTarget('javascript:alert(1)')).toBe(false);
    expect(isUploadTarget('data:text/plain,x')).toBe(false);
    expect(isUploadTarget('not a url')).toBe(false);
  });
});

describe('putAttachmentBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeRequest.last = undefined;
  });

  it('PUTs to storage with the intent’s headers, no credentials, and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const progress: number[] = [];
    const file = new Blob(['bytes']);
    const done = putAttachmentBytes({
      url: 'https://storage.example.test/upload?sig=1',
      headers: { 'content-type': 'image/png', 'content-length': '5' },
      body: file,
      signal: new AbortController().signal,
      onProgress: (fraction) => progress.push(fraction),
    });
    const request = FakeRequest.last;
    if (!request) throw new Error('no request');
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://storage.example.test/upload?sig=1');
    expect(request.withCredentials).toBe(false);
    // The browser sets content-length itself; no Authorization ever goes to storage.
    expect(request.headers).toEqual({ 'content-type': 'image/png' });
    expect(request.body).toBe(file);
    request.upload.onprogress?.(
      new ProgressEvent('progress', { lengthComputable: true, loaded: 2, total: 4 }),
    );
    request.status = 200;
    request.onload?.();
    await done;
    expect(progress).toEqual([0.5]);
  });

  it('sends nothing to a target that is not HTTPS', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    await expect(
      putAttachmentBytes({
        url: 'http://storage.example.test/u',
        headers: {},
        body: new Blob(['x']),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow('upload target refused');
    expect(FakeRequest.last).toBeUndefined();
  });

  it('rejects a refusal by storage, a dropped connection and an abort differently', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const input = {
      url: 'https://storage.example.test/u',
      headers: {},
      body: new Blob(['x']),
      onProgress: () => undefined,
    };
    const refused = putAttachmentBytes({ ...input, signal: new AbortController().signal });
    FakeRequest.last!.status = 403;
    FakeRequest.last!.onload?.();
    await expect(refused).rejects.toBeInstanceOf(AttachmentUploadError);

    const dropped = putAttachmentBytes({ ...input, signal: new AbortController().signal });
    FakeRequest.last!.onerror?.();
    await expect(dropped).rejects.toBeInstanceOf(TypeError);

    const controller = new AbortController();
    const aborted = putAttachmentBytes({ ...input, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });
});
