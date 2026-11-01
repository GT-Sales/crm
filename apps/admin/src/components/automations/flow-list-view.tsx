'use client';

import type { JSX } from 'react';
import type {
  FlowDefinition,
  FlowDraft,
  FlowDraftStep,
  FlowStep,
  FlowStepKind,
  FlowIssue,
} from '@gt-sales/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@gt-sales/ui';
import {
  describeCondition,
  describeStep,
  describeTrigger,
  issueText,
  type FlowNames,
} from './flow-words';
import { layoutFlow, STEP_KIND_LABELS, type FlowCanvasNode } from './canvas/layout-flow';

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const actions: readonly FlowStepKind[] = [
  'send_email',
  'create_task',
  'assign_lead',
  'update_lead',
  'notify_staff',
];
const controls: readonly FlowStepKind[] = ['if_else', 'wait'];
interface ListControls {
  selectedId?: string;
  onSelectNode?(id: string): void;
  onAddStep?(sequencePath: string, index: number, kind: FlowStepKind): void;
  nodes: readonly FlowCanvasNode[];
}

function AddStep({
  path,
  index,
  controls: editor,
}: {
  path: string;
  index: number;
  controls: ListControls;
}): JSX.Element | null {
  const data = editor.nodes.find((node) => node.id === `add:${path}.${index}`)?.data;
  if (data?.kind !== 'add_step' || !editor.onAddStep) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={data.disabled}
          aria-label={data.label}
        >
          + Add step
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        {actions.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => editor.onAddStep?.(path, index, kind)}>
            {STEP_KIND_LABELS[kind]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Flow</DropdownMenuLabel>
        {controls.map((kind) => (
          <DropdownMenuItem
            key={kind}
            disabled={kind === 'if_else' && !data.canAddIfElse}
            onSelect={() => editor.onAddStep?.(path, index, kind)}
          >
            {STEP_KIND_LABELS[kind]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Card({
  id,
  label,
  editor,
}: {
  id: string;
  label: string;
  editor: ListControls;
}): JSX.Element {
  const data = editor.nodes.find((node) => node.id === id)?.data;
  return (
    <>
      {editor.onSelectNode ? (
        <button
          type="button"
          data-node-id={id}
          aria-pressed={editor.selectedId === id}
          className="text-left underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => editor.onSelectNode?.(id)}
        >
          {label}
        </button>
      ) : (
        <p>{label}</p>
      )}
      {data && data.kind !== 'add_step'
        ? data.issues.map((issue, index) => (
            <p key={index} className="text-xs text-destructive">
              {issueText(issue)}
            </p>
          ))
        : null}
    </>
  );
}

function Steps({
  steps,
  names,
  label,
  path,
  editor,
}: {
  steps: readonly (FlowStep | FlowDraftStep)[];
  names: FlowNames;
  label: string;
  path: string;
  editor: ListControls;
}): JSX.Element {
  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {steps.map((step, index) => (
        <li key={step.id} className="rounded-md border bg-card px-3 py-2 text-sm">
          <div className="mb-2">
            <AddStep path={path} index={index} controls={editor} />
          </div>
          <Card id={step.id} label={describeStep(step, names)} editor={editor} />
          {step.kind === 'if_else' ? (
            <div className="mt-2 flex flex-col gap-2 border-l-2 pl-3">
              <p className="text-xs font-medium text-muted-foreground">Yes</p>
              <Steps
                steps={step.then}
                names={names}
                label="Yes"
                path={`${path}.${index}.then`}
                editor={editor}
              />
              <p className="text-xs font-medium text-muted-foreground">No</p>
              <Steps
                steps={step.else}
                names={names}
                label="No"
                path={`${path}.${index}.else`}
                editor={editor}
              />
            </div>
          ) : null}
        </li>
      ))}
      {steps.at(-1)?.kind !== 'if_else' ? (
        <li>
          {steps.length === 0 ? <p className="text-sm text-muted-foreground">Nothing.</p> : null}
          <AddStep path={path} index={steps.length} controls={editor} />
        </li>
      ) : null}
    </ol>
  );
}

/** The same editor in flow order, with labelled nested Yes/No lists. */
export function FlowListView({
  definition,
  names,
  issues = [],
  readOnly = true,
  selectedId,
  onSelectNode,
  onAddStep,
}: {
  definition: FlowDefinition | FlowDraft;
  names: FlowNames;
  issues?: readonly FlowIssue[];
  readOnly?: boolean;
  selectedId?: string;
  onSelectNode?(id: string): void;
  onAddStep?(sequencePath: string, index: number, kind: FlowStepKind): void;
}): JSX.Element {
  const { trigger } = definition;
  const editor: ListControls = {
    selectedId,
    onSelectNode,
    onAddStep: readOnly ? undefined : onAddStep,
    nodes: layoutFlow(definition, { issues, readOnly, names }).nodes,
  };
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="When it runs" className="flex flex-col gap-1 text-sm">
        <li className="font-medium">
          <Card
            id="trigger"
            label={
              trigger === null
                ? 'No trigger yet.'
                : `When ${lowerFirst(describeTrigger(trigger, names))}`
            }
            editor={editor}
          />
        </li>
        {trigger?.when ? (
          <li className="text-muted-foreground">
            Only when {describeCondition(trigger.when, names)}
          </li>
        ) : null}
      </ol>
      <Steps steps={definition.steps} names={names} label="Steps" path="steps" editor={editor} />
    </div>
  );
}
