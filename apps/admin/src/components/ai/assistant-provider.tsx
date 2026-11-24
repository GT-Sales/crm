'use client';
import type {
  AiAttachmentKind,
  AiAttachmentMediaType,
  AiAttachmentSummary,
  AiAutomationDraft,
  AiAutomationProposal,
  AiAutomationSimulation,
  AiConversation,
  AiStoredMessage,
} from '@gt-sales/contracts';
import { saveAiAutomation, reviseAiAutomation, simulateAiAutomation } from '../../lib/api';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AI_ASSISTANT_LIMITS,
  AI_CARD_LIMITS,
  AI_CHAT_LIMITS,
  aiAssistantHistoryText,
  type AiCapabilitiesResponse,
  type AiEffort,
  type AiModelChoice,
  type AiBlock,
  type AiSource,
  type AiStreamPart,
  type AiActionCard,
  type AiCardDraft,
  type AiFollowUp,
} from '@gt-sales/contracts';

import { buildAiChatRequest, streamAnswer, uiErrorForStreamCode } from '../../lib/ai-transport';
import type { AiRequestLimits, AiUiError, AiHistoryEntry } from '../../lib/ai-transport';
import {
  getAiCapabilities,
  confirmAiAction,
  reviseAiAction,
  BackendError,
  listAiConversations,
  getAiConversation,
  renameAiConversation,
  deleteAiConversation,
  createAiAttachmentIntent,
  finalizeAiAttachment,
  deleteAiAttachment,
  getAiAttachmentLink,
} from '../../lib/api';
import { dateTimeLabel } from '../../lib/dates';
import { describeError, errorKind } from '../../lib/error-text';
import { notifyLeadWorkSaved } from '../../lib/lead-work-events';
import { useStoredChoice } from '../leads/view-preferences';
import { createAttachmentLinkCache, type AttachmentLinkCache } from './attachment-links';
import {
  checkAttachmentFile,
  putAttachmentBytes,
  sha256Hex,
  type AttachmentSettings,
} from './attachment-files';

/**
 * Words for a lead update the backend refused at Confirm because a stage rule
 * was not met, the same refusals a staff edit gets. Undefined for any other
 * error. Nothing was saved in any of these cases.
 */
export function leadUpdateRefusalText(error: BackendError): string | undefined {
  switch (error.code) {
    case 'dispatch_details_required':
      return 'Not saved. This move needs dispatch details (a courier) on the lead page first.';
    case 'activation_details_required':
      return 'Not saved. This move needs an activation date on the lead page first.';
    case 'documents_incomplete': {
      const listed: unknown = error.details?.['missing'];
      const missing = Array.isArray(listed)
        ? listed.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return missing.length > 0
        ? `Not saved. These documents must be approved on the lead page first: ${missing.join(', ')}.`
        : 'Not saved. The required documents must be approved on the lead page first.';
    }
    case 'illegal_stage_move':
      return 'Not saved. The lead can no longer move to that stage from where it is now. Check the lead page.';
    case 'assignee_not_found':
      return 'Not saved. That member can no longer be assigned. Ask for a fresh draft.';
    case 'validation_error':
      return 'Not saved. The proposed value is not valid for this lead. Ask for a fresh draft.';
    default:
      return undefined;
  }
}

/**
 * Words for a refusal only the wider cards get (docs/design/ai-actions.md,
 * "Wider cards"): the mention tick missing, the daily caps, something the card
 * names changed since it was prepared, or fill-ins a template lacks.
 * Undefined for any other error. Nothing was saved in any of these cases.
 */
export function cardRefusalText(error: BackendError, now = new Date()): string | undefined {
  const reason = error.details?.['reason'];
  const retryAfter = error.details?.['retryAfterSeconds'];
  // T10: when the cap opens again, if the backend said.
  const opensAt =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
      ? dateTimeLabel(new Date(now.getTime() + retryAfter * 1000).toISOString())
      : undefined;
  if (error.code === 'conflict' && reason === 'acknowledgement_required')
    return 'Not saved. Tick that you checked the other customers it names, then try again.';
  if (error.code === 'conflict' && reason === 'changed')
    return 'Not saved: this changed since the card was prepared. Check it and ask for a fresh draft.';
  // T7: each reason a mail is no longer the one the card showed, in its own words.
  if (error.code === 'conflict' && reason === 'recipient_changed')
    return 'Not sent. The customer’s email address changed since the card was prepared. Check the lead and ask for a fresh draft.';
  if (error.code === 'conflict' && reason === 'sender_changed')
    return 'Not sent. The site’s sender address changed since the card was prepared. Check Settings → Email and ask for a fresh draft.';
  if (error.code === 'conflict' && reason === 'template_changed')
    return 'Not sent. The email template was changed since the card was prepared. Ask for a fresh draft to see the new text.';
  if (error.code === 'conflict' && reason === 'text_changed')
    return 'Not sent. The text the template fills in from the lead changed since the card was prepared. Check the lead and ask for a fresh draft.';
  if (error.code === 'ai_rate_limited' && reason === 'daily_changes')
    return `Not saved. You have reached today’s limit of ${AI_CARD_LIMITS.changesPerMemberPerDay} changes made with Ask AI on this site. Make the change on its page${
      opensAt
        ? `. You can make changes with Ask AI again from ${opensAt}.`
        : ', or try again tomorrow.'
    }`;
  if (error.code === 'ai_rate_limited' && reason === 'daily_mail')
    return `Not sent. You have reached today’s limit of ${AI_CARD_LIMITS.mailPerMemberPerDay} emails sent with Ask AI on this site. Send it from the lead’s Mail tab${
      opensAt
        ? `. You can send emails with Ask AI again from ${opensAt}.`
        : ', or try again tomorrow.'
    }`;
  const missing = error.details?.['missing'];
  if (error.code === 'conflict' && Array.isArray(missing) && missing.length > 0)
    return `Not sent. The lead lacks what the template fills in: ${missing
      .filter((entry): entry is string => typeof entry === 'string')
      .join(', ')}. Add it on the lead page first.`;
  return undefined;
}

/**
 * Ask AI's client state, the one owner of it for the panel and the full page.
 * One composite key (site + member) owns everything here, and a generation
 * counter makes every late stream part harmless after a stop, a reset or a
 * credential change. Nothing is written to any browser storage.
 *
 * Against an older backend (capabilities without `conversations`) the
 * conversation lives in memory only and the browser sends its signed history,
 * exactly as before. When the backend stores conversations, the browser names
 * the conversation (an id it generates for a new chat) and sends no history:
 * the server replays its own. The list of the member's conversations, the
 * open conversation's id and title, a stored conversation being loaded, and
 * the files waiting to go with the next message live here too, each answer
 * checked against the key and its own generation before it touches state.
 */

export interface AiUserMessage {
  id: string;
  role: 'user';
  text: string;
  /** The files sent with the question (stored conversations only). */
  attachments?: readonly AiAttachmentSummary[];
  /** Asked at High effort (the request carried it); a retry asks at the same level. */
  effort?: 'high';
  /** Emptied by a customer's erasure (stored conversations only); its answer says so. */
  erased?: true;
}

/**
 * What an automation proposal card has come to, kept with its message so a
 * closed and reopened panel shows the same card (UI-1): the re-signed
 * proposal, the person's edits, a save, a dismissal and the last simulation.
 */
export interface AutomationCardState {
  proposal: AiAutomationProposal;
  draft: AiAutomationDraft;
  savedKey?: string;
  cancelled?: boolean;
  simulation?: AiAutomationSimulation;
}

export interface AiAssistantMessage {
  automationProposals?: readonly AiAutomationProposal[];
  automationCards?: Readonly<Record<string, AutomationCardState>>;
  followUp?: AiFollowUp;
  actions?: readonly AiActionView[];
  id: string;
  role: 'assistant';
  text: string;
  status: 'streaming' | 'complete' | 'stopped' | 'error';
  sources: readonly AiSource[];
  /** Blocks under the answer (docs/design/ai-blocks.md); never stored, so a reload has none. */
  blocks?: readonly AiBlock[];
  /** The current tool's plain-language label, never announced as a live region. */
  progress?: string;
  /** The finished answer's history signature (CHAT-2), sent back with the next question. */
  signature?: string;
  error?: AiUiError;
  /**
   * A reloaded answer's drafts (action cards, automation proposals) that are
   * no longer available: their signed tokens are not kept.
   */
  expiredDrafts?: number;
  /** The saved answer's id (`done.messageId`) in a stored conversation. */
  storedId?: string;
  /**
   * A reloaded conversation's last question had no stored answer yet (the
   * page was reloaded while it was being written): shown as stopped until
   * the stored answer is read again.
   */
  interrupted?: boolean;
  /** Answered at High effort: the quiet "High effort" tag, live and after a reload. */
  effort?: 'high';
  /** High's own limit refused this turn: seconds until it may be asked at High again. */
  retryAfterSeconds?: number;
  /** Emptied by a customer's erasure: shown as one plain line, nothing else. */
  erased?: true;
  /** The member's daily file budget was spent: this answer was made without the files. */
  fileLimitReached?: true;
  /**
   * The server took this turn: a part of its stream arrived (the member's
   * message, and any files with it, are then stored), or it was loaded from
   * the store. A turn refused before its stream stored nothing.
   */
  accepted?: boolean;
}

export type AiMessage = AiUserMessage | AiAssistantMessage;

export interface AiActionView {
  /** The card in full when the backend sends `action_cards`, else the older proposal (which parses as one). */
  proposal: AiActionCard;
  /**
   * `refused`: Confirm was refused for a reason a retry cannot get past (a
   * daily cap, a change the member may no longer make); nothing was saved
   * and the card offers no Retry save.
   */
  status: 'pending' | 'revising' | 'saving' | 'saved' | 'cancelled' | 'error' | 'refused';
  error?: string;
}

/**
 * Why Ask AI cannot be used here right now: the sign-in expired (`session`),
 * the member's access to the site or to Ask AI was taken away (`access`), or
 * the CRM could not say (`unavailable`: a failure or no connection).
 */
export type AssistantCapabilityFailure = 'session' | 'access' | 'unavailable';

export type AssistantCapabilities =
  | { status: 'loading' }
  | { status: 'failed'; reason: AssistantCapabilityFailure; failure?: unknown }
  | { status: 'ready'; data: AiCapabilitiesResponse };

/** The capabilities state of a failure, for `reason` (and the error, when there is one). */
function failedCapabilities(
  key: string,
  reason: AssistantCapabilityFailure,
  failure?: unknown,
): CapabilitiesState {
  return {
    key,
    value: { status: 'failed', reason, ...(failure === undefined ? {} : { failure }) },
  };
}

/** Which failure an error is: an expired sign-in, lost access, or anything else. */
export function capabilityFailureOf(error: unknown): AssistantCapabilityFailure {
  const kind = errorKind(error);
  if (kind === 'session') return 'session';
  if (kind === 'permission') return 'access';
  return 'unavailable';
}

export interface AssistantWorkspace {
  id: string;
  slug: string;
  name: string;
}

/** Loading a stored conversation into the thread. */
export type ConversationLoad =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

interface SessionState {
  key: string;
  messages: readonly AiMessage[];
  streaming: boolean;
  /** The open stored conversation; undefined for a new chat (and always with an older backend). */
  conversationId?: string;
  title?: string;
  /**
   * The id is the browser's own for a new chat whose first turn the server has
   * not taken yet: nothing is stored under it, so it is not the active
   * conversation (the address and the list do not show it) until a part of
   * the answer arrives, and it is dropped if the request is refused.
   */
  provisional?: boolean;
  load: ConversationLoad;
}

interface CapabilitiesState {
  key: string;
  value: AssistantCapabilities;
}

/** The member's conversations, a page at a time, for one title search. */
export interface ConversationListState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** What the member has typed in the search box (one value for every view of the list). */
  search: string;
  /** The search the shown rows answer. */
  query: string;
  items: readonly AiConversation[];
  nextCursor?: string;
  loadingMore: boolean;
  /** Why the first page could not be loaded. */
  error?: string;
  /** Why the next page could not be loaded. */
  moreError?: string;
  /** A rename that did not save (the old title is back). */
  notice?: string;
}

interface ListState {
  key: string;
  value: ConversationListState;
}

/** A file chosen for the next message, from the first check to ready. */
export interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  kind?: AiAttachmentKind;
  status: 'uploading' | 'ready' | 'failed';
  /** 0 to 1 while the bytes go to storage. */
  progress: number;
  /** The attachment's id once the intent exists. */
  attachmentId?: string;
  /** The verified file, once finalized. */
  summary?: AiAttachmentSummary;
  /** A local `blob:` preview of an image; revoked when the chip goes. */
  previewUrl?: string;
  /** Why it was refused or failed, in plain words. */
  error?: string;
}

interface AttachmentState {
  key: string;
  items: readonly PendingAttachment[];
  /** A refusal about the set (too many files), not one file. */
  notice?: string;
}

export interface AssistantConversations {
  /** The backend stores conversations and Ask AI is available. */
  enabled: boolean;
  activeId?: string;
  title?: string;
  load: ConversationLoad;
  list: ConversationListState;
  /** Opens a stored conversation (stopping an answer still streaming). */
  open(id: string): void;
  /** Loads the open conversation again after a failure. */
  reload(): void;
  /** The first page for a title search ('' for all); keeps rows already shown for the same search. */
  loadList(query?: string): void;
  /**
   * The member typed in the search box: the text is kept here, once for every
   * view of the list, and the search runs a moment after typing stops.
   */
  setSearch(text: string): void;
  loadMore(): void;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<{ ok: true } | { ok: false; message: string }>;
  dismissNotice(): void;
}

export interface AssistantAttachments {
  /** What may be attached, or undefined when this site offers no attach control. */
  settings?: AttachmentSettings;
  pending: readonly PendingAttachment[];
  notice?: string;
  uploading: boolean;
  add(files: readonly File[]): void;
  remove(localId: string): void;
}

/** The effort level of the next message: the member's choice, while the tab is open. */
export interface AssistantEffort {
  /** The site offers High right now (capabilities list it); otherwise there is no control. */
  offered: boolean;
  /** What the member chose; it never changes by itself, and is sent only while offered. */
  value: AiEffort;
  set(value: AiEffort): void;
}

/**
 * The model of the next message (Settings → AI models): offered only where
 * capabilities list `models`, the site's default first. The member's pick is
 * kept in this browser per site and falls back to the default when the site
 * no longer allows it; the default itself is never sent, so it always means
 * the site's default of the moment.
 */
export interface AssistantModel {
  /** The site offers a choice now; otherwise there is no picker and nothing is sent. */
  offered: boolean;
  /** The allowed models, the site's default first. */
  options: readonly AiModelChoice[];
  /** The site's default model's id, when a choice is offered. */
  defaultModel?: string;
  /** The model the next message is asked with: the member's pick, or the default. */
  value: string;
  set(value: string): void;
}

/** Where the member's pick is kept in this browser, one key per site. */
export function modelChoiceKey(workspaceId: string): string {
  return `gt-ai-model:${workspaceId}`;
}

/**
 * The `model` a question carries: the member's pick when the site still
 * offers it and it is not the default, else nothing (the server's default).
 */
export function modelForRequest(
  capabilities: Pick<AiCapabilitiesResponse, 'available' | 'models' | 'defaultModel'> | undefined,
  choice: string,
): string | undefined {
  if (!capabilities?.available || capabilities.models === undefined) return undefined;
  if (choice === capabilities.defaultModel) return undefined;
  return capabilities.models.some((model) => model.id === choice) ? choice : undefined;
}

export interface AssistantContextValue {
  workspaceSlug: string;
  effort: AssistantEffort;
  model: AssistantModel;
  automationApi: {
    save: (token: string) => ReturnType<typeof saveAiAutomation>;
    revise: (
      token: string,
      draft: Parameters<typeof reviseAiAutomation>[3],
    ) => ReturnType<typeof reviseAiAutomation>;
    simulate: (
      body: Parameters<typeof simulateAiAutomation>[2],
    ) => ReturnType<typeof simulateAiAutomation>;
  };
  updateAutomationCard(
    messageId: string,
    proposalId: string,
    change: Partial<AutomationCardState>,
  ): void;
  reviseAction(messageId: string, actionId: string, draft: AiCardDraft): void;
  /** `acknowledged`: the person ticked the card's mention warning (B1). */
  confirmAction(messageId: string, actionId: string, acknowledged?: boolean): void;
  cancelAction(messageId: string, actionId: string): void;
  capabilities: AssistantCapabilities;
  messages: readonly AiMessage[];
  streaming: boolean;
  isOpen: boolean;
  activeLeadId?: string;
  /** The selected Site's name, always available even before capabilities load. */
  siteName: string;
  maxMessageChars: number;
  historyTrimmed: boolean;
  removeLeadContext(): void;
  open(returnFocusTo?: HTMLElement): void;
  close(): void;
  newChat(): void;
  /**
   * Sends a question; `withAttachments` adds the ready files (the full page's
   * composer only). False when nothing was sent (an answer is still coming,
   * the conversation is loading or not available, Ask AI is off).
   */
  send(text: string, options?: { withAttachments?: boolean }): boolean;
  stop(): void;
  retry(): void;
  /** The last answer may be asked again (failed, or stopped in a stored conversation). */
  canRetry: boolean;
  /**
   * The open stored conversation holds as many messages as it may: nothing
   * more can be sent in it, and a new chat is the way on.
   */
  conversationFull: boolean;
  /** Asks for capabilities again (after a failure the member can try to recover from). */
  reloadCapabilities(): void;
  /** Why the last failed answer is not offered again, in plain words, when that needs saying. */
  retryNote?: string;
  conversations: AssistantConversations;
  attachments: AssistantAttachments;
  /** Signed links to the member's files, for the files on messages. */
  attachmentLinks: AttachmentLinkCache;
  /** The full page is on screen: the header trigger stays away and the panel stays shut. */
  chatPageOpen: boolean;
  /** Called by the full page while it is mounted; returns the unregister. */
  registerChatPage(): () => void;
  /** Closes the panel for the full page, keeping an answer that is still streaming. */
  handOffToChatPage(): void;
}

const AssistantContext = createContext<AssistantContextValue | undefined>(undefined);

/** Typing in the conversation search asks the server this long after the last key. */
export const CONVERSATION_SEARCH_DELAY_MS = 300;

/** How long after an interrupted first turn the list is asked again (the server may still be saving it). */
const INTERRUPTED_REFRESH_MS = 1_500;

/**
 * Whether the server stored this turn (and linked its files): a part of its
 * answer arrived, it came from the store, or it was stopped (the server keeps a
 * stopped turn as cancelled, even one stopped before its first part). Only a
 * request that ended in an error before any part was refused unstored.
 */
function turnTaken(answer: AiAssistantMessage): boolean {
  return answer.accepted === true || answer.storedId !== undefined || answer.status === 'stopped';
}

/** Errors after which asking the same question again can only fail again. */
const NOT_RETRYABLE: readonly (AiUiError | undefined)[] = [
  'conversation_full',
  'conversation_limit',
  'conversation_missing',
];

/**
 * Whether the last answer may be asked again, and if not, whether the member
 * should be told why. In a stored conversation a stopped answer counts too;
 * a turn the server took has its files linked to it for good, so a question
 * that carried files cannot be asked again with them.
 */
function retryState(
  messages: readonly AiMessage[],
  streaming: boolean,
  stored: boolean,
): { canRetry: boolean; note?: string } {
  const last = messages[messages.length - 1];
  const question = messages[messages.length - 2];
  if (streaming || last?.role !== 'assistant' || question?.role !== 'user') {
    return { canRetry: false };
  }
  if (last.status !== 'error' && !(stored && last.status === 'stopped')) return { canRetry: false };
  if (!stored) return { canRetry: last.status === 'error' };
  if (last.status === 'error' && NOT_RETRYABLE.includes(last.error)) return { canRetry: false };
  const taken = turnTaken(last);
  if (taken && (question.attachments?.length ?? 0) > 0) {
    return {
      canRetry: false,
      note: 'The files sent with this question can’t be sent again. Attach them again and ask once more.',
    };
  }
  return { canRetry: true };
}

let messageSequence = 0;

function nextMessageId(): string {
  messageSequence += 1;
  return `message-${messageSequence}`;
}

let attachmentSequence = 0;

function nextAttachmentId(): string {
  attachmentSequence += 1;
  return `attachment-${attachmentSequence}`;
}

function emptySession(key: string): SessionState {
  return { key, messages: [], streaming: false, load: { status: 'idle' } };
}

function emptyList(): ConversationListState {
  return { status: 'idle', search: '', query: '', items: [], loadingMore: false };
}

/** The codes after which this member may no longer see the site's assistant. */
const ACCESS_CODES = [
  'permission_denied',
  'missing_session',
  'invalid_session',
  'membership_revoked',
  'membership_missing',
  'membership_pending',
];

/**
 * T8: the member keeps Ask AI but may no longer make this card's change: only
 * the card is refused, and the conversation stays.
 */
function isCardNotPermitted(error: unknown): boolean {
  return (
    error instanceof BackendError &&
    error.code === 'permission_denied' &&
    error.details?.['reason'] === 'card_not_permitted'
  );
}

const CARD_NOT_PERMITTED_TEXT =
  'Not saved. You no longer have permission to make this change. Ask the owner if you need it; you can still ask Ask AI questions.';

/** A refusal Retry save cannot get past: a daily cap (T10) or a change this member may not make (T8). */
function isFinalCardRefusal(error: unknown): boolean {
  return (
    isCardNotPermitted(error) ||
    (error instanceof BackendError &&
      error.code === 'ai_rate_limited' &&
      (error.details?.['reason'] === 'daily_changes' || error.details?.['reason'] === 'daily_mail'))
  );
}

function isAccessLoss(error: unknown): boolean {
  return (
    error instanceof BackendError && ACCESS_CODES.includes(error.code) && !isCardNotPermitted(error)
  );
}

function toHistory(messages: readonly AiMessage[]): AiHistoryEntry[] {
  const history: AiHistoryEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const question = messages[index];
    const answer = messages[index + 1];
    // Whole turns only (UI-7): a question whose answer was stopped, failed or
    // is still streaming stays on screen but never reaches the model, so the
    // history always alternates question, answer.
    if (question?.role !== 'user' || answer?.role !== 'assistant') continue;
    if (answer.status !== 'complete') continue;
    const text = aiAssistantHistoryText({ text: answer.text, followUp: answer.followUp });
    if (question.text.length === 0 || text.length === 0) continue;
    history.push(
      { role: 'user', text: question.text },
      {
        role: 'assistant',
        text,
        ...(answer.signature === undefined ? {} : { signature: answer.signature }),
      },
    );
  }
  return history;
}

/**
 * A stored message as the thread shows it. A failed answer keeps the sentence
 * its error code has in a live stream (an unknown code gets the general one,
 * never the code); action cards and automation drafts are not restored.
 */
export function storedToMessage(row: AiStoredMessage): AiMessage {
  const high = row.effort === 'high' ? { effort: 'high' as const } : {};
  if (row.role === 'user') {
    return {
      id: row.id,
      role: 'user',
      text: row.text,
      ...(row.attachments.length > 0 ? { attachments: row.attachments } : {}),
      ...high,
      ...(row.erased ? { erased: true as const } : {}),
    };
  }
  const status: AiAssistantMessage['status'] =
    row.outcome === 'completed' ? 'complete' : row.outcome === 'cancelled' ? 'stopped' : 'error';
  return {
    id: row.id,
    role: 'assistant',
    text: row.text,
    status,
    sources: row.sources,
    storedId: row.id,
    accepted: true,
    ...(row.followUp === undefined ? {} : { followUp: row.followUp }),
    ...(status === 'error'
      ? {
          error: uiErrorForStreamCode(
            row.outcome === 'access_lost' ? 'access_lost' : (row.errorCode ?? 'internal_error'),
          ),
        }
      : {}),
    ...(row.expiredDrafts > 0 ? { expiredDrafts: row.expiredDrafts } : {}),
    ...high,
    ...(row.erased ? { erased: true as const } : {}),
  };
}

/** The id of a reloaded conversation's interrupted-turn placeholder. */
const INTERRUPTED_ID = 'interrupted-turn';

/** How long after opening a conversation with an interrupted turn it is read once more. */
export const INTERRUPTED_REREAD_MS = 2_000;

/**
 * A stored conversation whose last message is a question with no answer was
 * read while that answer was still being written (a reload mid-answer): the
 * turn is shown as stopped at once, with Retry, rather than as a bare
 * question, until the stored answer is read.
 */
function withInterruptedTurn(messages: readonly AiMessage[]): AiMessage[] {
  if (messages.at(-1)?.role !== 'user') return [...messages];
  return [
    ...messages,
    {
      id: INTERRUPTED_ID,
      role: 'assistant',
      text: '',
      status: 'stopped',
      sources: [],
      accepted: true,
      interrupted: true,
    },
  ];
}

/** The title the server gives a new conversation, until its own arrives: the opening words. */
function provisionalTitle(text: string): string {
  const line = Array.from(text.replace(/[\p{Cc}\s]+/gu, ' ').trim())
    .slice(0, 60)
    .join('')
    .trim();
  return line.length > 0 ? line : 'New chat';
}

/** A uuid v4; `crypto.randomUUID` when the runtime has it, a small fallback otherwise. */
function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function revokePreview(item: PendingAttachment): void {
  if (item.previewUrl !== undefined && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(item.previewUrl);
  }
}

export function AssistantProvider({
  workspace,
  accessToken,
  actorIdentity,
  activeLeadId,
  children,
}: {
  workspace: AssistantWorkspace;
  accessToken: string;
  actorIdentity?: string;
  activeLeadId?: string;
  children: ReactNode;
}) {
  // The credential and the site together own the conversation. Comparing this
  // key during render clears it before a stale turn can paint; the abort and
  // the generation bump make every part already in flight a no-op.
  const sessionKey = `${workspace.id}:${workspace.slug}:${actorIdentity ?? accessToken}`;

  const [removedLead, setRemovedLead] = useState<string>();
  const [historyTrimmed, setHistoryTrimmed] = useState(false);
  const contextLeadId = activeLeadId === removedLead ? undefined : activeLeadId;
  const [isOpen, setIsOpen] = useState(false);
  // The effort level of the next message. Memory only (no browser storage),
  // so it lasts for this tab and never changes by itself: not on New chat,
  // another conversation or another site.
  const [effortChoice, setEffortChoice] = useState<AiEffort>('normal');
  // Bumped to ask for capabilities again (a site that stopped offering High).
  const [capabilitiesReload, setCapabilitiesReload] = useState(0);
  const [session, setSession] = useState<SessionState>(() => emptySession(sessionKey));
  const sessionRef = useRef(session);
  const [capabilitiesState, setCapabilitiesState] = useState<CapabilitiesState>(() => ({
    key: sessionKey,
    value: { status: 'loading' },
  }));
  const [listState, setListState] = useState<ListState>(() => ({
    key: sessionKey,
    value: emptyList(),
  }));
  const listRef = useRef(listState);
  const [attachmentState, setAttachmentState] = useState<AttachmentState>(() => ({
    key: sessionKey,
    items: [],
  }));
  const attachmentsRef = useRef(attachmentState);
  const [chatPages, setChatPages] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const capabilitiesGenerationRef = useRef(0);
  /** Bumped by every open, new chat and reset: only the newest conversation load may answer. */
  const loadGenerationRef = useRef(0);
  /** Bumped by every first-page load and reset: a late page of an older search is dropped. */
  const listGenerationRef = useRef(0);
  /** Bumped whenever the pending files are cleared: a late upload step is dropped. */
  const attachmentGenerationRef = useRef(0);
  const uploadsRef = useRef(new Map<string, AbortController>());
  // The list's first page, for a turn that ended before naming its
  // conversation (`loadList` is defined further down).
  const loadListRef = useRef<() => void>(() => undefined);
  /** Timers that ask for the list later; cleared when the provider goes. */
  const timersRef = useRef(new Set<number>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Long chains (an upload's four steps, a page of the list) read the newest
  // token when each step starts, so a refreshed sign-in is used at once.
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

  if (session.key !== sessionKey) {
    abortRef.current?.abort();
    abortRef.current = null;
    generationRef.current += 1;
    loadGenerationRef.current += 1;
    listGenerationRef.current += 1;
    attachmentGenerationRef.current += 1;
    for (const upload of uploadsRef.current.values()) upload.abort();
    uploadsRef.current.clear();
    const reset = emptySession(sessionKey);
    sessionRef.current = reset;
    setSession(reset);
    setIsOpen(false);
    setRemovedLead(undefined);
    setHistoryTrimmed(false);
  }

  const activeSession = useMemo<SessionState>(
    () => (session.key === sessionKey ? session : emptySession(sessionKey)),
    [session, sessionKey],
  );
  const capabilities = useMemo<AssistantCapabilities>(
    () => (capabilitiesState.key === sessionKey ? capabilitiesState.value : { status: 'loading' }),
    [capabilitiesState, sessionKey],
  );
  const list = useMemo<ConversationListState>(
    () => (listState.key === sessionKey ? listState.value : emptyList()),
    [listState, sessionKey],
  );
  const pendingAttachments = useMemo<readonly PendingAttachment[]>(
    () => (attachmentState.key === sessionKey ? attachmentState.items : []),
    [attachmentState, sessionKey],
  );
  const attachmentNotice = attachmentState.key === sessionKey ? attachmentState.notice : undefined;

  const offeredEfforts = useMemo<readonly AiEffort[]>(
    () =>
      capabilities.status === 'ready' && capabilities.data.available
        ? (capabilities.data.efforts ?? [])
        : [],
    [capabilities],
  );
  const highOffered = offeredEfforts.includes('high');
  // The site's models, when it offers a choice (capabilities list `models`).
  const offeredModels = useMemo<readonly AiModelChoice[]>(
    () =>
      capabilities.status === 'ready' && capabilities.data.available
        ? (capabilities.data.models ?? [])
        : [],
    [capabilities],
  );
  const defaultModel =
    capabilities.status === 'ready' && capabilities.data.available
      ? capabilities.data.defaultModel
      : undefined;
  const modelIds = useMemo(() => offeredModels.map((entry) => entry.id), [offeredModels]);
  // The member's pick, kept in this browser per site; a pick the site no
  // longer allows reads as the default.
  const [storedModel, setStoredModel] = useStoredChoice<string>(
    modelChoiceKey(workspace.id),
    modelIds,
    defaultModel ?? '',
  );
  const modelChoice =
    defaultModel !== undefined && !modelIds.includes(storedModel) ? defaultModel : storedModel;
  /** The `model` the next question carries; read when a turn starts, like `wide`. */
  const modelRequestRef = useRef<string | undefined>(undefined);
  modelRequestRef.current = modelForRequest(
    capabilities.status === 'ready' ? capabilities.data : undefined,
    modelChoice,
  );
  /**
   * T12: a backend that lists `cardActions` sends every card kind in full,
   * and this admin shows them all, so its questions say so (`wide`); an
   * older backend, whose strict request does not know the key, never gets it.
   */
  const showsEveryCardRef = useRef(false);
  showsEveryCardRef.current =
    capabilities.status === 'ready' && capabilities.data.cardActions !== undefined;
  const storesConversations =
    capabilities.status === 'ready' &&
    capabilities.data.available &&
    capabilities.data.conversations === true;
  const attachmentSettings =
    storesConversations &&
    capabilities.status === 'ready' &&
    capabilities.data.attachments !== undefined &&
    capabilities.data.attachments.kinds.length > 0
      ? capabilities.data.attachments
      : undefined;

  // One cache of signed file links per site and member; the old one's local
  // previews are revoked when the key changes or the provider goes.
  const linkCacheRef = useRef<{ key: string; cache: AttachmentLinkCache } | null>(null);
  if (linkCacheRef.current === null || linkCacheRef.current.key !== sessionKey) {
    linkCacheRef.current?.cache.dispose();
    const workspaceId = workspace.id;
    linkCacheRef.current = {
      key: sessionKey,
      cache: createAttachmentLinkCache((id) =>
        getAiAttachmentLink(tokenRef.current, workspaceId, id),
      ),
    };
  }
  const linkCache = linkCacheRef.current.cache;
  useEffect(() => () => linkCache.dispose(), [linkCache]);

  const commitSession = useCallback((next: SessionState) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const commitList = useCallback(
    (change: (current: ConversationListState) => ConversationListState) => {
      const current = listRef.current.key === sessionKey ? listRef.current.value : emptyList();
      const next = { key: sessionKey, value: change(current) };
      listRef.current = next;
      setListState(next);
    },
    [sessionKey],
  );

  const commitAttachments = useCallback(
    (change: (current: AttachmentState) => Omit<AttachmentState, 'key'>) => {
      const current =
        attachmentsRef.current.key === sessionKey
          ? attachmentsRef.current
          : { key: sessionKey, items: [] };
      const next = { key: sessionKey, ...change(current) };
      attachmentsRef.current = next;
      setAttachmentState(next);
    },
    [sessionKey],
  );

  /**
   * Drops every file waiting for the next message: uploads are cancelled and
   * previews revoked; with `remote`, files the server already holds are
   * deleted too (best effort; the daily sweep removes what is left).
   */
  const clearAttachments = useCallback(
    (remote: boolean) => {
      attachmentGenerationRef.current += 1;
      for (const upload of uploadsRef.current.values()) upload.abort();
      uploadsRef.current.clear();
      const current = attachmentsRef.current.key === sessionKey ? attachmentsRef.current.items : [];
      for (const item of current) {
        revokePreview(item);
        if (remote && item.attachmentId !== undefined) {
          void deleteAiAttachment(tokenRef.current, workspace.id, item.attachmentId).catch(
            () => undefined,
          );
        }
      }
      if (current.length > 0 || attachmentsRef.current.notice !== undefined) {
        commitAttachments(() => ({ items: [] }));
      }
    },
    [commitAttachments, sessionKey, workspace.id],
  );

  /**
   * The member lost access (or their sign-in): everything private goes, as
   * the memory-only panel always did. An open panel stays open, so it can say
   * why (the capabilities' failure).
   */
  const clearPrivate = useCallback(() => {
    generationRef.current += 1;
    loadGenerationRef.current += 1;
    listGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    clearAttachments(false);
    commitSession(emptySession(sessionKey));
    commitList(() => emptyList());
  }, [clearAttachments, commitList, commitSession, sessionKey]);

  const clearPrivateRef = useRef(clearPrivate);
  clearPrivateRef.current = clearPrivate;

  useEffect(() => {
    const requestGeneration = ++capabilitiesGenerationRef.current;
    if (accessToken.length === 0) {
      setCapabilitiesState(failedCapabilities(sessionKey, 'session'));
      return;
    }
    let current = true;
    void getAiCapabilities(accessToken, workspace.id).then(
      (data) => {
        if (!current || capabilitiesGenerationRef.current !== requestGeneration) return;
        setCapabilitiesState({ key: sessionKey, value: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (!current || capabilitiesGenerationRef.current !== requestGeneration) return;
        setCapabilitiesState(failedCapabilities(sessionKey, capabilityFailureOf(error), error));
        if (
          error instanceof BackendError &&
          [
            'permission_denied',
            'membership_revoked',
            'membership_missing',
            'membership_pending',
            'invalid_session',
          ].includes(error.code)
        ) {
          clearPrivateRef.current();
        }
      },
    );
    return () => {
      current = false;
    };
  }, [accessToken, sessionKey, workspace.id, capabilitiesReload]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      generationRef.current += 1;
      loadGenerationRef.current += 1;
      listGenerationRef.current += 1;
      attachmentGenerationRef.current += 1;
      for (const upload of uploadsRef.current.values()) upload.abort();
      uploadsRef.current.clear();
      for (const item of attachmentsRef.current.items) revokePreview(item);
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  /** Puts a conversation at the top of the list (or refreshes its row there). */
  const upsertConversation = useCallback(
    (conversation: AiConversation) => {
      commitList((current) => {
        if (current.status === 'idle') return current;
        const rest = current.items.filter((item) => item.id !== conversation.id);
        const matches =
          current.query.length === 0 ||
          conversation.title.toLocaleLowerCase().includes(current.query.toLocaleLowerCase());
        if (!matches) return { ...current, items: rest };
        return { ...current, items: [conversation, ...rest] };
      });
    },
    [commitList],
  );

  const applyPart = useCallback(
    (assistantId: string, part: AiStreamPart) => {
      const current = sessionRef.current;
      const messages = current.messages.map((message): AiMessage => {
        if (message.id !== assistantId || message.role !== 'assistant') return message;
        if (part.type === 'text') {
          return { ...message, text: message.text + part.text, progress: undefined };
        }
        if (part.type === 'progress') return { ...message, progress: part.label };
        if (part.type === 'blocks') return { ...message, blocks: part.blocks };
        if (part.type === 'sources') {
          // A turn may send its cards in more than one part; a repeated id wins.
          const byId = new Map<string, AiSource>();
          for (const source of message.sources) byId.set(source.id, source);
          for (const source of part.sources) byId.set(source.id, source);
          return { ...message, sources: [...byId.values()] };
        }
        // UI-2: a turn may send its cards in more than one part; merge by id
        // (a repeated id is replaced) rather than dropping earlier cards.
        if (part.type === 'automation_proposals') {
          const byId = new Map<string, AiAutomationProposal>();
          for (const proposal of message.automationProposals ?? []) byId.set(proposal.id, proposal);
          for (const proposal of part.proposals) byId.set(proposal.id, proposal);
          return { ...message, automationProposals: [...byId.values()] };
        }
        if (part.type === 'follow_up') return { ...message, followUp: part.followUp };
        if (part.type === 'notice' && part.code === 'attachment_budget_spent') {
          return { ...message, fileLimitReached: true };
        }
        if (part.type === 'done') {
          return {
            ...message,
            ...(part.signature === undefined ? {} : { signature: part.signature }),
            ...(part.messageId === undefined ? {} : { storedId: part.messageId }),
          };
        }
        if (part.type === 'actions' || part.type === 'action_cards') {
          // `action_cards` carries every card in full and comes first; the
          // older `actions` part repeats some of them, which are skipped here.
          const byId = new Map<string, AiActionView>();
          for (const action of message.actions ?? []) byId.set(action.proposal.id, action);
          for (const proposal of part.type === 'actions' ? part.actions : part.cards) {
            const known = byId.get(proposal.id);
            // A card already being worked on keeps its state.
            if (!known) byId.set(proposal.id, { proposal, status: 'pending' });
            else if (part.type === 'action_cards' && known.status === 'pending')
              byId.set(proposal.id, { ...known, proposal });
          }
          return { ...message, actions: [...byId.values()] };
        }
        if (part.type === 'error') {
          return {
            ...message,
            status: 'error',
            error: uiErrorForStreamCode(part.code),
            progress: undefined,
          };
        }
        return message;
      });
      commitSession({ ...current, messages });
    },
    [commitSession],
  );

  const finalize = useCallback(
    (assistantId: string, result: AiUiError | undefined) => {
      const current = sessionRef.current;
      const messages = current.messages.map((message): AiMessage => {
        if (message.id !== assistantId || message.role !== 'assistant') return message;
        if (result === undefined) return { ...message, status: 'complete', progress: undefined };
        if (result === 'cancelled') return { ...message, status: 'stopped', progress: undefined };
        return { ...message, status: 'error', error: result, progress: undefined };
      });
      commitSession({ ...current, messages, streaming: false });
      // The site no longer offers High: ask again, so the control goes. The
      // question waits for the member's Retry, which then asks at Normal.
      // The same for a model the site no longer allows: the Retry asks with
      // the default once the new list is read.
      if (result === 'effort_unavailable' || result === 'model_unavailable')
        setCapabilitiesReload((count) => count + 1);
    },
    [commitSession],
  );

  const startTurn = useCallback(
    (
      text: string,
      base: readonly AiMessage[],
      userMessage: AiUserMessage,
      limits: AiRequestLimits,
      stored: { conversationId: string; attachmentIds: readonly string[] } | undefined,
      efforts: readonly AiEffort[],
    ) => {
      const run = generationRef.current + 1;
      generationRef.current = run;
      const controller = new AbortController();
      abortRef.current = controller;
      // High only when the question is High and the site offers it now.
      const high = userMessage.effort === 'high' && efforts.includes('high');
      // The first message of a chat this browser made, not yet acknowledged
      // by the server: only it may create the conversation (a retry of it
      // goes on in the one its first try made).
      const fresh =
        stored !== undefined &&
        sessionRef.current.provisional === true &&
        sessionRef.current.conversationId === stored.conversationId;
      const assistant: AiAssistantMessage = {
        id: nextMessageId(),
        role: 'assistant',
        text: '',
        status: 'streaming',
        sources: [],
        ...(high ? { effort: 'high' as const } : {}),
      };
      commitSession({
        ...sessionRef.current,
        key: sessionKey,
        messages: [...base, userMessage, assistant],
        streaming: true,
      });
      const built = buildAiChatRequest({
        message: text,
        history: stored === undefined ? toHistory(base) : [],
        limits,
        requestId: randomUuid(),
        ...(contextLeadId === undefined ? {} : { leadId: contextLeadId }),
        ...(stored === undefined
          ? {}
          : {
              conversationId: stored.conversationId,
              attachmentIds: stored.attachmentIds,
              ...(fresh ? { newConversation: true } : {}),
            }),
        ...(userMessage.effort === undefined ? {} : { effort: userMessage.effort, efforts }),
        ...(modelRequestRef.current === undefined ? {} : { model: modelRequestRef.current }),
        ...(showsEveryCardRef.current ? { wide: true } : {}),
      });
      setHistoryTrimmed(built.trimmed);
      let titled = false;
      let answered = false;
      void (async () => {
        const result = await streamAnswer({
          accessToken,
          workspaceId: workspace.id,
          request: built.request,
          signal: controller.signal,
          onRetryAfter(seconds) {
            if (generationRef.current !== run) return;
            const current = sessionRef.current;
            commitSession({
              ...current,
              messages: current.messages.map((message) =>
                message.id === assistant.id && message.role === 'assistant'
                  ? { ...message, retryAfterSeconds: seconds }
                  : message,
              ),
            });
          },
          onPart(part) {
            if (generationRef.current !== run) return;
            if (!answered) {
              answered = true;
              // The server took the turn: the question (and its files) are
              // stored, and a new chat's id is now a real conversation.
              const current = sessionRef.current;
              commitSession({
                ...current,
                ...(stored !== undefined &&
                current.provisional === true &&
                current.conversationId === stored.conversationId
                  ? { provisional: false }
                  : {}),
                messages: current.messages.map((message) =>
                  message.id === assistant.id && message.role === 'assistant'
                    ? { ...message, accepted: true }
                    : message,
                ),
              });
            }
            if (part.type === 'error' && part.code === 'access_lost') {
              controller.abort();
              clearPrivateRef.current();
              setCapabilitiesState(failedCapabilities(sessionKey, 'access'));
              return;
            }
            if (part.type === 'conversation') {
              // Only the conversation this turn was sent to may take the title.
              const current = sessionRef.current;
              if (stored === undefined || part.conversationId !== stored.conversationId) return;
              titled = true;
              // The part carries the title as it was when the turn began: only
              // a conversation this turn created takes it. An existing one keeps
              // the title already known here (a rename made meanwhile wins).
              const known = listRef.current.value.items.find(
                (item) => item.id === part.conversationId,
              );
              const open = current.conversationId === part.conversationId;
              const title = part.created
                ? part.title
                : (known?.title ?? (open ? current.title : undefined) ?? part.title);
              if (open && part.created) commitSession({ ...current, title: part.title });
              const now = new Date().toISOString();
              upsertConversation({
                id: part.conversationId,
                title,
                createdAt: known?.createdAt ?? now,
                updatedAt: now,
                lastMessageAt: now,
              });
              return;
            }
            applyPart(assistant.id, part);
          },
        });
        if (generationRef.current !== run) {
          // Interrupted (New chat, another conversation) before the server
          // named this turn's conversation: it may well be stored, so the list
          // is asked again once, a moment later.
          if (stored !== undefined && !titled) {
            const key = sessionKey;
            const timer = window.setTimeout(() => {
              timersRef.current.delete(timer);
              if (sessionRef.current.key !== key) return;
              if (listRef.current.value.status === 'idle') return;
              loadListRef.current();
            }, INTERRUPTED_REFRESH_MS);
            timersRef.current.add(timer);
          }
          return;
        }
        if (abortRef.current === controller) abortRef.current = null;
        if (result === 'denied' || result === 'session_expired') {
          controller.abort();
          clearPrivateRef.current();
          setCapabilitiesState(
            failedCapabilities(sessionKey, result === 'session_expired' ? 'session' : 'access'),
          );
          return;
        }
        if (result === 'conversation_missing' && stored !== undefined && !fresh) {
          // Asked into a conversation that is gone (deleted in another tab):
          // nothing was recreated, and the stale thread must not look alive.
          const current = sessionRef.current;
          if (current.conversationId === stored.conversationId) {
            commitSession({
              key: sessionKey,
              messages: [],
              streaming: false,
              conversationId: stored.conversationId,
              load: { status: 'not_found' },
            });
          }
          commitList((list) => ({
            ...list,
            items: list.items.filter((item) => item.id !== stored.conversationId),
          }));
          return;
        }
        finalize(assistant.id, result);
        if (stored !== undefined && !answered) {
          // Refused before its stream: nothing was stored. A new chat's
          // provisional id goes (the question stays on screen with Retry).
          const current = sessionRef.current;
          if (current.provisional === true && current.conversationId === stored.conversationId) {
            const { conversationId: _dropped, title: _title, ...rest } = current;
            commitSession({ ...rest, provisional: false });
          }
        }
        if (stored !== undefined && answered && !titled) {
          // An answer without the `conversation` part still belongs at the top
          // (a request refused before its stream began stored nothing).
          const current = sessionRef.current;
          const known = listRef.current.value.items.find(
            (item) => item.id === stored.conversationId,
          );
          const now = new Date().toISOString();
          upsertConversation({
            id: stored.conversationId,
            title: known?.title ?? current.title ?? provisionalTitle(text),
            createdAt: known?.createdAt ?? now,
            updatedAt: now,
            lastMessageAt: now,
          });
        }
      })();
    },
    [
      accessToken,
      contextLeadId,
      applyPart,
      commitList,
      commitSession,
      finalize,
      sessionKey,
      upsertConversation,
      workspace.id,
    ],
  );

  const open = useCallback((returnFocusTo?: HTMLElement) => {
    // The trigger itself is the safest return target: a browser does not always
    // focus a button that was clicked.
    const active = document.activeElement;
    returnFocusRef.current = returnFocusTo ?? (active instanceof HTMLElement ? active : null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    // Closing a panel cancels its work: the answer must not keep streaming (or
    // keep a provider spend running) behind a closed panel. Completed messages
    // stay in memory for the next open.
    const current = sessionRef.current;
    if (current.streaming) {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      const messages = current.messages.map((message): AiMessage =>
        message.role === 'assistant' && message.status === 'streaming'
          ? { ...message, status: 'stopped', progress: undefined }
          : message,
      );
      commitSession({ ...current, messages, streaming: false });
    }
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    setIsOpen(false);
    if (target?.isConnected === true) {
      target.focus();
      requestAnimationFrame(() => {
        if (target.isConnected) target.focus();
      });
    }
  }, [commitSession]);

  const handOffToChatPage = useCallback(() => {
    // The full page shows this same conversation, so an answer still coming
    // keeps coming there; focus moves to the page, not back to the trigger.
    returnFocusRef.current = null;
    setIsOpen(false);
  }, []);

  const registerChatPage = useCallback(() => {
    setChatPages((count) => count + 1);
    setIsOpen(false);
    return () => setChatPages((count) => count - 1);
  }, []);

  const newChat = useCallback(() => {
    generationRef.current += 1;
    loadGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    clearAttachments(true);
    commitSession(emptySession(sessionKey));
    setHistoryTrimmed(false);
  }, [clearAttachments, commitSession, sessionKey]);

  const stop = useCallback(() => {
    const current = sessionRef.current;
    if (!current.streaming) return;
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const messages = current.messages.map((message): AiMessage =>
      message.role === 'assistant' && message.status === 'streaming'
        ? { ...message, status: 'stopped', progress: undefined }
        : message,
    );
    commitSession({ ...current, messages, streaming: false });
    // A first message stopped before the server named its conversation may
    // still have been stored (with its stopped answer): ask once, a moment
    // later, so the address, the heading and the list agree with the server.
    const conversationId = current.conversationId;
    if (current.provisional !== true || conversationId === undefined) return;
    const key = sessionKey;
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      const still = () =>
        sessionRef.current.key === key &&
        sessionRef.current.provisional === true &&
        sessionRef.current.conversationId === conversationId &&
        !sessionRef.current.streaming;
      if (!still()) return;
      void getAiConversation(tokenRef.current, workspace.id, conversationId).then(
        (response) => {
          if (!still()) return;
          commitSession({
            ...sessionRef.current,
            provisional: false,
            title: response.conversation.title,
          });
          upsertConversation(response.conversation);
        },
        () => undefined,
      );
    }, INTERRUPTED_REFRESH_MS);
    timersRef.current.add(timer);
  }, [commitSession, sessionKey, upsertConversation, workspace.id]);

  const loadConversation = useCallback(
    (id: string) => {
      // A switch while an answer streams stops it first; the server keeps the stopped answer.
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      clearAttachments(true);
      const run = ++loadGenerationRef.current;
      const key = sessionKey;
      const known = listRef.current.value.items.find((item) => item.id === id);
      commitSession({
        key,
        messages: [],
        streaming: false,
        conversationId: id,
        ...(known === undefined ? {} : { title: known.title }),
        load: { status: 'loading' },
      });
      setHistoryTrimmed(false);
      const isCurrent = () =>
        loadGenerationRef.current === run &&
        sessionRef.current.key === key &&
        sessionRef.current.conversationId === id;
      void getAiConversation(tokenRef.current, workspace.id, id).then(
        (response) => {
          if (!isCurrent()) return;
          const messages = withInterruptedTurn(response.messages.map(storedToMessage));
          commitSession({
            ...sessionRef.current,
            messages,
            title: response.conversation.title,
            load: { status: 'idle' },
          });
          if (messages.at(-1)?.role !== 'assistant' || messages.at(-1)?.id !== INTERRUPTED_ID)
            return;
          // Read once more a moment later: the stored answer (stopped, as
          // the reload left it) usually arrives then. Never more than once.
          const timer = window.setTimeout(() => {
            timersRef.current.delete(timer);
            const current = sessionRef.current;
            if (!isCurrent() || current.streaming || current.messages.at(-1)?.id !== INTERRUPTED_ID)
              return;
            void getAiConversation(tokenRef.current, workspace.id, id).then(
              (again) => {
                const latest = sessionRef.current;
                if (!isCurrent() || latest.streaming) return;
                if (latest.messages.at(-1)?.id !== INTERRUPTED_ID) return;
                if (again.messages.at(-1)?.role !== 'assistant') return;
                commitSession({ ...latest, messages: again.messages.map(storedToMessage) });
              },
              () => undefined,
            );
          }, INTERRUPTED_REREAD_MS);
          timersRef.current.add(timer);
        },
        (error: unknown) => {
          if (!isCurrent()) return;
          if (isAccessLoss(error)) {
            clearPrivateRef.current();
            setCapabilitiesState(failedCapabilities(key, capabilityFailureOf(error), error));
            return;
          }
          if (error instanceof BackendError && error.code === 'conversation_not_found') {
            commitSession({ ...sessionRef.current, load: { status: 'not_found' } });
            commitList((current) => ({
              ...current,
              items: current.items.filter((item) => item.id !== id),
            }));
            return;
          }
          commitSession({
            ...sessionRef.current,
            load: { status: 'error', message: describeError(error, 'open this conversation') },
          });
        },
      );
    },
    [clearAttachments, commitList, commitSession, sessionKey, workspace.id],
  );

  const openConversation = useCallback(
    (id: string) => {
      if (!storesConversations) return;
      const current = sessionRef.current;
      if (
        current.conversationId === id &&
        (current.load.status === 'idle' || current.load.status === 'loading')
      )
        return;
      loadConversation(id);
    },
    [loadConversation, storesConversations],
  );

  const reloadConversation = useCallback(() => {
    const id = sessionRef.current.conversationId;
    if (!storesConversations || id === undefined || sessionRef.current.streaming) return;
    loadConversation(id);
  }, [loadConversation, storesConversations]);

  const loadList = useCallback(
    (query?: string) => {
      if (!storesConversations) return;
      const term = (query ?? listRef.current.value.query).trim();
      const run = ++listGenerationRef.current;
      const key = sessionKey;
      const before = listRef.current.key === key ? listRef.current.value : emptyList();
      const keep = before.query === term && before.items.length > 0;
      commitList((current) => ({
        ...current,
        query: term,
        status: keep ? 'ready' : 'loading',
        items: keep ? current.items : [],
        ...(keep ? {} : { nextCursor: undefined }),
        loadingMore: false,
        error: undefined,
        moreError: undefined,
      }));
      void listAiConversations(
        tokenRef.current,
        workspace.id,
        term.length === 0
          ? {}
          : { q: Array.from(term).slice(0, AI_CHAT_LIMITS.maxTitleChars).join('') },
      ).then(
        (page) => {
          if (listGenerationRef.current !== run || sessionRef.current.key !== key) return;
          commitList((current) => ({
            ...current,
            status: 'ready',
            items: page.conversations,
            nextCursor: page.nextCursor,
            loadingMore: false,
            error: undefined,
          }));
        },
        (error: unknown) => {
          if (listGenerationRef.current !== run || sessionRef.current.key !== key) return;
          if (isAccessLoss(error)) {
            clearPrivateRef.current();
            setCapabilitiesState(failedCapabilities(key, capabilityFailureOf(error), error));
            return;
          }
          // A quiet refresh of rows already shown keeps them rather than an error wall.
          commitList((current) =>
            keep
              ? current
              : {
                  ...current,
                  status: 'error',
                  error: describeError(error, 'load your conversations'),
                },
          );
        },
      );
    },
    [commitList, sessionKey, storesConversations, workspace.id],
  );

  loadListRef.current = () => loadList();

  // One search box text and one debounce, whichever view of the list typed it.
  const searchTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(searchTimerRef.current), []);
  const setSearch = useCallback(
    (text: string) => {
      commitList((current) => ({ ...current, search: text }));
      window.clearTimeout(searchTimerRef.current);
      const key = sessionKey;
      searchTimerRef.current = window.setTimeout(() => {
        if (sessionRef.current.key !== key) return;
        const term = listRef.current.value.search.trim();
        if (term !== listRef.current.value.query) loadList(term);
      }, CONVERSATION_SEARCH_DELAY_MS);
    },
    [commitList, loadList, sessionKey],
  );

  const loadMore = useCallback(() => {
    const current = listRef.current.value;
    if (!storesConversations || current.nextCursor === undefined || current.loadingMore) return;
    if (current.status !== 'ready') return;
    const run = listGenerationRef.current;
    const key = sessionKey;
    const cursor = current.nextCursor;
    commitList((value) => ({ ...value, loadingMore: true, moreError: undefined }));
    void listAiConversations(tokenRef.current, workspace.id, {
      cursor,
      ...(current.query.length === 0 ? {} : { q: current.query }),
    }).then(
      (page) => {
        if (listGenerationRef.current !== run || sessionRef.current.key !== key) return;
        commitList((value) => {
          const seen = new Set(value.items.map((item) => item.id));
          return {
            ...value,
            items: [...value.items, ...page.conversations.filter((item) => !seen.has(item.id))],
            nextCursor: page.nextCursor,
            loadingMore: false,
          };
        });
      },
      (error: unknown) => {
        if (listGenerationRef.current !== run || sessionRef.current.key !== key) return;
        if (isAccessLoss(error)) {
          clearPrivateRef.current();
          setCapabilitiesState(failedCapabilities(key, capabilityFailureOf(error), error));
          return;
        }
        commitList((value) => ({
          ...value,
          loadingMore: false,
          moreError: describeError(error, 'load more conversations'),
        }));
      },
    );
  }, [commitList, sessionKey, storesConversations, workspace.id]);

  const renameConversation = useCallback(
    async (id: string, raw: string) => {
      if (!storesConversations) return;
      const title = Array.from(raw.replace(/[\p{Cc}\s]+/gu, ' ').trim())
        .slice(0, AI_CHAT_LIMITS.maxTitleChars)
        .join('')
        .trim();
      const before = listRef.current.value.items.find((item) => item.id === id);
      const previous =
        before?.title ??
        (sessionRef.current.conversationId === id ? sessionRef.current.title : undefined);
      if (title.length === 0 || title === previous) return;
      const key = sessionKey;
      const setTitle = (next: string, only?: string) => {
        commitList((current) => ({
          ...current,
          items: current.items.map((item) =>
            item.id === id && (only === undefined || item.title === only)
              ? { ...item, title: next }
              : item,
          ),
        }));
        const open = sessionRef.current;
        if (open.conversationId === id && (only === undefined || open.title === only)) {
          commitSession({ ...open, title: next });
        }
      };
      setTitle(title);
      commitList((current) => ({ ...current, notice: undefined }));
      try {
        const response = await renameAiConversation(tokenRef.current, workspace.id, id, title);
        if (sessionRef.current.key !== key) return;
        setTitle(response.conversation.title, title);
      } catch (error) {
        if (sessionRef.current.key !== key) return;
        if (isAccessLoss(error)) {
          clearPrivateRef.current();
          setCapabilitiesState(failedCapabilities(key, capabilityFailureOf(error), error));
          return;
        }
        // Back to the old title, unless something renamed it again meanwhile.
        if (previous !== undefined) setTitle(previous, title);
        commitList((current) => ({
          ...current,
          notice: describeError(error, 'rename the conversation'),
        }));
      }
    },
    [commitList, commitSession, sessionKey, storesConversations, workspace.id],
  );

  const removeConversation = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!storesConversations) return { ok: false, message: describeError('ai_unavailable', '') };
      const key = sessionKey;
      const forget = () => {
        commitList((current) => ({
          ...current,
          items: current.items.filter((item) => item.id !== id),
        }));
        if (sessionRef.current.conversationId === id) newChat();
      };
      try {
        await deleteAiConversation(tokenRef.current, workspace.id, id);
        if (sessionRef.current.key === key) forget();
        return { ok: true };
      } catch (error) {
        if (sessionRef.current.key !== key) return { ok: true };
        if (error instanceof BackendError && error.code === 'conversation_not_found') {
          // Already gone: what the member wanted.
          forget();
          return { ok: true };
        }
        if (isAccessLoss(error)) {
          clearPrivateRef.current();
          setCapabilitiesState(failedCapabilities(key, capabilityFailureOf(error), error));
          return { ok: false, message: describeError(error, 'delete the conversation') };
        }
        return { ok: false, message: describeError(error, 'delete the conversation') };
      }
    },
    [commitList, newChat, sessionKey, storesConversations, workspace.id],
  );

  const patchAttachment = useCallback(
    (localId: string, change: Partial<PendingAttachment>) => {
      commitAttachments((current) => ({
        items: current.items.map((item) =>
          item.localId === localId ? { ...item, ...change } : item,
        ),
        ...(current.notice === undefined ? {} : { notice: current.notice }),
      }));
    },
    [commitAttachments],
  );

  const uploadAttachment = useCallback(
    (localId: string, file: File, mediaType: AiAttachmentMediaType) => {
      const generation = attachmentGenerationRef.current;
      const key = sessionKey;
      const controller = new AbortController();
      uploadsRef.current.set(localId, controller);
      const alive = () =>
        !controller.signal.aborted &&
        attachmentGenerationRef.current === generation &&
        sessionRef.current.key === key &&
        attachmentsRef.current.items.some(
          (item) => item.localId === localId && item.status === 'uploading',
        );
      let attachmentId: string | undefined;
      const discard = () => {
        if (attachmentId !== undefined)
          void deleteAiAttachment(tokenRef.current, workspace.id, attachmentId).catch(
            () => undefined,
          );
      };
      void (async () => {
        try {
          const intent = await createAiAttachmentIntent(tokenRef.current, workspace.id, {
            fileName: Array.from(file.name.trim() || 'file')
              .slice(0, 255)
              .join(''),
            mediaType,
            byteSize: file.size,
          });
          attachmentId = intent.uploadId;
          if (!alive()) return discard();
          patchAttachment(localId, { attachmentId });
          await putAttachmentBytes({
            url: intent.url,
            headers: intent.headers,
            body: file,
            signal: controller.signal,
            onProgress: (fraction) => {
              if (alive()) patchAttachment(localId, { progress: Math.min(1, fraction) });
            },
          });
          if (!alive()) return discard();
          const checksum = await sha256Hex(file);
          if (!alive()) return discard();
          const finalized = await finalizeAiAttachment(
            tokenRef.current,
            workspace.id,
            intent.uploadId,
            checksum,
          );
          if (!alive()) return discard();
          patchAttachment(localId, {
            status: 'ready',
            progress: 1,
            summary: finalized.attachment,
          });
        } catch (error) {
          if (!alive()) return;
          if (isAccessLoss(error)) {
            clearPrivateRef.current();
            setCapabilitiesState(failedCapabilities(key, capabilityFailureOf(error), error));
            return;
          }
          patchAttachment(localId, {
            status: 'failed',
            error: describeError(error, 'attach the file'),
          });
        } finally {
          if (uploadsRef.current.get(localId) === controller) uploadsRef.current.delete(localId);
        }
      })();
    },
    [patchAttachment, sessionKey, workspace.id],
  );

  const addAttachments = useCallback(
    (files: readonly File[]) => {
      if (attachmentSettings === undefined || files.length === 0) return;
      const current = attachmentsRef.current.key === sessionKey ? attachmentsRef.current.items : [];
      let room =
        attachmentSettings.maxPerMessage -
        current.filter((item) => item.status !== 'failed').length;
      const added: PendingAttachment[] = [];
      const uploads: [string, File, AiAttachmentMediaType][] = [];
      let overflow = false;
      for (const file of files) {
        const check = checkAttachmentFile(file, attachmentSettings);
        const localId = nextAttachmentId();
        const base = { localId, name: file.name || 'file', size: file.size, progress: 0 };
        if (!check.ok) {
          added.push({
            ...base,
            ...(check.kind === undefined ? {} : { kind: check.kind }),
            status: 'failed',
            error: check.message,
          });
          continue;
        }
        if (room <= 0) {
          overflow = true;
          continue;
        }
        room -= 1;
        const previewUrl =
          check.kind === 'image' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : undefined;
        added.push({
          ...base,
          kind: check.kind,
          status: 'uploading',
          ...(previewUrl === undefined ? {} : { previewUrl }),
        });
        uploads.push([localId, file, check.mediaType]);
      }
      const max = attachmentSettings.maxPerMessage;
      commitAttachments((state) => ({
        items: [...state.items, ...added],
        ...(overflow
          ? {
              notice: `You can attach up to ${max} ${max === 1 ? 'file' : 'files'} to one message. The rest were left out.`,
            }
          : {}),
      }));
      for (const [localId, file, mediaType] of uploads) uploadAttachment(localId, file, mediaType);
    },
    [attachmentSettings, commitAttachments, sessionKey, uploadAttachment],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      const item = attachmentsRef.current.items.find((entry) => entry.localId === localId);
      if (item === undefined) return;
      uploadsRef.current.get(localId)?.abort();
      uploadsRef.current.delete(localId);
      revokePreview(item);
      commitAttachments((current) => ({
        items: current.items.filter((entry) => entry.localId !== localId),
      }));
      if (item.attachmentId !== undefined) {
        void deleteAiAttachment(tokenRef.current, workspace.id, item.attachmentId).catch(
          () => undefined,
        );
      }
    },
    [commitAttachments, workspace.id],
  );

  const send = useCallback(
    (raw: string, options?: { withAttachments?: boolean }) => {
      const current = sessionRef.current;
      if (current.streaming || capabilities.status !== 'ready') return false;
      if (!capabilities.data.available) return false;
      if (current.load.status !== 'idle') return false;
      const text = Array.from(raw.trim())
        .slice(0, capabilities.data.limits.maxMessageChars)
        .join('');
      if (text.length === 0) return false;
      // The member's level, for this question only where the site offers it.
      const level = effortChoice === 'high' && highOffered ? { effort: 'high' as const } : {};
      if (!storesConversations) {
        startTurn(
          text,
          current.messages,
          { id: nextMessageId(), role: 'user', text, ...level },
          capabilities.data.limits,
          undefined,
          offeredEfforts,
        );
        return true;
      }
      // A conversation at its message limit takes no more (the server would refuse it).
      if (
        current.conversationId !== undefined &&
        current.messages.filter((message) => message.id !== INTERRUPTED_ID).length >=
          AI_CHAT_LIMITS.maxConversationMessages
      )
        return false;
      const pending = options?.withAttachments === true ? attachmentsRef.current.items : [];
      if (pending.some((item) => item.status === 'uploading')) return false;
      const ready = pending.flatMap((item) =>
        item.status === 'ready' && item.summary !== undefined
          ? [{ item, summary: item.summary }]
          : [],
      );
      if (options?.withAttachments === true) {
        // The chips go; a sent image keeps its local preview on the message.
        for (const { item, summary } of ready) {
          if (item.previewUrl !== undefined) linkCache.seedLocal(summary.id, item.previewUrl);
        }
        for (const item of pending) {
          if (item.status === 'ready') continue;
          revokePreview(item);
          if (item.attachmentId !== undefined) {
            void deleteAiAttachment(tokenRef.current, workspace.id, item.attachmentId).catch(
              () => undefined,
            );
          }
        }
        attachmentGenerationRef.current += 1;
        commitAttachments(() => ({ items: [] }));
      }
      const conversationId = current.conversationId ?? randomUuid();
      if (current.conversationId === undefined) {
        commitSession({
          ...current,
          conversationId,
          title: provisionalTitle(text),
          provisional: true,
        });
      }
      const attachments = ready.map(({ summary }) => summary);
      startTurn(
        text,
        sessionRef.current.messages,
        {
          id: nextMessageId(),
          role: 'user',
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...level,
        },
        capabilities.data.limits,
        { conversationId, attachmentIds: attachments.map((summary) => summary.id) },
        offeredEfforts,
      );
      return true;
    },
    [
      capabilities,
      commitAttachments,
      commitSession,
      effortChoice,
      highOffered,
      linkCache,
      offeredEfforts,
      startTurn,
      storesConversations,
      workspace.id,
    ],
  );

  const conversationFull =
    storesConversations &&
    activeSession.conversationId !== undefined &&
    activeSession.messages.filter((message) => message.id !== INTERRUPTED_ID).length >=
      AI_CHAT_LIMITS.maxConversationMessages;

  const reloadCapabilities = useCallback(() => {
    setCapabilitiesState({ key: sessionKey, value: { status: 'loading' } });
    setCapabilitiesReload((count) => count + 1);
  }, [sessionKey]);

  const { canRetry, note: retryNote } = retryState(
    activeSession.messages,
    activeSession.streaming,
    storesConversations,
  );

  const retry = useCallback(() => {
    const current = sessionRef.current;
    if (current.streaming || capabilities.status !== 'ready') return;
    if (!capabilities.data.available) return;
    const assistantIndex = current.messages.length - 1;
    const failed = current.messages[assistantIndex];
    if (failed === undefined || failed.role !== 'assistant') return;
    const userIndex = assistantIndex - 1;
    const user = current.messages[userIndex];
    if (user === undefined || user.role !== 'user') return;
    if (storesConversations) {
      if (!retryState(current.messages, current.streaming, true).canRetry) return;
      if (current.load.status !== 'idle') return;
      if (turnTaken(failed)) {
        // The server keeps the answer that failed, so the thread keeps it too
        // and the question is asked again below it, as a reload will show it.
        if (current.conversationId === undefined) return;
        startTurn(
          user.text,
          current.messages,
          {
            id: nextMessageId(),
            role: 'user',
            text: user.text,
            // Asked again at the level it was asked at (Normal if the site stopped offering High).
            ...(user.effort === undefined ? {} : { effort: user.effort }),
          },
          capabilities.data.limits,
          { conversationId: current.conversationId, attachmentIds: [] },
          offeredEfforts,
        );
        return;
      }
      // Refused before its stream: nothing was stored and the files are still
      // unsent, so the same question goes again in its place, with them.
      const conversationId = current.conversationId ?? randomUuid();
      if (current.conversationId === undefined) {
        commitSession({
          ...current,
          conversationId,
          title: provisionalTitle(user.text),
          provisional: true,
        });
      }
      startTurn(
        user.text,
        sessionRef.current.messages.slice(0, userIndex),
        user,
        capabilities.data.limits,
        {
          conversationId,
          attachmentIds: (user.attachments ?? []).map((attachment) => attachment.id),
        },
        offeredEfforts,
      );
      return;
    }
    if (failed.status !== 'error') return;
    startTurn(
      user.text,
      current.messages.slice(0, userIndex),
      user,
      capabilities.data.limits,
      undefined,
      offeredEfforts,
    );
  }, [capabilities, commitSession, offeredEfforts, startTurn, storesConversations]);

  const updateAction = useCallback(
    (messageId: string, actionId: string, change: Partial<AiActionView>) => {
      const current = sessionRef.current;
      commitSession({
        ...current,
        messages: current.messages.map((message) =>
          message.id !== messageId || message.role !== 'assistant'
            ? message
            : {
                ...message,
                actions: message.actions?.map((action) =>
                  action.proposal.id === actionId ? { ...action, ...change } : action,
                ),
              },
        ),
      });
    },
    [commitSession],
  );

  const updateAutomationCard = useCallback(
    (messageId: string, proposalId: string, change: Partial<AutomationCardState>) => {
      const current = sessionRef.current;
      commitSession({
        ...current,
        messages: current.messages.map((message) => {
          if (message.id !== messageId || message.role !== 'assistant') return message;
          const initial = message.automationProposals?.find((p) => p.id === proposalId);
          if (!initial) return message;
          const card = message.automationCards?.[proposalId] ?? {
            proposal: initial,
            draft: initial.draft,
          };
          return {
            ...message,
            automationCards: { ...message.automationCards, [proposalId]: { ...card, ...change } },
          };
        }),
      });
    },
    [commitSession],
  );

  const reviseAction = useCallback(
    (messageId: string, actionId: string, draft: AiCardDraft) => {
      const current = sessionRef.current;
      if (current.streaming) return;
      const message = current.messages.find((m) => m.id === messageId);
      const action =
        message?.role === 'assistant'
          ? message.actions?.find((a) => a.proposal.id === actionId)
          : undefined;
      if (!action || action.status !== 'pending') return;
      const activeKey = sessionKey;
      updateAction(messageId, actionId, { status: 'revising', error: undefined });
      // A backend that lists `cardActions` answers a revision in full when asked.
      const wide = capabilities.status === 'ready' && capabilities.data.cardActions !== undefined;
      // The flag goes only to a backend that takes it, so an older one is asked as before.
      const revision = wide
        ? reviseAiAction(accessToken, workspace.id, action.proposal.token, draft, true)
        : reviseAiAction(accessToken, workspace.id, action.proposal.token, draft);
      void revision.then(
        (proposal) => {
          if (sessionRef.current.key !== activeKey) return;
          updateAction(messageId, actionId, { proposal, status: 'pending', error: undefined });
        },
        (error: unknown) => {
          if (
            sessionRef.current.key !== activeKey ||
            !sessionRef.current.messages.some((m) => m.id === messageId)
          )
            return;
          if (isAccessLoss(error)) {
            clearPrivateRef.current();
            setCapabilitiesState(failedCapabilities(sessionKey, capabilityFailureOf(error), error));
            return;
          }
          if (isCardNotPermitted(error)) {
            updateAction(messageId, actionId, {
              status: 'refused',
              error: CARD_NOT_PERMITTED_TEXT,
            });
            return;
          }
          updateAction(messageId, actionId, {
            status: 'pending',
            error: `${describeError(error, 'update the draft')} The original draft is shown; nothing was saved.`,
          });
        },
      );
    },
    [accessToken, workspace.id, sessionKey, updateAction, capabilities],
  );

  const confirmAction = useCallback(
    (messageId: string, actionId: string, acknowledged = false) => {
      const current = sessionRef.current;
      if (current.streaming) return;
      const message = current.messages.find((m) => m.id === messageId);
      const action =
        message?.role === 'assistant'
          ? message.actions?.find((a) => a.proposal.id === actionId)
          : undefined;
      if (!action || !['pending', 'error'].includes(action.status)) return;
      const activeKey = sessionKey;
      updateAction(messageId, actionId, { status: 'saving', error: undefined });
      const confirmation = acknowledged
        ? confirmAiAction(accessToken, workspace.id, action.proposal.token, true)
        : confirmAiAction(accessToken, workspace.id, action.proposal.token);
      void confirmation.then(
        (receipt) => {
          if (sessionRef.current.key !== activeKey) return;
          if (receipt.actionId !== actionId || receipt.kind !== action.proposal.draft.kind) {
            updateAction(messageId, actionId, {
              status: 'error',
              error: 'Could not verify this save. Check the lead before trying again.',
            });
            return;
          }
          // The Tasks page and the lead page refresh; a plain task names no lead.
          const draft = action.proposal.draft;
          notifyLeadWorkSaved(
            workspace.id,
            draft.kind === 'task_update'
              ? (action.proposal.taskUpdateContext?.leadId ?? null)
              : draft.kind === 'automation_off'
                ? null
                : (draft.leadId ?? null),
          );
          if (sessionRef.current.messages.some((m) => m.id === messageId))
            updateAction(messageId, actionId, { status: 'saved' });
        },
        (error: unknown) => {
          if (
            sessionRef.current.key !== activeKey ||
            !sessionRef.current.messages.some((m) => m.id === messageId)
          )
            return;
          if (isAccessLoss(error)) {
            clearPrivateRef.current();
            setCapabilitiesState(failedCapabilities(sessionKey, capabilityFailureOf(error), error));
            return;
          }
          if (isFinalCardRefusal(error) && error instanceof BackendError) {
            updateAction(messageId, actionId, {
              status: 'refused',
              error: isCardNotPermitted(error)
                ? CARD_NOT_PERMITTED_TEXT
                : (cardRefusalText(error) ?? CARD_NOT_PERMITTED_TEXT),
            });
            return;
          }
          const gate =
            error instanceof BackendError
              ? error.code === 'conflict' && error.details?.['reason'] === 'superseded'
                ? 'Not saved: another version of this draft was already saved. Check the lead.'
                : (cardRefusalText(error) ?? leadUpdateRefusalText(error))
              : undefined;
          updateAction(messageId, actionId, {
            status: 'error',
            error: gate
              ? gate
              : error instanceof BackendError && error.code === 'conflict'
                ? action.proposal.draft.kind === 'lead_update'
                  ? 'The lead changed or this update needs additional details. Check the lead page and request a fresh draft.'
                  : action.proposal.draft.kind === 'task_update'
                    ? 'The task changed since this draft. Check the Tasks page and request a fresh draft.'
                    : action.proposal.draft.kind === 'email' ||
                        action.proposal.draft.kind === 'template_email'
                      ? 'The email recipient or sender changed. Check the lead and ask for a fresh draft before sending.'
                      : 'Not saved: this changed since the card was prepared. Check it and ask for a fresh draft.'
                : error instanceof BackendError && error.code === 'plain_tasks_unavailable'
                  ? 'Tasks without a lead are not switched on for this site yet. Ask for the task on a lead.'
                  : error instanceof BackendError && error.code === 'feature_not_ready'
                    ? 'Email is not ready. Check this Site’s email settings and the customer address on the lead.'
                    : error instanceof BackendError &&
                        [
                          'invalid_request',
                          'lead_not_found',
                          'lead_trashed',
                          'task_not_found',
                          'ai_unavailable',
                        ].includes(error.code)
                      ? 'This draft expired or is no longer available. Check the lead before asking for a new draft.'
                      : 'Could not confirm the save. Retry this same card to avoid a duplicate.',
          });
        },
      );
    },
    [accessToken, workspace.id, sessionKey, updateAction],
  );

  const cancelAction = useCallback(
    (messageId: string, actionId: string) => {
      const message = sessionRef.current.messages.find((m) => m.id === messageId);
      const action =
        message?.role === 'assistant'
          ? message.actions?.find((a) => a.proposal.id === actionId)
          : undefined;
      if (action && ['pending', 'error'].includes(action.status))
        updateAction(messageId, actionId, {
          status: 'cancelled',
          error:
            action.status === 'error'
              ? 'Dismissed. Check the lead if a save was already attempted.'
              : undefined,
        });
    },
    [updateAction],
  );

  const dismissNotice = useCallback(() => {
    commitList((current) => ({ ...current, notice: undefined }));
  }, [commitList]);

  const conversations = useMemo<AssistantConversations>(
    () => ({
      enabled: storesConversations,
      // A new chat's own id is not a conversation until the server takes its first turn.
      ...(activeSession.conversationId === undefined || activeSession.provisional === true
        ? {}
        : { activeId: activeSession.conversationId }),
      ...(activeSession.title === undefined ? {} : { title: activeSession.title }),
      load: activeSession.load,
      list,
      open: openConversation,
      reload: reloadConversation,
      loadList,
      setSearch,
      loadMore,
      rename: renameConversation,
      remove: removeConversation,
      dismissNotice,
    }),
    [
      activeSession.conversationId,
      activeSession.provisional,
      activeSession.load,
      activeSession.title,
      dismissNotice,
      list,
      loadList,
      loadMore,
      setSearch,
      openConversation,
      reloadConversation,
      removeConversation,
      renameConversation,
      storesConversations,
    ],
  );

  const attachments = useMemo<AssistantAttachments>(
    () => ({
      ...(attachmentSettings === undefined ? {} : { settings: attachmentSettings }),
      pending: pendingAttachments,
      ...(attachmentNotice === undefined ? {} : { notice: attachmentNotice }),
      uploading: pendingAttachments.some((item) => item.status === 'uploading'),
      add: addAttachments,
      remove: removeAttachment,
    }),
    [addAttachments, attachmentNotice, attachmentSettings, pendingAttachments, removeAttachment],
  );

  const effort = useMemo<AssistantEffort>(
    () => ({ offered: highOffered, value: effortChoice, set: setEffortChoice }),
    [effortChoice, highOffered],
  );

  const model = useMemo<AssistantModel>(
    () => ({
      offered: offeredModels.length > 1 && defaultModel !== undefined,
      options: offeredModels,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      value: modelChoice,
      set: setStoredModel,
    }),
    [defaultModel, modelChoice, offeredModels, setStoredModel],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({
      workspaceSlug: workspace.slug,
      effort,
      model,
      automationApi: {
        save: (token) => saveAiAutomation(accessToken, workspace.id, token),
        revise: (token, draft) => reviseAiAutomation(accessToken, workspace.id, token, draft),
        simulate: (body) => simulateAiAutomation(accessToken, workspace.id, body),
      },
      capabilities,
      messages: activeSession.messages,
      streaming: activeSession.streaming,
      isOpen,
      ...(contextLeadId === undefined ? {} : { activeLeadId: contextLeadId }),
      historyTrimmed,
      removeLeadContext: () => setRemovedLead(activeLeadId),
      siteName: capabilities.status === 'ready' ? capabilities.data.site.name : workspace.name,
      maxMessageChars:
        capabilities.status === 'ready'
          ? Math.min(capabilities.data.limits.maxMessageChars, AI_ASSISTANT_LIMITS.maxMessageChars)
          : AI_ASSISTANT_LIMITS.maxMessageChars,
      open,
      close,
      newChat,
      send,
      stop,
      retry,
      canRetry,
      conversationFull,
      reloadCapabilities,
      ...(retryNote === undefined ? {} : { retryNote }),
      updateAutomationCard,
      reviseAction,
      confirmAction,
      cancelAction,
      conversations,
      attachments,
      attachmentLinks: linkCache,
      chatPageOpen: chatPages > 0,
      registerChatPage,
      handOffToChatPage,
    }),
    [
      updateAutomationCard,
      effort,
      model,
      activeLeadId,
      contextLeadId,
      historyTrimmed,
      activeSession,
      attachments,
      canRetry,
      conversationFull,
      reloadCapabilities,
      retryNote,
      capabilities,
      chatPages,
      close,
      conversations,
      handOffToChatPage,
      isOpen,
      linkCache,
      newChat,
      open,
      registerChatPage,
      retry,
      reviseAction,
      confirmAction,
      cancelAction,
      send,
      stop,
      workspace.name,
      workspace.id,
      workspace.slug,
      accessToken,
    ],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('useAssistant must be used inside AssistantProvider');
  return value;
}

export function useOptionalAssistant(): AssistantContextValue | undefined {
  return useContext(AssistantContext);
}
