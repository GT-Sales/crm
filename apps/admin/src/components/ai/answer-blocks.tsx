'use client';

import Link from 'next/link';
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react';
import type { AiBlock } from '@gt-sales/contracts';
import { Badge, cn } from '@gt-sales/ui';

import { safeInternalHref } from './assistant-sources';

const numberFormat = new Intl.NumberFormat('en-CA');

/**
 * Blocks under an answer (docs/design/ai-blocks.md): a short lead list, a few
 * figures or a ranked list, each filled by the server from a read of the
 * turn. Plain markup and a CSS bar, no chart library; container queries
 * keep them readable in the narrow side panel.
 */
export function AnswerBlocks({ blocks }: { blocks: readonly AiBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => (
        <section
          // A block is shown once per answer and never reordered.
          key={`${block.kind}-${String(index)}`}
          aria-label={block.title}
          className="@container rounded-lg border bg-card text-sm"
        >
          <h3 className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            {block.title}
          </h3>
          {block.kind === 'leads' ? <LeadRows block={block} /> : null}
          {block.kind === 'stats' ? <StatTiles block={block} /> : null}
          {block.kind === 'ranking' ? <RankRows block={block} /> : null}
        </section>
      ))}
    </div>
  );
}

function LeadRows({ block }: { block: Extract<AiBlock, { kind: 'leads' }> }) {
  return (
    <>
      <ul className="divide-y">
        {block.rows.map((row, index) => {
          const href = row.href === null ? undefined : safeInternalHref(row.href);
          return (
            <li
              key={`${row.label}-${String(index)}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              {href ? (
                <Link
                  href={href}
                  className="min-w-0 truncate font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"
                >
                  {row.label}
                </Link>
              ) : (
                <span className="min-w-0 truncate font-medium">{row.label}</span>
              )}
              {row.stage ? (
                <Badge variant="outline" className="font-normal">
                  {row.stage}
                </Badge>
              ) : null}
              {row.fact ? (
                <span className="ml-auto hidden text-xs text-muted-foreground @xs:inline">
                  {row.fact}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {block.more > 0 ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          And {numberFormat.format(block.more)} more.
        </p>
      ) : null}
    </>
  );
}

function StatTiles({ block }: { block: Extract<AiBlock, { kind: 'stats' }> }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-lg bg-border @sm:grid-cols-3">
      {block.tiles.map((tile) => {
        const change = tile.previous === null ? null : tile.value - tile.previous;
        return (
          <div key={tile.label} className="flex flex-col gap-0.5 bg-card px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {numberFormat.format(tile.value)}
            </dd>
            {change === null ? null : (
              <dd
                className={cn(
                  'flex items-center gap-0.5 text-xs tabular-nums',
                  change > 0 && 'text-emerald-700 dark:text-emerald-400',
                  change < 0 && 'text-rose-700 dark:text-rose-400',
                  change === 0 && 'text-muted-foreground',
                )}
              >
                {change > 0 ? <ArrowUpRightIcon aria-hidden="true" className="size-3" /> : null}
                {change < 0 ? <ArrowDownRightIcon aria-hidden="true" className="size-3" /> : null}
                {change === 0
                  ? 'Same as before'
                  : `${change > 0 ? '+' : '−'}${numberFormat.format(Math.abs(change))} vs before`}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

function RankRows({ block }: { block: Extract<AiBlock, { kind: 'ranking' }> }) {
  const max = Math.max(1, ...block.rows.map((row) => row.value));
  return (
    <ol className="flex flex-col gap-2 px-3 py-2.5">
      {block.rows.map((row, index) => (
        <li key={`${row.label}-${String(index)}`} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {numberFormat.format(row.value)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted" aria-hidden="true">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${String(Math.round((row.value / max) * 100))}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
