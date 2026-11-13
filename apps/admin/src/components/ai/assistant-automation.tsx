'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Input, Textarea } from '@gt-sales/ui';
import {
  leadTypeCatalog,
  flowStepRunSchema,
  type AiAutomationProposal,
  type AiAutomationSimulation,
  type AiAutomationDraft,
} from '@gt-sales/contracts';
import { useAssistant, type AutomationCardState } from './assistant-provider';
import { BackendError } from '../../lib/api';
import { describeError } from '../../lib/error-text';
import dynamic from 'next/dynamic';
const FlowCanvas = dynamic(
  () => import('../automations/canvas/flow-canvas').then((module) => module.FlowCanvas),
  { ssr: false },
);
import { FlowListView } from '../automations/flow-list-view';
import { StepSidePanel } from '../automations/canvas/step-side-panel';
import {
  insertStepAt,
  updateStepById,
  removeStepById,
  findStepById,
} from '../automations/canvas/draft-mutations';
import {
  namesFromCatalog,
  issueText,
  stepKindLabel,
  testStepOutcomeText,
} from '../automations/flow-words';
import '../automations/automation-motion.css';

function simulationStepText(step: AiAutomationSimulation['steps'][number]): string {
  const parsed = flowStepRunSchema.safeParse(step);
  if (!parsed.success) return 'Action result unavailable. Check this flow in the builder.';
  const value = parsed.data;
  if (value.stepKind === 'wait' && value.outcome === 'done') return 'Wait simulated';
  const outcome =
    value.stepKind === 'send_email' && value.outcome === 'done'
      ? 'Email simulated · no email queued'
      : testStepOutcomeText(value);
  return `${stepKindLabel(value.stepKind)}: ${outcome}`;
}

export function AssistantAutomation({
  messageId,
  initial,
  stored,
}: {
  messageId: string;
  initial: AiAutomationProposal;
  /** What this card has come to so far; it outlives the panel (UI-1). */
  stored?: AutomationCardState;
}) {
  const { automationApi, workspaceSlug, updateAutomationCard } = useAssistant();
  const card: AutomationCardState = stored ?? { proposal: initial, draft: initial.draft };
  const { proposal, draft, savedKey, simulation } = card;
  const cancelled = card.cancelled === true;
  const update = (change: Partial<AutomationCardState>) =>
    updateAutomationCard(messageId, initial.id, change);
  const setDraft = (next: AiAutomationDraft) => update({ draft: next });
  const [editing, setEditing] = useState(false),
    [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [canvas, setCanvas] = useState(false);
  const firstType = proposal.catalog.leadTypes[0]?.key ?? 'sim_order';
  const [scenario, setScenario] = useState<{
    leadType: string;
    stage: string;
    planId: string;
    assignedActorId: string;
    properties: Record<string, string | number | boolean | null>;
  }>({
    leadType: firstType,
    stage: proposal.catalog.leadTypes[0]?.stages[0]?.key ?? 'pending',
    planId: '',
    assignedActorId: '',
    properties: {},
  });
  const names = namesFromCatalog(proposal.catalog);
  const dirty = JSON.stringify(draft) !== JSON.stringify(proposal.draft);
  // UI-5: the card turns expired at its expiry, not only when it next renders.
  const expiresAtMs = Date.parse(proposal.expiresAt);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Math.min(remaining + 50, 2 ** 31 - 1),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAtMs]);
  const expired = nowMs >= expiresAtMs;
  const disabled = busy || cancelled || !!savedKey || expired;
  const href = `/w/${encodeURIComponent(workspaceSlug)}/automations/${savedKey ?? proposal.target?.key ?? ''}`;
  function failure(cause: unknown) {
    if (cause instanceof BackendError && cause.code === 'automation_limit_reached')
      return 'This site already has the most automations it can hold. Archive one before saving this draft.';
    if (
      cause instanceof BackendError &&
      (cause.status === 410 || cause.details?.['reason'] === 'expired')
    )
      return 'This proposal expired. Ask AI to prepare a fresh one; nothing was saved.';
    if (cause instanceof BackendError && cause.status === 404)
      return 'This proposal is no longer available. Ask AI to prepare a fresh one.';
    if (cause instanceof BackendError && cause.code === 'revision_conflict')
      return 'This automation changed. Ask AI to reload it and prepare a fresh proposal; your edits remain visible.';
    if (
      cause instanceof BackendError &&
      ['permission_denied', 'membership_revoked', 'missing_session', 'invalid_session'].includes(
        cause.code,
      )
    )
      return 'Your access changed. Sign in again or ask a site manager.';
    return `${describeError(cause, 'save this automation')} Your edits are preserved.`;
  }
  async function review() {
    setBusy(true);
    setError('');
    try {
      const next = await automationApi.revise(proposal.token, draft);
      update({ proposal: next, draft: next.draft, simulation: undefined });
      setEditing(false);
      setSelected(undefined);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const saved = await automationApi.save(proposal.token);
      update({ savedKey: saved.key });
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }
  async function simulate() {
    setBusy(true);
    setError('');
    try {
      const type = Object.keys(leadTypeCatalog).find((key) => key === scenario.leadType);
      if (!type) throw new Error('invalid type');
      const { aiAutomationSimulateRequestSchema } = await import('@gt-sales/contracts');
      const body = aiAutomationSimulateRequestSchema.parse({
        token: proposal.token,
        scenario: {
          leadType: type,
          stage: scenario.stage,
          planId: scenario.planId || null,
          assignedActorId: scenario.assignedActorId || null,
          properties: scenario.properties,
        },
      });
      update({ simulation: await automationApi.simulate(body) });
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Review automation draft"
      className="min-w-0 space-y-3 rounded-xl border bg-card p-3 text-sm"
    >
      <div>
        <h3 className="font-semibold">
          {proposal.target ? 'Edit automation' : 'Create automation'}
        </h3>
        <p className="text-xs text-muted-foreground">
          {proposal.siteName} ·{' '}
          {savedKey ? 'Saved draft' : cancelled ? 'Discarded proposal' : 'Unsaved draft'}
        </p>
      </div>
      <p>
        {proposal.target
          ? 'Saving updates the draft. Publishing and the On/Off switch stay separate.'
          : 'Saving creates a draft with the flow Off.'}
      </p>
      <label className="block">
        Flow name
        <Input
          aria-label="Automation draft name"
          disabled={!editing || disabled}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      {editing ? (
        <label className="block">
          Description
          <Textarea
            disabled={disabled}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
      ) : null}
      <ul aria-label="Proposed changes" className="list-disc space-y-1 pl-4">
        {proposal.changes.map((change, i) => (
          <li key={i}>{change}</li>
        ))}
      </ul>
      {proposal.issues.length ? (
        <div aria-label="Automation draft issues" className="rounded border p-2">
          {proposal.issues.map((issue, i) => (
            <p key={i}>{issueText(issue)}</p>
          ))}
          <p>Finish these settings before publishing.</p>
        </div>
      ) : null}
      {proposal.before ? (
        <details>
          <summary>Before this edit</summary>
          <FlowListView definition={proposal.before.definition} names={names} readOnly />
        </details>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => setCanvas(!canvas)}>
        {canvas ? 'Show list' : 'Show canvas'}
      </Button>
      {canvas ? (
        <FlowCanvas
          definition={draft.definition}
          names={names}
          readOnly
          selectedId={selected}
          onSelectNode={setSelected}
          onAddStep={() => {}}
        />
      ) : (
        <FlowListView
          definition={draft.definition}
          names={names}
          readOnly={!editing || disabled}
          selectedId={selected}
          onSelectNode={setSelected}
          onAddStep={(path, index, kind) => {
            const next = insertStepAt(draft.definition, path, index, kind);
            setDraft({ ...draft, definition: next.draft });
            setSelected(next.stepId);
          }}
        />
      )}
      {editing && selected ? (
        <StepSidePanel
          key={selected}
          workspaceSlug={workspaceSlug}
          selectedId={selected}
          trigger={draft.definition.trigger}
          step={findStepById(draft.definition.steps, selected)?.step}
          issues={[]}
          catalog={{ ...proposal.catalog, requestId: 'ai-automation-proposal' }}
          readOnly={disabled}
          onUpdateTrigger={(trigger) =>
            setDraft({ ...draft, definition: { ...draft.definition, trigger } })
          }
          onUpdateStep={(id, update) =>
            setDraft({ ...draft, definition: updateStepById(draft.definition, id, update) })
          }
          onRemoveStep={(id) => {
            setDraft({ ...draft, definition: removeStepById(draft.definition, id) });
            setSelected(undefined);
          }}
          onClose={() => setSelected(undefined)}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {savedKey ? (
        <p role="status">
          Draft saved.{' '}
          <Link href={href} className="underline">
            Open in builder
          </Link>
        </p>
      ) : cancelled ? (
        <p>Proposal discarded.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled || dirty || editing} onClick={() => void save()}>
            {busy ? 'Working…' : 'Save draft'}
          </Button>
          {editing ? (
            <Button variant="outline" disabled={disabled} onClick={() => void review()}>
              Review edits
            </Button>
          ) : (
            <Button variant="outline" disabled={disabled} onClick={() => setEditing(true)}>
              Edit draft
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => update({ cancelled: true })}>
            Discard
          </Button>
          {proposal.target ? (
            <Link href={href} className="self-center underline">
              Open builder
            </Link>
          ) : null}
        </div>
      )}
      {expired && !savedKey ? <p>Proposal expired. Ask AI to prepare a fresh one.</p> : null}
      {!disabled ? (
        <details>
          <summary className="cursor-pointer">Simulate with sample data</summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted-foreground">
              No email is sent or queued. Lead changes and waits are simulated. This does not verify
              live document requirements or email delivery.
            </p>
            <label className="block">
              Sample lead type
              <select
                aria-label="Sample lead type"
                className="block w-full rounded border bg-background p-2"
                value={scenario.leadType}
                onChange={(e) => {
                  const leadType = e.target.value;
                  setScenario({
                    ...scenario,
                    leadType,
                    planId: '',
                    properties: {},
                    stage:
                      proposal.catalog.leadTypes.find((t) => t.key === leadType)?.stages[0]?.key ??
                      '',
                  });
                }}
              >
                {proposal.catalog.leadTypes.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Sample stage
              <select
                aria-label="Sample stage"
                className="block w-full rounded border bg-background p-2"
                value={scenario.stage}
                onChange={(e) => setScenario({ ...scenario, stage: e.target.value })}
              >
                {proposal.catalog.leadTypes
                  .find((t) => t.key === scenario.leadType)
                  ?.stages.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              Sample plan
              <select
                aria-label="Sample plan"
                className="block w-full rounded border bg-background p-2"
                value={scenario.planId}
                onChange={(e) => setScenario({ ...scenario, planId: e.target.value })}
              >
                <option value="">No plan</option>
                {proposal.catalog.plans
                  .filter((p) => p.leadType === scenario.leadType)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              Sample assignee
              <select
                aria-label="Sample assignee"
                className="block w-full rounded border bg-background p-2"
                value={scenario.assignedActorId}
                onChange={(e) => setScenario({ ...scenario, assignedActorId: e.target.value })}
              >
                <option value="">Unassigned</option>
                {proposal.catalog.members.map((m) => (
                  <option key={m.actorId} value={m.actorId}>
                    {m.displayName ?? 'Unnamed member'}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>Sample properties</summary>
              {proposal.catalog.properties
                .filter((p) => p.condition && p.leadTypes.includes(scenario.leadType))
                .map((property) => (
                  <label key={property.key} className="block">
                    {property.label}
                    {property.kind === 'yesNo' ? (
                      <select
                        className="block w-full rounded border bg-background p-2"
                        value={String(scenario.properties[property.key] ?? '')}
                        onChange={(e) =>
                          setScenario({
                            ...scenario,
                            properties: {
                              ...scenario.properties,
                              [property.key]:
                                e.target.value === '' ? null : e.target.value === 'true',
                            },
                          })
                        }
                      >
                        <option value="">Not set</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : (
                      <Input
                        aria-label={`Sample ${property.label}`}
                        type={
                          ['number', 'money', 'count'].includes(property.kind) ? 'number' : 'text'
                        }
                        value={String(scenario.properties[property.key] ?? '')}
                        onChange={(e) =>
                          setScenario({
                            ...scenario,
                            properties: {
                              ...scenario.properties,
                              [property.key]:
                                e.target.value === ''
                                  ? null
                                  : ['number', 'money', 'count'].includes(property.kind)
                                    ? Number(e.target.value)
                                    : e.target.value,
                            },
                          })
                        }
                      />
                    )}
                  </label>
                ))}
            </details>
            <Button
              variant="outline"
              disabled={busy || dirty || editing}
              onClick={() => void simulate()}
            >
              Run simulation
            </Button>
          </div>
        </details>
      ) : null}
      {simulation ? (
        <div aria-label="Automation simulation results" className="space-y-1 rounded border p-2">
          <p>
            {simulation.triggerMatched
              ? 'Trigger conditions match'
              : 'Trigger conditions do not match'}{' '}
            · No email queued
          </p>
          {simulation.steps.map((s) => (
            <p key={s.stepId}>{simulationStepText(s)}</p>
          ))}
          <p>{simulation.uncoveredBranches.length} branch outcomes remain untested.</p>
        </div>
      ) : null}
    </section>
  );
}
