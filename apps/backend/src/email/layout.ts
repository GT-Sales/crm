import {
  DEFAULT_EMAIL_BRAND_COLOR,
  type CustomerEmailTemplate,
  type EmailFillInKey,
} from '@gt-sales/contracts';

import {
  parseEmailBody,
  parseEmailSubject,
  type EmailBlock,
  type EmailHref,
  type EmailInline,
  type EmailSubjectPart,
  type MarkupError,
} from './markup.js';

/**
 * The one layout every customer mail of every site is drawn in: the site's
 * logo (or its name), the template's blocks, its button in the brand colour
 * and its footer, as an HTML part and a plain-text part made from the same
 * blocks. Every text and value is escaped in the HTML and left raw in the
 * text; the subject is filled, never escaped. Deterministic and pure.
 */

export interface EmailBranding {
  siteName: string;
  logoUrl: string | null;
  brandColor: string;
  footerText: string;
}

export type FillInValues = Partial<Record<EmailFillInKey, string>>;

export type RenderedEmail =
  | { ok: true; subject: string; html: string; text: string }
  | { ok: false; missing: EmailFillInKey[] }
  | ({ ok: false } & MarkupError);

const TEXT_COLOR = '#15130f';
const MUTED_COLOR = '#6b6359';
const RULE_COLOR = '#e8e1d8';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Settings store a `#rrggbb` colour; anything else never reaches a style attribute. */
function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : DEFAULT_EMAIL_BRAND_COLOR;
}

/** A value counts only when it is not blank. */
function present(values: FillInValues, key: EmailFillInKey): string | undefined {
  const value = values[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function inlineFillIns(inlines: readonly EmailInline[]): EmailFillInKey[] {
  return inlines.flatMap((inline): EmailFillInKey[] => {
    switch (inline.kind) {
      case 'fillIn':
        return [inline.key];
      case 'bold':
        return inlineFillIns(inline.children);
      case 'link':
        return [...inlineFillIns(inline.label), ...hrefFillIns(inline.href)];
      default:
        return [];
    }
  });
}

function hrefFillIns(href: EmailHref): EmailFillInKey[] {
  return href.kind === 'fillIn' ? [href.key] : [];
}

/** Every fill-in used, subject first, in order of first use. */
function fillInsUsed(
  subject: readonly EmailSubjectPart[],
  blocks: readonly EmailBlock[],
): EmailFillInKey[] {
  const keys = [
    ...subject.flatMap((part) => (part.kind === 'fillIn' ? [part.key] : [])),
    ...blocks.flatMap((block) =>
      block.kind === 'button' ? hrefFillIns(block.href) : inlineFillIns(block.inlines),
    ),
  ];
  return [...new Set(keys)];
}

/** Draws blocks whose every fill-in has a value (checked first by `renderCustomerEmail`). */
class Drawing {
  constructor(
    private readonly values: FillInValues,
    private readonly brandColor: string,
  ) {}

  private value(key: EmailFillInKey): string {
    return present(this.values, key) ?? '';
  }

  private address(href: EmailHref): string {
    return href.kind === 'url' ? href.url : this.value(href.key);
  }

  html(inlines: readonly EmailInline[]): string {
    return inlines
      .map((inline) => {
        switch (inline.kind) {
          case 'text':
            return escapeHtml(inline.text);
          case 'fillIn':
            return escapeHtml(this.value(inline.key));
          case 'bold':
            return `<strong>${this.html(inline.children)}</strong>`;
          case 'link':
            return `<a href="${escapeHtml(this.address(inline.href))}" style="color:${this.brandColor};">${this.html(inline.label)}</a>`;
          case 'break':
            return '<br>';
        }
      })
      .join('');
  }

  text(inlines: readonly EmailInline[]): string {
    return inlines
      .map((inline) => {
        switch (inline.kind) {
          case 'text':
            return inline.text;
          case 'fillIn':
            return this.value(inline.key);
          case 'bold':
            return this.text(inline.children);
          case 'link':
            return `${this.text(inline.label)} (${this.address(inline.href)})`;
          case 'break':
            return '\n';
        }
      })
      .join('');
  }

  htmlBlock(block: EmailBlock): string {
    if (block.kind === 'paragraph') {
      return `<p style="margin:0 0 16px;">${this.html(block.inlines)}</p>`;
    }
    return `<p style="margin:8px 0 24px;"><a href="${escapeHtml(this.address(block.href))}" style="display:inline-block;background:${this.brandColor};color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">${escapeHtml(block.label)}</a></p>`;
  }

  textBlock(block: EmailBlock): string {
    return block.kind === 'paragraph'
      ? this.text(block.inlines)
      : `${block.label}: ${this.address(block.href)}`;
  }
}

/**
 * Renders one customer mail: the template's subject and body (parsed for
 * `template`), filled with `values`, in the site's branding. A markup problem
 * is returned as the parser reports it; a fill-in with no value (absent or
 * blank) is collected into `missing` and nothing renders.
 */
export function renderCustomerEmail(input: {
  template: CustomerEmailTemplate;
  subject: string;
  body: string;
  branding: EmailBranding;
  values: FillInValues;
}): RenderedEmail {
  const subject = parseEmailSubject(input.subject, input.template);
  if (!subject.ok) return subject;
  const body = parseEmailBody(input.body, input.template);
  if (!body.ok) return body;

  const missing = fillInsUsed(subject.parts, body.blocks).filter(
    (key) => present(input.values, key) === undefined,
  );
  if (missing.length > 0) return { ok: false, missing };

  const { branding } = input;
  const drawing = new Drawing(input.values, safeColor(branding.brandColor));
  const footerLines = (branding.footerText.replace(/\r\n?/g, '\n').trim() || branding.siteName)
    .split('\n')
    .map((line) => line.trim());

  const header = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.siteName)}" height="40" style="display:block;height:40px;width:auto;border:0;">`
    : `<div style="font-size:18px;font-weight:bold;color:${TEXT_COLOR};">${escapeHtml(branding.siteName)}</div>`;

  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:24px 12px;background:#f6f3ef;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${RULE_COLOR};border-radius:12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:${TEXT_COLOR};">`,
    `<tr><td style="padding:24px 28px 8px;">${header}</td></tr>`,
    `<tr><td style="padding:8px 28px;">${body.blocks.map((block) => drawing.htmlBlock(block)).join('')}</td></tr>`,
    `<tr><td style="padding:16px 28px 24px;border-top:1px solid ${RULE_COLOR};color:${MUTED_COLOR};font-size:12px;line-height:1.5;">${footerLines.map(escapeHtml).join('<br>')}</td></tr>`,
    '</table>',
    '</body></html>',
  ].join('');

  const text = [
    ...body.blocks.map((block) => drawing.textBlock(block)),
    `--\n${footerLines.join('\n')}`,
  ].join('\n\n');

  const filledSubject = subject.parts
    .map((part) => (part.kind === 'text' ? part.text : (present(input.values, part.key) ?? '')))
    .join('')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();

  return { ok: true, subject: filledSubject, html, text };
}
