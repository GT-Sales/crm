'use client';

import type { AiUsageAssistant, AiUsageFailure, AiUsageModel } from '@gt-sales/contracts';
import { BotIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardContent, cn } from '@gt-sales/ui';

import { dateTimeLabel } from '../../lib/dates';
import { BarList, percentFormat } from '../analytics/charts';
import { failureReason } from './failure-reasons';
import { ScrollEdge } from './scroll-edge';
import { answerTime, attachmentKindsLabel, count, engineLabel, lastUsed } from './usage-format';

export const HEAD_CELL = 'px-3 py-2 font-medium';
export const CELL = 'px-3 py-2.5';
export const NUMBER = 'text-right tabular-nums';

/** A card with the dashboard's heading row: an icon, a title and one line under it. */
export function SectionCard({
  id,
  title,
  description,
  icon,
  children,
}: {
  id: string;
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-0 py-0">
      <section aria-labelledby={`${id}-title`} className="flex flex-col">
        <div className="crm-card-heading">
          {icon}
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-base font-medium">
              {title}
            </h2>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <CardContent className="min-w-0 px-5 py-5">{children}</CardContent>
      </section>
    </Card>
  );
}

function OnOff({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          on ? 'bg-[var(--crm-success)]' : 'bg-muted-foreground/50',
        )}
      />
      {children}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * What the deployment has configured for this site now, whatever the period.
 * The model id and host slugs are configuration text, shown as text.
 */
export function AssistantCard({ assistant }: { assistant: AiUsageAssistant }) {
  return (
    <SectionCard
      id="ai-usage-assistant"
      title="Assistant"
      description="How Ask AI is set up for this site right now"
      icon={<BotIcon aria-hidden="true" />}
    >
      <dl className="m-0 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Ask AI on this site">
          <OnOff on={assistant.enabled}>{assistant.enabled ? 'On' : 'Off'}</OnOff>
        </Fact>
        <Fact label="Model">
          {assistant.configuredModel === null ? (
            <span className="text-muted-foreground">Not set</span>
          ) : (
            <code className="font-mono text-[13px] break-all">{assistant.configuredModel}</code>
          )}
        </Fact>
        <Fact label="Allowed hosts">
          {assistant.providers.length === 0 ? (
            <span className="text-muted-foreground">Any host the Gateway chooses</span>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {assistant.providers.map((provider) => (
                <li key={provider}>
                  <code className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
                    {provider}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </Fact>
        <Fact label="Saved conversations">
          <OnOff on={assistant.conversations}>{assistant.conversations ? 'On' : 'Off'}</OnOff>
        </Fact>
        <Fact label="File uploads">
          <OnOff on={assistant.attachmentKinds.length > 0}>
            {attachmentKindsLabel(assistant.attachmentKinds)}
          </OnOff>
        </Fact>
        {assistant.highEffort === undefined ? null : (
          <Fact label="High effort">
            <OnOff on={assistant.highEffort.enabled}>
              <span>
                {assistant.highEffort.enabled ? 'On' : 'Off'}
                {assistant.highEffort.enabled && assistant.highEffort.model !== null ? (
                  <>
                    {', '}
                    <code className="font-mono text-[13px] break-all">
                      {assistant.highEffort.model}
                    </code>
                  </>
                ) : null}
              </span>
            </OnOff>
          </Fact>
        )}
      </dl>
      {assistant.enabled ? null : (
        <p className="mt-4 text-xs text-muted-foreground">
          Members of this site cannot use Ask AI. On the backend it needs{' '}
          <code className="font-mono">AI_ASSISTANT_ENABLED=true</code>, a Gateway key and model, and
          this site in <code className="font-mono">AI_ASSISTANT_WORKSPACE_IDS</code>. The usage
          below is kept either way.
        </p>
      )}
    </SectionCard>
  );
}

/**
 * The models that served turns in the period, most turns first. The row of
 * the model configured now is marked; a turn that recorded no model reads
 * "Unknown", and the test deployment's engine is named.
 */
export function ModelsTable({
  models,
  configuredModel,
  period,
}: {
  models: readonly AiUsageModel[];
  configuredModel: string | null | undefined;
  period: number;
}) {
  // A backend that counts High turns sends them on every row.
  const high = models.some((model) => model.highEffortTurns !== undefined);
  return (
    <section aria-labelledby="ai-usage-models-title" className="flex flex-col gap-3">
      <h2 id="ai-usage-models-title" className="text-base font-medium">
        Models
      </h2>
      {models.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model answered in this period.</p>
      ) : (
        <ScrollEdge>
          <table className="w-full min-w-[820px] text-sm">
            <caption className="sr-only">{`Models that served Ask AI turns, last ${String(period)} days`}</caption>
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th scope="col" className={HEAD_CELL}>
                  Model
                </th>
                {[
                  'Turns',
                  ...(high ? ['High'] : []),
                  'Completed',
                  'Failed',
                  'Tokens in',
                  'Tokens out',
                  'Avg answer time',
                  'Last used',
                ].map((heading) => (
                  <th key={heading} scope="col" className={cn(HEAD_CELL, 'text-right')}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const engine = engineLabel(model.engine);
                const current =
                  configuredModel !== undefined &&
                  configuredModel !== null &&
                  model.model === configuredModel;
                return (
                  <tr
                    key={`${model.engine}:${model.model ?? ''}`}
                    className="border-b last:border-0 transition-colors hover:bg-muted/40"
                  >
                    <th scope="row" className={cn(CELL, 'max-w-[320px] text-left font-normal')}>
                      <span className="flex flex-wrap items-center gap-2">
                        {model.model === null ? (
                          <span className="text-muted-foreground">Unknown</span>
                        ) : (
                          <code className="font-mono text-[13px] break-all">{model.model}</code>
                        )}
                        {current ? <Badge variant="secondary">Current</Badge> : null}
                      </span>
                      {engine ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{engine}</span>
                      ) : null}
                    </th>
                    <td className={cn(CELL, NUMBER, 'font-medium')}>{count.format(model.turns)}</td>
                    {high ? (
                      <td className={cn(CELL, NUMBER)}>
                        {count.format(model.highEffortTurns ?? 0)}
                      </td>
                    ) : null}
                    <td className={cn(CELL, NUMBER)}>{count.format(model.completedTurns)}</td>
                    <td className={cn(CELL, NUMBER)}>{count.format(model.failedTurns)}</td>
                    <td className={cn(CELL, NUMBER)}>{count.format(model.inputTokens)}</td>
                    <td className={cn(CELL, NUMBER)}>{count.format(model.outputTokens)}</td>
                    <td className={cn(CELL, NUMBER)}>{answerTime(model.averageDurationMs)}</td>
                    <td className={cn(CELL, NUMBER, 'whitespace-nowrap text-muted-foreground')}>
                      <time dateTime={model.lastUsedAt} title={dateTimeLabel(model.lastUsedAt)}>
                        {lastUsed(model.lastUsedAt)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollEdge>
      )}
    </section>
  );
}

/** The reasons failed turns ended, most frequent first, each in plain words with its code beside it. */
export function FailuresCard({
  failures,
  failedTurns,
}: {
  failures: readonly AiUsageFailure[];
  failedTurns: number | undefined;
}) {
  const failed = failedTurns ?? failures.reduce((sum, failure) => sum + failure.turns, 0);
  return (
    <SectionCard
      id="ai-usage-failures"
      title="Why turns failed"
      description={
        failed === 0
          ? 'The reason each failed answer ended'
          : `${count.format(failed)} failed ${failed === 1 ? 'turn' : 'turns'} in this period`
      }
      icon={<TriangleAlertIcon aria-hidden="true" />}
    >
      {failures.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          No turns failed in this period.
        </p>
      ) : (
        <BarList
          label="Failure reasons"
          items={failures.map((failure) => ({
            key: failure.code,
            label: failureReason(failure.code),
            detail:
              failed > 0
                ? `${failure.code} · ${percentFormat.format(failure.turns / failed)}`
                : failure.code,
            total: failure.turns,
          }))}
        />
      )}
    </SectionCard>
  );
}
