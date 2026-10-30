import { describe, expect, it } from 'vitest';

import { DEFAULT_LEAD_ORDER, type LeadOrder, type PlanSnapshot } from '@gt-sales/contracts';

import {
  fillInValuesForLead,
  formatPlanPrice,
  sampleFillInValues,
} from '../src/email/fill-in-values.js';
import { renderCustomerEmail, type EmailBranding } from '../src/email/layout.js';

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
      'background:#0a7d3e;color:#ffffff;padding:10px 18px;border-radius:8px',
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
      '<a href="https://example.test/g" style="color:#0a7d3e;">the <strong>guide</strong></a>',
    );
    expect(mail.text).toContain('Read the guide (https://example.test/g) today.');
  });

  it('falls back to the default colour for a colour that is not #rrggbb', () => {
    const mail = rendered({
      body: '[button: Go](https://a.test)',
      branding: { ...branding, brandColor: 'red;background:url(x)' },
    });
    expect(mail.html).toContain('background:#d72638;color:#ffffff');
    expect(mail.html).not.toContain('url(x)');
  });

  it('heads the mail with the logo when there is one, else the site name', () => {
    const withLogo = rendered({
      branding: { ...branding, siteName: 'A & B', logoUrl: 'https://cdn.example/logo.png?v=1&s=2' },
    });
    expect(withLogo.html).toContain(
      '<img src="https://cdn.example/logo.png?v=1&amp;s=2" alt="A &amp; B" height="40"',
    );
    const withoutLogo = rendered({ branding: { ...branding, siteName: 'A & B' } });
    expect(withoutLogo.html).not.toContain('<img');
    expect(withoutLogo.html).toContain('>A &amp; B</');
  });

  it('lays the mail out as one 560px Arial table', () => {
    const mail = rendered({});
    expect(mail.html.match(/<table/g)).toHaveLength(1);
    expect(mail.html).toContain('max-width:560px');
    expect(mail.html).toContain('font-family:Arial');
  });

  it('ends with the footer lines in the HTML and after -- in the text', () => {
    const mail = rendered({ body: 'Hello there.' });
    expect(mail.html).toContain('color:#6b6359;font-size:12px');
    expect(mail.html).toContain('Get Canada Sim<br>123 Main St, Toronto');
    expect(mail.text).toBe('Hello there.\n\n--\nGet Canada Sim\n123 Main St, Toronto');
  });

  it('signs with the site name when there is no footer', () => {
    const mail = rendered({ body: 'Hello there.', branding: { ...branding, footerText: '  ' } });
    expect(mail.text).toBe('Hello there.\n\n--\nGet Canada Sim');
  });

  it('writes paragraphs and breaks into both parts', () => {
    const mail = rendered({ body: 'One\ntwo\n\n**Three**' });
    expect(mail.html).toContain('One<br>two</p>');
    expect(mail.html).toContain('<strong>Three</strong>');
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
      code: '483920',
    });
  });

  it('uses example.com for a site with no address', () => {
    expect(sampleFillInValues({ siteName: 'X', siteUrl: null })['tracking link']).toBe(
      'https://example.com/track',
    );
  });
});
