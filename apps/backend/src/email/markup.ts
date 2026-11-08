import {
  PROPERTY_FILL_IN_PREFIX,
  fillInsForTemplate,
  isSiteTemplateKey,
  normalizeFillInName,
  propertyKeySchema,
  type EmailFillInKey,
  type EmailFillInName,
  type EmailTemplateKey,
} from '@gt-sales/contracts';

/**
 * The small markup a site's customer mails are written in (Settings → Email):
 * paragraphs split on blank lines, a single newline is a line break,
 * `**bold**`, `[label](https://…)` links, one `[button: Label](https://…)`
 * alone in its paragraph, and `{fill-ins}` the template may use. A link or
 * button goes to an `http(s)://` address with no braces in it, or to
 * `{tracking link}` as the whole address. A site-made (`tpl_`) template may
 * also write a property of the lead, `{prop:<key>}`. What is not markup (an unclosed
 * `**`, a `{` with no `}` on its line, brackets that are not a link) stays
 * literal text. The subject and a button's label take fill-ins only.
 *
 * A paragraph may also be one of these blocks, decided by its shape (else it
 * stays an ordinary paragraph, its markers literal):
 *
 * - `[badge: Label]` (or `[badge success: Label]`) alone on its one line: a
 *   status pill above the heading; the label takes fill-ins only.
 * - `[progress: Ordered | >Documents | Active]` alone on its one line: a
 *   progress tracker of 2 to 5 steps split on `|`. At most one step starts
 *   with `>`, the current one: the steps before it show as done, the ones
 *   after it as still to come; with no `>` every step shows as done. Labels
 *   take fill-ins only.
 * - A first line starting `# ` (or `## `): a big heading (or a small section
 *   heading). Every leading line with the same marker joins the heading; the
 *   lines after it are an ordinary paragraph below it.
 * - Two or more lines, each `**Label:** value`: a details box, one row a line.
 * - Every line starting with `>`: a highlighted box (the `>` and one space
 *   after it are dropped).
 * - A last line wrapped in backticks, `` `{SIM number}` ``, with at most one
 *   line above it: a code box, the value large, the line above its label.
 * - A first line starting `1. ` (any number up to 99, `.` or `)`): steps. A
 *   line starting with a number starts the next step, the lines after it are
 *   its words; steps in consecutive paragraphs are one list.
 *
 * Every block reads the same inline markup and fill-ins as a paragraph, and a
 * button inside one is `button_not_alone`.
 *
 * Pure: no database, no environment. The layout (`layout.ts`) renders the
 * blocks; the settings store validates a template with these parsers.
 */

/** Where a link or the button goes: a typed address, or the tracking link fill-in. */
export type EmailHref = { kind: 'url'; url: string } | { kind: 'fillIn'; key: 'tracking link' };

export type EmailInline =
  | { kind: 'text'; text: string }
  | { kind: 'fillIn'; key: EmailFillInName }
  | { kind: 'bold'; children: readonly EmailInline[] }
  | { kind: 'link'; label: readonly EmailInline[]; href: EmailHref }
  | { kind: 'break' };

/** Text and fill-ins, nothing else: a subject, or a button's label. */
export type EmailTextPart =
  { kind: 'text'; text: string } | { kind: 'fillIn'; key: EmailFillInName };

export interface EmailDetailRow {
  label: readonly EmailInline[];
  value: readonly EmailInline[];
}

export interface EmailStep {
  /** The number as written, such as `1`. */
  number: string;
  title: readonly EmailInline[];
  /** The step's words below its title; empty when it has none. */
  body: readonly EmailInline[];
}

export type EmailBlock =
  | { kind: 'paragraph'; inlines: readonly EmailInline[] }
  | { kind: 'button'; label: readonly EmailTextPart[]; href: EmailHref }
  | { kind: 'badge'; tone: 'brand' | 'success'; label: readonly EmailTextPart[] }
  | {
      kind: 'progress';
      steps: readonly (readonly EmailTextPart[])[];
      /** The index of the current step; `null` when every step is done. */
      current: number | null;
    }
  | { kind: 'heading'; level: 1 | 2; inlines: readonly EmailInline[] }
  | { kind: 'details'; rows: readonly EmailDetailRow[] }
  | { kind: 'callout'; inlines: readonly EmailInline[] }
  | { kind: 'code'; label: readonly EmailInline[] | null; value: readonly EmailInline[] }
  | { kind: 'steps'; steps: readonly EmailStep[] };

export type MarkupError =
  | { error: 'invalid_fill_in'; fillIn: string; where: 'subject' | 'body' }
  | { error: 'invalid_email_markup'; reason: 'two_buttons' | 'button_not_alone' | 'bad_link' };

type Failure = { ok: false } & MarkupError;

/** A button as the inline reader finds it, before the paragraph check places it. */
type ButtonToken = { kind: 'button'; label: EmailTextPart[]; href: EmailHref };
type Token = EmailInline | ButtonToken;

export interface MarkupOptions {
  /** Save-time check of a `{prop:…}` (true = usable in a customer email); absent at render time. */
  property?: (key: string) => boolean;
}

interface Reader {
  readonly allowed: ReadonlySet<EmailFillInKey>;
  /** Whether `{prop:<key>}` is markup here: site-made templates only. */
  readonly properties: boolean;
  readonly property: ((key: string) => boolean) | undefined;
  readonly where: 'subject' | 'body';
}

function readerFor(
  template: EmailTemplateKey,
  where: 'subject' | 'body',
  options: MarkupOptions | undefined,
): Reader {
  return {
    allowed: new Set(fillInsForTemplate(template)),
    properties: isSiteTemplateKey(template),
    property: options?.property,
    where,
  };
}

const PROPERTY_FILL_IN = /^prop:(.*)$/is;

const FILL_IN = /\{([^{}\n]*)\}/y;
const BUTTON_LABEL = /^button:(.*)$/is;
const HTTP_URL = /^https?:\/\/\S+$/i;

const markupError = (reason: 'two_buttons' | 'button_not_alone' | 'bad_link'): Failure => ({
  ok: false,
  error: 'invalid_email_markup',
  reason,
});

/** The fill-in written as `{inner}`, if the template may use it. */
function readFillIn(inner: string, reader: Reader): { ok: true; key: EmailFillInName } | Failure {
  const property = PROPERTY_FILL_IN.exec(inner.trim());
  if (property) {
    const key = (property[1] ?? '').trim();
    const usable =
      reader.properties &&
      propertyKeySchema.safeParse(key).success &&
      (reader.property === undefined || reader.property(key));
    if (!usable) {
      return { ok: false, error: 'invalid_fill_in', fillIn: inner.trim(), where: reader.where };
    }
    return { ok: true, key: `${PROPERTY_FILL_IN_PREFIX}${key}` };
  }
  const key = normalizeFillInName(inner);
  if (key === undefined || !reader.allowed.has(key)) {
    return { ok: false, error: 'invalid_fill_in', fillIn: inner.trim(), where: reader.where };
  }
  return { ok: true, key };
}

function isHttpUrl(value: string): boolean {
  if (!HTTP_URL.test(value)) return false;
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
}

function readHref(address: string, reader: Reader): { ok: true; href: EmailHref } | Failure {
  const braced = /^\{([^{}]*)\}$/.exec(address);
  if (braced) {
    const inner = braced[1] ?? '';
    if (normalizeFillInName(inner) !== 'tracking link') return markupError('bad_link');
    const fillIn = readFillIn(inner, reader);
    return fillIn.ok ? { ok: true, href: { kind: 'fillIn', key: 'tracking link' } } : fillIn;
  }
  // A typed address is sent as written: a fill-in inside it would reach the customer as braces.
  if (/[{}]/.test(address)) return markupError('bad_link');
  return isHttpUrl(address)
    ? { ok: true, href: { kind: 'url', url: address } }
    : markupError('bad_link');
}

/**
 * `[label](address)` starting at `start`, on one line: a label with no
 * brackets, then an address up to its matching `)` (balanced parentheses, so
 * `javascript:alert(1)` is one address). `undefined` when it is not a link.
 */
function matchBracket(
  source: string,
  start: number,
): { label: string; address: string; end: number } | undefined {
  let index = start + 1;
  while (index < source.length && !'[]\n'.includes(source.charAt(index))) index += 1;
  if (source.charAt(index) !== ']' || index === start + 1 || source.charAt(index + 1) !== '(') {
    return undefined;
  }
  const label = source.slice(start + 1, index);
  const addressStart = index + 2;
  let depth = 0;
  for (let cursor = addressStart; cursor < source.length; cursor += 1) {
    const char = source.charAt(cursor);
    if (char === '\n') return undefined;
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) {
        return { label, address: source.slice(addressStart, cursor), end: cursor + 1 };
      }
      depth -= 1;
    }
  }
  return undefined;
}

/** Text and fill-ins only (a subject, a button's label): any other markup stays literal. */
function readTextParts(
  source: string,
  reader: Reader,
): { ok: true; parts: EmailTextPart[] } | Failure {
  const parts: EmailTextPart[] = [];
  let text = '';
  let index = 0;
  while (index < source.length) {
    FILL_IN.lastIndex = index;
    const match = source.charAt(index) === '{' ? FILL_IN.exec(source) : null;
    if (match) {
      const fillIn = readFillIn(match[1] ?? '', reader);
      if (!fillIn.ok) return fillIn;
      if (text !== '') parts.push({ kind: 'text', text });
      text = '';
      parts.push({ kind: 'fillIn', key: fillIn.key });
      index += match[0].length;
      continue;
    }
    text += source.charAt(index);
    index += 1;
  }
  if (text !== '') parts.push({ kind: 'text', text });
  return { ok: true, parts };
}

function isInline(token: Token): token is EmailInline {
  return token.kind !== 'button';
}

/** Reads the inline markup of `source`: text, breaks, bold, links, buttons and fill-ins. */
function readInlines(
  source: string,
  reader: Reader,
  inside: { bold: boolean; link: boolean },
): { ok: true; tokens: Token[] } | Failure {
  const tokens: Token[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
  };

  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '\n') {
      flush();
      tokens.push({ kind: 'break' });
      index += 1;
      continue;
    }

    if (char === '*' && source.startsWith('**', index) && !inside.bold) {
      const close = source.indexOf('**', index + 2);
      const lineEnd = source.indexOf('\n', index);
      if (close > index + 2 && (lineEnd === -1 || close < lineEnd)) {
        const inner = readInlines(source.slice(index + 2, close), reader, {
          ...inside,
          bold: true,
        });
        if (!inner.ok) return inner;
        const children = inner.tokens.filter(isInline);
        if (children.length !== inner.tokens.length) return markupError('button_not_alone');
        flush();
        tokens.push({ kind: 'bold', children });
        index = close + 2;
        continue;
      }
      text += '**';
      index += 2;
      continue;
    }

    if (char === '[' && !inside.link) {
      const bracket = matchBracket(source, index);
      if (bracket) {
        const buttonLabel = BUTTON_LABEL.exec(bracket.label)?.[1]?.trim() ?? '';
        const label =
          buttonLabel === ''
            ? readInlines(bracket.label, reader, { ...inside, link: true })
            : readTextParts(buttonLabel, reader);
        if (!label.ok) return label;
        const href = readHref(bracket.address, reader);
        if (!href.ok) return href;
        flush();
        tokens.push(
          'tokens' in label
            ? { kind: 'link', label: label.tokens.filter(isInline), href: href.href }
            : { kind: 'button', label: label.parts, href: href.href },
        );
        index = bracket.end;
        continue;
      }
    }

    if (char === '{') {
      FILL_IN.lastIndex = index;
      const match = FILL_IN.exec(source);
      if (match) {
        const fillIn = readFillIn(match[1] ?? '', reader);
        if (!fillIn.ok) return fillIn;
        flush();
        tokens.push({ kind: 'fillIn', key: fillIn.key });
        index += match[0].length;
        continue;
      }
    }

    text += char;
    index += 1;
  }
  flush();
  return { ok: true, tokens };
}

/** The paragraphs of `body`: split on blank lines, each line trimmed, empty ones dropped. */
function paragraphsOf(body: string): string[] {
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .trim(),
    )
    .filter((paragraph) => paragraph !== '');
}

/** Inline markup that may not hold a button: a block's text. */
function readBlockInlines(
  source: string,
  reader: Reader,
): { ok: true; inlines: EmailInline[] } | Failure {
  const read = readInlines(source, reader, { bold: false, link: false });
  if (!read.ok) return read;
  const inlines = read.tokens.filter(isInline);
  return inlines.length === read.tokens.length
    ? { ok: true, inlines }
    : markupError('button_not_alone');
}

const BADGE = /^\[badge( success)?:([^[\]\n]*)\]$/i;
const PROGRESS = /^\[progress:([^[\]\n]*)\]$/i;
const PROGRESS_MAX_STEPS = 5;
const HEADING = /^(#{1,2}) (.*)$/;
const CODE_LINE = /^`([^`]+)`$/;
const STEP_LINE = /^(\d{1,2})[.)] (.*)$/;

/** Splits inlines at their line breaks. */
function linesOf(inlines: readonly EmailInline[]): EmailInline[][] {
  const lines: EmailInline[][] = [[]];
  for (const inline of inlines) {
    if (inline.kind === 'break') lines.push([]);
    else lines[lines.length - 1]?.push(inline);
  }
  return lines;
}

/** `**Label:** value` as one row, else `undefined`. */
function detailRow(line: readonly EmailInline[]): EmailDetailRow | undefined {
  const [first, ...rest] = line;
  if (first?.kind !== 'bold') return undefined;
  const last = first.children[first.children.length - 1];
  if (last?.kind !== 'text' || !last.text.trimEnd().endsWith(':')) return undefined;
  const lastText = last.text.trimEnd().slice(0, -1).trimEnd();
  const label: EmailInline[] = [
    ...first.children.slice(0, -1),
    ...(lastText === '' ? [] : [{ kind: 'text' as const, text: lastText }]),
  ];
  if (label.length === 0) return undefined;
  const value = rest.map((inline, index) =>
    index === 0 && inline.kind === 'text'
      ? { kind: 'text' as const, text: inline.text.trimStart() }
      : inline,
  );
  const filled = value.filter((inline) => inline.kind !== 'text' || inline.text !== '');
  return filled.length === 0 ? undefined : { label, value: filled };
}

type ParagraphBlocks = { ok: true; blocks: EmailBlock[] } | Failure;

/** The blocks one paragraph makes, or `undefined` when it is not one of the shaped blocks. */
function readShapedParagraph(paragraph: string, reader: Reader): ParagraphBlocks | undefined {
  const lines = paragraph.split('\n');
  const [firstLine = ''] = lines;

  const badge = lines.length === 1 ? BADGE.exec(firstLine) : null;
  const badgeLabel = badge?.[2]?.trim() ?? '';
  if (badge && badgeLabel !== '') {
    const label = readTextParts(badgeLabel, reader);
    if (!label.ok) return label;
    return {
      ok: true,
      blocks: [{ kind: 'badge', tone: badge[1] ? 'success' : 'brand', label: label.parts }],
    };
  }

  const progress = lines.length === 1 ? PROGRESS.exec(firstLine) : null;
  if (progress) {
    const raw = (progress[1] ?? '').split('|').map((step) => step.trim());
    const marked = raw.flatMap((step, index) => (step.startsWith('>') ? [index] : []));
    const labels = raw.map((step) => step.replace(/^>\s*/, ''));
    if (
      raw.length >= 2 &&
      raw.length <= PROGRESS_MAX_STEPS &&
      marked.length <= 1 &&
      labels.every((label) => label !== '')
    ) {
      const steps: EmailTextPart[][] = [];
      for (const label of labels) {
        const parts = readTextParts(label, reader);
        if (!parts.ok) return parts;
        steps.push(parts.parts);
      }
      return { ok: true, blocks: [{ kind: 'progress', steps, current: marked[0] ?? null }] };
    }
  }

  const heading = HEADING.exec(firstLine);
  if (heading && (heading[2] ?? '').trim() !== '') {
    const marker = heading[1] ?? '#';
    const headingLines: string[] = [];
    let index = 0;
    for (; index < lines.length; index += 1) {
      const match = HEADING.exec(lines[index] ?? '');
      if (!match || match[1] !== marker || (match[2] ?? '').trim() === '') break;
      headingLines.push((match[2] ?? '').trim());
    }
    const title = readBlockInlines(headingLines.join('\n'), reader);
    if (!title.ok) return title;
    const blocks: EmailBlock[] = [
      { kind: 'heading', level: marker === '#' ? 1 : 2, inlines: title.inlines },
    ];
    const rest = lines.slice(index).join('\n');
    if (rest !== '') {
      const below = readParagraph(rest, reader);
      if (!below.ok) return below;
      blocks.push(...below.blocks);
    }
    return { ok: true, blocks };
  }

  if (lines.every((line) => line.startsWith('>'))) {
    const inner = lines
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n')
      .trim();
    if (inner !== '') {
      const read = readBlockInlines(inner, reader);
      if (!read.ok) return read;
      return { ok: true, blocks: [{ kind: 'callout', inlines: read.inlines }] };
    }
  }

  const code = lines.length <= 2 ? CODE_LINE.exec(lines[lines.length - 1] ?? '') : null;
  const codeValue = code?.[1]?.trim() ?? '';
  if (code && codeValue !== '') {
    const value = readBlockInlines(codeValue, reader);
    if (!value.ok) return value;
    const label = lines.length === 2 ? readBlockInlines(firstLine, reader) : undefined;
    if (label && !label.ok) return label;
    return {
      ok: true,
      blocks: [{ kind: 'code', label: label ? label.inlines : null, value: value.inlines }],
    };
  }

  const firstStep = STEP_LINE.exec(firstLine);
  if (firstStep && (firstStep[2] ?? '').trim() !== '') {
    const steps: EmailStep[] = [];
    let current: { number: string; title: string; body: string[] } | undefined;
    const finish = (): Failure | undefined => {
      if (!current) return undefined;
      const title = readBlockInlines(current.title, reader);
      if (!title.ok) return title;
      const body = readBlockInlines(current.body.join('\n'), reader);
      if (!body.ok) return body;
      steps.push({ number: current.number, title: title.inlines, body: body.inlines });
      return undefined;
    };
    for (const line of lines) {
      const step = STEP_LINE.exec(line);
      if (step && (step[2] ?? '').trim() !== '') {
        const failed = finish();
        if (failed) return failed;
        current = { number: step[1] ?? '', title: (step[2] ?? '').trim(), body: [] };
      } else {
        current?.body.push(line);
      }
    }
    const failed = finish();
    if (failed) return failed;
    return { ok: true, blocks: [{ kind: 'steps', steps }] };
  }

  return undefined;
}

/** One paragraph: a shaped block, a button alone, a details box or plain text. */
function readParagraph(paragraph: string, reader: Reader): ParagraphBlocks {
  const shaped = readShapedParagraph(paragraph, reader);
  if (shaped) return shaped;
  const read = readInlines(paragraph, reader, { bold: false, link: false });
  if (!read.ok) return read;
  const buttons = read.tokens.filter((token) => token.kind === 'button');
  const [button] = buttons;
  if (button !== undefined) {
    if (buttons.length > 1) return markupError('two_buttons');
    if (read.tokens.length > 1) return markupError('button_not_alone');
    return { ok: true, blocks: [{ kind: 'button', label: button.label, href: button.href }] };
  }
  const inlines = read.tokens.filter(isInline);
  const lines = linesOf(inlines);
  const rows = lines.length >= 2 ? lines.map(detailRow) : [];
  const complete = rows.filter((row): row is EmailDetailRow => row !== undefined);
  if (complete.length >= 2 && complete.length === rows.length) {
    return { ok: true, blocks: [{ kind: 'details', rows: complete }] };
  }
  return { ok: true, blocks: [{ kind: 'paragraph', inlines }] };
}

/**
 * The blocks of a template's body, or the first problem in it: a fill-in the
 * template may not use (`invalid_fill_in`, naming what was typed in the
 * braces, in the text or a button's label), a link that is not `http(s)://`
 * with no braces or `{tracking link}` (`bad_link`),
 * a second button (`two_buttons`) or a button sharing its paragraph or inside
 * another block (`button_not_alone`).
 */
export function parseEmailBody(
  body: string,
  template: EmailTemplateKey,
  options?: MarkupOptions,
): { ok: true; blocks: EmailBlock[] } | Failure {
  const reader = readerFor(template, 'body', options);
  const blocks: EmailBlock[] = [];
  let hasButton = false;
  for (const paragraph of paragraphsOf(body)) {
    const read = readParagraph(paragraph, reader);
    if (!read.ok) return read;
    for (const block of read.blocks) {
      if (block.kind === 'button') {
        if (hasButton) return markupError('two_buttons');
        hasButton = true;
      }
      const previous = blocks[blocks.length - 1];
      if (block.kind === 'steps' && previous?.kind === 'steps') {
        blocks[blocks.length - 1] = { kind: 'steps', steps: [...previous.steps, ...block.steps] };
        continue;
      }
      blocks.push(block);
    }
  }
  return { ok: true, blocks };
}

/** The parts of a template's subject: text and fill-ins, nothing else is markup there. */
export function parseEmailSubject(
  subject: string,
  template: EmailTemplateKey,
  options?: MarkupOptions,
): { ok: true; parts: EmailTextPart[] } | Failure {
  return readTextParts(subject, readerFor(template, 'subject', options));
}

/** Any site-made key: what a `tpl_` template may write does not depend on which one it is. */
const ANY_SITE_TEMPLATE = 'tpl_0000000000000000';

function inlineNames(inlines: readonly EmailInline[]): EmailFillInName[] {
  return inlines.flatMap((inline): EmailFillInName[] => {
    switch (inline.kind) {
      case 'fillIn':
        return [inline.key];
      case 'bold':
        return inlineNames(inline.children);
      case 'link':
        return [
          ...inlineNames(inline.label),
          ...(inline.href.kind === 'fillIn' ? [inline.href.key] : []),
        ];
      default:
        return [];
    }
  });
}

const partNames = (parts: readonly EmailTextPart[]): EmailFillInName[] =>
  parts.flatMap((part) => (part.kind === 'fillIn' ? [part.key] : []));

/** Every fill-in one block uses, in reading order (a link's or button's address included). */
export function blockFillIns(block: EmailBlock): EmailFillInName[] {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
    case 'callout':
      return inlineNames(block.inlines);
    case 'button':
      return [...partNames(block.label), ...(block.href.kind === 'fillIn' ? [block.href.key] : [])];
    case 'badge':
      return partNames(block.label);
    case 'progress':
      return block.steps.flatMap(partNames);
    case 'details':
      return block.rows.flatMap((row) => [...inlineNames(row.label), ...inlineNames(row.value)]);
    case 'code':
      return [...inlineNames(block.label ?? []), ...inlineNames(block.value)];
    case 'steps':
      return block.steps.flatMap((step) => [...inlineNames(step.title), ...inlineNames(step.body)]);
  }
}

/** The `{prop:…}` keys a site-made template's subject and body use, sorted, each once; [] when it does not parse. */
export function templatePropertyKeys(subject: string, body: string): string[] {
  const parsedSubject = parseEmailSubject(subject, ANY_SITE_TEMPLATE);
  const parsedBody = parseEmailBody(body, ANY_SITE_TEMPLATE);
  if (!parsedSubject.ok || !parsedBody.ok) return [];
  const names = [...partNames(parsedSubject.parts), ...parsedBody.blocks.flatMap(blockFillIns)];
  const keys = names
    .filter((name) => name.startsWith(PROPERTY_FILL_IN_PREFIX))
    .map((name) => name.slice(PROPERTY_FILL_IN_PREFIX.length));
  return [...new Set(keys)].sort();
}
