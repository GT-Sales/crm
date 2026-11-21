import {
  type AiActionDraft,
  type AiStageMoveNeed,
  type EmailFillInName,
  type EmailSkipped,
  type QueueCustomerEmailRequest,
  type LeadActivity,
  type LeadAssigneeFilter,
  type LeadBoardColumn,
  type LeadContactEdit,
  type LeadContactExpected,
  type LeadDetail,
  type LeadOrderEdit,
  type LeadPropertyFilter,
  type LeadTask,
  type LeadTaskStatus,
  type PropertyCatalog,
  type TaskAssigneeFilter,
  type TaskStatusFilter,
  type LeadTypeCount,
  type WorkspaceTask,
} from '@gt-sales/contracts';
import { type StageMoveRefusal } from './stage-move.js';
import { type LeadStats, type LeadWithWork } from './staff-queries.js';
import type { Scope, WriteScope } from '../tenant-scope.js';

/**
 * The lead work store's contract: what each write takes and answers, and the
 * `LeadWorkStore` interface the staff routes, the automations and Ask AI's
 * cards are written against (`work-store.ts` is the database implementation).
 */

export type LeadWorkResult = LeadWithWork;

export type UpdateLeadWorkOutcome =
  | {
      status: 'updated';
      lead: LeadDetail;
      activities: LeadActivity[];
      /** The mails the move's rules were on for but could not send; absent when none. */
      emailSkipped?: EmailSkipped[];
    }
  | { status: 'not_found' | 'trashed' | 'invalid_stage' | 'assignee_not_found' }
  /** A form correction the type does not allow; names the field, never the value. */
  | { status: 'invalid_field'; field: string }
  /** A move the type does not allow, or one whose dispatch or activation details are missing. */
  | StageMoveRefusal
  /** The required documents of the order's plan that have no approved current file. */
  | { status: 'documents_incomplete'; missing: string[] }
  /** An override reason was given but is blank. */
  | { status: 'document_override_reason_required' }
  /** Contact fields someone else changed since the editor opened (`expectedContact`); names only. */
  | { status: 'contact_conflict'; fields: string[] };

export type ArchiveLeadOutcome =
  | {
      status: 'changed' | 'unchanged';
      lead: LeadDetail;
      activity: LeadActivity | null;
      /** An AI card's confirmation that had already been saved (its receipt found under the lock). */
      replayed?: true;
    }
  | { status: 'not_found' };

export type NoteOutcome =
  { status: 'created'; activity: LeadActivity } | { status: 'not_found' } | { status: 'trashed' };

export type CustomerEmailOutcome =
  | { status: 'queued'; activity: LeadActivity }
  | { status: 'not_found' }
  | { status: 'trashed' }
  /** The site has no sender, or the deployment cannot send. */
  | { status: 'no_sender' }
  /** What the lead lacks for the mail: its fill-ins, or an address to send it to. */
  | { status: 'missing'; missing: Array<EmailFillInName | 'customer email'> };

export interface QueueCustomerEmailInput extends WriteScope {
  leadId: string;
  template: Extract<QueueCustomerEmailRequest, { template: unknown }>['template'];
}

/** A template mail as an AI card shows it before Send: rendered here, from the site's current template. */
export type AiTemplateEmailPreview =
  | {
      status: 'ready';
      templateName: string;
      version: number;
      subject: string;
      text: string;
      toAddress: string;
      fromAddress: string;
      /** The digest of the rendered mail; Send refuses a mail that would differ from the one shown. */
      renderedDigest: string;
    }
  | { status: 'missing'; missing: Array<EmailFillInName | 'customer email'> }
  | { status: 'unavailable' };

export type TaskOutcome =
  { status: 'saved'; task: LeadTask } | { status: 'not_found' | 'trashed' | 'assignee_not_found' };

/** A plain task's creation: saved, or refused (`unavailable`: the database lacks migration 0038). */
export type PlainTaskOutcome =
  { status: 'saved'; task: LeadTask } | { status: 'assignee_not_found' | 'unavailable' };

/** A task as an AI move card is prepared against: its stage then and its update time. */
export interface AiTaskUpdatePreview {
  /** The task's update time in microseconds; confirmation refuses a card older than it. */
  version: string;
  title: string;
  status: LeadTaskStatus;
  /** Null for a plain task. */
  leadId: string | null;
  /** The due day (`YYYY-MM-DD`, as it is stored at noon UTC), or null. */
  dueDate?: string | null;
  assignedActorId?: string | null;
}

/** A confirmed AI task move: saved, or why not. */
export type AiTaskUpdateConfirmOutcome =
  | { status: 'saved'; recordId: string }
  | { status: 'not_found' | 'trashed' | 'conflict' | 'assignee_not_found' };

export interface UpdateLeadWorkInput extends WriteScope {
  leadId: string;
  stage?: string;
  /** `null` unassigns; `undefined` leaves the assignee alone. */
  assignedActorId?: string | null;
  contact?: LeadContactEdit;
  /**
   * With `contact`: the values the editor opened with. A saved field whose
   * value is no longer this is refused (`contact_conflict`), so a stale editor
   * never undoes a colleague's correction (#89). Absent, nothing is checked.
   */
  expectedContact?: LeadContactExpected;
  /** Corrections to the form's editable fields; null clears one. */
  form?: Record<string, string | number | boolean | null>;
  /** New values of the site's custom properties; null clears one. */
  customValues?: Record<string, string | number | boolean | null>;
  /** The site's property catalogue, loaded once for the request; custom values are checked against it. */
  catalog: PropertyCatalog;
  /** Order details of an order lead type: a new `planId` re-freezes the plan, null clears it. */
  order?: LeadOrderEdit;
  /**
   * Why the stage move goes ahead without the plan's documents approved. The
   * route admits it only from an actor with `order.override`; the store
   * trusts it. Ignored when nothing is missing.
   */
  documentsOverrideReason?: string;
}

/** Rolls back an AI-confirmed update the store refused, carrying the refusal out. */
export class AiLeadUpdateRefused extends Error {
  constructor(readonly outcome: Exclude<UpdateLeadWorkOutcome, { status: 'updated' }>) {
    super('ai lead update refused');
  }
}

export type AiLeadUpdateDraft = Extract<AiActionDraft, { kind: 'lead_update' }>;
export type AiLeadUpdatePreview = {
  version: string;
  before: string | null;
  beforeLabel: string;
  choices: {
    value: string | null;
    label: string;
    /** What a stage move still needs on the lead page first; absent when nothing. */
    needs?: AiStageMoveNeed;
    missingDocuments?: string[];
  }[];
};

/** A confirmed AI lead update: saved, or why not (a refusal carries the same outcome a staff edit gets). */
export type AiLeadUpdateConfirmOutcome =
  | { status: 'saved'; recordId: string }
  | { status: 'conflict' | 'not_found' | 'trashed' | 'invalid' }
  | { status: 'refused'; refusal: Exclude<UpdateLeadWorkOutcome, { status: 'updated' }> };

export interface CreateTaskInput extends WriteScope {
  /** Server-signed AI proposal id; retries reuse the existing record under the lead lock. */
  creationId?: string;
  /** The AI card that confirmed it (a version of `creationId`'s draft), kept in the audit. */
  aiCardId?: string;
  leadId: string;
  title: string;
  dueAt?: string | null;
  assignedActorId?: string | null;
}

export interface CreatePlainTaskInput extends WriteScope {
  /** Server-signed AI proposal id; a retry finds the task it made instead of making another. */
  creationId?: string;
  aiCardId?: string;
  title: string;
  dueAt?: string | null;
  assignedActorId?: string | null;
}

export interface UpdateTaskInput extends WriteScope {
  taskId: string;
  title?: string;
  dueAt?: string | null;
  assignedActorId?: string | null;
  status?: LeadTaskStatus;
}

export interface LeadWorkStore {
  /** With `dueBy`, each type also counts its leads with a follow-up due by that day. */
  summary(input: Scope & { dueBy?: string }): Promise<{ types: LeadTypeCount[]; archived: number }>;
  /** The dashboard's counts for one type, received in the last `days` days or ever. */
  stats(input: Scope & { leadType: string; days?: number }): Promise<LeadStats>;
  board(
    input: Scope & {
      leadType: string;
      assignee?: LeadAssigneeFilter;
      search?: string;
      where?: readonly LeadPropertyFilter[];
      /** The site's property catalogue `where` was validated against. */
      catalog: PropertyCatalog;
    },
    perStage: number,
  ): Promise<LeadBoardColumn[]>;
  /**
   * `includeWork: false` skips the timeline, tasks, related requests, identities, documents and custom values for a caller who may not see them.
   * `catalog` is the site's property catalogue, loaded once for the request.
   */
  getLead(
    input: Scope & { leadId: string; includeWork: boolean; catalog: PropertyCatalog },
  ): Promise<LeadWorkResult | undefined>;
  previewAiLeadUpdate?(
    input: Scope & { leadId: string; field: AiLeadUpdateDraft['field'] },
  ): Promise<AiLeadUpdatePreview | undefined>;
  confirmAiLeadUpdate?(
    input: WriteScope & {
      draft: AiLeadUpdateDraft;
      creationId: string;
      /** The digest of the field's value the card was prepared against (ACT-3, ACT-5). */
      before: string;
      aiCardId?: string;
      /** The site's property catalogue (C2); the code catalogue when absent. */
      catalog?: PropertyCatalog;
    },
  ): Promise<AiLeadUpdateConfirmOutcome>;
  /**
   * The AI card that saved a draft (by the draft's root id), or null when the
   * save predates card ids or nothing was saved: a confirmation compares it
   * with its own card to tell a retry from a second version of the draft.
   */
  aiCardOf?(input: Scope & { rootId: string }): Promise<string | null>;
  updateLead(input: UpdateLeadWorkInput): Promise<UpdateLeadWorkOutcome>;
  /**
   * Archives a lead (or restores one); the timeline and audit keep the
   * `trashed`/`restored` names. An AI card's confirmation passes its root id
   * (`creationId`): the audit keeps it, the entry is marked `viaAi`, and a
   * retry finds that audit under the lead lock and answers `replayed`.
   */
  setArchived(
    input: WriteScope & {
      leadId: string;
      archived: boolean;
      creationId?: string;
      aiCardId?: string;
    },
  ): Promise<ArchiveLeadOutcome>;
  /** The first open by someone who works leads; null activity when it was already opened. */
  markOpened(
    input: WriteScope & { leadId: string },
  ): Promise<{ status: 'opened'; activity: LeadActivity | null } | { status: 'not_found' }>;
  addNote(
    input: WriteScope & { leadId: string; body: string; creationId?: string; aiCardId?: string },
  ): Promise<NoteOutcome>;
  /** Resolves addresses for an authorized browser preview; returns no model-visible data. */
  previewAiEmail?(
    input: WriteScope & { leadId: string },
  ): Promise<{ toAddress: string; fromAddress: string } | undefined>;
  queueAiEmail?(
    input: WriteScope & {
      leadId: string;
      creationId: string;
      aiCardId?: string;
      draft: Extract<AiActionDraft, { kind: 'email' }>;
      emailContext: { toAddress: string; fromAddress: string };
    },
  ): Promise<
    | { status: 'queued'; recordId: string }
    | { status: 'not_found' | 'trashed' | 'no_sender' | 'missing' }
    | { status: 'changed'; reason: AiMailChange }
  >;
  queueCustomerEmail(input: QueueCustomerEmailInput): Promise<CustomerEmailOutcome>;
  /** Renders a template for an AI card's preview (M1); writes nothing. */
  previewAiTemplateEmail?(input: QueueCustomerEmailInput): Promise<AiTemplateEmailPreview>;
  /**
   * Queues a template mail an AI card prepared, as `queueCustomerEmail` does,
   * under its own key (`ai_template_email:<root id>`, so a retry finds the
   * first job), and only when the mail is still the one the card showed: the
   * template's version, the rendered text, the recipient and the sender.
   */
  queueAiTemplateEmail?(
    input: QueueCustomerEmailInput & {
      creationId: string;
      aiCardId?: string;
      version: number;
      renderedDigest: string;
      emailContext: { toAddress: string; fromAddress: string };
    },
  ): Promise<
    | { status: 'queued'; recordId: string }
    | { status: 'not_found' | 'trashed' | 'no_sender' }
    | { status: 'changed'; reason: AiMailChange }
    | { status: 'missing'; missing: Array<EmailFillInName | 'customer email'> }
  >;
  /** Queues a message staff wrote themselves to the lead's own address. */
  queueWrittenEmail(
    input: WriteScope & { leadId: string; subject: string; body: string },
  ): Promise<CustomerEmailOutcome>;
  createTask(input: CreateTaskInput): Promise<TaskOutcome>;
  /**
   * A plain task (no lead), through the same insert, audit and checks as a
   * lead's task; `unavailable` until migration 0038 is applied.
   */
  createPlainTask?(input: CreatePlainTaskInput): Promise<PlainTaskOutcome>;
  /** Whether the database takes plain tasks yet (migration 0038). */
  plainTasksReady?(input: Scope): Promise<boolean>;
  updateTask(input: UpdateTaskInput): Promise<TaskOutcome>;
  /** A task an AI move card may name: a plain task, or one on an active, unrestricted lead. */
  previewAiTaskUpdate?(input: Scope & { taskId: string }): Promise<AiTaskUpdatePreview | undefined>;
  /**
   * Moves a task as a staff `PATCH` does, unless it changed since the card:
   * its update time is not the card's `version`, or its status not `before`.
   */
  confirmAiTaskUpdate?(
    input: WriteScope & {
      taskId: string;
      /** Absent: the status stays (a card that edits only the title, due date or assignee). */
      status?: LeadTaskStatus;
      title?: string;
      dueAt?: string | null;
      /** An active member of the site, or null to unassign; checked as the staff `PATCH` checks it. */
      assignedActorId?: string | null;
      version: string;
      before: LeadTaskStatus;
      creationId: string;
      aiCardId?: string;
    },
  ): Promise<AiTaskUpdateConfirmOutcome>;
  listTasks(
    input: Scope & {
      assignee: TaskAssigneeFilter;
      status: TaskStatusFilter;
      dueBy?: string;
      completedSince?: string;
      /** List plain tasks too; left out otherwise (older admins cannot read one). */
      includePlain?: boolean;
    },
    page: number,
    pageSize: number,
  ): Promise<{ tasks: WorkspaceTask[]; total: number }>;
}

/**
 * Why an AI card's mail is no longer the one it showed (T7): the customer's
 * address, the site's sender, the template (saved again, or no longer
 * usable), or the text it renders to from the lead.
 */
export type AiMailChange =
  'recipient_changed' | 'sender_changed' | 'template_changed' | 'text_changed';
