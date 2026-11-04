import { MarkerType, type Edge, type Node } from '@xyflow/react';
import {
  AUTOMATION_MAX_BRANCH_DEPTH,
  AUTOMATION_MAX_STEPS,
  type FlowDefinition,
  type FlowDraft,
  type FlowDraftStep,
  type FlowDraftTrigger,
  type FlowIssue,
  type FlowStep,
  type FlowStepKind,
  type FlowTrigger,
} from '@gt-sales/contracts';

import {
  describeCondition,
  describeStep,
  describeTrigger,
  namesFromCode,
  type FlowNames,
} from '../flow-words';

export const CARD_WIDTH = 304;
export const CARD_HEIGHT = 116;
export const ADD_BUTTON_SIZE = 32;
export const VERTICAL_GAP = 32;
export const BRANCH_GAP = 64;
export const BRANCH_LABEL_GAP = 24;

export const STEP_KIND_LABELS: Readonly<Record<FlowStepKind, string>> = {
  send_email: 'Send email',
  create_task: 'Create task',
  assign_lead: 'Assign lead',
  update_lead: 'Update lead',
  notify_staff: 'Notify staff',
  if_else: 'If/else',
  wait: 'Wait',
};

export interface TriggerNodeData extends Record<string, unknown> {
  kind: 'trigger';
  trigger: FlowTrigger | FlowDraftTrigger | null;
  path: 'trigger';
  summary: string;
  whenSummary: string | null;
  issues: FlowIssue[];
  incomplete: boolean;
  readOnly: boolean;
}

export interface StepNodeData extends Record<string, unknown> {
  kind: 'step';
  step: FlowStep | FlowDraftStep;
  path: string;
  kindLabel: string;
  summary: string;
  issues: FlowIssue[];
  incomplete: boolean;
  readOnly: boolean;
}

export interface IfElseNodeData extends Record<string, unknown> {
  kind: 'if_else';
  step: Extract<FlowStep | FlowDraftStep, { kind: 'if_else' }>;
  path: string;
  kindLabel: string;
  summary: string;
  issues: FlowIssue[];
  incomplete: boolean;
  depth: number;
  readOnly: boolean;
}

export interface AddStepNodeData extends Record<string, unknown> {
  kind: 'add_step';
  sequencePath: string;
  index: number;
  depth: number;
  branchLabel?: 'Yes' | 'No';
  label: string;
  canAddIfElse: boolean;
  disabled: boolean;
}

export interface EndNodeData extends Record<string, unknown> {
  kind: 'end';
  label: string;
  branchLabel?: 'Yes' | 'No';
}
export type FlowCanvasNodeData =
  TriggerNodeData | StepNodeData | IfElseNodeData | AddStepNodeData | EndNodeData;

export type FlowCanvasNode = Node<FlowCanvasNodeData>;
export type FlowCanvasEdge = Edge;

export interface LayoutFlowOptions {
  issues?: readonly FlowIssue[];
  readOnly?: boolean;
  names?: FlowNames;
}

export interface LayoutFlowResult {
  nodes: FlowCanvasNode[];
  edges: FlowCanvasEdge[];
  totalSteps: number;
}

export function isTriggerIncomplete(trigger: FlowTrigger | FlowDraftTrigger | null): boolean {
  if (trigger === null) return true;
  switch (trigger.kind) {
    case 'lead_submitted':
      return trigger.leadTypes.length === 0;
    case 'stage_entered':
      return trigger.leadType === null || trigger.stage === null;
    case 'time_in_stage':
      return trigger.leadType === null || trigger.stage === null || trigger.after === null;
    case 'task_overdue':
      return false;
    case 'after_submitted':
      return trigger.leadTypes.length === 0 || trigger.after === null;
  }
}

export function isStepIncomplete(step: FlowStep | FlowDraftStep): boolean {
  switch (step.kind) {
    case 'send_email':
      return step.template === null;
    case 'create_task':
      return step.title === null || step.title.trim() === '';
    case 'assign_lead':
      return step.actorId === null;
    case 'update_lead':
      return step.change === null;
    case 'notify_staff':
      return !step.toAssignee && step.actorIds.length === 0;
    case 'if_else':
      return step.condition === null;
    case 'wait':
      return step.for === null;
  }
}

function issuesForTrigger(issues: readonly FlowIssue[]): FlowIssue[] {
  return issues.filter(
    (issue) =>
      issue.path === '' ||
      issue.path === 'steps' ||
      issue.path === 'trigger' ||
      issue.path.startsWith('trigger.'),
  );
}

function issuesForStep(issues: readonly FlowIssue[], path: string, isIfElse: boolean): FlowIssue[] {
  return issues.filter((issue) => {
    if (issue.path === path) return true;
    if (!issue.path.startsWith(`${path}.`)) return false;
    if (isIfElse) {
      return !issue.path.startsWith(`${path}.then.`) && !issue.path.startsWith(`${path}.else.`);
    }
    return true;
  });
}

function countSteps(steps: readonly (FlowStep | FlowDraftStep)[]): number {
  let count = 0;
  for (const step of steps) {
    count += 1;
    if (step.kind === 'if_else') {
      count += countSteps(step.then) + countSteps(step.else);
    }
  }
  return count;
}

function branchDepth(steps: readonly (FlowStep | FlowDraftStep)[]): number {
  return steps.reduce(
    (deepest, step) =>
      step.kind === 'if_else'
        ? Math.max(deepest, 1 + Math.max(branchDepth(step.then), branchDepth(step.else)))
        : deepest,
    0,
  );
}

function computeSequenceWidth(steps: readonly (FlowStep | FlowDraftStep)[]): number {
  let width = CARD_WIDTH;
  for (const step of steps) {
    if (step.kind === 'if_else') {
      const leftWidth = computeSequenceWidth(step.then);
      const rightWidth = computeSequenceWidth(step.else);
      width = Math.max(width, leftWidth + BRANCH_GAP + rightWidth);
    }
  }
  return width;
}

/**
 * Pure deterministic auto-layout for a flow's canvas: places the trigger card
 * at the top, each step card vertically below it, "+" buttons between steps
 * and at the end of every path, and splits each `if_else` into side-by-side
 * Yes (left) and No (right) branches. Nodes are emitted in pre-order (`then`
 * before `else`) so DOM and keyboard Tab order match the logical flow order.
 */
export function layoutFlow(
  definition: FlowDefinition | FlowDraft,
  options: LayoutFlowOptions = {},
): LayoutFlowResult {
  const issues = options.issues ?? [];
  const readOnly = options.readOnly ?? false;
  const names = options.names ?? namesFromCode();
  const totalSteps = countSteps(definition.steps);
  const stepsLimitReached = totalSteps >= AUTOMATION_MAX_STEPS;

  const nodes: FlowCanvasNode[] = [];
  const edges: FlowCanvasEdge[] = [];

  const triggerSummary =
    definition.trigger === null
      ? 'Choose when this flow runs'
      : describeTrigger(definition.trigger, names);
  const whenSummary =
    definition.trigger?.when !== null && definition.trigger?.when !== undefined
      ? `Only when ${describeCondition(definition.trigger.when, names)}`
      : null;

  nodes.push({
    id: 'trigger',
    type: 'trigger',
    position: { x: -CARD_WIDTH / 2, y: 0 },
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    initialWidth: CARD_WIDTH,
    initialHeight: CARD_HEIGHT,
    draggable: false,
    selectable: false,
    data: {
      kind: 'trigger',
      trigger: definition.trigger,
      path: 'trigger',
      summary: triggerSummary,
      whenSummary,
      issues: issuesForTrigger(issues),
      incomplete: isTriggerIncomplete(definition.trigger),
      readOnly,
    },
  });

  function addEdge(source: string, target: string, label?: 'Yes' | 'No'): void {
    edges.push({
      id: `edge:${source}->${target}`,
      source,
      target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      ...(label
        ? {
            label: label === 'Yes' ? 'Yes · matches' : 'No · otherwise',
            sourceHandle: label.toLowerCase(),
          }
        : {}),
    });
  }

  function layoutSequence(
    steps: readonly (FlowStep | FlowDraftStep)[],
    sequencePath: string,
    depth: number,
    centerX: number,
    startY: number,
    parentNodeId: string,
    branchLabel?: 'Yes' | 'No',
  ): number {
    let currentY = startY;
    let previousId = parentNodeId;
    let pendingBranchLabel = branchLabel;

    const placeAddButton = (index: number, label: string) => {
      if (readOnly) return;
      const addId = `add:${sequencePath}.${index}`;
      nodes.push({
        id: addId,
        type: 'add_step',
        position: { x: centerX - ADD_BUTTON_SIZE / 2, y: currentY },
        width: ADD_BUTTON_SIZE,
        height: ADD_BUTTON_SIZE,
        initialWidth: ADD_BUTTON_SIZE,
        initialHeight: ADD_BUTTON_SIZE,
        draggable: false,
        selectable: false,
        data: {
          kind: 'add_step',
          sequencePath,
          index,
          depth,
          ...(pendingBranchLabel ? { branchLabel: pendingBranchLabel } : {}),
          label,
          canAddIfElse: depth + 1 + branchDepth(steps.slice(index)) <= AUTOMATION_MAX_BRANCH_DEPTH,
          disabled: stepsLimitReached,
        },
      });
      addEdge(previousId, addId, pendingBranchLabel);
      pendingBranchLabel = undefined;
      previousId = addId;
      currentY += ADD_BUTTON_SIZE + VERTICAL_GAP;
    };

    steps.forEach((step, index) => {
      const stepPath = `${sequencePath}.${index}`;
      const addLabel =
        index === 0 && branchLabel
          ? `Add step to ${branchLabel} branch`
          : index === 0 && sequencePath === 'steps'
            ? 'Add first step'
            : `Add step before ${STEP_KIND_LABELS[step.kind]}`;
      placeAddButton(index, addLabel);

      if (step.kind === 'if_else') {
        nodes.push({
          id: step.id,
          type: 'if_else',
          position: { x: centerX - CARD_WIDTH / 2, y: currentY },
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          initialWidth: CARD_WIDTH,
          initialHeight: CARD_HEIGHT,
          draggable: false,
          selectable: false,
          data: {
            kind: 'if_else',
            step,
            path: stepPath,
            kindLabel: STEP_KIND_LABELS.if_else,
            summary: describeStep(step, names),
            issues: issuesForStep(issues, stepPath, true),
            incomplete: isStepIncomplete(step),
            depth,
            readOnly,
          },
        });
        addEdge(previousId, step.id, pendingBranchLabel);
        pendingBranchLabel = undefined;
        previousId = step.id;
        currentY += CARD_HEIGHT + VERTICAL_GAP + BRANCH_LABEL_GAP;

        const leftWidth = computeSequenceWidth(step.then);
        const rightWidth = computeSequenceWidth(step.else);
        const totalWidth = leftWidth + BRANCH_GAP + rightWidth;
        const leftEdge = centerX - totalWidth / 2;
        const yesCenterX = leftEdge + leftWidth / 2;
        const noCenterX = leftEdge + leftWidth + BRANCH_GAP + rightWidth / 2;

        const yesEndY = layoutSequence(
          step.then,
          `${stepPath}.then`,
          depth + 1,
          yesCenterX,
          currentY,
          step.id,
          'Yes',
        );
        const noEndY = layoutSequence(
          step.else,
          `${stepPath}.else`,
          depth + 1,
          noCenterX,
          currentY,
          step.id,
          'No',
        );
        currentY = Math.max(yesEndY, noEndY);
      } else {
        nodes.push({
          id: step.id,
          type: 'step',
          position: { x: centerX - CARD_WIDTH / 2, y: currentY },
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          initialWidth: CARD_WIDTH,
          initialHeight: CARD_HEIGHT,
          draggable: false,
          selectable: false,
          data: {
            kind: 'step',
            step,
            path: stepPath,
            kindLabel: STEP_KIND_LABELS[step.kind],
            summary: describeStep(step, names),
            issues: issuesForStep(issues, stepPath, false),
            incomplete: isStepIncomplete(step),
            readOnly,
          },
        });
        addEdge(previousId, step.id, pendingBranchLabel);
        pendingBranchLabel = undefined;
        previousId = step.id;
        currentY += CARD_HEIGHT + VERTICAL_GAP;
      }
    });

    const lastStep = steps.at(-1);
    if (lastStep?.kind !== 'if_else') {
      const endLabel = branchLabel
        ? `Add step to ${branchLabel} branch`
        : steps.length === 0
          ? 'Add first step'
          : 'Add step at end';
      placeAddButton(steps.length, endLabel);
      const endId = `end:${sequencePath}`;
      nodes.push({
        id: endId,
        type: 'end',
        position: { x: centerX - 90, y: currentY },
        width: 180,
        height: 36,
        initialWidth: 180,
        initialHeight: 36,
        draggable: false,
        selectable: false,
        data: {
          kind: 'end',
          label: steps.length === 0 ? 'No actions on this path' : 'End of path',
          ...(pendingBranchLabel ? { branchLabel: pendingBranchLabel } : {}),
        },
      });
      addEdge(previousId, endId, pendingBranchLabel);
      currentY += 36 + VERTICAL_GAP;
    }

    return currentY;
  }

  layoutSequence(definition.steps, 'steps', 0, 0, CARD_HEIGHT + VERTICAL_GAP, 'trigger', undefined);

  return { nodes, edges, totalSteps };
}
