import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_EMAIL_TEMPLATES,
  emailBodySchema,
  emailSubjectSchema,
  type EmailFillInName,
} from '@gt-sales/contracts';

import { sampleFillInValues } from '../src/email/fill-in-values.js';
import { renderCustomerEmail, type EmailBranding } from '../src/email/layout.js';
import { parseEmailBody, parseEmailSubject, type EmailInline } from '../src/email/markup.js';
import { STARTER_TEMPLATES } from '../src/email/starters.js';

const branding: EmailBranding = {
  siteName: 'Get Canada Sim',
  logoUrl: null,
  brandColor: '#d72638',
  footerText: '',
};
const site = { siteName: 'Get Canada Sim', siteUrl: 'https://getcanadasim.example' };

function inlineKeys(inlines: readonly EmailInline[]): EmailFillInName[] {
  return inlines.flatMap((inline): EmailFillInName[] => {
    switch (inline.kind) {
      case 'fillIn':
        return [inline.key];
      case 'bold':
        return inlineKeys(inline.children);
      case 'link':
        return [
          ...inlineKeys(inline.label),
          ...(inline.href.kind === 'fillIn' ? [inline.href.key] : []),
        ];
      default:
        return [];
    }
  });
}

/** Every fill-in a template's subject and body use. */
function fillInsUsed(
  subject: string,
  body: string,
  template: (typeof CUSTOMER_EMAIL_TEMPLATES)[number],
) {
  const parsedSubject = parseEmailSubject(subject, template);
  const parsedBody = parseEmailBody(body, template);
  if (!parsedSubject.ok || !parsedBody.ok) throw new Error('the starter does not parse');
  const keys = [
    ...parsedSubject.parts.flatMap((part) => (part.kind === 'fillIn' ? [part.key] : [])),
    ...parsedBody.blocks.flatMap((block) =>
      block.kind === 'button'
        ? block.href.kind === 'fillIn'
          ? [block.href.key]
          : []
        : inlineKeys(block.inlines),
    ),
  ];
  return new Set(keys);
}

describe('starter templates', () => {
  it('has one starter per template', () => {
    expect(Object.keys(STARTER_TEMPLATES).sort()).toEqual([...CUSTOMER_EMAIL_TEMPLATES].sort());
  });

  it.each(CUSTOMER_EMAIL_TEMPLATES)(
    '%s parses, fits the limits and renders with samples',
    (template) => {
      const { subject, body } = STARTER_TEMPLATES[template];
      expect(parseEmailSubject(subject, template)).toMatchObject({ ok: true });
      expect(parseEmailBody(body, template)).toMatchObject({ ok: true });
      expect(emailSubjectSchema.safeParse(subject).success).toBe(true);
      expect(emailBodySchema.safeParse(body).success).toBe(true);
      expect(emailSubjectSchema.parse(subject)).toBe(subject);
      expect(emailBodySchema.parse(body)).toBe(body);

      const mail = renderCustomerEmail({
        template,
        subject,
        body,
        branding,
        values: sampleFillInValues(site),
      });
      expect(mail).toMatchObject({ ok: true });
      if (!mail.ok) return;
      expect(mail.subject).not.toMatch(/[{}]/);
      expect(mail.text).not.toMatch(/[{}]|\*\*/);
    },
  );

  it('sim_number_ready needs only the first name and the SIM number', () => {
    const { subject, body } = STARTER_TEMPLATES.sim_number_ready;
    expect(fillInsUsed(subject, body, 'sim_number_ready')).toEqual(
      new Set(['first name', 'SIM number']),
    );
    const mail = renderCustomerEmail({
      template: 'sim_number_ready',
      subject,
      body,
      branding,
      values: { 'first name': 'Nadia', 'SIM number': '+1 647 555 0123' },
    });
    expect(mail).toMatchObject({ ok: true });
    if (!mail.ok) return;
    expect(mail.subject).toBe('Your Canadian mobile number is ready');
    expect(mail.text).toContain('Your Canadian mobile number is ready, Nadia.');
    expect(mail.text).toContain('+1 647 555 0123');
    expect(mail.text).toContain('The line activates up to 24 hours before your arrival date');
    expect(mail.text).toContain('reply to this email straight away');
  });

  it.each(['change_approved', 'change_rejected'] as const)(
    '%s needs only the first name and the site name',
    (template) => {
      const { subject, body } = STARTER_TEMPLATES[template];
      expect(fillInsUsed(subject, body, template)).toEqual(new Set(['first name', 'site name']));
    },
  );

  it('the change decision starters say what was decided', () => {
    expect(STARTER_TEMPLATES.change_approved).toEqual({
      subject: 'Your change request was approved',
      body: 'Hi {first name},\n\nThe changes you asked for on your order with {site name} have been made.\n\nReply to this email if anything looks wrong.',
    });
    expect(STARTER_TEMPLATES.change_rejected).toEqual({
      subject: 'About your change request',
      body: 'Hi {first name},\n\nWe could not make the changes you asked for on your order with {site name}. Reply to this email and we will help.',
    });
  });

  it('there are nine', () => {
    expect(Object.keys(STARTER_TEMPLATES)).toHaveLength(9);
  });

  it('dispatched names the courier and tracking number and offers the tracking button', () => {
    const { subject, body } = STARTER_TEMPLATES.dispatched;
    const used = fillInsUsed(subject, body, 'dispatched');
    expect(used.has('courier')).toBe(true);
    expect(used.has('tracking number')).toBe(true);
    expect(body).toContain('[button: Track your order]({tracking link})');
  });
});
