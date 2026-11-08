import {
  DEFAULT_EMAIL_BRAND_COLOR,
  PROPERTY_FILL_IN_PREFIX,
  type EmailFillInKey,
  type EmailFillInName,
  type EmailTemplateKey,
} from '@gt-sales/contracts';

import {
  blockFillIns,
  parseEmailBody,
  parseEmailSubject,
  type EmailBlock,
  type EmailHref,
  type EmailInline,
  type EmailTextPart,
  type MarkupError,
} from './markup.js';

/**
 * The one layout every customer mail of every site is drawn in, in the design
 * language of the Get Canada Sim website's own mail: a warm canvas, a white
 * rounded card with the site's logo (or its name) centred over a rule in the
 * brand colour, the template's blocks (paragraphs, a status pill, headings, a
 * details box, a highlighted box, a code box, steps and a pill-shaped button in
 * the brand colour) and a footer block in the brand colour with the site's
 * name and footer lines. Everything site-specific comes from the branding, so
 * every site gets the same design in its own colour and name. An HTML part and
 * a plain-text part are made from the same blocks; every text and value is
 * escaped in the HTML and left raw in the text; the subject is filled, never
 * escaped. Deterministic and pure.
 */

export interface EmailBranding {
  siteName: string;
  logoUrl: string | null;
  brandColor: string;
  footerText: string;
}

/** The fill-ins' values; `props` holds a site-made template's `{prop:<key>}` values by property key. */
export type FillInValues = Partial<Record<EmailFillInKey, string>> & {
  readonly props?: Readonly<Record<string, string>>;
};

export type RenderedEmail =
  | { ok: true; subject: string; html: string; text: string }
  | { ok: false; missing: EmailFillInName[] }
  | ({ ok: false } & MarkupError);

const FONT =
  "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
const INK = '#15130f';
const BODY_INK = '#4a443d';
const MUTED = '#6b6359';
const LINE = '#efe7dd';
const CANVAS = '#f4ece1';
const SOFT = '#fbf7f2';

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

function channels(color: string): readonly [number, number, number] {
  const at = (index: number) => Number.parseInt(color.slice(index, index + 2), 16);
  return [at(1), at(3), at(5)];
}

const hex = (rgb: readonly number[]): string =>
  `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** `color` moved toward `target` by `amount` (0–1). */
function mix(color: string, target: string, amount: number): string {
  const from = channels(color);
  const to = channels(target);
  return hex(from.map((channel, index) => channel + ((to[index] ?? 0) - channel) * amount));
}

/** White or ink, whichever reads on `color` (WCAG relative luminance). */
function textOn(color: string): string {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(color);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return 1.05 / (luminance + 0.05) >= 3 ? '#ffffff' : INK;
}

/** The colours one site's mail is drawn in, all derived from its brand colour. */
interface Palette {
  brand: string;
  /** Text and links in the brand's hue, dark enough to read on white. */
  brandDark: string;
  /** A light tint of the brand, for the status pill. */
  brandTint: string;
  onBrand: string;
}

function paletteFor(brandColor: string): Palette {
  const brand = safeColor(brandColor);
  return {
    brand,
    brandDark: mix(brand, '#000000', 0.15),
    brandTint: mix(brand, '#ffffff', 0.9),
    onBrand: textOn(brand),
  };
}

const isPropertyFillIn = (name: EmailFillInName): name is `prop:${string}` =>
  name.startsWith(PROPERTY_FILL_IN_PREFIX);

/** A value counts only when it is not blank. */
function present(values: FillInValues, name: EmailFillInName): string | undefined {
  const raw = isPropertyFillIn(name)
    ? values.props?.[name.slice(PROPERTY_FILL_IN_PREFIX.length)]
    : values[name];
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Text parts with their fill-ins replaced; raw, for the caller to escape where it needs to. */
function filledText(parts: readonly EmailTextPart[], values: FillInValues): string {
  return parts
    .map((part) => (part.kind === 'text' ? part.text : (present(values, part.key) ?? '')))
    .join('');
}

/** Every fill-in used, subject first, in order of first use. */
function fillInsUsed(
  subject: readonly EmailTextPart[],
  blocks: readonly EmailBlock[],
): EmailFillInName[] {
  const keys = [
    ...subject.flatMap((part) => (part.kind === 'fillIn' ? [part.key] : [])),
    ...blocks.flatMap(blockFillIns),
  ];
  return [...new Set(keys)];
}

/** A one-cell table: how a box keeps its background, border and radius in every client. */
function box(cellStyle: string, content: string, margin = '0 0 24px'): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;margin:${margin};"><tr><td style="${cellStyle}">${content}</td></tr></table>`;
}

/** Draws blocks whose every fill-in has a value (checked first by `renderCustomerEmail`). */
class Drawing {
  constructor(
    private readonly values: FillInValues,
    private readonly palette: Palette,
  ) {}

  private value(key: EmailFillInName): string {
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
            return `<strong style="color:${INK};">${this.html(inline.children)}</strong>`;
          case 'link':
            return `<a href="${escapeHtml(this.address(inline.href))}" style="color:${this.palette.brandDark};font-weight:600;">${this.html(inline.label)}</a>`;
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
    const { brand, brandDark, brandTint, onBrand } = this.palette;
    switch (block.kind) {
      case 'paragraph':
        return `<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:${BODY_INK};font-family:${FONT};">${this.html(block.inlines)}</p>`;
      case 'button':
        return `<table role="presentation" cellpadding="0" cellspacing="0" class="gt-btn" style="margin:4px 0 26px;"><tr><td align="center" bgcolor="${brand}" style="background:${brand};border-radius:999px;"><a href="${escapeHtml(this.address(block.href))}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;line-height:1.2;color:${onBrand};text-decoration:none;border-radius:999px;font-family:${FONT};">${escapeHtml(filledText(block.label, this.values))}</a></td></tr></table>`;
      case 'badge': {
        const success = block.tone === 'success';
        const background = success ? '#e9f8ee' : brandTint;
        const color = success ? '#14703c' : brandDark;
        return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 18px;"><tr><td style="background:${background};color:${color};font-size:12px;font-weight:700;letter-spacing:0.01em;line-height:1.2;padding:7px 14px;border-radius:999px;font-family:${FONT};">${success ? '&#10003;&nbsp;' : ''}${escapeHtml(filledText(block.label, this.values))}</td></tr></table>`;
      }
      case 'heading':
        return block.level === 1
          ? `<h1 style="margin:0 0 14px;font-size:26px;line-height:1.25;font-weight:800;color:${INK};letter-spacing:-0.02em;font-family:${FONT};">${this.html(block.inlines)}</h1>`
          : `<h2 style="margin:8px 0 10px;font-size:12px;line-height:1.5;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:${brandDark};font-family:${FONT};">${this.html(block.inlines)}</h2>`;
      case 'details': {
        const rows = block.rows
          .map((row, index) => {
            const edge = index > 0 ? `border-top:1px solid ${LINE};` : '';
            return `<tr><td style="padding:12px 16px;color:${MUTED};font-size:13px;line-height:1.45;font-family:${FONT};${edge}">${this.html(row.label)}</td><td align="right" style="padding:12px 16px;color:${INK};font-size:14px;font-weight:600;line-height:1.45;text-align:right;font-family:${FONT};${edge}">${this.html(row.value)}</td></tr>`;
          })
          .join('');
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ${LINE};border-radius:14px;margin:0 0 26px;">${rows}</table>`;
      }
      case 'callout':
        return box(
          `background:#fff8e6;border:1px solid #f0dfa8;border-radius:14px;padding:14px 16px;font-size:13px;line-height:1.6;color:#7a6a33;font-family:${FONT};`,
          this.html(block.inlines),
        );
      case 'code': {
        const label = block.label
          ? `<div style="margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${brandDark};font-family:${FONT};">${this.html(block.label)}</div>`
          : '';
        return box(
          `background:${SOFT};border:1px solid ${LINE};border-radius:14px;padding:22px 16px;text-align:center;`,
          // A labelled value (a phone number) is set tighter, in ink; a bare one (a code) wide, in the brand.
          `${label}<div style="font-size:${block.label ? '28px' : '32px'};line-height:1.25;font-weight:800;letter-spacing:${block.label ? '0.06em' : '0.22em'};color:${block.label ? INK : brandDark};font-family:${MONO};">${this.html(block.value)}</div>`,
        );
      }
      case 'steps': {
        const rows = block.steps
          .map((step, index) => {
            const last = index === block.steps.length - 1;
            const connector = last ? '' : `border-left:2px solid ${LINE};`;
            const body =
              step.body.length > 0
                ? `<div style="font-size:13px;line-height:1.55;color:${MUTED};font-family:${FONT};">${this.html(step.body)}</div>`
                : '';
            // [12px][connector][12px][words]: the connector is a real cell, so it
            // stretches to the step's height in every client, Outlook included.
            return (
              `<tr><td colspan="3" width="26" valign="top" style="width:26px;padding:0;"><div style="width:26px;height:26px;line-height:26px;background:${brand};border-radius:999px;text-align:center;color:${onBrand};font-size:12px;font-weight:700;font-family:${FONT};">${escapeHtml(step.number)}</div></td>` +
              `<td valign="middle" style="padding:0 0 0 14px;font-size:15px;line-height:1.35;font-weight:700;color:${INK};font-family:${FONT};">${this.html(step.title)}</td></tr>` +
              `<tr><td width="12" style="width:12px;font-size:1px;line-height:1px;">&nbsp;</td><td width="0" style="width:0;font-size:1px;line-height:1px;${connector}">&nbsp;</td><td width="12" style="width:12px;font-size:1px;line-height:1px;">&nbsp;</td>` +
              `<td valign="top" style="padding:${body === '' ? '0' : '4px'} 0 ${last ? '0' : '18px'} 14px;">${body}</td></tr>`
            );
          })
          .join('');
        return box(
          `border:1px solid ${LINE};border-radius:16px;padding:20px 22px;`,
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;">${rows}</table>`,
          '0 0 26px',
        );
      }
    }
  }

  textBlock(block: EmailBlock): string {
    switch (block.kind) {
      case 'paragraph':
      case 'callout':
        return this.text(block.inlines);
      case 'heading':
        return block.level === 1
          ? this.text(block.inlines)
          : this.text(block.inlines).toUpperCase();
      case 'button':
        return `${filledText(block.label, this.values)}: ${this.address(block.href)}`;
      case 'badge':
        return `[${filledText(block.label, this.values)}]`;
      case 'details':
        return block.rows
          .map((row) => `${this.text(row.label)}: ${this.text(row.value)}`)
          .join('\n');
      case 'code':
        return [block.label ? this.text(block.label) : '', `    ${this.text(block.value)}`]
          .filter((line) => line !== '')
          .join('\n');
      case 'steps':
        return block.steps
          .map((step) =>
            [
              `${step.number}. ${this.text(step.title)}`,
              ...(step.body.length > 0
                ? this.text(step.body)
                    .split('\n')
                    .map((line) => `   ${line}`)
                : []),
            ].join('\n'),
          )
          .join('\n');
    }
  }
}

/** Footer lines: the footer text's lines, blank ones dropped. */
function footerLinesOf(branding: EmailBranding): string[] {
  return branding.footerText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The card around a mail's content: header, brand rule, content, brand footer. */
function shell(branding: EmailBranding, palette: Palette, content: string): string {
  const siteName = escapeHtml(branding.siteName);
  const header = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${siteName}" height="60" style="display:block;margin:0 auto;height:auto;width:auto;max-height:60px;max-width:220px;border:0;font-family:${FONT};font-size:20px;font-weight:800;color:${INK};">`
    : `<div style="font-size:22px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:${INK};font-family:${FONT};">${siteName}</div>`;
  const footerLines = footerLinesOf(branding);
  const footerText =
    footerLines.length > 0
      ? `<p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:${palette.onBrand};opacity:0.9;font-family:${FONT};">${footerLines.map(escapeHtml).join('<br>')}</p>`
      : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">',
    `<style>body{margin:0;padding:0;width:100%!important;}img{border:0;outline:none;text-decoration:none;}@media only screen and (max-width:600px){.gt-card{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important;}.gt-pad{padding-left:22px!important;padding-right:22px!important;}.gt-btn a{display:block!important;}}</style>`,
    '</head>',
    `<body style="margin:0;padding:0;background:${CANVAS};-webkit-font-smoothing:antialiased;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${CANVAS};"><tr><td align="center" style="padding:32px 16px 40px;">`,
    `<table role="presentation" class="gt-card" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:20px;overflow:hidden;border-collapse:separate;font-family:${FONT};color:${INK};">`,
    `<tr><td class="gt-pad" align="center" style="padding:30px 32px 24px;background:#ffffff;">${header}</td></tr>`,
    `<tr><td style="height:4px;line-height:4px;font-size:4px;background:${palette.brand};">&nbsp;</td></tr>`,
    `<tr><td class="gt-pad" style="padding:30px 32px 8px;">${content}</td></tr>`,
    `<tr><td class="gt-pad" style="padding:0 32px 32px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;background:${palette.brand};border-radius:16px;"><tr><td align="center" style="padding:28px 24px;">`,
    `<div style="font-size:22px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:${palette.onBrand};font-family:${FONT};">${siteName}</div>${footerText}`,
    '</td></tr></table>',
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');
}

/**
 * Renders one customer mail: the template's subject and body (parsed for
 * `template`), filled with `values`, in the site's branding. A markup problem
 * is returned as the parser reports it; a fill-in with no value (absent or
 * blank) is collected into `missing` and nothing renders.
 */
export function renderCustomerEmail(input: {
  template: EmailTemplateKey;
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
  const palette = paletteFor(branding.brandColor);
  const drawing = new Drawing(input.values, palette);
  const footerLines = footerLinesOf(branding);

  const html = shell(
    branding,
    palette,
    body.blocks.map((block) => drawing.htmlBlock(block)).join(''),
  );

  const text = [
    ...body.blocks.map((block) => drawing.textBlock(block)),
    `--\n${(footerLines.length > 0 ? footerLines : [branding.siteName]).join('\n')}`,
  ].join('\n\n');

  const filledSubject = filledText(subject.parts, input.values)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();

  return { ok: true, subject: filledSubject, html, text };
}

/** A staff-authored message: plain text only, drawn in the same card as every customer mail. */
export function renderPlainCustomerEmail(input: {
  subject: string;
  body: string;
  branding: EmailBranding;
}): { subject: string; text: string; html: string } {
  const { branding } = input;
  const footer = branding.footerText || branding.siteName;
  const palette = paletteFor(branding.brandColor);
  return {
    subject: input.subject,
    text: `${input.body}\n\n--\n${footer}`,
    html: shell(
      branding,
      palette,
      `<div style="margin:0 0 22px;white-space:pre-wrap;font-size:15px;line-height:1.6;color:${BODY_INK};font-family:${FONT};">${escapeHtml(input.body)}</div>`,
    ),
  };
}
