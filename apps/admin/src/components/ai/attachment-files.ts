import {
  aiAttachmentKindOf,
  aiAttachmentMediaTypeSchema,
  type AiAttachmentKind,
  type AiAttachmentMediaType,
  type AiCapabilitiesResponse,
} from '@gt-sales/contracts';

/**
 * The browser's side of an attached file before anything is sent: which
 * accepted type it is, whether this site's settings allow it and its size, the
 * SHA-256 finalize checks, and the PUT that sends the bytes straight to
 * storage. The server decides the real type from the bytes; these checks only
 * spare the member a request that would be refused.
 */

export type AttachmentSettings = NonNullable<AiCapabilitiesResponse['attachments']>;

/** Browsers often give `.md` and `.csv` no type (or a spreadsheet's), so the name decides. */
const BY_EXTENSION: Readonly<Record<string, AiAttachmentMediaType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The accepted media type a file is, from the browser's type or else its extension. */
export function attachmentMediaTypeOf(file: {
  name: string;
  type: string;
}): AiAttachmentMediaType | undefined {
  const reported = aiAttachmentMediaTypeSchema.safeParse(
    file.type.split(';')[0]?.trim().toLowerCase() ?? '',
  );
  if (reported.success) return reported.data;
  return BY_EXTENSION[extensionOf(file.name)];
}

export function maxBytesFor(kind: AiAttachmentKind, settings: AttachmentSettings): number {
  switch (kind) {
    case 'image':
      return settings.maxImageBytes;
    case 'pdf':
      return settings.maxPdfBytes;
    case 'text':
      return settings.maxTextFileBytes;
  }
}

/** "5 MB", "512 KB", "800 bytes": a size in the words people use. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : Number(megabytes.toFixed(1))} MB`;
}

const KIND_WORDS: Record<AiAttachmentKind, string> = {
  image: 'an image (PNG, JPEG or WebP)',
  pdf: 'a PDF',
  text: 'a text file (.txt, .csv or .md)',
};

const KIND_NOUN: Record<AiAttachmentKind, string> = {
  image: 'An image',
  pdf: 'A PDF',
  text: 'A text file',
};

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

export type AttachmentCheck =
  | { ok: true; mediaType: AiAttachmentMediaType; kind: AiAttachmentKind }
  | { ok: false; kind?: AiAttachmentKind; message: string };

/**
 * Whether one chosen file may be uploaded here, before any request: an
 * accepted type of a kind this site offers, not empty, within its kind's size.
 */
export function checkAttachmentFile(
  file: { name: string; type: string; size: number },
  settings: AttachmentSettings,
): AttachmentCheck {
  const mediaType = attachmentMediaTypeOf(file);
  const kind = mediaType === undefined ? undefined : aiAttachmentKindOf(mediaType);
  if (mediaType === undefined || kind === undefined || !settings.kinds.includes(kind)) {
    return {
      ok: false,
      message: `That kind of file can’t be attached here. Attach ${listWords(
        settings.kinds.map((offered) => KIND_WORDS[offered]),
      )}.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, kind, message: 'That file is empty. Choose another file.' };
  }
  const limit = maxBytesFor(kind, settings);
  if (file.size > limit) {
    return {
      ok: false,
      kind,
      message: `That file is too large. ${KIND_NOUN[kind]} can be up to ${fileSizeLabel(limit)}.`,
    };
  }
  return { ok: true, mediaType, kind };
}

/** The lower-case hex SHA-256 of the bytes, as finalize expects it. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The storage refused the upload (an expired link, a size it did not expect). */
export class AttachmentUploadError extends Error {
  constructor(readonly status: number) {
    super(`upload refused (${status})`);
    this.name = 'AttachmentUploadError';
  }
}

/**
 * PUTs the bytes to the signed storage URL with the headers the intent gave.
 * XMLHttpRequest because it reports upload progress; no credentials and no
 * Authorization header go with it, since the request is for storage, not the
 * CRM. An abort rejects with an `AbortError`; a dropped connection with a
 * `TypeError`, which the error words read as "couldn't reach".
 */
export function putAttachmentBytes(input: {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Blob;
  signal: AbortSignal;
  onProgress(fraction: number): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    const request = new XMLHttpRequest();
    request.open('PUT', input.url);
    request.withCredentials = false;
    for (const [name, value] of Object.entries(input.headers)) {
      // The browser sets these itself and refuses to be told.
      if (['content-length', 'host'].includes(name.toLowerCase())) continue;
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) input.onProgress(event.loaded / event.total);
    };
    const abort = () => request.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    const settle = () => input.signal.removeEventListener('abort', abort);
    request.onload = () => {
      settle();
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new AttachmentUploadError(request.status));
    };
    request.onerror = () => {
      settle();
      reject(new TypeError('upload failed'));
    };
    request.onabort = () => {
      settle();
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    request.send(input.body);
  });
}
