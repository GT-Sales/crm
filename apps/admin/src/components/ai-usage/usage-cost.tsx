'use client';

import type { AiUsageCost } from '@gt-sales/contracts';
import { CircleDollarSignIcon } from 'lucide-react';
import { cn } from '@gt-sales/ui';

import { ScrollEdge } from './scroll-edge';
import { CELL, HEAD_CELL, NUMBER, SectionCard } from './usage-sections';
import { count, engineLabel, perMillion, usd } from './usage-format';

/**
 * Settings → AI usage's approximate cost: the backend prices each model's
 * tokens at the AI Gateway catalogue's current list prices and sends whole
 * micro-dollars; this only formats them. A cost that could not be worked out
 * at all (the price list could not be read) is one line, and the usage is
 * shown as before; an older backend sends no cost and nothing here is drawn.
 */

/** "1 turn", "3 turns". */
function turnsLabel(turns: number): string {
  return `${count.format(turns)} ${turns === 1 ? 'turn' : 'turns'}`;
}

/** Whether the answer has a figure to show (some of the period could be priced). */
export function costShown(cost: AiUsageCost | undefined): cost is AiUsageCost {
  return cost !== undefined && cost.priced;
}

/** Whether there is anything to say about cost beyond one line: a figure, or models to list. */
function costSection(cost: AiUsageCost): boolean {
  return cost.priced || cost.models.length > 0;
}

/** The totals tile: "≈ $4.12", and how many turns are left out of it. */
export function costTile(cost: AiUsageCost): { label: string; value: string; note?: string } {
  return {
    label: 'Approximate cost',
    value: `≈ ${usd(cost.totalMicroUsd, cost.currency)}`,
    ...(cost.unpricedTurns > 0 ? { note: `${turnsLabel(cost.unpricedTurns)} not priced` } : {}),
  };
}

/** The one line shown instead of the cost when nothing could be worked out. */
export function CostUnavailable({ cost }: { cost: AiUsageCost }) {
  if (costSection(cost)) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cost.reason === 'catalogue_unavailable'
        ? 'Approximate cost is not available right now: the AI Gateway’s price list could not be read.'
        : 'Approximate cost is not available for this period.'}
    </p>
  );
}

/** A member's cost cell: the amount, and the turns of theirs it leaves out. */
export function MemberCost({
  cost,
  entry,
}: {
  cost: AiUsageCost;
  entry: { costMicroUsd: number; unpricedTurns: number } | undefined;
}) {
  return (
    <>
      {usd(entry?.costMicroUsd ?? 0, cost.currency)}
      {entry && entry.unpricedTurns > 0 ? (
        <span className="block text-xs text-muted-foreground">
          {`${turnsLabel(entry.unpricedTurns)} not priced`}
        </span>
      ) : null}
    </>
  );
}

/**
 * The period's cost per model, with the honest small print: what the figure
 * is worked out from, what it leaves out and where the real figure is.
 * Model labels and ids go in as text children only.
 */
export function CostByModel({ cost, period }: { cost: AiUsageCost; period: number }) {
  if (!costSection(cost)) return null;
  const description = cost.priced
    ? `≈ ${usd(cost.totalMicroUsd, cost.currency)} in the last ${String(period)} days`
    : `None of the ${turnsLabel(cost.unpricedTurns)} in this period could be priced`;
  return (
    <SectionCard
      id="ai-usage-cost"
      title="Approximate cost by model"
      description={description}
      icon={<CircleDollarSignIcon aria-hidden="true" />}
    >
      <div className="flex flex-col gap-4">
        {cost.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">No model answered in this period.</p>
        ) : (
          <ScrollEdge>
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">{`Approximate cost per model, last ${String(period)} days`}</caption>
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th scope="col" className={HEAD_CELL}>
                    Model
                  </th>
                  {[
                    'Tokens in',
                    'Tokens out',
                    'Price in / 1M',
                    'Price out / 1M',
                    'Approx. cost',
                  ].map((heading) => (
                    <th key={heading} scope="col" className={cn(HEAD_CELL, 'text-right')}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cost.models.map((model) => {
                  const engine = engineLabel(model.engine);
                  return (
                    <tr
                      key={`${model.engine}:${model.model ?? ''}`}
                      className="border-b last:border-0 transition-colors hover:bg-muted/40"
                    >
                      <th scope="row" className={cn(CELL, 'max-w-[320px] text-left font-normal')}>
                        {model.label === null ? null : (
                          <span className="block font-medium break-words">{model.label}</span>
                        )}
                        {model.model === null ? (
                          <span className="text-muted-foreground">Unknown</span>
                        ) : (
                          <code
                            className={cn(
                              'font-mono text-[13px] break-all',
                              model.label !== null && 'text-xs text-muted-foreground',
                            )}
                          >
                            {model.model}
                          </code>
                        )}
                        {engine ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {engine}
                          </span>
                        ) : null}
                      </th>
                      <td className={cn(CELL, NUMBER)}>{count.format(model.inputTokens)}</td>
                      <td className={cn(CELL, NUMBER)}>{count.format(model.outputTokens)}</td>
                      <td className={cn(CELL, NUMBER, 'text-muted-foreground')}>
                        {model.inputPricePerMillion === null
                          ? '—'
                          : perMillion(model.inputPricePerMillion, cost.currency)}
                      </td>
                      <td className={cn(CELL, NUMBER, 'text-muted-foreground')}>
                        {model.outputPricePerMillion === null
                          ? '—'
                          : perMillion(model.outputPricePerMillion, cost.currency)}
                      </td>
                      <td
                        className={cn(
                          CELL,
                          NUMBER,
                          model.costMicroUsd === null
                            ? 'text-muted-foreground'
                            : 'font-medium whitespace-nowrap',
                        )}
                      >
                        {model.costMicroUsd === null
                          ? 'Not priced'
                          : usd(model.costMicroUsd, cost.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollEdge>
        )}
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>
            Approximate: each model’s tokens at the AI Gateway’s current list prices, not the prices
            on the day of each turn. It leaves out cached-token discounts, retries the provider
            billed and anything outside Ask AI. Your Vercel AI Gateway invoice is the real figure.
            History covers the last 90 days only.
          </p>
          {cost.unpricedTurns > 0 ? (
            <p>
              {`${turnsLabel(cost.unpricedTurns)} could not be priced: no model was recorded, the turn ran on the test engine, or the model is not in the Gateway’s price list.`}
            </p>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
