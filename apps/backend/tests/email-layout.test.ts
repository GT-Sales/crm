import { describe, expect, it } from 'vitest';

import { DEFAULT_LEAD_ORDER, type LeadOrder, type PlanSnapshot } from '@gt-sales/contracts';

import {
  fillInValuesForLead,
  formatPlanPrice,
  sampleFillInValues,
} from '../src/email/fill-in-values.js';
import {
  renderCustomerEmail,
  renderPlainCustomerEmail,
  type EmailBranding,
} from '../src/email/layout.js';

const branding: EmailBranding = {
  siteName: 'Get Canada Sim',
  logoUrl: null,
  brandColor: '#0a7d3e',
  footerText: 'Get Canada Sim\n123 Main St, Toronto',
};

function rendered(input: Partial<Parameters<typeof renderCustomerEmail>[0]>) {
  const result = renderCustomerEmail({
    template: 'dispatched',
    subject: 'Hello',
    body: 'Body',
    branding,
    values: {},
    ...input,
  });
  if (!result.ok) throw new Error(`expected a rendered mail, got ${JSON.stringify(result)}`);
  return result;
}

describe('renderCustomerEmail', () => {
  it('escapes every value in the HTML and leaves it raw in the text', () => {
    const mail = rendered({
      subject: 'For {first name}',
      body: 'Hi {first name} <i>{last name}</i>',
      values: { 'first name': '<b>Ann</b> & co', 'last name': '"Lee"' },
    });
    expect(mail.html).toContain(
      'Hi &lt;b&gt;Ann&lt;/b&gt; &amp; co &lt;i&gt;&quot;Lee&quot;&lt;/i&gt;',
    );
    expect(mail.html).not.toContain('<b>Ann</b>');
    expect(mail.text).toContain('Hi <b>Ann</b> & co <i>"Lee"</i>');
    expect(mail.text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
  });

  it('fills the subject and never escapes it', () => {
    const mail = rendered({
      subject: 'Order for {first name} — {site name}',
      values: { 'first name': '<b>Ann</b> & co', 'site name': 'Get Canada Sim' },
    });
    expect(mail.subject).toBe('Order for <b>Ann</b> & co — Get Canada Sim');
  });

  it('puts a value with a newline on one subject line', () => {
    const mail = rendered({
      subject: 'Hi {first name}',
      values: { 'first name': 'Ann\r\nBcc: x' },
    });
    expect(mail.subject).toBe('Hi Ann Bcc: x');
  });

  it('draws the button in the brand colour, with its address', () => {
    const mail = rendered({
      body: 'Your parcel is on its way.\n\n[button: Track your order]({tracking link})',
      values: { 'tracking link': 'https://shop.example/track?a=1&b=2' },
    });
    expect(mail.html).toContain(
      'bgcolor="#0a7d3e" style="background:#0a7d3e;border-radius:999px;"',
    );
    expect(mail.html).toContain(
      'padding:14px 32px;font-size:15px;font-weight:700;line-height:1.2;color:#ffffff;',
    );
    expect(mail.html).toContain('href="https://shop.example/track?a=1&amp;b=2"');
    expect(mail.html).toContain('>Track your order</a>');
    expect(mail.text).toContain('Track your order: https://shop.example/track?a=1&b=2');
  });

  it('fills the button label, escaped in the HTML and raw in the text', () => {
    const mail = rendered({
      body: '[button: Track {first name}’s order]({tracking link})',
      values: { 'first name': '<b>Ann</b>', 'tracking link': 'https://a.test/track' },
    });
    expect(mail.html).toContain('>Track &lt;b&gt;Ann&lt;/b&gt;’s order</a>');
    expect(mail.html).not.toContain('{first name}');
    expect(mail.text).toContain('Track <b>Ann</b>’s order: https://a.test/track');
  });

  it('refuses a button label whose fill-in has no value', () => {
    expect(
      renderCustomerEmail({
        template: 'dispatched',
        subject: 'Hello',
        body: '[button: Track {first name}’s order](https://a.test)',
        branding,
        values: {},
      }),
    ).toEqual({ ok: false, missing: ['first name'] });
  });

  it('writes a link as its label then its address in the text', () => {
    const mail = rendered({ body: 'Read [the **guide**](https://example.test/g) today.' });
    expect(mail.html).toContain(
      '<a href="https://example.test/g" style="color:#096a35;font-weight:600;">the <strong style="color:#15130f;">guide</strong></a>',
    );
    expect(mail.text).toContain('Read the guide (https://example.test/g) today.');
  });

  it('falls back to the default colour for a colour that is not #rrggbb', () => {
    const mail = rendered({
      body: '[button: Go](https://a.test)',
      branding: { ...branding, brandColor: 'red;background:url(x)' },
    });
    expect(mail.html).toContain('style="background:#d72638;border-radius:999px;"');
    expect(mail.html).not.toContain('url(x)');
  });

  it('heads the mail with the logo when there is one, else the site name', () => {
    const withLogo = rendered({
      branding: { ...branding, siteName: 'A & B', logoUrl: 'https://cdn.example/logo.png?v=1&s=2' },
    });
    expect(withLogo.html).toContain(
      '<img src="https://cdn.example/logo.png?v=1&amp;s=2" alt="A &amp; B" height="60"',
    );
    const withoutLogo = rendered({ branding: { ...branding, siteName: 'A & B' } });
    expect(withoutLogo.html).not.toContain('<img');
    expect(withoutLogo.html).toContain(
      'font-size:22px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#15130f;',
    );
    expect(withoutLogo.html).toContain('>A &amp; B</');
  });

  it('lays the mail out as a 560px rounded card on the canvas, under a rule in the brand colour', () => {
    const mail = rendered({});
    expect(mail.html).toContain('<body style="margin:0;padding:0;background:#f4ece1;');
    expect(mail.html).toContain(
      'class="gt-card" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:#ffffff;border:1px solid #efe7dd;border-radius:20px;',
    );
    expect(mail.html).toContain("font-family:'Inter',-apple-system,");
    expect(mail.html).toContain('height:4px;line-height:4px;font-size:4px;background:#0a7d3e;');
  });

  it('ends with the footer lines in the HTML and after -- in the text', () => {
    const mail = rendered({ body: 'Hello there.' });
    expect(mail.html).toContain('background:#0a7d3e;border-radius:16px;');
    expect(mail.html).toContain(
      "color:#ffffff;opacity:0.9;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\">Get Canada Sim<br>123 Main St, Toronto</p>",
    );
    expect(mail.text).toBe('Hello there.\n\n--\nGet Canada Sim\n123 Main St, Toronto');
  });

  it('signs with the site name when there is no footer', () => {
    const mail = rendered({ body: 'Hello there.', branding: { ...branding, footerText: '  ' } });
    expect(mail.text).toBe('Hello there.\n\n--\nGet Canada Sim');
  });

  it('writes paragraphs and breaks into both parts', () => {
    const mail = rendered({ body: 'One\ntwo\n\n**Three**' });
    expect(mail.html).toContain('One<br>two</p>');
    expect(mail.html).toContain('<strong style="color:#15130f;">Three</strong>');
    expect(mail.text.startsWith('One\ntwo\n\nThree\n\n--\n')).toBe(true);
  });

  it('refuses a missing value and renders nothing', () => {
    expect(
      renderCustomerEmail({
        template: 'dispatched',
        subject: 'On its way',
        body: 'Tracking number: {tracking number}',
        branding,
        values: { courier: 'Canada Post' },
      }),
    ).toEqual({ ok: false, missing: ['tracking number'] });
  });

  it('lists every missing value once, subject first, in order of first use', () => {
    expect(
      renderCustomerEmail({
        template: 'dispatched',
        subject: '{plan} for {first name}',
        body: '{courier} {plan} {first name}\n\n[button: Track]({tracking link})',
        branding,
        values: { 'first name': '   ', plan: '' },
      }),
    ).toEqual({ ok: false, missing: ['plan', 'first name', 'courier', 'tracking link'] });
  });

  it('returns the markup error of the subject before the body', () => {
    expect(
      renderCustomerEmail({
        template: 'cancelled',
        subject: '{courier}',
        body: '{nope}',
        branding,
        values: {},
      }),
    ).toEqual({ ok: false, error: 'invalid_fill_in', fillIn: 'courier', where: 'subject' });
    expect(
      renderCustomerEmail({
        template: 'cancelled',
        subject: 'Hi',
        body: '[x](javascript:alert(1))',
        branding,
        values: {},
      }),
    ).toEqual({ ok: false, error: 'invalid_email_markup', reason: 'bad_link' });
  });

  it('renders the same input to the same output', () => {
    const input = {
      template: 'dispatched' as const,
      subject: 'Hi {first name}',
      body: 'Body {courier}',
      branding,
      values: { 'first name': 'Ann', courier: 'Canada Post' },
    };
    expect(renderCustomerEmail(input)).toEqual(renderCustomerEmail(input));
  });
});

describe('renderCustomerEmail blocks', () => {
  const evil = { 'first name': '<b>Ann</b> & co' };

  it('draws a badge as a pill in a tint of the brand, and a success badge in green with a tick', () => {
    const mail = rendered({
      body: '[badge: Hi {first name}]\n\n[badge success: Order confirmed]',
      values: evil,
    });
    expect(mail.html).toContain(
      'background:#e7f2ec;color:#096a35;font-size:12px;font-weight:700;letter-spacing:0.01em;line-height:1.2;padding:7px 14px;border-radius:999px;',
    );
    expect(mail.html).toContain('>Hi &lt;b&gt;Ann&lt;/b&gt; &amp; co</td>');
    expect(mail.html).toContain('background:#e9f8ee;color:#14703c;');
    expect(mail.html).toContain('>&#10003;&nbsp;Order confirmed</td>');
    expect(mail.text.startsWith('[Hi <b>Ann</b> & co]\n\n[Order confirmed]\n\n--')).toBe(true);
  });

  it('draws # as a big heading and ## as an uppercase section heading in the brand', () => {
    const mail = rendered({
      body: '# Thanks, {first name}!\n# Your order is in.\nWe have it.\n\n## What next',
      values: evil,
    });
    expect(mail.html).toContain(
      'font-size:26px;line-height:1.25;font-weight:800;color:#15130f;letter-spacing:-0.02em;',
    );
    expect(mail.html).toContain(
      '>Thanks, &lt;b&gt;Ann&lt;/b&gt; &amp; co!<br>Your order is in.</h1>',
    );
    expect(mail.html).toContain('We have it.</p>');
    expect(mail.html).toContain('text-transform:uppercase;letter-spacing:0.08em;color:#096a35;');
    expect(mail.html).toContain('>What next</h2>');
    expect(mail.text).toContain(
      'Thanks, <b>Ann</b> & co!\nYour order is in.\n\nWe have it.\n\nWHAT NEXT\n\n--',
    );
  });

  it('draws **Label:** value lines as a bordered details box, and as Label: value lines in the text', () => {
    const mail = rendered({
      body: '**Courier:** {courier}\n**Tracking <no>:** [{tracking number}](https://t.test/?a=1&b=2)',
      values: { courier: 'A & B', 'tracking number': '<LX1>' },
    });
    expect(mail.html).toContain('border:1px solid #efe7dd;border-radius:14px;margin:0 0 26px;');
    expect(mail.html).toContain('>Courier</td>');
    expect(mail.html).toContain('text-align:right;');
    expect(mail.html).toContain('>A &amp; B</td>');
    expect(mail.html).toContain('>Tracking &lt;no&gt;</td>');
    expect(mail.html).toContain('href="https://t.test/?a=1&amp;b=2"');
    expect(mail.html).toContain('>&lt;LX1&gt;</a>');
    expect(mail.text).toContain(
      'Courier: A & B\nTracking <no>: <LX1> (https://t.test/?a=1&b=2)\n\n--',
    );
  });

  it('draws > lines as a highlighted box', () => {
    const mail = rendered({
      body: '> **Wrong number?** Reply, {first name}.\n> We will fix it.',
      values: evil,
    });
    expect(mail.html).toContain('background:#fff8e6;border:1px solid #f0dfa8;border-radius:14px;');
    expect(mail.html).toContain(
      '<strong style="color:#15130f;">Wrong number?</strong> Reply, &lt;b&gt;Ann&lt;/b&gt; &amp; co.<br>We will fix it.</td>',
    );
    expect(mail.text).toContain('Wrong number? Reply, <b>Ann</b> & co.\nWe will fix it.\n\n--');
  });

  it('draws a backticked line as a code box, with the line above as its label', () => {
    const mail = rendered({
      body: 'Your <number>\n`{SIM number}`\n\n`{tracking number}`',
      values: { 'SIM number': '+1 <647>', 'tracking number': 'LX&1' },
    });
    expect(mail.html).toContain(
      'background:#fbf7f2;border:1px solid #efe7dd;border-radius:14px;padding:22px 16px;text-align:center;',
    );
    expect(mail.html).toContain('>Your &lt;number&gt;</div>');
    expect(mail.html).toContain('letter-spacing:0.06em;color:#15130f;');
    expect(mail.html).toContain('>+1 &lt;647&gt;</div>');
    expect(mail.html).toContain(
      'font-size:32px;line-height:1.25;font-weight:800;letter-spacing:0.22em;color:#096a35;',
    );
    expect(mail.html).toContain('>LX&amp;1</div>');
    expect(mail.text).toContain('Your <number>\n    +1 <647>\n\n    LX&1\n\n--');
  });

  it('draws steps as numbered bubbles in the brand, joined by a line, in one box', () => {
    const mail = rendered({
      body: '1. Placed\nWe have {first name}’s order.\n\n2. Shipped\n3) Active',
      values: evil,
    });
    expect(mail.html.match(/border-radius:999px;text-align:center;color:#ffffff;/g)).toHaveLength(
      3,
    );
    expect(mail.html).toContain('background:#0a7d3e;border-radius:999px;');
    expect(mail.html).toContain('>1</div>');
    expect(mail.html).toContain('>3</div>');
    expect(mail.html.match(/border-left:2px solid #efe7dd;/g)).toHaveLength(2);
    expect(mail.html).toContain('>We have &lt;b&gt;Ann&lt;/b&gt; &amp; co’s order.</div>');
    expect(mail.text).toContain(
      '1. Placed\n   We have <b>Ann</b> & co’s order.\n2. Shipped\n3. Active\n\n--',
    );
  });

  it('refuses a block whose fill-in has no value', () => {
    expect(
      renderCustomerEmail({
        template: 'dispatched',
        subject: 'Hi',
        body: '[badge: {courier}]\n\n`{SIM number}`\n\n1. {plan}',
        branding,
        values: {},
      }),
    ).toEqual({ ok: false, missing: ['courier', 'SIM number', 'plan'] });
  });

  it('writes ink, not white, on a light brand colour', () => {
    const mail = rendered({
      body: '[button: Go](https://a.test)',
      branding: { ...branding, brandColor: '#ffd84d' },
    });
    expect(mail.html).toContain('line-height:1.2;color:#15130f;text-decoration:none;');
    expect(mail.html).not.toContain('color:#ffffff;text-decoration:none;');
  });

  it('names the site in the footer block even with no footer text', () => {
    const mail = rendered({ branding: { ...branding, footerText: '' } });
    expect(mail.html).toContain("color:#ffffff;font-family:'Inter'");
    expect(mail.html.match(/>Get Canada Sim<\/div>/g)?.length).toBe(2);
    expect(mail.html).not.toContain('opacity:0.9');
  });
});

describe('renderPlainCustomerEmail', () => {
  it('draws the staff message escaped, in the same card', () => {
    const mail = renderPlainCustomerEmail({
      subject: 'Hello',
      body: 'Line <one>\nLine two',
      branding,
    });
    expect(mail.html).toContain('class="gt-card"');
    expect(mail.html).toContain('white-space:pre-wrap;');
    expect(mail.html).toContain('>Line &lt;one&gt;\nLine two</div>');
    expect(mail.text).toBe('Line <one>\nLine two\n\n--\nGet Canada Sim\n123 Main St, Toronto');
  });
});

describe('formatPlanPrice', () => {
  it.each([
    [4000, 'month', '$40.00/month'],
    [4000, 'one_time', '$40.00'],
    [123450, '30_days', '$1,234.50/30 days'],
    [999, '90_days', '$9.99/90 days'],
    [0, 'year', '$0.00/year'],
  ] as const)('formats %i %s as %s', (priceMinor, billingPeriod, expected) => {
    expect(formatPlanPrice({ priceMinor, billingPeriod })).toBe(expected);
  });
});

const plan: PlanSnapshot = {
  planId: '10000000-0000-4000-8000-000000000401',
  name: 'Rogers 60GB',
  priceMinor: 4000,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: [],
  properties: {},
  frozenAt: '2026-10-30T12:00:00.000Z',
};
const order: LeadOrder = {
  ...DEFAULT_LEAD_ORDER,
  planId: plan.planId,
  plan,
  courier: 'Canada Post',
  trackingNumber: 'LX1CA',
};
const site = { siteName: 'Get Canada Sim', siteUrl: 'https://getcanadasim.example/' };

describe('fillInValuesForLead', () => {
  it('reads the form, the frozen plan and the order', () => {
    expect(
      fillInValuesForLead(
        {
          leadType: 'sim_order',
          externalRef: null,
          customValues: {},
          fullName: 'Nadia Khan',
          form: {
            firstName: ' Nadia ',
            lastName: 'Khan',
            simNumber: '+1 647 555 0123',
            planLabel: 'Old',
          },
          order,
        },
        site,
      ),
    ).toEqual({
      'first name': 'Nadia',
      'last name': 'Khan',
      'site name': 'Get Canada Sim',
      plan: 'Rogers 60GB',
      price: '$40.00/month',
      'SIM number': '+1 647 555 0123',
      courier: 'Canada Post',
      'tracking number': 'LX1CA',
      'tracking link': 'https://getcanadasim.example/track',
    });
  });

  it('splits the full name and falls back to the form plan label', () => {
    expect(
      fillInValuesForLead(
        {
          leadType: 'sim_order',
          externalRef: null,
          customValues: {},
          fullName: '  Mary  Ann Lee ',
          form: { planLabel: 'Freedom 20GB', code: '123' },
          order: null,
        },
        { siteName: 'CanadaWide', siteUrl: null },
      ),
    ).toEqual({
      'first name': 'Mary',
      'last name': 'Ann Lee',
      'site name': 'CanadaWide',
      plan: 'Freedom 20GB',
    });
  });

  it('leaves out what the lead does not have, and never a code', () => {
    const values = fillInValuesForLead(
      {
        leadType: 'sim_order',
        externalRef: null,
        customValues: {},
        fullName: 'Cher',
        form: { firstName: '', simNumber: 42, code: '123456' },
        order: DEFAULT_LEAD_ORDER,
      },
      { siteName: 'CanadaWide', siteUrl: null },
    );
    expect(values).toEqual({ 'first name': 'Cher', 'site name': 'CanadaWide' });
    expect(values).not.toHaveProperty('code');
  });
});

describe('sampleFillInValues', () => {
  it('gives a value for every fill-in', () => {
    expect(sampleFillInValues(site)).toEqual({
      'first name': 'Nadia',
      'last name': 'Khan',
      'site name': 'Get Canada Sim',
      plan: 'Rogers 60GB',
      price: '$40.00/month',
      'SIM number': '+1 647 555 0123',
      courier: 'Canada Post',
      'tracking number': 'LX123456789CA',
      'tracking link': 'https://getcanadasim.example/track',
      'order number': 'MS-1042',
      code: '483920',
    });
  });

  it('uses example.com for a site with no address', () => {
    expect(sampleFillInValues({ siteName: 'X', siteUrl: null })['tracking link']).toBe(
      'https://example.com/track',
    );
  });
});
