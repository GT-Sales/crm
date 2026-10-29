import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The view bar under a CRM page header: the view switcher on
 * the left and Filter / Sort / Options on the right; a second row with the
 * active filter chips and the Reset / save actions appears only while there is
 * something to show.
 */
export function ViewBar({
  switcher,
  actions,
  chips,
  details,
}: {
  switcher: ReactNode;
  actions: ReactNode;
  chips: ReactNode;
  /** Reset and save controls; shown only while the view has unsaved changes. */
  details?: ReactNode;
}) {
  const showDetails = Boolean(chips) || Boolean(details);
  return (
    <div className="shrink-0 border-b border-crm-row-border">
      <div className="flex h-10 items-center gap-2 px-2">
        <div className="min-w-0">{switcher}</div>
        <div className="ml-auto flex items-center gap-0.5">{actions}</div>
      </div>
      {showDetails ? (
        <div className="flex min-h-9 flex-wrap items-center gap-1 border-t border-crm-row-border px-2 py-1">
          {chips}
          {details ? <div className="ml-auto flex items-center gap-1">{details}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One active filter: "Field: value ×". */
export function FilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove(): void;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-[4px] border border-crm-chip-border bg-crm-chip pr-0.5 pl-2 text-[12px] text-crm-chip-foreground">
      <span className="font-medium">{label}:</span>
      <span>{value}</span>
      <button
        type="button"
        aria-label={`Remove filter ${label}`}
        className="grid size-5 place-items-center rounded-[3px] outline-none hover:bg-crm-chip-border/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}
