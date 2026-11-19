import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  AI_CARD_LIMITS,
  aiActionCardSchema,
  aiActionDraftSchema,
  aiCardDraftSchema,
  aiLeadEditChangesSchema,
  aiTaskAssigneeSchema,
  aiTemplateEmailKeySchema,
  automationKeySchema,
  leadOrderEditSchema,
  leadStageLabel,
  leadTaskStatusSchema,
  type AiActionCard,
  type AiCardDraft,
  type AiCardKind,
  type AiLeadEditChanges,
  type AiStageMoveNeed,
  type AiTaskUpdateContext,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import type { Scope } from '../tenant-scope.js';
import type { AiReadService, LeadHint } from './read-service.js';
import type { StaffAccessSnapshot } from '../staff/authorization.js';
import { TurnBudget } from './limits.js';
import { DISPLAY_NAME_MAX } from './projections.js';
import { RECORD_DATA_NOTICE, inertRecordText, neutralizeSerialized } from './record-text.js';
import {
  aiLeadValueDigest,
  type AiTaskUpdatePreview,
  type AiTemplateEmailPreview,
} from '../leads/work-store.js';
import { archiveEffects, automationOffEffects, type AiLeadEditPreview } from './card-store.js';
import {
  cardAllowed,
  cardLeadLabel,
  emailMentionText,
  legacyProposalOf,
  MAX_SEEN_LEADS,
  mentionedLeads,
  sideEffectsDigest,
  type CardSite,
  type SeenLead,
} from './card-safeguards.js';

const hexDigest = z.string().regex(/^[0-9a-f]{64}$/);

const signedActionSchema = z
  .object({
    id: z.uuid(),
    /**
     * The first card of this draft, when this one is a revision of it. Every
     * version of one draft confirms under the root's id, so a draft saves at
     * most once however many versions were signed (absent: the card is its
     * own root).
     */
    rootId: z.uuid().optional(),
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    expiresAt: z.iso.datetime(),
    draft: aiCardDraftSchema,
    /**
     * A lead update's field value when prepared, as `aiLeadValueDigest`
     * (ACT-3, ACT-5): never the name or phone itself, which the card shows
     * from the stream and the bearer token does not carry.
     */
    leadUpdateBefore: hexDigest.optional(),
    emailContext: z.object({ toAddress: z.email(), fromAddress: z.email() }).strict().optional(),
    /**
     * A task move's task version when prepared (its update time): confirmation
     * refuses the card if the task changed since, never moving it over a change.
     */
    taskUpdateVersion: z.string().min(1).max(100).optional(),
    /**
     * The task's status when the move was prepared: confirmation refuses the
     * card if it differs, even when the update time did not move (the nightly
     * Get Canada Sim sync changes imported tasks without touching it).
     */
    taskUpdateBefore: leadTaskStatusSchema.optional(),
    /** C3: the digest of the side effects the card shows; confirmation recomputes and compares. */
    sideEffects: hexDigest.optional(),
    /** C4: a lead edit's digest of everything it touches (`leadEditVersion`). */
    leadEditVersion: hexDigest.optional(),
    /** C4 + M1: the template version and the digest of the mail the card showed. */
    template: z
      .object({ version: z.int().min(0), rendered: hexDigest })
      .strict()
      .optional(),
    /** C4: an automation switch-off card's flow revision. */
    automationRevision: z.int().min(0).optional(),
    /** B1: the confirmation needs the person's tick that they checked the named leads. */
    acknowledgementRequired: z.literal(true).optional(),
    /**
     * B1: every other lead the card was checked against (those it names
     * first), so a revision checks its new text against the same leads (R2).
     * At most the turn's MAX_SEEN_LEADS.
     */
    mentionLeadIds: z.array(z.uuid()).max(200).optional(),
  })
  .strict();
export type SignedAiAction = z.infer<typeof signedActionSchema>;
const TTL_MS = 10 * 60 * 1000;
/** Members the model is shown per options call (ACT-4); a card may name any active member. */
const MODEL_ASSIGNEE_CHOICES = 24;
/** Members a task card offers to choose from on the card (the contract's 101 choices, You and Unassigned included). */
const CARD_ASSIGNEE_CHOICES = 99;

/** Why a stage move cannot be prepared yet, in words the model can relay. */
const STAGE_NEED_MESSAGES: Record<AiStageMoveNeed, string> = {
  dispatch_details:
    'No card was prepared. This move needs dispatch details (a courier) entered on the lead page first.',
  activation_details:
    'No card was prepared. This move needs an activation date entered on the lead page first.',
  documents:
    'No card was prepared. This move needs the listed required documents approved on the lead page first.',
};

/** What the task tool answers when the database cannot hold a plain task yet (before 0038). */
const PLAIN_TASKS_UNAVAILABLE =
  'No card was prepared. Tasks without a lead are not available on this site yet. Ask the person which lead the task is for.';

const taskDraftShape = {
  title: z.string().trim().min(1).max(200),
  dueDate: z.iso.date().nullable(),
  assignee: aiTaskAssigneeSchema.describe(
    'me (the asking person), none (unassigned), or an active member’s id from getAssigneeOptions.',
  ),
};

/**
 * The task tool's input: the draft's fields with `leadId` required but
 * nullable, so a model states "no lead" (null, a plain task) instead of
 * leaving the id out by accident.
 */
const taskToolInputSchema = z
  .object({
    leadId: z
      .uuid()
      .nullable()
      .describe(
        'The lead the task follows up, from a read tool; null for a plain task (a task with no lead).',
      ),
    ...taskDraftShape,
  })
  .strict();

/** A task edit's input: the task and what changes (any of stage, title, due date, assignee). */
const taskUpdateToolInputSchema = z
  .object({
    taskId: z.uuid(),
    status: leadTaskStatusSchema.optional(),
    title: taskDraftShape.title.optional(),
    dueDate: taskDraftShape.dueDate.optional(),
    assignee: taskDraftShape.assignee.optional(),
  })
  .strict();

/**
 * The lead edit tool's input. The model may propose a courier, tracking
 * number and dates the person gave; an activation number or account is typed
 * by the person on the card, so the model's order edit has neither.
 */
const modelOrderEditSchema = z
  .object({
    planId: z.uuid().nullable().optional(),
    quantity: z.int().min(1).max(99).optional(),
    paymentStatus: z.enum(['not_needed', 'pending', 'paid']).optional(),
    carrierCommission: z.enum(['not_yet', 'invoiced', 'received', 'clawback']).optional(),
    courier: z.string().trim().min(1).max(80).nullable().optional(),
    trackingNumber: z.string().trim().min(1).max(120).nullable().optional(),
    dispatchedAt: z.iso.date().nullable().optional(),
    activatedAt: z.iso.date().nullable().optional(),
  })
  .strict();
const leadEditToolInputSchema = z
  .object({
    leadId: z.uuid(),
    stage: z.string().min(1).max(40).optional(),
    order: modelOrderEditSchema.optional(),
    form: z
      .record(
        z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/),
        z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
    customValues: z
      .record(
        z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/),
        z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();

const templateEmailToolInputSchema = z
  .object({ leadId: z.uuid(), template: aiTemplateEmailKeySchema })
  .strict();
const archiveToolInputSchema = z.object({ leadId: z.uuid(), archived: z.boolean() }).strict();
const automationOffToolInputSchema = z.object({ automationKey: automationKeySchema }).strict();
const assigneeOptionsInputSchema = z
  .object({
    search: z.string().max(80).optional().describe('Part of a member name, to narrow a long list.'),
  })
  .strict();
const leadEditOptionsInputSchema = z.object({ leadId: z.uuid() }).strict();
const leadUpdateOptionsInputSchema = z
  .object({
    leadId: z.uuid(),
    field: z.enum(['stage', 'assignedActorId']),
    search: z
      .string()
      .max(80)
      .optional()
      .describe('For assignedActorId: part of a member name, to narrow a long list.'),
  })
  .strict();

/** The card tools the route dispatches to this toolset, beside the tools each kind needs (C1). */
export const ACTION_TOOL_NAMES = [
  'getLeadUpdateOptions',
  'prepareLeadUpdate',
  'prepareNote',
  'prepareEmail',
  'prepareTask',
  'prepareTaskUpdate',
  'getAssigneeOptions',
  'getLeadEditOptions',
  'prepareLeadEdit',
  'prepareTemplateEmail',
  'prepareArchive',
  'prepareAutomationOff',
] as const;
export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

/** The card kind each tool prepares (or reads choices for), so the C1 table decides whether it is offered. */
const TOOL_KIND: Readonly<Record<ActionToolName, AiCardKind>> = {
  getLeadUpdateOptions: 'lead_update',
  prepareLeadUpdate: 'lead_update',
  prepareNote: 'note',
  prepareEmail: 'email',
  prepareTask: 'task',
  prepareTaskUpdate: 'task_update',
  getAssigneeOptions: 'task',
  getLeadEditOptions: 'lead_edit',
  prepareLeadEdit: 'lead_edit',
  prepareTemplateEmail: 'template_email',
  prepareArchive: 'lead_archive',
  prepareAutomationOff: 'automation_off',
};

/** The card kinds an older admin shows (its `actions` part), whatever this backend offers. */
export const LEGACY_CARD_KINDS: readonly AiCardKind[] = [
  'note',
  'task',
  'email',
  'lead_update',
  'task_update',
];

/**
 * The tools an older admin's turn is offered (T12): those of its kinds, less
 * the member list, which only serves a task for another member.
 */
const LEGACY_TOOL_NAMES: ReadonlySet<ActionToolName> = new Set(
  ACTION_TOOL_NAMES.filter(
    (name) => LEGACY_CARD_KINDS.includes(TOOL_KIND[name]) && name !== 'getAssigneeOptions',
  ),
);

// Domain-separated signing key; rotation of the Gateway key invalidates old cards.
function signature(payload: string, key: string): Buffer {
  const derived = createHmac('sha256', key).update('gt-sales/ai-action/v1').digest();
  return createHmac('sha256', derived).update(payload).digest();
}

export function signAiAction(action: SignedAiAction, key: string): string {
  const payload = Buffer.from(JSON.stringify(signedActionSchema.parse(action))).toString(
    'base64url',
  );
  return `${payload}.${signature(payload, key).toString('base64url')}`;
}

export function verifyAiAction(
  token: string,
  key: string,
  scope: Scope,
  now: Date,
): SignedAiAction | undefined {
  try {
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra !== undefined || token.length > 40000) return undefined;
    const supplied = Buffer.from(mac, 'base64url');
    const expected = signature(payload, key);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return undefined;
    const parsed = signedActionSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return undefined;
    const action = parsed.data;
    const remaining = Date.parse(action.expiresAt) - now.getTime();
    if (
      action.actorId !== scope.actorId ||
      action.workspaceId !== scope.workspaceId ||
      remaining <= 0 ||
      remaining > TTL_MS
    )
      return undefined;
    return action;
  } catch {
    return undefined;
  }
}

/** A lead an archive card names, archived or not (`leadHint` reads only active leads). */
export interface ArchiveLead extends LeadHint {
  readonly archived: boolean;
}

/** The flow a switch-off card names, as it is now. */
export interface AutomationPreview {
  readonly name: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly archived: boolean;
}

/** These tools only prepare cards. The model has no reference to a write store. */
export function createActionProposalTools(input: {
  scope: Scope;
  site: { name: string; slug: string };
  key: string;
  reads: AiReadService;
  /** C1: whether a kind is offered here at all (the automation site allowlist). */
  cardSite?: CardSite;
  emailPreview?: (
    leadId: string,
  ) => Promise<{ toAddress: string; fromAddress: string } | undefined>;
  leadUpdatePreview?: (
    leadId: string,
    field: Extract<import('@gt-sales/contracts').AiActionDraft, { kind: 'lead_update' }>['field'],
    options?: { search?: string; limit?: number },
  ) => Promise<import('../leads/work-store.js').AiLeadUpdatePreview | undefined>;
  /** The task a move card names, read as the card is prepared; absent, no move is offered. */
  taskUpdatePreview?: (taskId: string) => Promise<AiTaskUpdatePreview | undefined>;
  /** Whether a task may have no lead (migration 0038 applied); false asks for a lead. */
  plainTasks?: boolean;
  /** The site's active members (T1–T3): a task's assignee is checked against them. */
  members?: () => Promise<{ actorId: string; displayName: string | null }[]>;
  /** C3: what moving the lead to `stage` sets off, in words. */
  stageEffects?: (leadId: string, stage: string) => Promise<string[] | undefined>;
  leadEditPreview?: (leadId: string, changes: AiLeadEditChanges) => Promise<AiLeadEditPreview>;
  /** The site's property catalogue, for the lead edit options. */
  catalog?: () => Promise<PropertyCatalog>;
  planChoices?: (leadType: string) => Promise<{ planId: string; name: string }[]>;
  templateEmailPreview?: (
    leadId: string,
    template: z.infer<typeof aiTemplateEmailKeySchema>,
  ) => Promise<AiTemplateEmailPreview>;
  archiveLead?: (leadId: string) => Promise<ArchiveLead | undefined>;
  automationPreview?: (key: string) => Promise<AutomationPreview | undefined>;
  /** B1: the leads the model read in this turn; a revision passes the ones its first card named. */
  seenLeads?: () => readonly SeenLead[] | Promise<readonly SeenLead[]>;
  /**
   * The lead's source card: a refusal that sends the person to the lead page
   * leaves them a link to it, and every prepared card about a lead gives its
   * answer the lead's card, so a stored answer is not replayed once the lead
   * is restricted and the erasure finds it (docs/design/ai-chat.md §6, §13).
   */
  onLeadPage?: (lead: LeadHint) => void;
  loadAccess(): Promise<StaffAccessSnapshot | undefined>;
  now(): Date;
  budget: TurnBudget;
  /** Set when revising: the draft's first card, signed into the new one. */
  rootId?: string;
  /**
   * T12: the client shows only the older cards (its chat request had no
   * `wide`). The new kinds' tools are not offered, and no card is prepared
   * that the older shape cannot carry (a task for another member, a task
   * edit beyond its status, a card that needs the mention tick).
   */
  legacyClient?: boolean;
}) {
  const proposals: AiActionCard[] = [];
  const cardSite = input.cardSite ?? { automations: false };
  const automationHref = (key: string) =>
    `/w/${encodeURIComponent(input.site.slug)}/automations/${encodeURIComponent(key)}`;
  const leadHref = (leadId: string) => `/w/${encodeURIComponent(input.site.slug)}/leads/${leadId}`;

  /** You, Unassigned and every active member, labelled; the assignee a card may name. */
  async function assigneeChoices(): Promise<{ value: string; label: string }[] | null> {
    const members = await (input.members?.() ?? Promise.resolve([])).catch(() => null);
    if (members === null) return null;
    return [
      { value: 'me', label: 'You' },
      { value: 'none', label: 'Unassigned' },
      ...members
        .filter((member) => member.actorId !== input.scope.actorId)
        .slice(0, CARD_ASSIGNEE_CHOICES)
        .map((member) => ({
          value: member.actorId,
          label: (member.displayName || 'Unnamed member').slice(0, 160),
        })),
    ];
  }

  async function prepare(raw: unknown): Promise<string> {
    if (!input.budget.reserveToolCall() || proposals.length >= 3)
      return JSON.stringify({ status: 'not_available' });
    const access = await input.loadAccess().catch(() => null);
    if (access === null)
      return JSON.stringify({
        status: 'temporary_failure',
        message: 'Access could not be checked.',
      });
    const draft: AiCardDraft = aiCardDraftSchema.parse(raw);
    /** The draft the card signs: the one asked for, or a lead edit with the server's defaults (T2). */
    let cardDraft: AiCardDraft = draft;
    // C1: the same actions the kind's staff route checks, decided now.
    if (!cardAllowed(access, draft.kind, cardSite))
      return JSON.stringify({ status: 'not_available' });
    // The lead the card is about: a note's, an email's, a lead update's, a
    // task's when it follows one up, or the moved task's lead. None for a
    // plain task or an automation's switch.
    let lead: LeadHint | undefined;
    let taskUpdateContext: AiTaskUpdateContext | undefined;
    const extras: Partial<AiActionCard> = {};
    const signed: Partial<SignedAiAction> = {};
    let resultMessage = 'Draft prepared. Nothing saved. The person must press Confirm in the card.';
    const readLead = async (leadId: string): Promise<LeadHint | 'failed' | undefined> => {
      const hint = await input.reads.leadHint(input.scope, leadId).catch(() => null);
      if (hint === null) return 'failed';
      return hint && hint.leadId === leadId ? hint : undefined;
    };
    if (draft.kind === 'task_update') {
      const task = input.taskUpdatePreview
        ? await input.taskUpdatePreview(draft.taskId).catch(() => null)
        : undefined;
      // Each refusal names its `reason`, which a revision answers by (TASK_REFUSALS).
      if (task === null)
        return JSON.stringify({
          status: 'temporary_failure',
          reason: 'temporary_failure',
          message: 'The task could not be checked.',
        });
      if (!task)
        return JSON.stringify({
          status: 'not_available',
          reason: 'task_not_found',
          message: 'No task with that id is available in this site.',
        });
      const editsBeyondStatus =
        draft.title !== undefined || draft.dueDate !== undefined || draft.assignee !== undefined;
      if (draft.status === task.status && !editsBeyondStatus)
        return JSON.stringify({
          status: 'not_available',
          reason: 'already_in_stage',
          message: 'No card was prepared. The task is already in that stage.',
        });
      if (task.leadId !== null) {
        const found = await readLead(task.leadId);
        if (found === 'failed')
          return JSON.stringify({
            status: 'temporary_failure',
            reason: 'temporary_failure',
            message: 'The task’s lead could not be checked.',
          });
        if (!found)
          return JSON.stringify({
            status: 'not_available',
            reason: 'task_unavailable',
            message: 'No card was prepared. The task’s lead is archived or not available.',
          });
        lead = found;
      }
      taskUpdateContext = {
        version: task.version,
        title: task.title,
        before: task.status,
        leadId: task.leadId,
      };
      if (editsBeyondStatus || draft.status === undefined) {
        const choices = await assigneeChoices();
        if (choices === null)
          return JSON.stringify({
            status: 'temporary_failure',
            reason: 'temporary_failure',
            message: 'The members could not be checked.',
          });
        if (
          draft.assignee !== undefined &&
          !choices.some((choice) => choice.value === draft.assignee)
        )
          return JSON.stringify({
            status: 'not_available',
            reason: 'assignee_not_found',
            message: 'Choose an active member, from getAssigneeOptions.',
          });
        const currentAssignee = task.assignedActorId ?? null;
        extras.assigneeChoices = choices;
        extras.taskEditContext = {
          dueDate: task.dueDate ?? null,
          assigneeLabel:
            currentAssignee === null
              ? 'Unassigned'
              : currentAssignee === input.scope.actorId
                ? 'You'
                : (choices.find((choice) => choice.value === currentAssignee)?.label ??
                  'Former member'),
        };
      }
    } else if (draft.kind === 'automation_off') {
      const flow = input.automationPreview
        ? await input.automationPreview(draft.automationKey).catch(() => null)
        : undefined;
      if (flow === null)
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The automation could not be checked.',
        });
      if (!flow || flow.archived)
        return JSON.stringify({
          status: 'not_available',
          message: 'No automation with that key is available in this site.',
        });
      if (!flow.enabled)
        return JSON.stringify({
          status: 'not_available',
          reason: 'already_off',
          message: 'No card was prepared. That automation is already off.',
        });
      extras.automationOffContext = { name: flow.name.slice(0, 80), revision: flow.revision };
      extras.sideEffects = automationOffEffects(flow.name);
      signed.automationRevision = flow.revision;
    } else if (draft.kind === 'lead_archive') {
      const found = input.archiveLead
        ? await input.archiveLead(draft.leadId).catch(() => null)
        : undefined;
      if (found === null)
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The lead could not be checked.',
        });
      if (!found) return JSON.stringify({ status: 'not_available' });
      if (found.archived === draft.archived)
        return JSON.stringify({
          status: 'not_available',
          reason: draft.archived ? 'already_archived' : 'not_archived',
          message: draft.archived
            ? 'No card was prepared. The lead is already archived.'
            : 'No card was prepared. The lead is not archived.',
        });
      lead = found;
      extras.sideEffects = archiveEffects(draft.archived);
    } else if (draft.kind === 'task' && draft.leadId === undefined) {
      if (input.plainTasks !== true)
        return JSON.stringify({
          status: 'not_available',
          reason: 'plain_tasks_unavailable',
          message: PLAIN_TASKS_UNAVAILABLE,
        });
    } else {
      const found = await readLead(draft.leadId ?? '');
      if (found === 'failed')
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The lead could not be checked.',
        });
      if (!found) return JSON.stringify({ status: 'not_available' });
      lead = found;
    }
    if (draft.kind === 'task') {
      // T1, T2: any active member; the store checks membership again at Confirm.
      const choices = await assigneeChoices();
      if (choices === null)
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The members could not be checked.',
        });
      if (!choices.some((choice) => choice.value === draft.assignee))
        return JSON.stringify({
          status: 'not_available',
          message: 'Choose an active member, from getAssigneeOptions.',
        });
      extras.assigneeChoices = choices;
    }
    const emailContext =
      draft.kind === 'email'
        ? await input.emailPreview?.(draft.leadId).catch(() => undefined)
        : undefined;
    if (draft.kind === 'email' && !emailContext)
      return JSON.stringify({
        status: 'not_available',
        message: 'Email cannot be prepared. The Site sender or customer address is unavailable.',
      });
    if (draft.kind === 'email' && emailContext)
      extras.sideEffects = [
        `Sends this email to ${emailContext.toAddress} from ${emailContext.fromAddress}. A sent email cannot be called back.`,
      ];
    if (draft.kind === 'template_email') {
      const preview = input.templateEmailPreview
        ? await input.templateEmailPreview(draft.leadId, draft.template).catch(() => null)
        : undefined;
      if (preview === null)
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The email could not be prepared.',
        });
      if (!preview || preview.status === 'unavailable')
        return JSON.stringify({
          status: 'not_available',
          message: 'Email cannot be prepared. The Site sender or this lead is unavailable.',
        });
      if (preview.status === 'missing')
        return JSON.stringify({
          status: 'not_available',
          reason: 'missing_fill_ins',
          missing: preview.missing,
          message: `No card was prepared. The lead lacks what this template fills in: ${preview.missing
            .map((name) => (name === 'customer email' ? 'the customer’s email address' : name))
            .join(', ')}. Add it on the lead page first.`,
        });
      extras.templateEmailContext = {
        templateName: preview.templateName,
        version: preview.version,
        subject: preview.subject.slice(0, 300),
        text: preview.text.slice(0, 20_000),
      };
      extras.emailContext = { toAddress: preview.toAddress, fromAddress: preview.fromAddress };
      signed.emailContext = extras.emailContext;
      signed.template = { version: preview.version, rendered: preview.renderedDigest };
      extras.sideEffects = [
        `Sends the “${preview.templateName}” email to ${preview.toAddress} from ${preview.fromAddress}. A sent email cannot be called back.`,
      ];
    }
    if (draft.kind === 'lead_edit') {
      const preview = input.leadEditPreview
        ? await input.leadEditPreview(draft.leadId, draft.changes).catch(() => null)
        : undefined;
      if (preview === null)
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The lead could not be checked.',
        });
      if (!preview || preview.status === 'not_found')
        return JSON.stringify({ status: 'not_available' });
      if (preview.status === 'no_change')
        return JSON.stringify({
          status: 'not_available',
          reason: 'no_change',
          message: 'No card was prepared. Nothing would change: the lead already has those values.',
        });
      if (preview.status === 'invalid')
        return JSON.stringify({
          status: 'not_available',
          reason: 'invalid_field',
          field: preview.field,
          message: `No card was prepared. The ${preview.field} value is not one this lead accepts. Check getLeadEditOptions.`,
        });
      if (preview.status === 'illegal_stage_move')
        return JSON.stringify({
          status: 'not_available',
          reason: 'illegal_stage_move',
          message: `No card was prepared. That move is not allowed from the lead’s stage. Allowed: ${
            preview.allowed
              .map((stage) => leadStageLabel(lead?.leadType ?? '', stage))
              .join(', ') || 'none'
          }.`,
        });
      if (preview.status === 'documents') {
        if (lead) input.onLeadPage?.(lead);
        return JSON.stringify({
          status: 'needs_lead_page',
          needs: 'documents',
          missingDocuments: preview.missing,
          message: `No card was prepared. This move needs these required documents approved on the lead page first: ${preview.missing
            .map((type) => type.replace(/_/g, ' '))
            .join(', ')}. The lead page link is under the answer.`,
        });
      }
      extras.leadEditContext = preview.context;
      signed.leadEditVersion = preview.version;
      // T2: the card signs what Confirm saves, a move's default date included.
      cardDraft = { ...draft, changes: preview.changes };
      if (preview.sideEffects.length > 0) extras.sideEffects = preview.sideEffects;
      if (preview.context.needs === 'dispatch_details')
        resultMessage =
          'Draft prepared. Nothing saved. The person must enter the courier on the card, then confirm.';
    }
    const leadUpdateContext =
      draft.kind === 'lead_update'
        ? await input.leadUpdatePreview?.(draft.leadId, draft.field)
        : undefined;
    if (draft.kind === 'lead_update') {
      if (!leadUpdateContext) return JSON.stringify({ status: 'not_available' });
      const choice = leadUpdateContext.choices.find((entry) => entry.value === draft.value);
      if ((draft.field === 'stage' || draft.field === 'assignedActorId') && !choice)
        return JSON.stringify({
          status: 'not_available',
          message: 'Choose an available stage or active member.',
        });
      // A move whose gate is unmet would only be refused after Confirm: say
      // what it needs instead, so the person completes it on the lead page.
      if (draft.field === 'stage' && choice?.needs !== undefined)
        return JSON.stringify({
          status: 'needs_lead_page',
          needs: choice.needs,
          ...(choice.missingDocuments ? { missingDocuments: choice.missingDocuments } : {}),
          message:
            choice.needs === 'documents' || !input.leadEditPreview
              ? STAGE_NEED_MESSAGES[choice.needs]
              : `${STAGE_NEED_MESSAGES[choice.needs]} Or prepare it with prepareLeadEdit, which carries those details on the card.`,
        });
      if (draft.field !== 'assignedActorId' && draft.value === null)
        return JSON.stringify({ status: 'not_available' });
      if (draft.field === 'phone' && (draft.value?.length ?? 0) > 40)
        return JSON.stringify({ status: 'not_available' });
      if (draft.field === 'stage' && draft.value !== null && input.stageEffects) {
        const effects = await input.stageEffects(draft.leadId, draft.value).catch(() => null);
        if (effects === null)
          return JSON.stringify({
            status: 'temporary_failure',
            message: 'The lead could not be checked.',
          });
        if (effects) extras.sideEffects = effects;
      }
    }
    // B1: an email or a note that names another lead read in this turn.
    if (draft.kind === 'email' || draft.kind === 'note') {
      const seen = await Promise.resolve(input.seenLeads?.() ?? []).catch(() => null);
      if (seen === null)
        return JSON.stringify({
          status: 'temporary_failure',
          message: 'The draft could not be checked.',
        });
      const others = seen.filter((entry) => entry.leadId !== draft.leadId);
      const { names: mentions, leadIds: mentioned } = mentionedLeads(
        draft.kind === 'email' ? emailMentionText(draft.subject, draft.body) : draft.body,
        others,
        { leadId: draft.leadId, name: lead?.name ?? null },
      );
      // R2: every lead it was checked against is signed, the ones it names
      // first, so a revision is checked against them all (a lead seen under
      // several names is listed once; the turn keeps at most MAX_SEEN_LEADS).
      const otherIds = [...new Set([...mentioned, ...others.map((entry) => entry.leadId)])];
      if (otherIds.length > 0) signed.mentionLeadIds = otherIds.slice(0, MAX_SEEN_LEADS);
      if (mentions.length > 0) {
        extras.mentions = mentions;
        extras.acknowledgementRequired = true;
        signed.acknowledgementRequired = true;
        resultMessage =
          'Draft prepared. Nothing saved. It names other customers; the person must check it and tick that they did before it can be confirmed.';
      }
    }
    if (extras.sideEffects) signed.sideEffects = sideEffectsDigest(extras.sideEffects);

    const previous = proposals.find((p) => JSON.stringify(p.draft) === JSON.stringify(cardDraft));
    if (previous)
      return JSON.stringify({
        status: 'confirmation_required',
        message: 'A confirmation card for this draft is already prepared.',
      });
    // Parallel calls can all pass the entry guard before their reads finish.
    // Recheck after the final await; checking and appending below are synchronous.
    if (proposals.length >= 3) return JSON.stringify({ status: 'not_available' });
    const id = randomUUID();
    const expiresAt = new Date(input.now().getTime() + TTL_MS).toISOString();
    const token = signAiAction(
      {
        ...input.scope,
        id,
        ...(input.rootId ? { rootId: input.rootId } : {}),
        expiresAt,
        draft: cardDraft,
        ...(emailContext ? { emailContext } : {}),
        ...(leadUpdateContext
          ? { leadUpdateBefore: aiLeadValueDigest(leadUpdateContext.before) }
          : {}),
        ...(taskUpdateContext
          ? {
              taskUpdateVersion: taskUpdateContext.version,
              taskUpdateBefore: taskUpdateContext.before,
            }
          : {}),
        ...signed,
      },
      input.key,
    );
    const result = JSON.stringify({ status: 'confirmation_required', message: resultMessage });
    if (
      input.budget.acceptResult({ bytes: Buffer.byteLength(result, 'utf8'), records: 1 }).rejected
    )
      return JSON.stringify({ status: 'not_available' });
    const card = aiActionCardSchema.parse({
      id,
      token,
      expiresAt,
      draft: cardDraft,
      ...(emailContext ? { emailContext } : {}),
      ...(leadUpdateContext ? { leadUpdateContext } : {}),
      ...(taskUpdateContext ? { taskUpdateContext } : {}),
      ...extras,
      siteName: input.site.name,
      // A card about no lead (a plain task) names none and links nowhere;
      // an automation's card links to the automation.
      ...(lead
        ? { leadLabel: cardLeadLabel(lead), leadHref: leadHref(lead.leadId) }
        : draft.kind === 'automation_off'
          ? { leadHref: automationHref(draft.automationKey) }
          : {}),
    });
    // T12: an older admin drops a card it cannot parse, leaving "Draft ready" and no card.
    if (input.legacyClient === true && legacyProposalOf(card) === undefined)
      return JSON.stringify({
        status: 'not_available',
        reason: 'client_cannot_show',
        message:
          'No card was prepared. The person’s Ask AI panel is out of date and cannot show this card. Ask them to reload the page, or offer the change for themselves (me) without naming other customers.',
      });
    proposals.push(card);
    if (lead) input.onLeadPage?.(lead);
    // Never send the bearer confirmation token to the model.
    return result;
  }

  async function allowed(kind: AiCardKind): Promise<boolean> {
    const access = await input.loadAccess();
    return cardAllowed(access, kind, cardSite);
  }

  async function getLeadUpdateOptions({
    leadId,
    field,
    search,
  }: {
    leadId: string;
    field: 'stage' | 'assignedActorId';
    search?: string | undefined;
  }) {
    if (!input.budget.reserveToolCall()) return 'Not available';
    if (!(await allowed('lead_update'))) return 'Not available';
    // The model sees at most 24 members; a name narrows the list (ACT-4).
    const preview = await input.leadUpdatePreview?.(leadId, field, {
      ...(search ? { search } : {}),
      limit: MODEL_ASSIGNEE_CHOICES,
    });
    // Member names and stage labels are staff-typed: neutralised and labelled as every read.
    const result = neutralizeSerialized(
      JSON.stringify({ choices: preview?.choices ?? [], notice: RECORD_DATA_NOTICE }),
    );
    if (
      input.budget.acceptResult({
        bytes: Buffer.byteLength(result, 'utf8'),
        records: preview?.choices.length ?? 0,
      }).rejected
    )
      return 'Too many choices. Use the lead page.';
    return result;
  }

  /** T1–T3: active members a task may be given; at most 24 shown, a name narrows them. */
  async function getAssigneeOptions({ search }: { search?: string | undefined }) {
    if (!input.budget.reserveToolCall()) return 'Not available';
    if (!(await allowed('task'))) return 'Not available';
    const members = (await input.members?.()) ?? [];
    const needle = search?.normalize('NFKC').trim().toLowerCase();
    const choices = members
      .map((member) => ({
        value: member.actorId,
        // A display name is colleague-typed text: cleaned as every read cleans it.
        label:
          member.actorId === input.scope.actorId
            ? 'You'
            : (inertRecordText(member.displayName, DISPLAY_NAME_MAX) ?? 'Unnamed member'),
      }))
      .filter((choice) => !needle || choice.label.normalize('NFKC').toLowerCase().includes(needle))
      .slice(0, MODEL_ASSIGNEE_CHOICES);
    const result = neutralizeSerialized(
      JSON.stringify({
        choices: [{ value: 'none', label: 'Unassigned' }, ...choices],
        notice: RECORD_DATA_NOTICE,
      }),
    );
    if (
      input.budget.acceptResult({
        bytes: Buffer.byteLength(result, 'utf8'),
        records: choices.length,
      }).rejected
    )
      return 'Too many choices. Ask the person for the member’s name.';
    return result;
  }

  /**
   * What a lead edit may change on one lead: its stage moves (with what each
   * still needs), the active plans of its type, and the fields with their
   * labels, kinds and choices. Never a value.
   */
  async function getLeadEditOptions({ leadId }: { leadId: string }) {
    if (!input.budget.reserveToolCall()) return 'Not available';
    if (!(await allowed('lead_edit'))) return 'Not available';
    const hint = await input.reads.leadHint(input.scope, leadId).catch(() => undefined);
    if (!hint) return JSON.stringify({ status: 'not_available' });
    const [stages, catalog, plans] = await Promise.all([
      input.leadUpdatePreview?.(leadId, 'stage').catch(() => undefined),
      input.catalog?.().catch(() => undefined),
      input.planChoices?.(hint.leadType).catch(() => []),
    ]);
    const fields = (catalog?.forType(hint.leadType) ?? [])
      // Never a hidden or sensitive property: the lead page masks a sensitive
      // value, and its edit stays there (the reads' rule, isModelVisibleProperty).
      .filter(
        (property) =>
          !property.hidden &&
          !property.sensitive &&
          ((property.storage === 'form' && property.editable) ||
            property.storage === 'custom' ||
            (property.storage === 'order' &&
              !['activationNumber', 'activationAccount'].includes(
                property.storageKey ?? property.key,
              ))),
      )
      .slice(0, 40)
      .map((property) => ({
        key: `${property.storage}.${property.storageKey ?? property.key}`,
        // Labels and choices are staff-typed: cleaned like every read's text.
        label: inertRecordText(property.label) ?? property.key,
        kind: property.kind,
        ...(property.options
          ? {
              choices: property.options
                .filter((option) => !option.hidden)
                .slice(0, 20)
                .map((option) => ({
                  value: option.value,
                  label: inertRecordText(option.label) ?? option.value,
                })),
            }
          : {}),
      }));
    const result = neutralizeSerialized(
      JSON.stringify({
        stages: (stages?.choices ?? []).map((choice) => ({
          value: choice.value,
          label: choice.label,
          ...(choice.needs ? { needs: choice.needs } : {}),
          ...(choice.missingDocuments ? { missingDocuments: choice.missingDocuments } : {}),
        })),
        plans: (plans ?? []).map((plan) => ({
          planId: plan.planId,
          name: inertRecordText(plan.name) ?? 'Plan',
        })),
        fields,
        notice: RECORD_DATA_NOTICE,
      }),
    );
    if (
      input.budget.acceptResult({
        bytes: Buffer.byteLength(result, 'utf8'),
        records: fields.length + (plans?.length ?? 0),
      }).rejected
    )
      return 'Too many fields to list. Ask the person which field they mean.';
    return result;
  }

  /** A lead edit from the model: its order edit keeps to what the model may propose. */
  function leadEditDraftOf(raw: z.infer<typeof leadEditToolInputSchema>): AiCardDraft {
    const { leadId, stage, order, form, customValues } = raw;
    return {
      kind: 'lead_edit',
      leadId,
      changes: aiLeadEditChangesSchema.parse({
        ...(stage === undefined ? {} : { stage }),
        ...(order === undefined ? {} : { order: leadOrderEditSchema.parse(order) }),
        ...(form === undefined ? {} : { form }),
        ...(customValues === undefined ? {} : { customValues }),
      }),
    };
  }

  async function prepareLeadEdit(raw: z.infer<typeof leadEditToolInputSchema>) {
    let draft: AiCardDraft;
    try {
      draft = leadEditDraftOf(raw);
    } catch {
      if (!input.budget.reserveToolCall()) return JSON.stringify({ status: 'not_available' });
      return JSON.stringify({
        status: 'not_available',
        reason: 'invalid_field',
        message: `No card was prepared. Give one to ${AI_CARD_LIMITS.maxLeadEditFields} changes with values the lead’s fields accept.`,
      });
    }
    return prepare(draft);
  }

  const all: Record<ActionToolName, ToolSet[string]> = {
    getLeadUpdateOptions: tool({
      description:
        'Read available stage moves or active assignees for one lead before preparing a lead update. Returns choices only, never contact values. A stage choice with `needs` dispatch_details or activation_details is prepared with prepareLeadEdit, which carries those details on the card; one that needs documents cannot be prepared: tell the person which documents, and that they are approved on the lead page.',
      inputSchema: leadUpdateOptionsInputSchema,
      execute: getLeadUpdateOptions,
    }),
    prepareLeadUpdate: tool({
      description:
        'Prepare one explicitly requested stage, assignee, name or phone change. Use getLeadUpdateOptions for stage/member choices first. The person reviews current/proposed values and confirms; no write occurs here.',
      inputSchema: aiActionDraftSchema.options[3].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'lead_update' }),
    }),
    prepareNote: tool({
      description:
        'Prepare a note for an identified lead. Only when the person explicitly asks to add a note. Use their requested text; ask if missing. Never put another customer’s details in it. Does not save: a separate confirmation card is required.',
      inputSchema: aiActionDraftSchema.options[0].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'note' }),
    }),
    prepareEmail: tool({
      description:
        'Draft a customer email only when requested. Resolve the lead first; ask for missing recipient intent or message details. Address is resolved by the server, never provide an address. Plain text subject and body. Never put another customer’s details in it. Does not send: the person reviews and presses Send.',
      inputSchema: aiActionDraftSchema.options[2].omit({ kind: true }),
      execute: (raw) => prepare({ ...raw, kind: 'email' }),
    }),
    prepareTask: tool({
      description: input.plainTasks
        ? 'Prepare a task, only when the person asks for one. leadId is the lead it follows up when the person names a lead or means the one open; use leadId null for a plain task (a task with no lead) when they name none or it is not about a lead. Never ask for a lead only because a task could have one. Use a calendar dueDate (YYYY-MM-DD) or null; ask if the date is ambiguous. Assignee me assigns the asking person, none leaves it unassigned, or a member id from getAssigneeOptions for someone else. Does not save until the person confirms the card.'
        : 'Prepare a follow-up task on a lead, only when explicitly requested. Every task needs a lead on this site for now: pass its leadId (leadId null is refused) and ask which lead when none is named. Use a calendar dueDate (YYYY-MM-DD) or null; ask if ambiguous. Assignee me assigns the asking person, none leaves it unassigned, or a member id from getAssigneeOptions for someone else. Does not save until the person confirms the card.',
      inputSchema: taskToolInputSchema,
      execute: (raw) => prepare(taskDraftOf(raw)),
    }),
    prepareTaskUpdate: tool({
      description:
        'Prepare a change to one task, a lead’s or a plain one: its stage (open = To do, in_progress, done, cancelled), title, dueDate (YYYY-MM-DD or null) and assignee (me, none or a member id from getAssigneeOptions), any of them. Find the task id with listOpenTasks (filter by status; due any) or getLeadSummary first, and prepare one card per task. The person sees the task, what changes and confirms; no write occurs here.',
      inputSchema: taskUpdateToolInputSchema,
      execute: (raw) => prepare({ ...raw, kind: 'task_update' }),
    }),
    getAssigneeOptions: tool({
      description:
        'List active members a task may be assigned to (at most 24; a name narrows the list). Returns names and ids only. Ask the person when a name matches more than one member.',
      inputSchema: assigneeOptionsInputSchema,
      execute: getAssigneeOptions,
    }),
    getLeadEditOptions: tool({
      description:
        'Read what prepareLeadEdit may change on one lead: its stage moves (a move with `needs` documents cannot be prepared), the active plans of its type (ids and names), and its fields as keys (form.<key>, custom.<key>, order.<field>) with labels, kinds and choices. Never values.',
      inputSchema: leadEditOptionsInputSchema,
      execute: getLeadEditOptions,
    }),
    prepareLeadEdit: tool({
      description:
        'Prepare one card that changes one lead: its stage, order details (plan, quantity, payment status, carrier commission, courier, tracking number, dispatch and activation dates the person gave), form fields and custom values, together. Use getLeadEditOptions first for stages, plan ids and field keys; pass form and custom values by their key without the form./custom. prefix. A move to Delivered needs a courier: include the one the person gave, or leave it for them to type on the card. Activation numbers and accounts are typed by the person on the card, never proposed. Never a documents override and never the customer’s email. The person reviews every change and its side effects and confirms; no write occurs here.',
      inputSchema: leadEditToolInputSchema,
      execute: prepareLeadEdit,
    }),
    prepareTemplateEmail: tool({
      description:
        'Prepare sending one of the site’s email templates to a lead’s customer, only when the person asks for that template. The server renders it from the lead and the card shows the exact mail; addresses are the server’s. Does not send: the person reviews and presses Send.',
      inputSchema: templateEmailToolInputSchema,
      execute: (raw) => prepare({ ...raw, kind: 'template_email' }),
    }),
    prepareArchive: tool({
      description:
        'Prepare archiving one lead (archived true) or restoring one (archived false), only when the person asks. One lead per card. The card says that archiving cancels the lead’s waiting automation runs and timers and that restoring does not bring them back. No write occurs here.',
      inputSchema: archiveToolInputSchema,
      execute: (raw) => prepare({ ...raw, kind: 'lead_archive' }),
    }),
    prepareAutomationOff: tool({
      description:
        'Prepare switching one automation flow OFF, only when the person asks (find its key with listAutomations). Switching off cancels the flow’s waiting runs. There is no way to switch a flow on or activate it here: that is done on the Automations page. No write occurs here.',
      inputSchema: automationOffToolInputSchema,
      execute: (raw) => prepare({ ...raw, kind: 'automation_off' }),
    }),
  };

  /** The tools whose stores this deployment has; `offered` narrows them to the member (C1). */
  const definitions: ToolSet = {};
  for (const name of ACTION_TOOL_NAMES) {
    const kind = TOOL_KIND[name];
    if (kind === 'lead_edit' && !input.leadEditPreview) continue;
    if (kind === 'template_email' && !input.templateEmailPreview) continue;
    if (kind === 'lead_archive' && !input.archiveLead) continue;
    if (kind === 'automation_off' && !input.automationPreview) continue;
    if (name === 'getAssigneeOptions' && !input.members) continue;
    definitions[name] = all[name];
  }

  /**
   * C1: only the tools of kinds this member may use here are offered to the
   * model; to an older admin (T12), only those of the kinds it shows.
   */
  async function offered(): Promise<ToolSet> {
    const access = await input.loadAccess();
    const allowedTools: ToolSet = {};
    for (const name of ACTION_TOOL_NAMES) {
      const definition = definitions[name];
      if (input.legacyClient === true && !LEGACY_TOOL_NAMES.has(name)) continue;
      if (definition && cardAllowed(access, TOOL_KIND[name], cardSite))
        allowedTools[name] = definition;
    }
    return allowedTools;
  }

  return {
    definitions,
    offered,
    proposals,
    handles(name: string): name is ActionToolName {
      return ACTION_TOOL_NAMES.some((toolName) => toolName === name);
    },
    /** A draft the person edited on the card (a revision): every field the card may carry. */
    prepareCard(draft: AiCardDraft) {
      return prepare(draft);
    },
    execute(name: string, raw: unknown) {
      switch (name) {
        case 'getLeadUpdateOptions':
          return getLeadUpdateOptions(leadUpdateOptionsInputSchema.parse(raw));
        case 'getAssigneeOptions':
          return getAssigneeOptions(assigneeOptionsInputSchema.parse(raw));
        case 'getLeadEditOptions':
          return getLeadEditOptions(leadEditOptionsInputSchema.parse(raw));
        case 'prepareLeadUpdate':
          return prepare({
            kind: 'lead_update',
            ...aiActionDraftSchema.options[3].omit({ kind: true }).parse(raw),
          });
        case 'prepareTask':
          return prepare(taskDraftOf(taskToolInputSchema.parse(raw)));
        case 'prepareTaskUpdate':
          return prepare({ kind: 'task_update', ...taskUpdateToolInputSchema.parse(raw) });
        case 'prepareNote':
          return prepare({
            kind: 'note',
            ...aiActionDraftSchema.options[0].omit({ kind: true }).parse(raw),
          });
        case 'prepareEmail':
          return prepare({
            kind: 'email',
            ...aiActionDraftSchema.options[2].omit({ kind: true }).parse(raw),
          });
        case 'prepareLeadEdit':
          return prepareLeadEdit(leadEditToolInputSchema.parse(raw));
        case 'prepareTemplateEmail':
          return prepare({ kind: 'template_email', ...templateEmailToolInputSchema.parse(raw) });
        case 'prepareArchive':
          return prepare({ kind: 'lead_archive', ...archiveToolInputSchema.parse(raw) });
        case 'prepareAutomationOff':
          return prepare({ kind: 'automation_off', ...automationOffToolInputSchema.parse(raw) });
        default:
          throw new Error('unknown action proposal');
      }
    },
  };
}

/** A task draft from the task tool's input: a null lead is a plain task, which has no `leadId`. */
function taskDraftOf(
  raw: z.infer<typeof taskToolInputSchema>,
): Extract<AiCardDraft, { kind: 'task' }> {
  const { leadId, ...rest } = raw;
  return { kind: 'task', ...(leadId === null ? {} : { leadId }), ...rest };
}

/** The task tool's input for a task draft (the revise route re-runs the tool on an edit). */
export function taskToolInputOf(
  draft: Extract<AiCardDraft, { kind: 'task' }>,
): z.infer<typeof taskToolInputSchema> {
  const { kind: _kind, leadId, ...rest } = draft;
  return { ...rest, leadId: leadId ?? null };
}

/**
 * Why a task tool made no card, from its result: the `reason` a move or a plain
 * task's refusal names (`task_not_found`, `already_in_stage`,
 * `task_unavailable`, `plain_tasks_unavailable`, `temporary_failure`), or
 * `not_available` for any other.
 */
export function taskRefusalReason(result: string): string {
  try {
    const parsed = z
      .object({ status: z.string(), reason: z.string().max(40).optional() })
      .safeParse(JSON.parse(result));
    if (!parsed.success) return 'not_available';
    return (
      parsed.data.reason ??
      (parsed.data.status === 'temporary_failure' ? 'temporary_failure' : 'not_available')
    );
  } catch {
    return 'not_available';
  }
}

/** The id a confirmation saves under: the draft's first card (`rootId`), else the card's own. */
export function aiActionRootId(action: SignedAiAction): string {
  return action.rootId ?? action.id;
}
