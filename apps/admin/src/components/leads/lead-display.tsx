import { leadStageLabel, type LeadContact } from '@gt-sales/contracts';
import { Avatar, AvatarFallback, cn } from '@gt-sales/ui';

import { initials } from '../../lib/people';

/**
 * Small pieces every lead screen shares: the stage badge (the colours of
 * CanadaWide's old admin, so the board reads the way staff are used to), the
 * person chip, and the lead's display name.
 */

const STAGE_TONES: Record<string, string> = {
  new: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  contacted: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  replied: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  qualified: 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  existing_shaw: 'border-orange-500/30 bg-orange-500/15 text-orange-300',
  non_serviceable_address: 'border-rose-500/30 bg-rose-500/15 text-rose-300',
  old_due: 'border-yellow-500/30 bg-yellow-500/15 text-yellow-300',
  installed: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300',
  activated: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300',
  won: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  approved: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  lost: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
  declined: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
  closed: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
};

const STAGE_DOTS: Record<string, string> = {
  new: 'bg-sky-400',
  contacted: 'bg-amber-400',
  replied: 'bg-amber-400',
  qualified: 'bg-violet-400',
  existing_shaw: 'bg-orange-400',
  non_serviceable_address: 'bg-rose-400',
  old_due: 'bg-yellow-400',
  installed: 'bg-cyan-400',
  activated: 'bg-cyan-400',
  won: 'bg-emerald-400',
  approved: 'bg-emerald-400',
  lost: 'bg-zinc-400',
  declined: 'bg-zinc-400',
  closed: 'bg-zinc-400',
};

export function stageDotClass(stage: string): string {
  return STAGE_DOTS[stage] ?? 'bg-muted-foreground';
}

export function StageBadge({
  leadType,
  stage,
  className,
}: {
  leadType: string;
  stage: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STAGE_TONES[stage] ?? 'border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {leadStageLabel(leadType, stage)}
    </span>
  );
}

export function PersonChip({
  name,
  size = 'sm',
  className,
}: {
  name: string;
  size?: 'sm' | 'xs';
  className?: string;
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <Avatar className={size === 'xs' ? 'size-5' : 'size-6'}>
        <AvatarFallback
          className={cn(
            'bg-primary/35 font-semibold text-foreground',
            size === 'xs' ? 'text-[9px]' : 'text-[10px]',
          )}
        >
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Name, else email, else phone, else a placeholder for a lead with no contact (or hidden ones). */
export function leadDisplayName(contact: LeadContact): string {
  return contact.fullName ?? contact.email ?? contact.phone ?? 'Unnamed lead';
}
