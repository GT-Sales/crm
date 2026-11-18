import type { AiAttachmentKind } from '@gt-sales/contracts';

/** Whole counts, as the rest of the admin writes them. */
export const count = new Intl.NumberFormat('en-CA');

const seconds = new Intl.NumberFormat('en-CA', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** An average answer time: seconds with one decimal ("1.5 s"), or a dash when none completed. */
export function answerTime(ms: number | null): string {
  if (ms === null) return '—';
  if (ms > 0 && ms < 50) return '< 0.1 s';
  return `${seconds.format(ms / 1000)} s`;
}

export function totalTokens(counts: { inputTokens: number; outputTokens: number }): number {
  return counts.inputTokens + counts.outputTokens;
}

/** A day the turn was last used, in the viewer's own calendar (it is an instant). */
export function lastUsed(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const KIND_LABELS: Record<AiAttachmentKind, string> = {
  image: 'Images',
  pdf: 'PDFs',
  text: 'Text files',
};

/** "Images, PDFs, Text files", or "Uploads off" for none. */
export function attachmentKindsLabel(kinds: readonly AiAttachmentKind[]): string {
  return kinds.length === 0 ? 'Uploads off' : kinds.map((kind) => KIND_LABELS[kind]).join(', ');
}

/** The engine as the owner reads it; a turn on the Gateway needs no label. */
export function engineLabel(engine: string): string | undefined {
  if (engine === 'gateway') return undefined;
  if (engine === 'fake') return 'Test engine';
  return engine;
}
