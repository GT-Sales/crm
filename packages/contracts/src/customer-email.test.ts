import { describe, expect, it } from 'vitest';

import {
  ALWAYS_SENT_TEMPLATES,
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
  emailSettingsResponseSchema,
  emailSettingsSchema,
  emailTemplateResponseSchema,
  emailTemplateSchema,
  emailSubjectSchema,
  fillInsForTemplate,
  httpsUrlSchema,
  listEmailTemplatesResponseSchema,
  normalizeFillInName,
  previewEmailTemplateRequestSchema,
  previewEmailTemplateResponseSchema,
  sendTestEmailResponseSchema,
  updateEmailSettingsRequestSchema,
  updateEmailTemplateRequestSchema,
  TRACKING_CODE_JOB_TYPE,
  trackingCodeJobPayloadSchema,
  trackingCodeScrubbedPayloadSchema,
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
  it('are the nine, each with a label', () => {
    expect(CUSTOMER_EMAIL_TEMPLATES).toEqual([
      'tracking_code',
      'order_received',
      'information_needed',
      'dispatched',
      'activated',
      'cancelled',
      'sim_number_ready',
      'change_approved',
      'change_rejected',
    ]);
    expect(Object.keys(CUSTOMER_EMAIL_TEMPLATE_LABELS)).toEqual([...CUSTOMER_EMAIL_TEMPLATES]);
    expect(CUSTOMER_EMAIL_TEMPLATE_LABELS.tracking_code).toBe('Tracking code');
    expect(CUSTOMER_EMAIL_TEMPLATE_LABELS.sim_number_ready).toBe('SIM number ready');
    expect(CUSTOMER_EMAIL_TEMPLATE_LABELS.change_approved).toBe('Change approved');
    expect(CUSTOMER_EMAIL_TEMPLATE_LABELS.change_rejected).toBe('Change rejected');
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

  it('give the two change decision mails the first name, the site name and the tracking link', () => {
    expect(fillInsForTemplate('change_approved')).toEqual([
      'first name',
      'site name',
      'tracking link',
    ]);
    expect(fillInsForTemplate('change_rejected')).toEqual([
      'first name',
      'site name',
      'tracking link',
    ]);
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

describe('the mails that are always sent', () => {
  it('are the tracking code and the two change decisions', () => {
    expect(ALWAYS_SENT_TEMPLATES).toEqual(['tracking_code', 'change_approved', 'change_rejected']);
  });
});

describe('the tracking code job', () => {
  const payload = {
    challengeId: UUID_A,
    toAddress: 'nadia@example.com',
    contactHash: 'a'.repeat(64),
    sealedCode: 'v1.sealed',
    expiresAt: '2026-10-30T12:10:00.000Z',
  };

  it('carries the code sealed, never in the clear', () => {
    expect(TRACKING_CODE_JOB_TYPE).toBe('tracking_code_email');
    expect(trackingCodeJobPayloadSchema.parse(payload)).toEqual(payload);
    expect(trackingCodeJobPayloadSchema.safeParse({ ...payload, code: '123456' }).success).toBe(
      false,
    );
    expect(
      trackingCodeJobPayloadSchema.safeParse({ ...payload, sealedCode: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(
      trackingCodeJobPayloadSchema.safeParse({ ...payload, sealedCode: 'x'.repeat(100) }).success,
    ).toBe(true);
  });

  it('is scrubbed to the challenge id', () => {
    expect(trackingCodeScrubbedPayloadSchema.parse({ challengeId: UUID_A })).toEqual({
      challengeId: UUID_A,
    });
    expect(trackingCodeScrubbedPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

const SETTINGS_REQUEST = {
  fromName: 'Get Canada Sim',
  fromAddress: 'orders@example.com',
  replyTo: null,
  logoUrl: null,
  siteUrl: 'https://example.com',
};

const SAVED_SETTINGS = {
  ...SETTINGS_REQUEST,
  brandColor: '#d72638',
  footerText: '',
  updatedAt: '2026-10-30T12:00:00.000Z',
  updatedBy: UUID_A,
};

describe('email settings', () => {
  it('defaults the colour and the footer when the request leaves them out', () => {
    expect(updateEmailSettingsRequestSchema.parse(SETTINGS_REQUEST)).toEqual({
      ...SETTINGS_REQUEST,
      brandColor: DEFAULT_EMAIL_BRAND_COLOR,
      footerText: '',
    });
  });

  it('lower-cases a colour the owner typed', () => {
    const parsed = updateEmailSettingsRequestSchema.parse({
      ...SETTINGS_REQUEST,
      brandColor: '#AABBCC',
    });
    expect(parsed.brandColor).toBe('#aabbcc');
  });

  it('refuses an http logo, an 81-character name, a bad address and an extra key', () => {
    const refuses = (patch: Record<string, unknown>) =>
      updateEmailSettingsRequestSchema.safeParse({ ...SETTINGS_REQUEST, ...patch }).success;
    expect(refuses({ logoUrl: 'http://example.com/logo.png' })).toBe(false);
    expect(refuses({ logoUrl: 'https://example.com/logo.png' })).toBe(true);
    expect(refuses({ fromName: 'a'.repeat(81) })).toBe(false);
    expect(refuses({ fromName: 'a'.repeat(80) })).toBe(true);
    expect(refuses({ fromName: '   ' })).toBe(false);
    expect(refuses({ fromAddress: 'not-an-address' })).toBe(false);
    expect(refuses({ replyTo: 'not-an-address' })).toBe(false);
    expect(refuses({ siteUrl: 'http://example.com' })).toBe(false);
    expect(refuses({ updatedAt: '2026-10-30T12:00:00.000Z' })).toBe(false);
  });

  it('answers with the saved settings, or null while none are saved, and no fallback sender', () => {
    expect(emailSettingsSchema.parse(SAVED_SETTINGS)).toEqual(SAVED_SETTINGS);
    expect(
      emailSettingsResponseSchema.parse({ settings: SAVED_SETTINGS, requestId: UUID_A }),
    ).toEqual({ settings: SAVED_SETTINGS, requestId: UUID_A });
    expect(emailSettingsResponseSchema.parse({ settings: null, requestId: UUID_A })).toEqual({
      settings: null,
      requestId: UUID_A,
    });
    // An older server's fallback key is dropped, never passed on.
    expect(
      emailSettingsResponseSchema.parse({ settings: null, fallback: null, requestId: UUID_A }),
    ).not.toHaveProperty('fallback');
    expect(emailSettingsResponseSchema.safeParse({ requestId: UUID_A }).success).toBe(false);
  });
});

describe('email templates', () => {
  const template = (key: string, version = 0) => ({
    key,
    subject: 'Hello',
    body: 'Hi {first name}',
    version,
    updatedAt: version === 0 ? null : '2026-10-30T12:00:00.000Z',
    updatedBy: version === 0 ? null : UUID_A,
  });

  it('lists exactly the nine templates', () => {
    const templates = CUSTOMER_EMAIL_TEMPLATES.map((key) => template(key));
    expect(
      listEmailTemplatesResponseSchema.parse({ templates, requestId: UUID_A }).templates,
    ).toHaveLength(9);
    expect(
      listEmailTemplatesResponseSchema.safeParse({
        templates: templates.slice(1),
        requestId: UUID_A,
      }).success,
    ).toBe(false);
  });

  it('reads one template, the starter text being version 0', () => {
    expect(emailTemplateSchema.parse(template('dispatched'))).toEqual(template('dispatched'));
    expect(emailTemplateSchema.safeParse(template('dispatched', -1)).success).toBe(false);
    expect(emailTemplateSchema.safeParse(template('unknown')).success).toBe(false);
    expect(
      emailTemplateResponseSchema.safeParse({
        template: template('dispatched', 2),
        requestId: UUID_A,
      }).success,
    ).toBe(true);
  });

  it('refuses a 151-character subject, an empty body and an enabled key on a save', () => {
    const save = { expectedVersion: 0, subject: 'Hello', body: 'Hi' };
    expect(updateEmailTemplateRequestSchema.parse(save)).toEqual(save);
    const refuses = (patch: Record<string, unknown>) =>
      updateEmailTemplateRequestSchema.safeParse({ ...save, ...patch }).success;
    expect(refuses({ subject: 'a'.repeat(150) })).toBe(true);
    expect(refuses({ subject: 'a'.repeat(151) })).toBe(false);
    expect(refuses({ body: '   ' })).toBe(false);
    expect(refuses({ expectedVersion: -1 })).toBe(false);
    expect(refuses({ enabled: true })).toBe(false);
  });

  it('previews and test-sends', () => {
    const draft = { subject: 'Hello', body: 'Hi' };
    expect(previewEmailTemplateRequestSchema.parse(draft)).toEqual(draft);
    expect(
      previewEmailTemplateRequestSchema.safeParse({ ...draft, expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      previewEmailTemplateResponseSchema.parse({
        subject: 'Hello',
        html: '<p>Hi</p>',
        text: 'Hi',
        requestId: UUID_A,
      }).html,
    ).toBe('<p>Hi</p>');
    expect(sendTestEmailResponseSchema.parse({ queued: true, requestId: UUID_A }).queued).toBe(
      true,
    );
    expect(sendTestEmailResponseSchema.safeParse({ requestId: UUID_A }).success).toBe(false);
  });
});
