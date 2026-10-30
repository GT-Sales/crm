import {
  fillInsForTemplate,
  normalizeFillInName,
  type CustomerEmailTemplate,
  type EmailFillInKey,
} from '@gt-sales/contracts';

/**
 * The small markup a site's customer mails are written in (Settings → Email):
 * paragraphs split on blank lines, a single newline is a line break,
 * `**bold**`, `[label](https://…)` links, one `[button: Label](https://…)`
 * alone in its paragraph, and `{fill-ins}` the template may use. A link or
 * button goes to an `http(s)://` address or to `{tracking link}`. What is not
 * markup (an unclosed `**`, a `{` with no `}` on its line, brackets that are
 * not a link) stays literal text. The subject takes fill-ins only.
 *
 * Pure: no database, no environment. The layout (`layout.ts`) renders the
 * blocks; the settings store validates a template with these parsers.
 */

/** Where a link or the button goes: a typed address, or the tracking link fill-in. */
export type EmailHref = { kind: 'url'; url: string } | { kind: 'fillIn'; key: 'tracking link' };

export type EmailInline =
  | { kind: 'text'; text: string }
  | { kind: 'fillIn'; key: EmailFillInKey }
  | { kind: 'bold'; children: readonly EmailInline[] }
  | { kind: 'link'; label: readonly EmailInline[]; href: EmailHref }
  | { kind: 'break' };

export type EmailBlock =
  | { kind: 'paragraph'; inlines: readonly EmailInline[] }
  | { kind: 'button'; label: string; href: EmailHref };

export type MarkupError =
  | { error: 'invalid_fill_in'; fillIn: string; where: 'subject' | 'body' }
  | { error: 'invalid_email_markup'; reason: 'two_buttons' | 'button_not_alone' | 'bad_link' };

type Failure = { ok: false } & MarkupError;

export type EmailSubjectPart =
  { kind: 'text'; text: string } | { kind: 'fillIn'; key: EmailFillInKey };

/** A button as the inline reader finds it, before the paragraph check places it. */
type ButtonToken = { kind: 'button'; label: string; href: EmailHref };
type Token = EmailInline | ButtonToken;

interface Reader {
  readonly allowed: ReadonlySet<EmailFillInKey>;
  readonly where: 'subject' | 'body';
}

const FILL_IN = /\{([^{}\n]*)\}/y;
const BUTTON_LABEL = /^button:(.*)$/is;
const HTTP_URL = /^https?:\/\/\S+$/i;

const markupError = (reason: 'two_buttons' | 'button_not_alone' | 'bad_link'): Failure => ({
  ok: false,
  error: 'invalid_email_markup',
  reason,
});

/** The fill-in written as `{inner}`, if the template may use it. */
function readFillIn(inner: string, reader: Reader): { ok: true; key: EmailFillInKey } | Failure {
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
            : undefined;
        if (label && !label.ok) return label;
        const href = readHref(bracket.address, reader);
        if (!href.ok) return href;
        flush();
        tokens.push(
          label
            ? { kind: 'link', label: label.tokens.filter(isInline), href: href.href }
            : { kind: 'button', label: buttonLabel, href: href.href },
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

/**
 * The blocks of a template's body, or the first problem in it: a fill-in the
 * template may not use (`invalid_fill_in`, naming what was typed in the
 * braces), a link that is not `http(s)://` or `{tracking link}` (`bad_link`),
 * a second button (`two_buttons`) or a button sharing its paragraph
 * (`button_not_alone`).
 */
export function parseEmailBody(
  body: string,
  template: CustomerEmailTemplate,
): { ok: true; blocks: EmailBlock[] } | Failure {
  const reader: Reader = { allowed: new Set(fillInsForTemplate(template)), where: 'body' };
  const blocks: EmailBlock[] = [];
  let hasButton = false;
  for (const paragraph of paragraphsOf(body)) {
    const read = readInlines(paragraph, reader, { bold: false, link: false });
    if (!read.ok) return read;
    const buttons = read.tokens.filter((token) => token.kind === 'button');
    const [button] = buttons;
    if (button === undefined) {
      blocks.push({ kind: 'paragraph', inlines: read.tokens.filter(isInline) });
      continue;
    }
    if (hasButton || buttons.length > 1) return markupError('two_buttons');
    if (read.tokens.length > 1) return markupError('button_not_alone');
    hasButton = true;
    blocks.push({ kind: 'button', label: button.label, href: button.href });
  }
  return { ok: true, blocks };
}

/** The parts of a template's subject: text and fill-ins, nothing else is markup there. */
export function parseEmailSubject(
  subject: string,
  template: CustomerEmailTemplate,
): { ok: true; parts: EmailSubjectPart[] } | Failure {
  const reader: Reader = { allowed: new Set(fillInsForTemplate(template)), where: 'subject' };
  const parts: EmailSubjectPart[] = [];
  let text = '';
  let index = 0;
  while (index < subject.length) {
    FILL_IN.lastIndex = index;
    const match = subject.charAt(index) === '{' ? FILL_IN.exec(subject) : null;
    if (match) {
      const fillIn = readFillIn(match[1] ?? '', reader);
      if (!fillIn.ok) return fillIn;
      if (text !== '') parts.push({ kind: 'text', text });
      text = '';
      parts.push({ kind: 'fillIn', key: fillIn.key });
      index += match[0].length;
      continue;
    }
    text += subject.charAt(index);
    index += 1;
  }
  if (text !== '') parts.push({ kind: 'text', text });
  return { ok: true, parts };
}
