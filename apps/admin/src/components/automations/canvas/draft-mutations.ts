import {
  randomKeySuffix,
  walkDraftSteps,
  type FlowDefinition,
  type FlowDraft,
  type FlowDraftStep,
  type FlowStep,
  type FlowStepKind,
} from '@gt-sales/contracts';

export function generateStepId(existingIds?: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `s_${randomKeySuffix(8)}`;
    if (!existingIds?.has(candidate)) return candidate;
  }
  return `s_${randomKeySuffix(12)}`;
}

export function collectStepIds(steps: readonly FlowDraftStep[]): Set<string> {
  const ids = new Set<string>();
  walkDraftSteps(steps, (step) => {
    ids.add(step.id);
  });
  return ids;
}

export function createBlankDraftStep(kind: FlowStepKind, id: string): FlowDraftStep {
  switch (kind) {
    case 'send_email':
      return { id, kind: 'send_email', template: null };
    case 'create_task':
      return {
        id,
        kind: 'create_task',
        title: null,
        dueInDays: 1,
        assignee: { kind: 'lead_assignee' },
      };
    case 'assign_lead':
      return { id, kind: 'assign_lead', actorId: null, reassign: false };
    case 'update_lead':
      return { id, kind: 'update_lead', change: null };
    case 'notify_staff':
      return { id, kind: 'notify_staff', toAssignee: true, actorIds: [], note: '' };
    case 'if_else':
      return { id, kind: 'if_else', condition: null, then: [], else: [] };
    case 'wait':
      return { id, kind: 'wait', for: { amount: 1, unit: 'days' } };
  }
}

function updateSequenceAtPath(
  steps: readonly FlowDraftStep[],
  parts: readonly string[],
  transform: (sequence: readonly FlowDraftStep[]) => FlowDraftStep[],
): FlowDraftStep[] {
  if (parts.length === 0) {
    return transform(steps);
  }
  const [indexPart, branchPart, ...rest] = parts;
  const targetIndex = Number(indexPart);
  return steps.map((step, idx) => {
    if (idx !== targetIndex || step.kind !== 'if_else') return step;
    if (branchPart === 'then') {
      return { ...step, then: updateSequenceAtPath(step.then, rest, transform) };
    }
    if (branchPart === 'else') {
      return { ...step, else: updateSequenceAtPath(step.else, rest, transform) };
    }
    return step;
  });
}

/**
 * Inserts a new step of `kind` into `sequencePath` (`"steps"`,
 * `"steps.0.then"`, `"steps.0.else"`, etc.) at `index`. Per rule R7, an
 * `if_else` is always the last step of its sequence, so inserting an `if_else`
 * before existing steps moves those steps into its `then` (Yes) branch.
 */
export function insertStepAt(
  draft: FlowDraft,
  sequencePath: string,
  index: number,
  kind: FlowStepKind,
): { draft: FlowDraft; stepId: string; movedToYesCount: number } {
  const existingIds = collectStepIds(draft.steps);
  const stepId = generateStepId(existingIds);
  const rawParts = sequencePath.split('.');
  const parts = rawParts[0] === 'steps' ? rawParts.slice(1) : rawParts;
  let movedToYesCount = 0;

  const nextSteps = updateSequenceAtPath(draft.steps, parts, (sequence) => {
    const clampedIndex = Math.max(0, Math.min(index, sequence.length));
    const before = sequence.slice(0, clampedIndex);
    const after = sequence.slice(clampedIndex);
    if (kind === 'if_else') {
      movedToYesCount = after.length;
      const ifElseStep: FlowDraftStep = {
        id: stepId,
        kind: 'if_else',
        condition: null,
        then: [...after],
        else: [],
      };
      return [...before, ifElseStep];
    }
    const created = createBlankDraftStep(kind, stepId);
    return [...before, created, ...after];
  });

  return {
    draft: { ...draft, steps: nextSteps },
    stepId,
    movedToYesCount,
  };
}

export function updateStepById(
  draft: FlowDraft,
  stepId: string,
  updater: (step: FlowDraftStep) => FlowDraftStep,
): FlowDraft {
  function mapSequence(steps: readonly FlowDraftStep[]): FlowDraftStep[] {
    return steps.map((step) => {
      if (step.id === stepId) {
        return updater(step);
      }
      if (step.kind === 'if_else') {
        return {
          ...step,
          then: mapSequence(step.then),
          else: mapSequence(step.else),
        };
      }
      return step;
    });
  }
  return { ...draft, steps: mapSequence(draft.steps) };
}

export function removeStepById(draft: FlowDraft, stepId: string): FlowDraft {
  function filterSequence(steps: readonly FlowDraftStep[]): FlowDraftStep[] {
    return steps
      .filter((step) => step.id !== stepId)
      .map((step) =>
        step.kind === 'if_else'
          ? {
              ...step,
              then: filterSequence(step.then),
              else: filterSequence(step.else),
            }
          : step,
      );
  }
  return { ...draft, steps: filterSequence(draft.steps) };
}

export function findStepById(
  steps: readonly (FlowStep | FlowDraftStep)[],
  stepId: string,
): { step: FlowStep | FlowDraftStep; path: string; depth: number } | undefined {
  function search(
    sequence: readonly (FlowStep | FlowDraftStep)[],
    prefix: string,
    depth: number,
  ): { step: FlowStep | FlowDraftStep; path: string; depth: number } | undefined {
    for (let index = 0; index < sequence.length; index += 1) {
      const step = sequence[index]!;
      const path = `${prefix}.${index}`;
      if (step.id === stepId) return { step, path, depth };
      if (step.kind === 'if_else') {
        const inThen = search(step.then, `${path}.then`, depth + 1);
        if (inThen) return inThen;
        const inElse = search(step.else, `${path}.else`, depth + 1);
        if (inElse) return inElse;
      }
    }
    return undefined;
  }
  return search(steps, 'steps', 0);
}

export function countNestedSteps(step: FlowStep | FlowDraftStep): number {
  if (step.kind !== 'if_else') return 0;
  let total = 0;
  const countBranch = (branch: readonly (FlowStep | FlowDraftStep)[]) => {
    for (const child of branch) {
      total += 1;
      if (child.kind === 'if_else') {
        countBranch(child.then);
        countBranch(child.else);
      }
    }
  };
  countBranch(step.then);
  countBranch(step.else);
  return total;
}

/** Clones an active FlowDefinition into a mutable FlowDraft structure. */
export function definitionToDraft(definition: FlowDefinition | FlowDraft): FlowDraft {
  function cloneStep(step: FlowStep | FlowDraftStep): FlowDraftStep {
    if (step.kind === 'if_else') {
      return {
        id: step.id,
        kind: 'if_else',
        condition: step.condition,
        then: step.then.map(cloneStep),
        else: step.else.map(cloneStep),
      };
    }
    return { ...step };
  }
  return {
    schemaVersion: 1,
    trigger: definition.trigger ? { ...definition.trigger } : null,
    steps: definition.steps.map(cloneStep),
  };
}
