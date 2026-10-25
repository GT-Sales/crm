import { Upload } from 'lucide-react';

import { cn } from '../lib/utils';
import { Label } from './label';

/** Shown until T17 wires real R2 uploads. Deliberately explicit about that. */
const FILE_DROP_DEFAULT_NOTE =
  'File uploads are not enabled yet — this is a placeholder until upload support ships.';

export interface FileDropProps {
  id: string;
  label: string;
  hint?: string;
  accept?: string;
  disabled?: boolean;
  note?: string;
}

/**
 * Placeholder upload control: a labelled, keyboard-focusable drop area around
 * a visually-hidden file input. It performs no upload — no fetch, no
 * FileReader, no change handler — and only wires the input's accessible name
 * and description. Real signature-verified R2 uploads are T17.
 */
function FileDrop({
  id,
  label,
  hint,
  accept,
  disabled = false,
  note = FILE_DROP_DEFAULT_NOTE,
}: FileDropProps) {
  const describedBy = [hint ? `${id}-hint` : undefined, `${id}-note`]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div data-slot="file-drop" className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <label
        htmlFor={id}
        data-slot="file-drop-area"
        data-disabled={disabled ? 'true' : 'false'}
        className={cn(
          'flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-transparent px-4 py-6 text-center text-sm shadow-xs transition-[color,box-shadow]',
          'hover:border-ring hover:bg-accent/50',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          disabled && 'pointer-events-none cursor-not-allowed opacity-50',
        )}
      >
        <input
          id={id}
          data-slot="file-drop-input"
          type="file"
          accept={accept}
          disabled={disabled}
          aria-describedby={describedBy}
          className="sr-only"
        />
        <Upload aria-hidden="true" className="size-5 text-muted-foreground" />
        <span className="font-medium text-foreground">Choose a file</span>
        <span className="text-muted-foreground">or drag and drop it here</span>
      </label>
      {hint ? (
        <p id={`${id}-hint`} data-slot="file-drop-hint" className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <p id={`${id}-note`} data-slot="file-drop-note" className="text-sm text-muted-foreground">
        {note}
      </p>
    </div>
  );
}

export { FileDrop, FILE_DROP_DEFAULT_NOTE };
