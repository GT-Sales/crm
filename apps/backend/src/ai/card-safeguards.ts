import { createHash } from 'node:crypto';
import {
  AI_CARD_KINDS,
  AI_CARD_LIMITS,
  aiActionProposalSchema,
  leadTypeLabel,
  type AiActionCard,
  type AiActionProposal,
  type AiCardKind,
} from '@gt-sales/contracts';
import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';

import {
  decideAccess,
  type StaffAction,
  type StaffAccessSnapshot,
} from '../staff/authorization.js';
import type { Scope } from '../tenant-scope.js';

/**
 * C1: the staff actions each card kind needs, the same ones its staff route
 * checks (`lead.manage` for every lead and task write, `integration.manage`
 * for an automation's switch). Capabilities, the prepare tools (a tool is not
 * offered without them), revise and confirm all read this one table.
 */
export const AI_CARD_ACTIONS: Readonly<Record<AiCardKind, readonly StaffAction[]>> = {
  note: ['workspace.read', 'lead.manage'],
  task: ['workspace.read', 'lead.manage'],
  email: ['workspace.read', 'lead.manage'],
  lead_update: ['workspace.read', 'lead.manage'],
  task_update: ['workspace.read', 'lead.manage'],
  lead_edit: ['workspace.read', 'lead.manage'],
  template_email: ['workspace.read', 'lead.manage'],
  lead_archive: ['workspace.read', 'lead.manage'],
  automation_off: ['workspace.read', 'integration.manage'],
};

/** Where a kind is offered at all, beside the member's actions: an automation card only on an automation site. */
export interface CardSite {
  /** The site is in `AI_AUTOMATION_WORKSPACE_IDS` (automation tools are allowed there). */
  readonly automations: boolean;
}

/** Whether this member may prepare, revise and confirm a card of `kind` here, decided now. */
export function cardAllowed(
  access: StaffAccessSnapshot | undefined,
  kind: AiCardKind,
  site: CardSite,
): boolean {
  if (kind === 'automation_off' && !site.automations) return false;
  return AI_CARD_ACTIONS[kind].every((action) => decideAccess(access, action).allowed);
}

/** Every kind this member may use here, in `AI_CARD_KINDS` order. */
export function cardKindsFor(
  access: StaffAccessSnapshot | undefined,
  site: CardSite,
): AiCardKind[] {
  return AI_CARD_KINDS.filter((kind) => cardAllowed(access, kind, site));
}

/**
 * B5: a card's lead label, "‹name› (‹type›, created ‹date›)", led by the
 * lead's reference when it has one. A reference is set by the site's own
 * server (the order counter or the website's backend through its site key),
 * never typed by the customer; the name is the customer's, so it is cut short
 * enough that the server's part always shows, and never stands alone.
 */
export function cardLeadLabel(lead: {
  readonly leadType: string;
  readonly reference: string | null;
  readonly name: string | null;
  readonly createdAt?: Date | undefined;
}): string {
  const name = (lead.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Unnamed lead';
  const created = lead.createdAt ? `, created ${lead.createdAt.toISOString().slice(0, 10)}` : '';
  const reference = lead.reference?.trim().slice(0, 40);
  return `${reference ? `${reference} · ` : ''}${name} (${leadTypeLabel(lead.leadType)}${created})`.slice(
    0,
    160,
  );
}

/** A lead the model read in this turn, as B1 compares a body with it. */
export interface SeenLead {
  readonly leadId: string;
  readonly name: string | null;
  readonly reference: string | null;
}

/** The most leads one turn remembers for B1; a page of reads stays far below it. */
export const MAX_SEEN_LEADS = 200;

/**
 * The leads a tool result names: every object in it with a `leadId` and a
 * `name`/`reference` (a lead) or `leadName`/`leadReference` (a task's lead).
 * Read from the result the model was given, so whatever a read returns is
 * covered without each tool reporting it.
 */
export function leadsInToolResult(result: string): SeenLead[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }
  const found: SeenLead[] = [];
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || found.length >= MAX_SEEN_LEADS) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    const leadId = record['leadId'];
    if (typeof leadId === 'string') {
      const name = text(record['name']) ?? text(record['leadName']);
      const reference = text(record['reference']) ?? text(record['leadReference']);
      if (name !== null || reference !== null) found.push({ leadId, name, reference });
    }
    for (const entry of Object.values(record)) walk(entry, depth + 1);
  };
  walk(parsed, 0);
  return found;
}

/**
 * The leads of one turn, kept as the read tools answer: each lead under every
 * name and reference it was seen with (what a result said, which a read may
 * have shortened, and the lead's real name and reference from the server's
 * own labels), so the B1 check compares a body with the real values.
 */
export class SeenLeads {
  private readonly byId = new Map<string, SeenLead[]>();

  private variants(leadId: string): SeenLead[] | undefined {
    const known = this.byId.get(leadId);
    if (known) return known;
    if (this.byId.size >= MAX_SEEN_LEADS) return undefined;
    const created: SeenLead[] = [];
    this.byId.set(leadId, created);
    return created;
  }

  private push(lead: SeenLead): void {
    if (lead.name === null && lead.reference === null) return;
    const variants = this.variants(lead.leadId);
    if (!variants) return;
    if (variants.some((entry) => entry.name === lead.name && entry.reference === lead.reference))
      return;
    variants.push(lead);
  }

  record(result: string): void {
    for (const lead of leadsInToolResult(result)) this.push(lead);
  }

  add(lead: SeenLead): void {
    this.push(lead);
  }

  /** A lead a read named in some other way (its source card): its labels are looked up. */
  addId(leadId: string): void {
    this.variants(leadId);
  }

  /** The leads' real names and references, from the server's lead labels. */
  addLabels(
    labels: ReadonlyMap<
      string,
      { readonly name: string | null; readonly reference: string | null }
    >,
  ): void {
    for (const [leadId, label] of labels)
      this.push({ leadId, name: label.name, reference: label.reference });
  }

  /** Every lead id seen this turn, first seen first. */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  list(): SeenLead[] {
    return [...this.byId.entries()].flatMap(([leadId, variants]) =>
      variants.length > 0 ? variants : [{ leadId, name: null, reference: null }],
    );
  }
}

/**
 * Control, format and separator characters, as `inertRecordText` (the reads'
 * cleaning) treats them. A body is compared with them read as spaces and with
 * them removed, so neither a zero-width joiner inside a name nor a bidi mark
 * inside a reference hides a mention.
 */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * The characters that end a word in both readings: line breaks, tabs and the
 * other spacing controls, and the line and paragraph separators. Removing one
 * would glue two words together (T5: the subject's last word and the body's
 * first), so they are always read as a space.
 */
const SEPARATING_CHARACTERS = /[\t\n\v\f\r\u0085\p{Zl}\p{Zp}]/gu;

/**
 * Letters of other scripts that read as Latin ones (lower case, after the
 * case fold): the common Cyrillic and Greek look-alikes and a few Latin
 * variants NFKC keeps. A body written with one still names the lead.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  һ: 'h',
  н: 'h',
  і: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  о: 'o',
  р: 'p',
  ԁ: 'd',
  с: 'c',
  ѕ: 's',
  т: 't',
  у: 'y',
  х: 'x',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'h',
  ι: 'i',
  κ: 'k',
  μ: 'm',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ζ: 'z',
  ı: 'i',
  ɑ: 'a',
  ɡ: 'g',
};

/**
 * The words of `value` as the check compares them: Unicode compatibility
 * forms folded (NFKC: full-width letters, a non-breaking space), hidden
 * characters read as `hidden`, lower case, accents and look-alike letters
 * folded, then split on everything that is not a letter or a digit, so every
 * dash, space and punctuation mark separates words alike.
 */
function wordsOf(value: string, hidden: ' ' | ''): string[] {
  const folded = value
    .normalize('NFKC')
    .replace(SEPARATING_CHARACTERS, ' ')
    .replace(HIDDEN_CHARACTERS, hidden)
    .toLocaleLowerCase('en-CA')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{L}/gu, (letter) => LOOK_ALIKES[letter] ?? letter);
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A reference read with only its letters and digits: "MS-9001", "MS 9001" and "ms9001" alike. */
function referenceMentioned(words: readonly string[], reference: string): boolean {
  if (reference.length < 3) return false;
  for (let start = 0; start < words.length; start += 1) {
    let joined = '';
    for (let at = start; at < words.length && joined.length < reference.length; at += 1) {
      joined += words[at];
      if (!reference.startsWith(joined)) break;
      if (joined === reference) return true;
    }
  }
  return false;
}

/** How many words apart a given name and a surname may stand ("Example, Robin", "Robin J. Example"). */
const NAME_PROXIMITY = 2;

/**
 * A name as whole words: all of it in order, or its given name and surname
 * (the first and last word, three characters or more each) within
 * `NAME_PROXIMITY` words of each other in either order. One common word alone
 * never matches a longer name.
 */
function nameMentioned(words: readonly string[], name: readonly string[]): boolean {
  if (name.length === 0 || name.join(' ').length < 3) return false;
  for (let start = 0; start + name.length <= words.length; start += 1)
    if (name.every((word, offset) => words[start + offset] === word)) return true;
  const given = name[0];
  const surname = name.at(-1);
  if (name.length < 2 || !given || !surname || given.length < 3 || surname.length < 3) return false;
  for (let at = 0; at < words.length; at += 1) {
    if (words[at] !== given) continue;
    for (let near = Math.max(0, at - NAME_PROXIMITY); near <= at + NAME_PROXIMITY; near += 1)
      if (near !== at && words[near] === surname) return true;
  }
  return false;
}

/** An email's subject and body as the check reads them: a line break that survives either reading between them (T5). */
export function emailMentionText(subject: string, body: string): string {
  return `${subject}\n\n${body}`;
}

/**
 * B1: the names and references of other leads that `body` mentions, and the
 * ids of those leads. A lead of the card's own (`ownLeadId`), or one with the
 * card lead's own name (the same person's other request), is not "another
 * customer". A name or reference under three characters is too common to tell
 * apart and is left out.
 */
export function mentionedLeads(
  body: string,
  others: readonly SeenLead[],
  own: { leadId: string | undefined; name: string | null },
): { names: string[]; leadIds: string[] } {
  const texts = [wordsOf(body, ' '), wordsOf(body, '')];
  const ownName = own.name ? wordsOf(own.name, ' ').join(' ') : undefined;
  const names = new Set<string>();
  const leadIds = new Set<string>();
  for (const lead of others) {
    if (lead.leadId === own.leadId) continue;
    const found: string[] = [];
    if (lead.reference !== null) {
      const reference = lead.reference;
      const needles = new Set([wordsOf(reference, ' ').join(''), wordsOf(reference, '').join('')]);
      if ([...needles].some((needle) => texts.some((words) => referenceMentioned(words, needle))))
        found.push(reference);
    }
    if (lead.name !== null) {
      const variants = [wordsOf(lead.name, ' '), wordsOf(lead.name, '')].filter(
        (words) => words.join(' ') !== ownName,
      );
      if (variants.some((name) => texts.some((words) => nameMentioned(words, name))))
        found.push(lead.name);
    }
    if (found.length === 0) continue;
    leadIds.add(lead.leadId);
    for (const value of found)
      if (names.size < AI_CARD_LIMITS.maxMentionNames)
        names.add(
          value
            .normalize('NFKC')
            .replace(HIDDEN_CHARACTERS, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160),
        );
  }
  return { names: [...names], leadIds: [...leadIds] };
}

/** B1: the names and references of other leads that `body` mentions (`mentionedLeads`). */
export function mentionedOtherLeads(
  body: string,
  others: readonly SeenLead[],
  own: { leadId: string | undefined; name: string | null },
): string[] {
  return mentionedLeads(body, others, own).names;
}

/** C3: the digest of a card's side effects, signed at prepare and compared at confirm. */
export function sideEffectsDigest(effects: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(effects)).digest('hex');
}

/**
 * The card in the older proposal's shape, for the `actions` part and an
 * older admin's revision, or undefined when an older admin cannot show it
 * (a new kind, or a widened draft: a task assigned to a member, a task edit
 * beyond its status). The extras are left out; a card whose confirmation
 * needs the acknowledgement tick is not offered there, since that admin
 * cannot send it.
 */
export function legacyProposalOf(card: AiActionCard): AiActionProposal | undefined {
  if (card.acknowledgementRequired === true) return undefined;
  const parsed = aiActionProposalSchema.safeParse({
    id: card.id,
    token: card.token,
    expiresAt: card.expiresAt,
    ...(card.leadUpdateContext ? { leadUpdateContext: card.leadUpdateContext } : {}),
    ...(card.taskUpdateContext ? { taskUpdateContext: card.taskUpdateContext } : {}),
    ...(card.emailContext ? { emailContext: card.emailContext } : {}),
    siteName: card.siteName,
    ...(card.leadLabel ? { leadLabel: card.leadLabel } : {}),
    ...(card.leadHref ? { leadHref: card.leadHref } : {}),
    draft: card.draft,
  });
  return parsed.success ? parsed.data : undefined;
}

/** What a kind counts against at confirm (C7): every change, and mail its own lower cap too. */
export function isMailCard(kind: AiCardKind): boolean {
  return kind === 'email' || kind === 'template_email';
}

/** Why a daily cap refused a confirmation, for `details.reason`. */
export type DailyCapRefusal = 'daily_changes' | 'daily_mail';

/**
 * C7: counts one confirmation against the member's daily caps on this site,
 * through the shared limiter (`app.rate_limit_hit`). Answers the cap that
 * refused it, or undefined when it may go ahead. A limiter that cannot be
 * reached throws, and the caller refuses the confirmation (fail closed).
 * A retry of a saved card counts again: the limiter cannot know it is one.
 *
 * Mail asks its own, lower cap first, so a mail that cap refuses is not
 * counted as a change (T10). The other way round cannot be told apart: a mail
 * counted before the changes cap refuses it is past that cap anyway, and both
 * caps are UTC days, so they open again at the same moment.
 */
export async function dailyCapRefusal(
  rateLimit: (input: RateLimitInput) => Promise<RateLimitResult>,
  scope: Scope,
  kind: AiCardKind,
): Promise<{ reason: DailyCapRefusal; retryAfterSeconds: number } | undefined> {
  const day = 24 * 60 * 60;
  if (isMailCard(kind)) {
    const mail = await rateLimit({
      bucketKey: `ai_mail_day:${scope.actorId}:${scope.workspaceId}`,
      windowSeconds: day,
      maxCount: AI_CARD_LIMITS.mailPerMemberPerDay,
    });
    if (!mail.allowed) return { reason: 'daily_mail', retryAfterSeconds: mail.retryAfterSeconds };
  }
  const changes = await rateLimit({
    bucketKey: `ai_card_day:${scope.actorId}:${scope.workspaceId}`,
    windowSeconds: day,
    maxCount: AI_CARD_LIMITS.changesPerMemberPerDay,
  });
  if (!changes.allowed)
    return { reason: 'daily_changes', retryAfterSeconds: changes.retryAfterSeconds };
  return undefined;
}
