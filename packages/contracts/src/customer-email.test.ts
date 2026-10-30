import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_EMAIL_JOB_TYPE,
  CUSTOMER_EMAIL_TEMPLATES,
  CUSTOMER_EMAIL_TEMPLATE_LABELS,
  DEFAULT_EMAIL_BRAND_COLOR,
  EMAIL_FILL_IN_KEYS,
  brandColorSchema,
  customerEmailJobPayloadSchema,
  customerEmailTemplateSchema,
  emailBodySchema,
  emailFillIns,
  emailSubjectSchema,
  fillInsForTemplate,
  httpsUrlSchema,
  normalizeFillInName,
} from './index';

const UUID_A = '00000000-0000-4000-8000-000000000001';

const JOB_PAYLOAD = {
  leadId: UUID_A,
  template: 'dispatched',
  templateVersion: 3,
  toAddress: 'ann@example.com',
  contactHash: 'hash',
  sender: { fromName: 'Get Canada Sim', fromAddress: 'orders@example.com' },
  rendered: { subject: 'On its way', html: '<p>Hi</p>', text: 'Hi' },
};

describe('customer email templates', () => {
  it('are the seven, each with a label', () => {
    expect(CUSTOMER_EMAIL_TEMPLATES).toEqual([
      'tracking_code',
      'order_received',
      'information_needed',
      'dispatched',
      'activated',
      'cancelled',
      'sim_number_ready',
    ]);
    expect(Object.keys(CUSTOMER_EMAIL_TEMPLATE_LABELS)).toEqual([...CUSTOMER_EMAIL_TEMPLATES]);
    expect(CUSTOMER_EMAIL_TEMPLATE_LABELS.tracking_code).toBe('Tracking code');
    expect(CUSTOMER_EMAIL_TEMPLATE_LABELS.sim_number_ready).toBe('SIM number ready');
    expect(customerEmailTemplateSchema.safeParse('order_status').success).toBe(false);
  });

  it('take a trimmed subject and body within their limits', () => {
    expect(emailSubjectSchema.parse('  Your order  ')).toBe('Your order');
    expect(emailSubjectSchema.safeParse('   ').success).toBe(false);
    expect(emailSubjectSchema.safeParse('x'.repeat(151)).success).toBe(false);
    expect(emailBodySchema.safeParse('x'.repeat(5000)).success).toBe(true);
    expect(emailBodySchema.safeParse('x'.repeat(5001)).success).toBe(false);
  });
});

describe('fill-ins', () => {
  it('are the ten, each naming the templates that may use it', () => {
    expect(emailFillIns.map((fillIn) => fillIn.key)).toEqual([...EMAIL_FILL_IN_KEYS]);
    for (const fillIn of emailFillIns) expect(fillIn.hint.length).toBeGreaterThan(0);
  });

  it('give the tracking code mail only the site name and the code', () => {
    expect(fillInsForTemplate('tracking_code')).toEqual(['site name', 'code']);
  });

  it('give the courier and tracking number only to the dispatched mail', () => {
    expect(fillInsForTemplate('cancelled')).not.toContain('courier');
    expect(fillInsForTemplate('dispatched')).toEqual([
      'first name',
      'last name',
      'site name',
      'plan',
      'price',
      'SIM number',
      'courier',
      'tracking number',
      'tracking link',
    ]);
    expect(fillInsForTemplate('sim_number_ready')).toContain('SIM number');
    expect(fillInsForTemplate('order_received')).not.toContain('SIM number');
  });

  it('forgive case and spacing, never a misspelling', () => {
    expect(normalizeFillInName(' First  Name ')).toBe('first name');
    expect(normalizeFillInName('sim number')).toBe('SIM number');
    expect(normalizeFillInName('TRACKING\tLINK')).toBe('tracking link');
    expect(normalizeFillInName('tracking nmber')).toBeUndefined();
    expect(normalizeFillInName('')).toBeUndefined();
  });
});

describe('email settings values', () => {
  it('store a brand colour in lower case, the default included', () => {
    expect(brandColorSchema.parse('#D72638')).toBe('#d72638');
    expect(brandColorSchema.parse(DEFAULT_EMAIL_BRAND_COLOR)).toBe('#d72638');
    expect(brandColorSchema.safeParse('#d7263').success).toBe(false);
    expect(brandColorSchema.safeParse('red').success).toBe(false);
  });

  it('take only https links', () => {
    expect(httpsUrlSchema.safeParse('https://getcanadasim.com/logo.png').success).toBe(true);
    expect(httpsUrlSchema.safeParse('http://getcanadasim.com/logo.png').success).toBe(false);
    expect(httpsUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(httpsUrlSchema.safeParse(`https://example.com/${'a'.repeat(2048)}`).success).toBe(false);
  });
});

describe('the customer email job', () => {
  it('carries the rendered mail and its sender', () => {
    expect(CUSTOMER_EMAIL_JOB_TYPE).toBe('lead_customer_email');
    expect(customerEmailJobPayloadSchema.parse(JOB_PAYLOAD)).toEqual(JOB_PAYLOAD);
    const test = { ...JOB_PAYLOAD, leadId: undefined, test: true };
    expect(customerEmailJobPayloadSchema.safeParse(test).success).toBe(true);
  });

  it('refuses an extra key, a negative version and a test flag of false', () => {
    expect(customerEmailJobPayloadSchema.safeParse({ ...JOB_PAYLOAD, extra: 1 }).success).toBe(
      false,
    );
    expect(
      customerEmailJobPayloadSchema.safeParse({ ...JOB_PAYLOAD, templateVersion: -1 }).success,
    ).toBe(false);
    expect(customerEmailJobPayloadSchema.safeParse({ ...JOB_PAYLOAD, test: false }).success).toBe(
      false,
    );
    expect(
      customerEmailJobPayloadSchema.safeParse({
        ...JOB_PAYLOAD,
        sender: { ...JOB_PAYLOAD.sender, extra: 1 },
      }).success,
    ).toBe(false);
  });
});
