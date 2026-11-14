import {
  DEFAULT_EMAIL_BRAND_COLOR,
  PROPERTY_FILL_IN_PREFIX,
  type EmailFillInKey,
  type EmailStyle,
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
 * The layout every customer mail of every site is drawn in, in one of two
 * styles (the site's `style` setting); both draw the same blocks (paragraphs,
 * a status pill, headings, a progress tracker, a details box, a highlighted
 * box, a code box, steps and a pill-shaped button in the brand colour).
 *
 * - `classic`, the design language of the Get Canada Sim website's own mail: a
 *   warm canvas, a white rounded card with the site's logo (or its name)
 *   centred over a rule in the brand colour, a centred opening when the mail
 *   starts with a badge and a big heading, and a quiet footer band with the
 *   site's name and footer lines.
 * - `hero`, the CanadaWide website's mail: a cool grey-blue canvas, a card
 *   whose header is a band in the brand colour (a gradient to a deeper shade,
 *   solid where gradients are not drawn) holding the site's name as a small
 *   uppercase wordmark and the opening badge top right in the accent colour;
 *   a mail that opens with a badge and a big heading also has that heading and
 *   the paragraph after it in the band, in white. The body is left-aligned,
 *   steps sit on the card with no box, and the mail's closing paragraph (its
 *   last block, when it is a paragraph after other content), the footer lines
 *   and the site name are small grey closing lines under a hairline. The logo
 *   is not drawn: a band in the brand colour reads the name better than a
 *   logo made for white.
 *
 * Everything site-specific comes from the branding, so every site gets the
 * same design in its own colour and name. An HTML part and a plain-text part
 * are made from the same blocks (the text is the same in both styles); every
 * text and value is escaped in the HTML and left raw in the text; the subject
 * is filled, never escaped. Deterministic and pure.
 */

export interface EmailBranding {
  siteName: string;
  logoUrl: string | null;
  brandColor: string;
  footerText: string;
  /** The layout; `classic` when absent. */
  style?: EmailStyle;
  /** The hero style's badge colour; absent or null, a light tint of the brand colour. */
  accentColor?: string | null;
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
const SUCCESS = '#1c8a4b';
const FAINT = '#9a9286';

/** The fixed colours and type of one style; the brand colour supplies the rest. */
interface Theme {
  font: string;
  ink: string;
  bodyInk: string;
  muted: string;
  line: string;
  soft: string;
  faint: string;
}

const CLASSIC_THEME: Theme = {
  font: FONT,
  ink: INK,
  bodyInk: BODY_INK,
  muted: MUTED,
  line: LINE,
  soft: SOFT,
  faint: FAINT,
};

/** The CanadaWide website's mail: Plus Jakarta Sans, cool inks and hairlines. */
const HERO_THEME: Theme = {
  font: "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  ink: '#0b1220',
  bodyInk: '#374151',
  muted: '#6b7280',
  line: '#e8eaee',
  soft: '#f7f9fc',
  faint: '#9ca3af',
};
const HERO_CANVAS = '#eef2f7';

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

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(color: string): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** True when white text reads on `color` (contrast of at least 3). */
const whiteReadsOn = (color: string): boolean => 1.05 / (luminance(color) + 0.05) >= 3;

/** White or ink, whichever reads on `color`. */
function textOn(color: string): string {
  return whiteReadsOn(color) ? '#ffffff' : INK;
}

/** The colours one site's mail is drawn in, all derived from its brand (and accent) colour. */
interface Palette {
  brand: string;
  /** Text and links in the brand's hue, dark enough to read on white. */
  brandDark: string;
  /** A light tint of the brand, for the status pill. */
  brandTint: string;
  onBrand: string;
  /** Hero: the band's gradient runs from the brand to this deeper shade. */
  brandDeep: string;
  /** Hero: a near-white wash of the brand, the details and code boxes' fill. */
  brandWash: string;
  /** Hero: the band's quieter text (the wordmark, the intro), a pale tint on a dark band. */
  bandSoft: string;
  /** Hero: links on white, the brand itself when it reads (4.5:1), else its darker shade. */
  link: string;
  /** Hero: the badge's fill and its text. */
  accent: string;
  onAccent: string;
}

function paletteFor(brandColor: string, accentColor?: string | null): Palette {
  const brand = safeColor(brandColor);
  const brandDark = mix(brand, '#000000', 0.15);
  const onBrand = textOn(brand);
  const accent = accentColor ? safeColor(accentColor) : mix(brand, '#ffffff', 0.82);
  return {
    brand,
    brandDark,
    brandTint: mix(brand, '#ffffff', 0.9),
    onBrand,
    brandDeep: mix(brand, '#000000', 0.18),
    brandWash: mix(brand, '#ffffff', 0.97),
    bandSoft: onBrand === '#ffffff' ? mix(brand, '#ffffff', 0.85) : mix(brand, '#000000', 0.7),
    link: 1.05 / (luminance(brand) + 0.05) >= 4.5 ? brand : brandDark,
    accent,
    // A dark shade of the accent itself on a light accent (lime gets a deep green), white on a dark one.
    onAccent: whiteReadsOn(accent) ? '#ffffff' : mix(accent, '#000000', 0.8),
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
  /** The colour of bold text and links: the card's by default, the band's inside it. */
  private onBand = false;

  constructor(
    private readonly values: FillInValues,
    private readonly palette: Palette,
    private readonly style: EmailStyle = 'classic',
    private readonly theme: Theme = CLASSIC_THEME,
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
            return `<strong style="color:${this.onBand ? this.palette.onBrand : this.theme.ink};">${this.html(inline.children)}</strong>`;
          case 'link':
            return `<a href="${escapeHtml(this.address(inline.href))}" style="${this.linkStyle()}">${this.html(inline.label)}</a>`;
          case 'break':
            return '<br>';
        }
      })
      .join('');
  }

  private linkStyle(): string {
    if (this.onBand)
      return `color:${this.palette.onBrand};font-weight:600;text-decoration:underline;`;
    return this.style === 'hero'
      ? `color:${this.palette.link};font-weight:600;text-decoration:none;`
      : `color:${this.palette.brandDark};font-weight:600;`;
  }

  /** `inlines` drawn for the hero band: bold and links in the band's text colour. */
  bandHtml(inlines: readonly EmailInline[]): string {
    this.onBand = true;
    try {
      return this.html(inlines);
    } finally {
      this.onBand = false;
    }
  }

  /** The badge as the hero band (or body) draws it: an uppercase pill in the accent colour. */
  accentBadge(label: readonly EmailTextPart[], place: 'band' | 'body'): string {
    const { accent, onAccent } = this.palette;
    return `<table role="presentation"${place === 'band' ? ' align="right"' : ''} cellpadding="0" cellspacing="0" style="border-collapse:separate;${place === 'body' ? 'margin:0 0 16px;' : ''}"><tr><td bgcolor="${accent}" style="background:${accent};color:${onAccent};font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;line-height:1.2;padding:6px 12px;border-radius:999px;white-space:nowrap;font-family:${this.theme.font};">${escapeHtml(filledText(label, this.values))}</td></tr></table>`;
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

  /** `centred`: the opening of a mail that starts with a badge and a big heading (see `heroLength`). */
  htmlBlock(block: EmailBlock, centred = false): string {
    if (this.style === 'hero') {
      const drawn = this.heroBlock(block);
      if (drawn !== undefined) return drawn;
    }
    const { brand, brandDark, brandTint, onBrand } = this.palette;
    const align = centred ? 'text-align:center;' : '';
    switch (block.kind) {
      case 'paragraph':
        return `<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:${this.theme.bodyInk};font-family:${this.theme.font};${align}">${this.html(block.inlines)}</p>`;
      case 'button':
        // Centred, as the website centres its main call to action.
        return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" class="gt-btn" style="margin:6px auto 30px;"><tr><td align="center" bgcolor="${brand}" style="background:${brand};border-radius:999px;"><a href="${escapeHtml(this.address(block.href))}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;line-height:1.2;color:${onBrand};text-decoration:none;border-radius:999px;font-family:${this.theme.font};">${escapeHtml(filledText(block.label, this.values))}</a></td></tr></table>`;
      case 'badge': {
        const success = block.tone === 'success';
        const background = success ? '#e9f8ee' : brandTint;
        const color = success ? '#14703c' : brandDark;
        return `<table role="presentation"${centred ? ' align="center"' : ''} cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:${centred ? '0 auto 18px' : '0 0 18px'};"><tr><td style="background:${background};color:${color};font-size:12px;font-weight:700;letter-spacing:0.01em;line-height:1.2;padding:7px 14px;border-radius:999px;font-family:${this.theme.font};">${success ? '&#10003;&nbsp;' : ''}${escapeHtml(filledText(block.label, this.values))}</td></tr></table>`;
      }
      case 'heading':
        return block.level === 1
          ? `<h1 style="margin:0 0 14px;font-size:26px;line-height:1.25;font-weight:800;color:${this.theme.ink};letter-spacing:-0.02em;font-family:${this.theme.font};${align}">${this.html(block.inlines)}</h1>`
          : `<h2 style="margin:8px 0 10px;font-size:12px;line-height:1.5;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:${brandDark};font-family:${this.theme.font};">${this.html(block.inlines)}</h2>`;
      case 'details': {
        const rows = block.rows
          .map((row, index) => {
            const edge = index > 0 ? `border-top:1px solid ${this.theme.line};` : '';
            return `<tr><td style="padding:13px 16px;color:${this.theme.bodyInk};font-size:14px;line-height:1.45;font-family:${this.theme.font};${edge}">${this.html(row.label)}</td><td align="right" style="padding:13px 16px;color:${this.theme.ink};font-size:14px;font-weight:700;line-height:1.45;text-align:right;font-family:${this.theme.font};${edge}">${this.html(row.value)}</td></tr>`;
          })
          .join('');
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ${this.theme.line};border-radius:14px;margin:0 0 26px;">${rows}</table>`;
      }
      case 'progress':
        return this.progress(block.steps, block.current);
      case 'callout':
        return box(
          `background:#fff8e6;border:1px solid #f0dfa8;border-radius:14px;padding:14px 16px;font-size:13px;line-height:1.6;color:#7a6a33;font-family:${this.theme.font};`,
          this.html(block.inlines),
        );
      case 'code': {
        const label = block.label
          ? `<div style="margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${brandDark};font-family:${this.theme.font};">${this.html(block.label)}</div>`
          : '';
        return box(
          `background:${this.theme.soft};border:1px solid ${this.theme.line};border-radius:14px;padding:22px 16px;text-align:center;`,
          // A labelled value (a phone number) is set tighter, in ink; a bare one (a code) wide, in the brand.
          `${label}<div style="font-size:${block.label ? '28px' : '32px'};line-height:1.25;font-weight:800;letter-spacing:${block.label ? '0.06em' : '0.22em'};color:${block.label ? this.theme.ink : brandDark};font-family:${MONO};">${this.html(block.value)}</div>`,
        );
      }
      case 'steps': {
        const rows = block.steps
          .map((step, index) => {
            const last = index === block.steps.length - 1;
            const connector = last ? '' : `border-left:2px solid ${this.theme.line};`;
            const body =
              step.body.length > 0
                ? `<div style="font-size:13px;line-height:1.55;color:${this.theme.muted};font-family:${this.theme.font};">${this.html(step.body)}</div>`
                : '';
            // [12px][connector][12px][words]: the connector is a real cell, so it
            // stretches to the step's height in every client, Outlook included.
            return (
              `<tr><td colspan="3" width="26" valign="top" style="width:26px;padding:0;"><div style="width:26px;height:26px;line-height:26px;background:${brand};border-radius:999px;text-align:center;color:${onBrand};font-size:12px;font-weight:700;font-family:${this.theme.font};">${escapeHtml(step.number)}</div></td>` +
              `<td valign="middle" style="padding:0 0 0 14px;font-size:15px;line-height:1.35;font-weight:700;color:${this.theme.ink};font-family:${this.theme.font};">${this.html(step.title)}</td></tr>` +
              `<tr><td width="12" style="width:12px;font-size:1px;line-height:1px;">&nbsp;</td><td width="0" style="width:0;font-size:1px;line-height:1px;${connector}">&nbsp;</td><td width="12" style="width:12px;font-size:1px;line-height:1px;">&nbsp;</td>` +
              `<td valign="top" style="padding:${body === '' ? '0' : '4px'} 0 ${last ? '0' : '18px'} 14px;">${body}</td></tr>`
            );
          })
          .join('');
        return box(
          `border:1px solid ${this.theme.line};border-radius:16px;padding:20px 22px;`,
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;">${rows}</table>`,
          '0 0 26px',
        );
      }
    }
  }

  /**
   * The blocks the hero style draws its own way, as the CanadaWide website's
   * mail does; undefined for the rest, which it draws as classic does (in its
   * own type and inks, left-aligned).
   */
  private heroBlock(block: EmailBlock): string | undefined {
    const { brand, brandWash, onBrand } = this.palette;
    const { font, ink, muted, line } = this.theme;
    switch (block.kind) {
      case 'badge':
        return this.accentBadge(block.label, 'body');
      case 'heading':
        return block.level === 1
          ? `<h1 style="margin:0 0 14px;font-size:24px;line-height:1.35;font-weight:800;color:${ink};letter-spacing:-0.01em;font-family:${font};">${this.html(block.inlines)}</h1>`
          : `<h2 style="margin:6px 0 14px;font-size:11px;line-height:1.5;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${muted};font-family:${font};">${this.html(block.inlines)}</h2>`;
      case 'details': {
        const rows = block.rows
          .map((row, index) => {
            const edge = index > 0 ? `border-top:1px solid ${line};` : '';
            return `<tr><td style="padding:12px 16px;color:${muted};font-size:13px;line-height:1.45;font-family:${font};${edge}">${this.html(row.label)}</td><td align="right" style="padding:12px 16px;color:${ink};font-size:14px;font-weight:700;line-height:1.45;text-align:right;font-family:${font};${edge}">${this.html(row.value)}</td></tr>`;
          })
          .join('');
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${brandWash}" style="width:100%;border-collapse:separate;border-spacing:0;background:${brandWash};border:1px solid ${line};border-radius:14px;margin:0 0 24px;">${rows}</table>`;
      }
      case 'code': {
        const label = block.label
          ? `<div style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${muted};font-family:${font};">${this.html(block.label)}</div>`
          : '';
        return box(
          `background:${brandWash};border:1px solid ${line};border-radius:14px;padding:22px 16px;text-align:center;`,
          `${label}<div style="font-size:${block.label ? '28px' : '32px'};line-height:1.25;font-weight:800;letter-spacing:${block.label ? '0.06em' : '0.22em'};color:${block.label ? ink : this.palette.link};font-family:${MONO};">${this.html(block.value)}</div>`,
        );
      }
      case 'steps': {
        // On the card with no box, as the website's "What happens next".
        const rows = block.steps
          .map((step, index) => {
            const last = index === block.steps.length - 1;
            const body =
              step.body.length > 0
                ? `<div style="margin-top:2px;font-size:13.5px;line-height:1.55;color:${muted};font-family:${font};">${this.html(step.body)}</div>`
                : '';
            return `<tr><td width="28" valign="top" style="width:28px;padding:0 14px ${last ? '0' : '20px'} 0;"><div style="width:28px;height:28px;line-height:28px;background:${brand};border-radius:999px;text-align:center;color:${onBrand};font-size:13px;font-weight:700;font-family:${font};">${escapeHtml(step.number)}</div></td><td valign="top" style="padding:4px 0 ${last ? '0' : '20px'};"><div style="font-size:14.5px;line-height:1.4;font-weight:700;color:${ink};font-family:${font};">${this.html(step.title)}</div>${body}</td></tr>`;
          })
          .join('');
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;margin:0 0 26px;">${rows}</table>`;
      }
      default:
        return undefined;
    }
  }

  /** The website's tracker: a bubble a step joined by a line, done ✓ green, current amber, the rest grey. */
  private progress(steps: readonly (readonly EmailTextPart[])[], current: number | null): string {
    const state = (index: number): 'done' | 'current' | 'ahead' =>
      current === null || index < current ? 'done' : index === current ? 'current' : 'ahead';
    const bubbles = steps
      .map((_, index) => {
        const status = state(index);
        const [background, border, color, glyph] =
          status === 'done'
            ? [SUCCESS, SUCCESS, '#ffffff', '&#10003;']
            : status === 'current'
              ? ['#fff7e6', '#f5a623', '#f5a623', '&#9679;']
              : ['#f3f0ec', '#ddd9d3', '#c5c0ba', '&#9679;'];
        const bubble = `<td align="center" valign="middle" style="padding:0 4px;"><div style="width:32px;height:32px;line-height:32px;background:${background};border:2px solid ${border};border-radius:999px;text-align:center;color:${color};font-size:${status === 'done' ? '15px' : '12px'};font-weight:700;font-family:${this.theme.font};margin:0 auto;">${glyph}</div></td>`;
        if (index === steps.length - 1) return bubble;
        const line = status === 'done' ? `2px solid ${SUCCESS}` : `2px dashed #ddd9d3`;
        return `${bubble}<td valign="middle" style="padding:0;width:48px;"><div style="border-top:${line};margin:0 2px;font-size:1px;line-height:1px;">&nbsp;</div></td>`;
      })
      .join('');
    const labels = steps
      .map((label, index) => {
        const status = state(index);
        const color =
          status === 'done' ? SUCCESS : status === 'current' ? this.theme.ink : this.theme.faint;
        const cell = `<td align="center" valign="top" style="padding:8px 2px 0;font-size:11px;line-height:1.35;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:${color};font-family:${this.theme.font};">${escapeHtml(filledText(label, this.values))}</td>`;
        return index === steps.length - 1 ? cell : `${cell}<td style="padding:0;"></td>`;
      })
      .join('');
    return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" class="gt-progress" style="margin:4px auto 26px;"><tr>${bubbles}</tr><tr>${labels}</tr></table>`;
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
      case 'progress':
        return `Progress: ${block.steps
          .map((label, index) => {
            const name = filledText(label, this.values);
            if (block.current === null || index < block.current) return `${name} (done)`;
            return index === block.current ? `${name} (now)` : name;
          })
          .join(' > ')}`;
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

/**
 * How many opening blocks are drawn centred, as the website's hero: a mail that
 * opens with a badge then a big heading centres those two and the paragraph,
 * progress tracker and button that directly follow, in that order, if present.
 */
function heroLength(blocks: readonly EmailBlock[]): number {
  if (blocks[0]?.kind !== 'badge' || blocks[1]?.kind !== 'heading' || blocks[1].level !== 1) {
    return 0;
  }
  let length = 2;
  for (const kind of ['paragraph', 'progress', 'button'] as const) {
    if (blocks[length]?.kind === kind) length += 1;
  }
  return length;
}

/**
 * The hero style's opening: the band always holds the wordmark; a mail that
 * opens with a badge puts it in the band (top right), and one that opens with
 * a badge then a big heading also puts the heading and the paragraph directly
 * after it there.
 */
interface HeroOpening {
  badge?: Extract<EmailBlock, { kind: 'badge' }>;
  heading?: Extract<EmailBlock, { kind: 'heading' }>;
  intro?: Extract<EmailBlock, { kind: 'paragraph' }>;
  /** How many opening blocks the band holds. */
  length: number;
}

/**
 * The hero style's closing lines: a mail that ends with a paragraph, after at
 * least one other block on the card, has that paragraph drawn small and grey
 * under the hairline with the footer, as the website's "Have a question…"
 * lines are. Undefined otherwise.
 */
function heroClosing(
  blocks: readonly EmailBlock[],
  opening: HeroOpening,
): Extract<EmailBlock, { kind: 'paragraph' }> | undefined {
  const last = blocks.at(-1);
  return last?.kind === 'paragraph' && blocks.length - opening.length >= 2 ? last : undefined;
}

function heroOpening(blocks: readonly EmailBlock[]): HeroOpening {
  const [first, second, third] = blocks;
  if (first?.kind !== 'badge') return { length: 0 };
  if (second?.kind !== 'heading' || second.level !== 1) return { badge: first, length: 1 };
  if (third?.kind !== 'paragraph') return { badge: first, heading: second, length: 2 };
  return { badge: first, heading: second, intro: third, length: 3 };
}

/** The style tag both shells share; the hero adds the website's font where a client loads one. */
const RESPONSIVE_CSS = `body{margin:0;padding:0;width:100%!important;}img{border:0;outline:none;text-decoration:none;}@media only screen and (max-width:600px){.gt-card{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important;}.gt-pad{padding-left:22px!important;padding-right:22px!important;}.gt-btn{width:100%!important;}.gt-btn a{display:block!important;}.gt-progress td div{font-size:10px!important;}}`;

/** The hero card: the band in the brand colour, the content on white, closing lines under a hairline. */
function heroShell(
  branding: EmailBranding,
  palette: Palette,
  drawing: Drawing,
  opening: HeroOpening,
  content: string,
  closingLines = '',
): string {
  const { font, muted, line, ink } = HERO_THEME;
  const { brand, brandDeep, bandSoft, onBrand } = palette;
  const siteName = escapeHtml(branding.siteName);
  const badge = opening.badge ? drawing.accentBadge(opening.badge.label, 'band') : '';
  const heading = opening.heading
    ? `<h1 style="margin:16px 0 0;font-size:24px;line-height:1.35;font-weight:800;color:${onBrand};letter-spacing:-0.01em;font-family:${font};">${drawing.bandHtml(opening.heading.inlines)}</h1>`
    : '';
  const intro = opening.intro
    ? `<p style="margin:8px 0 0;font-size:14.5px;line-height:1.6;color:${bandSoft};font-family:${font};">${drawing.bandHtml(opening.intro.inlines)}</p>`
    : '';
  const footerLines = footerLinesOf(branding).map(escapeHtml);
  const signOff = [
    ...footerLines,
    `<strong style="color:${muted};font-weight:700;">${siteName}</strong>`,
  ].join('<br>');
  const closing =
    closingLines === '' ? signOff : `<div style="margin:0 0 10px;">${closingLines}</div>${signOff}`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><meta name="format-detection" content="telephone=no,address=no,email=no,date=no">',
    `<style>@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');${RESPONSIVE_CSS}</style>`,
    '</head>',
    `<body style="margin:0;padding:0;background:${HERO_CANVAS};-webkit-font-smoothing:antialiased;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${HERO_CANVAS}" style="width:100%;background:${HERO_CANVAS};"><tr><td align="center" style="padding:24px 12px 32px;">`,
    `<table role="presentation" class="gt-card" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border-collapse:separate;font-family:${font};color:${ink};">`,
    // The band: a solid brand colour first, for clients that draw no gradient.
    `<tr><td class="gt-pad" bgcolor="${brand}" style="background:${brand};background-image:linear-gradient(135deg,${brand},${brandDeep});padding:30px 28px 26px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr>`,
    `<td valign="middle" style="font-size:13px;line-height:1.3;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${bandSoft};font-family:${font};">${siteName}</td>`,
    `<td align="right" valign="middle">${badge}</td>`,
    '</tr></table>',
    `${heading}${intro}`,
    '</td></tr>',
    `<tr><td class="gt-pad" style="padding:26px 28px 8px;">${content}</td></tr>`,
    `<tr><td class="gt-pad" style="padding:6px 28px 26px;"><div style="border-top:1px solid ${line};padding-top:16px;font-size:12px;line-height:1.6;color:${muted};font-family:${font};">${closing}</div></td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');
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
      ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.6;color:${MUTED};font-family:${FONT};">${footerLines.map(escapeHtml).join('<br>')}</p>`
      : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">',
    `<style>${RESPONSIVE_CSS}</style>`,
    '</head>',
    `<body style="margin:0;padding:0;background:${CANVAS};-webkit-font-smoothing:antialiased;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${CANVAS};"><tr><td align="center" style="padding:32px 16px 40px;">`,
    `<table role="presentation" class="gt-card" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:20px;overflow:hidden;border-collapse:separate;font-family:${FONT};color:${INK};">`,
    `<tr><td class="gt-pad" align="center" style="padding:30px 32px 24px;background:#ffffff;">${header}</td></tr>`,
    `<tr><td style="height:4px;line-height:4px;font-size:4px;background:${palette.brand};">&nbsp;</td></tr>`,
    `<tr><td class="gt-pad" style="padding:30px 32px 12px;">${content}</td></tr>`,
    // The footer is the card's quiet bottom band, as on the website's mail: the site name in the
    // brand's colour over the footer lines, never a block that could pass for a second button.
    `<tr><td class="gt-pad" align="center" style="padding:22px 32px 24px;background:${SOFT};border-top:1px solid ${LINE};">`,
    `<div style="font-size:15px;line-height:1.3;font-weight:800;letter-spacing:-0.01em;color:${palette.brandDark};font-family:${FONT};">${siteName}</div>${footerText}`,
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');
}

/** The letter's own inks: a plain page, so cooler and quieter than either card. */
const LETTER = { ink: '#101828', body: '#344054', muted: '#667085', line: '#eaecf0' } as const;
const LETTER_FONT =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** `https://www.example.com/` as people say it: `example.com`. Nothing for an address that is not a web address. */
function siteHost(siteUrl: string | null): { href: string; label: string } | undefined {
  if (!siteUrl) return undefined;
  try {
    const url = new URL(siteUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return { href: url.origin, label: url.hostname.replace(/^www\./, '') };
  } catch {
    return undefined;
  }
}

/**
 * The site's mark: its logo alone when it has one (a site's logo is its name
 * already), else its initial on the brand colour beside its name.
 */
function wordmark(branding: EmailBranding, palette: Palette, size: 'header' | 'footer'): string {
  const siteName = escapeHtml(branding.siteName);
  const big = size === 'header';
  if (branding.logoUrl) {
    const height = big ? 44 : 28;
    return `<img src="${escapeHtml(branding.logoUrl)}" alt="${siteName}" height="${height}" style="display:block;height:${height}px;width:auto;max-width:${big ? 220 : 150}px;border:0;font-family:${LETTER_FONT};font-size:${big ? 20 : 15}px;font-weight:700;color:${LETTER.ink};">`;
  }
  const mark = big ? 36 : 26;
  const initial = escapeHtml(Array.from(branding.siteName.trim())[0]?.toUpperCase() ?? '');
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>` +
    `<td valign="middle" style="padding:0 ${big ? 12 : 9}px 0 0;"><div style="width:${mark}px;height:${mark}px;line-height:${mark}px;border-radius:${big ? 9 : 7}px;background:${palette.brand};color:${palette.onBrand};text-align:center;font-size:${big ? 18 : 13}px;font-weight:700;font-family:${LETTER_FONT};">${initial}</div></td>` +
    `<td valign="middle" style="font-size:${big ? 20 : 15}px;line-height:1.2;font-weight:700;letter-spacing:-0.01em;color:${LETTER.ink};font-family:${LETTER_FONT};">${siteName}</td>` +
    `</tr></table>`
  );
}

/**
 * A message a person wrote (the lead's Mail tab, Ask AI's draft): a letter on
 * a plain white page rather than a card. The site's logo (or mark and name) on
 * top, the words as they were written, then a quiet footer: the footer lines, and the
 * mark again beside the site's address. No band, no button: nothing here is
 * the site's design speaking, only the person who wrote.
 */
function letterShell(branding: EmailBranding, siteUrl: string | null, bodyHtml: string): string {
  const palette = paletteFor(branding.brandColor, branding.accentColor);
  const footerLines = footerLinesOf(branding).map(escapeHtml);
  const site = siteHost(siteUrl);
  const small = `font-size:13px;line-height:1.6;color:${LETTER.muted};font-family:${LETTER_FONT};`;
  const footerText =
    footerLines.length > 0
      ? `<p style="margin:0 0 20px;${small}">${footerLines.join('<br>')}</p>`
      : '';
  const siteLink = site
    ? `<a href="${escapeHtml(site.href)}" style="${small}color:${palette.brandDark};text-decoration:underline;">${escapeHtml(site.label)}</a>`
    : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">',
    `<style>${RESPONSIVE_CSS}</style>`,
    '</head>',
    '<body style="margin:0;padding:0;background:#ffffff;-webkit-font-smoothing:antialiased;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;background:#ffffff;"><tr><td align="center" style="padding:0;">',
    `<table role="presentation" class="gt-card" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;font-family:${LETTER_FONT};color:${LETTER.ink};">`,
    `<tr><td class="gt-pad" style="padding:40px 40px 0;">${wordmark(branding, palette, 'header')}</td></tr>`,
    `<tr><td class="gt-pad" style="padding:40px 40px 0;"><div style="white-space:pre-wrap;font-size:16px;line-height:1.65;color:${LETTER.body};font-family:${LETTER_FONT};">${bodyHtml}</div></td></tr>`,
    `<tr><td class="gt-pad" style="padding:44px 40px 0;"><div style="border-top:1px solid ${LETTER.line};padding-top:24px;">${footerText}`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr>',
    `<td valign="middle">${wordmark(branding, palette, 'footer')}</td>`,
    `<td align="right" valign="middle">${siteLink}</td>`,
    '</tr></table></div></td></tr>',
    '<tr><td style="height:40px;line-height:40px;font-size:0;">&nbsp;</td></tr>',
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
  const footerLines = footerLinesOf(branding);
  let html: string;
  let drawing: Drawing;
  if (branding.style === 'hero') {
    const palette = paletteFor(branding.brandColor, branding.accentColor);
    drawing = new Drawing(input.values, palette, 'hero', HERO_THEME);
    const opening = heroOpening(body.blocks);
    const closing = heroClosing(body.blocks, opening);
    const content = body.blocks
      .slice(opening.length, closing ? -1 : undefined)
      .map((block) => drawing.htmlBlock(block))
      .join('');
    html = heroShell(
      branding,
      palette,
      drawing,
      opening,
      content,
      closing ? drawing.html(closing.inlines) : '',
    );
  } else {
    const palette = paletteFor(branding.brandColor);
    drawing = new Drawing(input.values, palette);
    const hero = heroLength(body.blocks);
    html = shell(
      branding,
      palette,
      body.blocks.map((block, index) => drawing.htmlBlock(block, index < hero)).join(''),
    );
  }

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
  /** The site's address, linked under the message; absent or null, no link. */
  siteUrl?: string | null;
}): { subject: string; text: string; html: string } {
  const { branding } = input;
  const footer = branding.footerText || branding.siteName;
  return {
    subject: input.subject,
    text: `${input.body}\n\n--\n${footer}`,
    html: letterShell(branding, input.siteUrl ?? null, escapeHtml(input.body)),
  };
}
