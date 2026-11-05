import {
  allowedStageMoves,
  leadStageLabel,
  stageGates,
  type LeadDocument,
} from '@gt-sales/contracts';

/**
 * Each lead type's main path, in the order a lead normally travels it. Stages
 * off to the side (on hold, cancelled, lost, declined, a non-serviceable
 * address…) stay reachable from the Stage menu; the path shows where a lead is
 * going, not every place it can end up. Presentation only: which moves are
 * allowed, and what they ask first, is still the catalogue's (`moves`, `gates`)
 * and the backend's.
 */
export const LEAD_STAGE_PATHS: Readonly<Record<string, readonly string[]>> = {
  sim_order: ['incomplete', 'pending', 'verified', 'delivered', 'activated', 'completed'],
  internet: ['new', 'contacted', 'qualified', 'installed', 'won'],
  mobility: ['new', 'contacted', 'qualified', 'activated', 'won'],
  partner_application: ['new', 'contacted', 'approved'],
  contact_message: ['new', 'replied', 'closed'],
};

export interface StagePathStep {
  readonly key: string;
  readonly label: string;
  readonly state: 'done' | 'current' | 'upcoming';
}

export interface NextStep {
  readonly key: string;
  readonly label: string;
  /** What the move asks for or waits on, in words; empty when it can go straight ahead. */
  readonly needs: readonly string[];
  /** True when a requirement cannot be met in the move's own dialog (documents not approved). */
  readonly blocked: boolean;
}

export interface StagePath {
  readonly steps: readonly StagePathStep[];
  /** Set when the lead stands on a stage off the main path (on hold, lost…). */
  readonly offPath: string | undefined;
  readonly next: NextStep | undefined;
}

const documentWords = (key: string) => key.replaceAll('_', ' ');

/**
 * The path a lead of this type travels, where it stands on it, and the next
 * step with what that step asks first: a courier (`dispatch`), an activation
 * date (`activation`, today unless given) and approved documents (`documents`,
 * from the frozen plan). Undefined for a type without a defined path.
 */
export function stagePath(input: {
  readonly leadType: string;
  readonly stage: string;
  readonly order?: {
    readonly courier?: string | null;
    readonly plan?: { readonly requiredDocuments: readonly string[] } | null;
  };
  readonly documents: readonly Pick<LeadDocument, 'documentType' | 'review'>[];
}): StagePath | undefined {
  const path = LEAD_STAGE_PATHS[input.leadType];
  if (!path) return undefined;
  const at = path.indexOf(input.stage);
  const steps: StagePathStep[] = path.map((key, index) => ({
    key,
    label: leadStageLabel(input.leadType, key),
    state: at === -1 ? 'upcoming' : index < at ? 'done' : index === at ? 'current' : 'upcoming',
  }));
  const offPath = at === -1 ? leadStageLabel(input.leadType, input.stage) : undefined;
  const candidate = at === -1 ? undefined : path[at + 1];
  if (!candidate || !allowedStageMoves(input.leadType, input.stage).includes(candidate)) {
    return { steps, offPath, next: undefined };
  }

  const needs: string[] = [];
  let blocked = false;
  for (const gate of stageGates(input.leadType, candidate)) {
    if (gate === 'dispatch' && !input.order?.courier?.trim()) needs.push('asks for the courier');
    if (gate === 'activation') needs.push('asks for the activation date');
    if (gate === 'documents') {
      const approved = new Set(
        input.documents
          .filter((document) => document.review?.decision === 'approved')
          .map((document) => document.documentType),
      );
      const missing = (input.order?.plan?.requiredDocuments ?? []).filter(
        (key) => !approved.has(key),
      );
      if (missing.length > 0) {
        needs.push(`needs ${missing.map(documentWords).join(', ')} approved`);
        blocked = true;
      }
    }
  }
  return {
    steps,
    offPath,
    next: { key: candidate, label: leadStageLabel(input.leadType, candidate), needs, blocked },
  };
}
