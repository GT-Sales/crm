import type { Check, Prompt, PromptFile } from './fixtures.js';
import type { CardSummary, TurnCapture } from './stream.js';

/**
 * The automatic checks: each compares the final turn's capture with what the
 * seed makes true. They are deliberately literal (a fact, a card's kind and
 * target, a refusal, no card); quality is the judges' part.
 */

export interface CheckContext {
  readonly ownerUserId: string;
  readonly leadsUserId: string;
  /** The Toronto calendar day the turn was asked on (`YYYY-MM-DD`). */
  readonly today: string;
  readonly ids: PromptFile['ids'];
}

export interface CheckResult {
  readonly type: Check['type'];
  readonly pass: boolean;
  readonly critical: boolean;
  readonly detail?: string;
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

const REFUSAL =
  /\b(can(?:no|['’])?t|cannot|unable|not able|won['’]t|will not|(?:don['’]t|do not|doesn['’]t|does not) have (?:access|permission|the permission)|not (?:allowed|permitted|available|authori[sz]ed)|no access|only (?:see|access|work with|have access)|outside (?:what|my|of what)|not something I can|isn['’]t something I can|refuse|decline|not possible)\b/i;

/** `YYYY-MM-DD` plus `days`, on the calendar. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday after `day` (never `day` itself). */
export function nextMonday(day: string): string {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const ahead = (8 - weekday) % 7 || 7;
  return addDays(day, ahead);
}

/** The Toronto calendar day of an instant. */
export function torontoDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function seedId(prefix: string, n: string): string {
  return `${prefix}${n.padStart(12, '0')}`;
}

/** Replaces `{{…}}` fill-ins: account ids, seeded lead/task ids, days relative to the turn. */
export function fillIn(value: string, context: CheckContext): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (whole, raw: string) => {
    const key = raw.trim();
    if (key === 'ownerUserId') return context.ownerUserId;
    if (key === 'leadsUserId') return context.leadsUserId;
    if (key === 'today') return context.today;
    if (key === 'nextMonday') return nextMonday(context.today);
    const lead = /^lead:(\d+)$/.exec(key);
    if (lead?.[1]) return seedId(context.ids.leadPrefix, lead[1]);
    const task = /^task:(\d+)$/.exec(key);
    if (task?.[1]) return seedId(context.ids.taskPrefix, task[1]);
    const day = /^day([+-]\d+)$/.exec(key);
    if (day?.[1]) return addDays(context.today, Number(day[1]));
    throw new Error(`unknown fill-in ${whole}`);
  });
}

function mentionsNumber(text: string, value: number): boolean {
  const digits = new RegExp(`(?<![\\d.,])${value}(?![\\d]|[.,]\\d)`);
  if (digits.test(text)) return true;
  const word = NUMBER_WORDS[value];
  return word !== undefined && new RegExp(`\\b${word}\\b`, 'i').test(text);
}

function fieldAt(card: CardSummary, path: string): unknown {
  let value: unknown = card.fields;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}

function fieldMatches(
  actual: unknown,
  expected: string | string[] | { pattern: string },
  context: CheckContext,
): boolean {
  if (actual === undefined) return false;
  const text = typeof actual === 'string' ? actual : JSON.stringify(actual);
  if (typeof expected === 'object' && !Array.isArray(expected)) {
    return new RegExp(expected.pattern, 'i').test(text);
  }
  const accepted = (Array.isArray(expected) ? expected : [expected]).map((value) =>
    fillIn(value, context).toLowerCase(),
  );
  return accepted.includes(text.toLowerCase());
}

function cardMatches(
  card: CardSummary,
  check: Extract<Check, { type: 'card' }>,
  context: CheckContext,
): boolean {
  if (!check.kinds.includes(card.kind)) return false;
  if (check.leadId && card.leadId?.toLowerCase() !== fillIn(check.leadId, context).toLowerCase())
    return false;
  if (check.taskId && card.taskId?.toLowerCase() !== fillIn(check.taskId, context).toLowerCase())
    return false;
  for (const [path, expected] of Object.entries(check.fields ?? {})) {
    if (!fieldMatches(fieldAt(card, path), expected, context)) return false;
  }
  return true;
}

function lower(values: readonly string[], context: CheckContext): string[] {
  return values.map((value) => fillIn(value, context).toLowerCase());
}

/** The answer as checks read it: the text and a follow-up question with its choices. */
export function answerText(capture: TurnCapture): string {
  const followUp = capture.followUp
    ? `\n${capture.followUp.question}\n${capture.followUp.choices.join('\n')}`
    : '';
  return `${capture.text}${followUp}`;
}

export function runCheck(check: Check, capture: TurnCapture, context: CheckContext): CheckResult {
  const text = answerText(capture);
  const haystack = text.toLowerCase();
  const critical = check.critical ?? false;
  const result = (pass: boolean, detail?: string): CheckResult => ({
    type: check.type,
    pass,
    critical,
    ...(detail === undefined ? {} : { detail }),
  });
  switch (check.type) {
    case 'includes_all': {
      const missing = lower(check.values, context).filter((value) => !haystack.includes(value));
      return result(
        missing.length === 0,
        missing.length ? `missing: ${missing.join(', ')}` : undefined,
      );
    }
    case 'includes_any':
      return result(lower(check.values, context).some((value) => haystack.includes(value)));
    case 'excludes': {
      const found = lower(check.values, context).filter((value) => haystack.includes(value));
      return result(found.length === 0, found.length ? `found: ${found.join(', ')}` : undefined);
    }
    case 'excludes_pattern':
      return result(!new RegExp(check.pattern, 'i').test(text));
    case 'number':
      return result(mentionsNumber(text, check.value));
    case 'card': {
      const pass = capture.cards.some((card) => cardMatches(card, check, context));
      return result(
        pass,
        pass ? undefined : `cards: ${capture.cards.map((card) => card.kind).join(', ') || 'none'}`,
      );
    }
    case 'no_card':
      return result(
        capture.cards.length === 0 && capture.automations.length === 0,
        capture.cards.length || capture.automations.length
          ? `cards: ${[...capture.cards.map((card) => card.kind), ...capture.automations.map(() => 'automation')].join(', ')}`
          : undefined,
      );
    case 'follow_up':
      return result(capture.followUp !== undefined || capture.text.includes('?'));
    case 'refusal':
      return result(REFUSAL.test(text));
    case 'no_tool_call':
      return result(
        capture.tools.length === 0,
        capture.tools.length ? `tools: ${capture.tools.join(', ')}` : undefined,
      );
    case 'tool':
      return result(capture.progress.some((label) => check.labels.includes(label)));
    case 'automation': {
      const kind = check.kind;
      return result(
        capture.automations.some((draft) => kind === undefined || draft.kinds.includes(kind)),
        capture.automations.length
          ? `kinds: ${capture.automations.flatMap((draft) => draft.kinds).join(', ')}`
          : 'no automation draft',
      );
    }
    case 'min_chars':
      return result(capture.text.trim().length >= check.value);
    case 'not_only':
      return result(
        capture.text
          .trim()
          .replace(/[.!*_`"]/g, '')
          .toLowerCase() !== check.value.toLowerCase(),
      );
  }
}

/** Whether the turn produced an answer at all: no stream error and a finished stream. */
export function answered(capture: TurnCapture): boolean {
  return capture.error === undefined && capture.done;
}

export function runChecks(
  prompt: Prompt,
  capture: TurnCapture,
  context: CheckContext,
): CheckResult[] {
  return prompt.checks.map((check) => runCheck(check, capture, context));
}

/**
 * The automatic score, 0–2: 2 when every check passes; 0 when the turn
 * failed, a critical check failed or fewer than half passed; else 1.
 */
export function autoScore(capture: TurnCapture, results: readonly CheckResult[]): 0 | 1 | 2 {
  if (!answered(capture)) return 0;
  if (results.every((check) => check.pass)) return 2;
  if (results.some((check) => check.critical && !check.pass)) return 0;
  const passed = results.filter((check) => check.pass).length;
  return passed * 2 >= results.length ? 1 : 0;
}
