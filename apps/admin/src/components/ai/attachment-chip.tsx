'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { CircleAlertIcon, FileTextIcon, FileTypeIcon, ImageIcon, XIcon } from 'lucide-react';
import type { AiAttachmentKind, AiAttachmentSummary } from '@gt-sales/contracts';
import { cn } from '@gt-sales/ui';

import { fileSizeLabel } from './attachment-files';
import { useAttachmentLink } from './attachment-links';
import { useOptionalAssistant, type PendingAttachment } from './assistant-provider';

/**
 * Files on screen: a chip in the composer for each file chosen for the next
 * message (uploading, ready or refused), and the files a sent question
 * carried. A file name is always text. A stored image shows through a
 * short-lived signed link, a just-sent one through the local preview of the
 * picked file; a link that cannot be had leaves a plain chip, never an error.
 */

function KindIcon({ kind, className }: { kind?: AiAttachmentKind; className?: string }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'pdf' ? FileTextIcon : FileTypeIcon;
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', className)} />;
}

const KIND_LABEL: Record<AiAttachmentKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  text: 'Text file',
};

/** One file chosen for the next message, in the composer. */
export function PendingAttachmentChip({
  item,
  onRemove,
}: {
  item: PendingAttachment;
  onRemove(): void;
}) {
  const percent = Math.round(item.progress * 100);
  const label =
    item.status === 'uploading' ? `Cancel the upload of ${item.name}` : `Remove ${item.name}`;
  return (
    <li
      className={cn(
        'relative flex w-52 max-w-[85%] min-w-0 shrink-0 items-center gap-2 overflow-hidden rounded-xl border bg-card p-1.5 pr-1 text-left sm:w-56 sm:max-w-full',
        item.status === 'failed' && 'border-destructive/40 bg-destructive/5',
      )}
    >
      {item.previewUrl !== undefined && item.status !== 'failed' ? (
        <img
          src={item.previewUrl}
          alt=""
          className="size-10 shrink-0 rounded-lg border bg-muted object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground',
            item.status === 'failed' && 'bg-destructive/10 text-destructive',
          )}
        >
          {item.status === 'failed' ? (
            <CircleAlertIcon className="size-4" />
          ) : (
            <KindIcon kind={item.kind} />
          )}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground" title={item.name}>
          {item.name}
        </span>
        {item.status === 'failed' ? (
          <span className="block text-[11px] leading-snug text-destructive">{item.error}</span>
        ) : item.status === 'uploading' ? (
          <span className="block text-[11px] text-muted-foreground">Uploading… {percent}%</span>
        ) : (
          <span className="block text-[11px] text-muted-foreground">
            {item.kind === undefined ? '' : `${KIND_LABEL[item.kind]} · `}
            {fileSizeLabel(item.size)}
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label={label}
        title={item.status === 'uploading' ? 'Cancel upload' : 'Remove'}
        onClick={onRemove}
        className="grid size-7 shrink-0 place-items-center self-start rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
      {item.status === 'uploading' ? (
        <span
          role="progressbar"
          aria-label={`Uploading ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-muted"
        >
          <span
            className="block h-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${Math.max(4, percent)}%` }}
          />
        </span>
      ) : null}
    </li>
  );
}

/** Asks for links once the files are on screen (at once where the browser cannot tell). */
function useOnScreen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return [ref, visible];
}

function SentAttachment({
  attachment,
  visible,
}: {
  attachment: AiAttachmentSummary;
  visible: boolean;
}) {
  const cache = useOptionalAssistant()?.attachmentLinks;
  const entry = useAttachmentLink(cache, attachment.id, visible);
  const url = entry?.status === 'ready' ? entry.url : undefined;
  // The first picture stays put: a refreshed link must not reload the image.
  const [thumb, setThumb] = useState<string>();
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (url !== undefined && thumb === undefined) setThumb(url);
  }, [thumb, url]);
  const refresh = () => cache?.request(attachment.id);
  const description = `${KIND_LABEL[attachment.kind]}, ${fileSizeLabel(attachment.byteSize)}`;

  if (attachment.kind === 'image' && thumb !== undefined && !broken) {
    const image = (
      <img
        src={thumb}
        alt={attachment.fileName}
        onError={() => setBroken(true)}
        className="max-h-44 max-w-full rounded-xl border bg-muted object-cover sm:max-w-64"
      />
    );
    return url === undefined ? (
      <span className="block">{image}</span>
    ) : (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${attachment.fileName} in a new tab`}
        onPointerEnter={refresh}
        onFocus={refresh}
        className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {image}
      </a>
    );
  }

  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground',
          entry?.status === 'loading' && attachment.kind === 'image' && 'animate-pulse',
        )}
      >
        <KindIcon kind={attachment.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium" title={attachment.fileName}>
          {attachment.fileName}
        </span>
        <span className="block text-[11px] text-muted-foreground">{description}</span>
      </span>
    </>
  );
  const chip =
    'flex w-56 max-w-full min-w-0 items-center gap-2 rounded-xl border bg-card p-1.5 pr-2.5 text-left text-foreground';
  return url === undefined ? (
    <span className={chip}>{body}</span>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${attachment.fileName} (${description}) in a new tab`}
      onPointerEnter={refresh}
      onFocus={refresh}
      className={cn(
        chip,
        'outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {body}
    </a>
  );
}

/** The files a question was sent with, above its bubble. */
export function MessageAttachments({
  attachments,
}: {
  attachments: readonly AiAttachmentSummary[];
}) {
  const [ref, visible] = useOnScreen<HTMLUListElement>();
  if (attachments.length === 0) return null;
  return (
    <ul
      ref={ref}
      aria-label="Attached files"
      className="flex max-w-[85%] flex-wrap justify-end gap-2"
    >
      {attachments.map((attachment) => (
        <li key={attachment.id} className="min-w-0 max-w-full">
          <SentAttachment attachment={attachment} visible={visible} />
        </li>
      ))}
    </ul>
  );
}
