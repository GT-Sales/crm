import type {
  AiActionCard,
  AiActionDraft,
  AiAutomationProposal,
  AiStreamPart,
} from '@gt-sales/contracts';
import { walkDraftSteps } from '@gt-sales/contracts';

/**
 * What one streamed Ask AI answer held, as the model test keeps it: the text,
 * the progress labels (the stream's only trace of which tools ran: raw tool
 * calls never leave the backend), the cards and automation drafts without
 * their signed tokens, the follow-up, the sources and how the turn ended.
 * Nothing secret is kept: no token, no email address.
 */
export interface CardSummary {
  readonly kind: string;
  readonly leadId?: string;
  readonly taskId?: string;
  readonly leadLabel?: string;
  /** The draft's fields other than `kind` (stage, body, subject, title, due date …). */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface AutomationSummary {
  readonly name?: string;
  /** The trigger's kind and every step's kind, in order. */
  readonly kinds: readonly string[];
  readonly edit: boolean;
}

export interface TurnCapture {
  text: string;
  progress: string[];
  /** Tool names the progress labels stand for (`a|b` when a label is shared). */
  tools: string[];
  cards: CardSummary[];
  automations: AutomationSummary[];
  followUp?: { question: string; choices: string[] };
  sources: { kind: string; label: string }[];
  notices: string[];
  error?: { code: string };
  conversationId?: string;
  /** Whether the stream ended with its `done` part. */
  done: boolean;
  /** Milliseconds from the request to the first text part. */
  firstTextMs?: number;
}

/** The route's progress labels (routes/ai-assistant.ts), mapped back to their tools. */
const LABEL_TOOLS: Readonly<Record<string, string>> = {
  'Checking lead counts': 'getSiteOverview',
  'Searching leads': 'findLeads',
  'Reading the lead': 'getLeadSummary',
  'Checking follow-ups': 'listOpenTasks',
  'Reading the source report': 'getSourcePerformance',
  'Checking the inbox counters': 'getInboxCounts',
  'Preparing a note for review': 'prepareNote',
  'Preparing a task for review': 'prepareTask',
  'Preparing a task move for review': 'prepareTaskUpdate',
  'Preparing an email for review': 'prepareEmail|prepareTemplateEmail',
  'Checking the lead’s choices': 'getLeadUpdateOptions',
  'Preparing a lead change for review': 'prepareLeadUpdate|prepareLeadEdit',
  'Checking the team': 'getAssigneeOptions',
  'Checking what the lead can change': 'getLeadEditOptions',
  'Preparing an archive change for review': 'prepareArchive',
  'Preparing to switch an automation off': 'prepareAutomationOff',
  'Reading the automations': 'listAutomations',
  'Reading the automation': 'getAutomation',
  'Checking what automations can use': 'getAutomationCatalog',
  'Reading recent runs': 'getAutomationRuns',
  'Drafting an automation for review': 'proposeAutomationCreate',
  'Drafting automation changes for review': 'proposeAutomationEdit',
  'Preparing a question': 'askFollowUp',
  'Looking up the CRM guide': 'getCrmGuide',
  'Checking the CRM': 'wideRead',
};

/** Progress that is not a tool. */
export const NON_TOOL_PROGRESS: ReadonlySet<string> = new Set(['Getting ready', 'Thinking']);

export function toolOfLabel(label: string): string | undefined {
  return NON_TOOL_PROGRESS.has(label) ? undefined : (LABEL_TOOLS[label] ?? 'unknown');
}

export function summarizeCard(
  card: Pick<AiActionCard, 'leadLabel'> & { draft: AiActionCard['draft'] | AiActionDraft },
): CardSummary {
  const { kind, ...fields } = card.draft;
  const leadId = 'leadId' in card.draft ? card.draft.leadId : undefined;
  const taskId = 'taskId' in card.draft ? card.draft.taskId : undefined;
  return {
    kind,
    ...(leadId ? { leadId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(card.leadLabel ? { leadLabel: card.leadLabel } : {}),
    fields,
  };
}

export function summarizeAutomation(proposal: AiAutomationProposal): AutomationSummary {
  const kinds: string[] = [];
  const definition = proposal.draft.definition;
  if (definition.trigger) kinds.push(definition.trigger.kind);
  walkDraftSteps(definition.steps, (step) => kinds.push(step.kind));
  const name: unknown = Reflect.get(proposal.draft, 'name');
  return {
    ...(typeof name === 'string' ? { name } : {}),
    kinds,
    edit: proposal.target !== undefined && proposal.target !== null,
  };
}

export function emptyCapture(): TurnCapture {
  return {
    text: '',
    progress: [],
    tools: [],
    cards: [],
    automations: [],
    sources: [],
    notices: [],
    done: false,
  };
}

/**
 * Folds one part into the capture. Cards come twice from a current backend
 * (in full in `action_cards`, again in their older shape in `actions`): the
 * full copy wins, and an `actions` card is kept only when no `action_cards`
 * part came (an older backend).
 */
export function addPart(
  capture: TurnCapture,
  part: AiStreamPart,
  elapsedMs: number,
  state: { sawFullCards: boolean; legacy: CardSummary[] },
): void {
  switch (part.type) {
    case 'text':
      if (capture.firstTextMs === undefined) capture.firstTextMs = elapsedMs;
      capture.text += part.text;
      break;
    case 'progress': {
      capture.progress.push(part.label);
      const tool = toolOfLabel(part.label);
      if (tool) capture.tools.push(tool);
      break;
    }
    case 'action_cards':
      state.sawFullCards = true;
      capture.cards.push(...part.cards.map(summarizeCard));
      break;
    case 'actions':
      state.legacy.push(...part.actions.map((action) => summarizeCard(action)));
      break;
    case 'automation_proposals':
      capture.automations.push(...part.proposals.map(summarizeAutomation));
      break;
    case 'follow_up':
      capture.followUp = { question: part.followUp.question, choices: [...part.followUp.choices] };
      break;
    case 'sources':
      capture.sources.push(
        ...part.sources.map((source) => ({ kind: source.kind, label: source.label })),
      );
      break;
    case 'notice':
      capture.notices.push(part.code);
      break;
    case 'error':
      capture.error = { code: part.code };
      break;
    case 'conversation':
      capture.conversationId = part.conversationId;
      break;
    case 'done':
      capture.done = true;
      break;
  }
}

/** Reads a whole streamed answer into a capture. `now` is injectable for tests. */
export async function captureStream(
  parts: AsyncIterable<AiStreamPart>,
  now: () => number = () => Date.now(),
): Promise<TurnCapture> {
  const started = now();
  const capture = emptyCapture();
  const legacy: CardSummary[] = [];
  const state = { sawFullCards: false, legacy };
  for await (const part of parts) addPart(capture, part, now() - started, state);
  if (!state.sawFullCards) capture.cards.push(...state.legacy);
  return capture;
}
