'use client';

import { Button } from '@gt-sales/ui';

/**
 * A draft as the composer keeps it: at most `maxChars` characters (code
 * points, as the server counts them), and whether anything was cut, so the
 * composer can say so instead of dropping a pasted text's end silently.
 */
export function keptDraft(value: string, maxChars: number): { text: string; clipped: boolean } {
  const characters = Array.from(value);
  return characters.length <= maxChars
    ? { text: value, clipped: false }
    : { text: characters.slice(0, maxChars).join(''), clipped: true };
}

/**
 * The lines under a composer that explain why it holds less than was typed,
 * or why it takes nothing more: a pasted text cut at the message limit, and
 * a stored conversation at its message limit (with the way on, a new chat).
 */
export function ComposerNotes({
  clipped,
  maxChars,
  full,
  onNewChat,
}: {
  clipped: boolean;
  maxChars: number;
  full: boolean;
  onNewChat: () => void;
}) {
  if (!clipped && !full) return null;
  return (
    <div className="mb-2 flex flex-col items-start gap-1.5">
      {clipped ? (
        <p role="status" className="text-xs text-muted-foreground">
          {`Only the first ${maxChars.toLocaleString('en-CA')} characters were kept.`}
        </p>
      ) : null}
      {full ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            This conversation is as long as it can get. Start a new chat to go on.
          </p>
          <Button type="button" size="sm" variant="outline" className="h-7" onClick={onNewChat}>
            Start a new chat
          </Button>
        </div>
      ) : null}
    </div>
  );
}
