import { describe, expect, it } from 'vitest';

import {
  renderCustomerEmail,
  renderPlainCustomerEmail,
  type EmailBranding,
} from '../src/email/layout.js';

// The hero style (the CanadaWide website's mail): the band in the brand
// colour holds the wordmark, the opening badge and, after a badge, the big
// heading and its intro.

const branding: EmailBranding = {
  siteName: 'CanadaWide',
  logoUrl: 'https://www.canadawideinternet.com/assets/images/logo/logo-dark.png',
  brandColor: '#0966ff',
  footerText: 'CanadaWide Internet\nSaskatoon, SK',
  style: 'hero',
  accentColor: '#c0ff72',
};

function rendered(body: string, overrides: Partial<EmailBranding> = {}, values = {}) {
  const result = renderCustomerEmail({
    template: 'order_received',
    subject: 'Order {order number}',
    body,
    branding: { ...branding, ...overrides },
    values: {
      'first name': 'Nadia',
      'order number': 'CW-1042',
      plan: 'Home Internet 500',
      ...values,
    },
  });
  if (!result.ok) throw new Error(`expected a rendered mail, got ${JSON.stringify(result)}`);
  return result;
}

/** The band cell's HTML: from its gradient to the card's content cell. */
function band(html: string): string {
  const start = html.indexOf('linear-gradient(135deg');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('padding:26px 28px 8px;'));
}

/** The card's content cell, after the band. */
function content(html: string): string {
  const start = html.indexOf('padding:26px 28px 8px;');
  return html.slice(start, html.indexOf('border-top:1px solid #e8eaee;padding-top:16px'));
}

const OPENING = [
  '[badge success: Order received]',
  '# Thanks, {first name}\n# we got your order!',
  'Our team will call you shortly.',
  '**Your plan:** {plan}\n**Order number:** {order number}',
  '## What happens next',
  '1. We review your order\nWe check the plan.\n2. We call you',
  '[button: Call us](https://example.com/call)',
].join('\n\n');

describe('hero style', () => {
  it('draws the band in the brand colour, solid first, then the gradient to a deeper shade', () => {
    const { html } = rendered(OPENING);
    expect(html).toContain(
      'bgcolor="#0966ff" style="background:#0966ff;background-image:linear-gradient(135deg,#0966ff,',
    );
    expect(html).toContain('background:#eef2f7;');
    expect(html).toContain("'Plus Jakarta Sans'");
    expect(html).toContain('fonts.googleapis.com/css2?family=Plus+Jakarta+Sans');
  });

  it('puts the wordmark, the accent badge, the heading and the intro in the band', () => {
    const { html } = rendered(OPENING);
    const top = band(html);
    expect(top).toContain('text-transform:uppercase;color:#dae8ff;');
    expect(top).toContain('>CanadaWide</td>');
    expect(top).toContain('align="right"');
    expect(top).toMatch(/background:#c0ff72;color:#[0-9a-f]{6};[^"]*">Order received<\/td>/);
    expect(top).toContain('color:#ffffff;letter-spacing:-0.01em;');
    expect(top).toContain('Thanks, Nadia<br>we got your order!</h1>');
    expect(top).toContain('Our team will call you shortly.</p>');
    // Drawn once: not again in the card's content.
    const body = content(html);
    expect(body).not.toContain('Order received');
    expect(body).not.toContain('Thanks, Nadia');
    expect(body).not.toContain('Our team will call you shortly.');
    expect(body).toContain('Home Internet 500');
  });

  it('never draws the logo: the wordmark reads on the band', () => {
    expect(rendered(OPENING).html).not.toContain('<img');
  });

  it('a dark accent badge has white text; no accent uses a light tint of the brand', () => {
    expect(band(rendered(OPENING, { accentColor: '#1a1a1a' }).html)).toContain(
      'background:#1a1a1a;color:#ffffff;',
    );
    const tinted = band(rendered(OPENING, { accentColor: null }).html);
    expect(tinted).not.toContain('#c0ff72');
    expect(tinted).toMatch(/background:#d[0-9a-f]e[0-9a-f]ff;/);
  });

  it('escapes the site name, badge, heading and intro in the band', () => {
    const { html } = rendered(
      '[badge: <b>{first name}</b>]\n\n# Hi <i>{first name}</i>\n\nIntro & <script>x</script>',
      { siteName: 'A <b>"site"</b>' },
      { 'first name': '<img src=x>' },
    );
    expect(html).toContain('A &lt;b&gt;&quot;site&quot;&lt;/b&gt;');
    expect(html).toContain('&lt;b&gt;&lt;img src=x&gt;&lt;/b&gt;');
    expect(html).toContain('Hi &lt;i&gt;&lt;img src=x&gt;&lt;/i&gt;</h1>');
    expect(html).toContain('Intro &amp; &lt;script&gt;x&lt;/script&gt;</p>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<script>');
  });

  it('bold and links in the band are drawn in the band’s text colour', () => {
    const { html } = rendered(
      '[badge: Hi]\n\n# Hi **{first name}**\n\nSee [your order](https://example.com/o).',
    );
    const top = band(html);
    expect(top).toContain('<strong style="color:#ffffff;">Nadia</strong>');
    expect(top).toContain(
      '<a href="https://example.com/o" style="color:#ffffff;font-weight:600;text-decoration:underline;">your order</a>',
    );
  });

  it('a mail that opens with a badge but no big heading has only the badge in the band', () => {
    const { html } = rendered('[badge: Tracking code]\n\nYour code is ready.\n\n# Later heading');
    const top = band(html);
    expect(top).toContain('>Tracking code</td>');
    expect(top).not.toContain('<h1');
    expect(top).not.toContain('Your code is ready.');
    expect(content(html)).toContain('Your code is ready.');
    expect(content(html)).toContain('Later heading</h1>');
  });

  it('a mail that opens with a heading, not a badge, keeps everything in the card, left-aligned', () => {
    const { html } = rendered('# Hi {first name}\n\nWelcome.\n\n[badge: Later]');
    const top = band(html);
    expect(top).toContain('>CanadaWide</td>');
    expect(top).not.toContain('<h1');
    expect(top).not.toContain('Later');
    const body = content(html);
    expect(body).toContain('Hi Nadia</h1>');
    expect(body).not.toContain('text-align:center');
    // A later badge is the accent pill, on the card's left.
    expect(body).toMatch(
      /<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 16px;">.*>Later<\/td>/,
    );
  });

  it('a badge and heading with no paragraph after them leaves the next block in the card', () => {
    const { html } = rendered(
      '[badge: Hi]\n\n# Hello\n\n**Plan:** {plan}\n**Order number:** {order number}',
    );
    expect(band(html)).toContain('Hello</h1>');
    expect(band(html)).not.toContain('Home Internet 500');
    expect(content(html)).toContain('Home Internet 500');
  });

  it('draws steps on the card with no box, details on a wash of the brand, and closing lines under a hairline', () => {
    const { html } = rendered(OPENING);
    const body = content(html);
    expect(body).not.toContain('border-radius:16px;padding:20px 22px');
    expect(body).toContain('width:28px;height:28px;line-height:28px;background:#0966ff;');
    expect(body).toContain('bgcolor="#f8faff"');
    expect(body).toContain('What happens next</h2>');
    expect(html).toContain(
      'border-top:1px solid #e8eaee;padding-top:16px;font-size:12px;line-height:1.6;color:#6b7280;',
    );
    expect(html).toContain(
      'CanadaWide Internet<br>Saskatoon, SK<br><strong style="color:#6b7280;font-weight:700;">CanadaWide</strong>',
    );
    // No separate footer band.
    expect(html).not.toContain('#fbf7f2');
  });

  it('draws a closing paragraph small and grey under the hairline, above the footer', () => {
    const { html, text } = rendered(
      `${OPENING}\n\nQuestions? Reply or write to [us](https://example.com/help).`,
    );
    expect(content(html)).not.toContain('Questions?');
    const closing = html.slice(html.indexOf('border-top:1px solid #e8eaee;padding-top:16px'));
    expect(closing).toContain(
      '<div style="margin:0 0 10px;">Questions? Reply or write to <a href="https://example.com/help" style="color:#0966ff;font-weight:600;text-decoration:none;">us</a>.</div>CanadaWide Internet<br>',
    );
    // The plain text keeps it where it was written.
    expect(text).toContain('Questions? Reply or write to us (https://example.com/help).\n\n--\n');
  });

  it('keeps a last paragraph on the card when it is the only block after the band', () => {
    const { html } = rendered('[badge: Hi]\n\n# Hello\n\nIntro.\n\nThe only words on the card.');
    expect(content(html)).toContain('The only words on the card.</p>');
    const plain = rendered('Just one paragraph.');
    expect(content(plain.html)).toContain('Just one paragraph.</p>');
  });

  it('writes the same plain text as the classic style', () => {
    const hero = rendered(OPENING);
    const classic = rendered(OPENING, { style: 'classic' });
    expect(hero.text).toBe(classic.text);
    expect(hero.subject).toBe(classic.subject);
    expect(hero.html).not.toBe(classic.html);
  });

  it('reads white text on a light brand colour as ink', () => {
    const top = band(rendered(OPENING, { brandColor: '#f7e04b' }).html);
    expect(top).toContain('color:#15130f;letter-spacing:-0.01em;');
  });

  it('draws a staff-written message in the hero card, escaped', () => {
    const mail = renderPlainCustomerEmail({
      subject: 'Hello',
      body: 'Hi <there>\nLine two',
      branding,
    });
    expect(mail.html).toContain('linear-gradient(135deg,#0966ff,');
    expect(mail.html).toContain('Hi &lt;there&gt;\nLine two');
    expect(mail.text).toBe('Hi <there>\nLine two\n\n--\nCanadaWide Internet\nSaskatoon, SK');
  });
});
