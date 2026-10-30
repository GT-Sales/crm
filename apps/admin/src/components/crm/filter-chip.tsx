import { XIcon } from 'lucide-react';

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
