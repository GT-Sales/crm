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

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** One currency format per currency and number of decimals, kept. */
function moneyFormat(currency: string, maxDecimals = 2): Intl.NumberFormat {
  const key = `${currency}:${String(maxDecimals)}`;
  let format = moneyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: maxDecimals,
    });
    moneyFormats.set(key, format);
  }
  return format;
}

/**
 * Whole micro-dollars as money ("$4.12"), rounded half up to the cent in
 * integers; a non-zero amount under half a cent is "< $0.01", never "$0.00".
 */
export function usd(microUsd: number, currency = 'USD'): string {
  const cents = Math.floor((microUsd + 5_000) / 10_000);
  const format = moneyFormat(currency);
  if (cents === 0 && microUsd > 0) return `< ${format.format(0.01)}`;
  return format.format(cents / 100);
}

/** A list price per million tokens, sent as an exact decimal string ("2.5" is "$2.50"). */
export function perMillion(text: string, currency = 'USD'): string {
  const decimals = text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
  return moneyFormat(currency, Math.min(20, Math.max(2, decimals))).format(Number(text));
}
