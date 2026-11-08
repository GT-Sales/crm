import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CUSTOMER_EMAIL_TEMPLATES } from '@gt-sales/contracts';

import { sampleFillInValues } from '../src/email/fill-in-values.js';
import {
  renderCustomerEmail,
  renderPlainCustomerEmail,
  type EmailBranding,
} from '../src/email/layout.js';
import { STARTER_TEMPLATES } from '../src/email/starters.js';

/**
 * The classic layout is what every site sent before the style setting
 * existed. These hashes were taken from the layout before `style` was added,
 * so a change to the hero style can never move a byte of a classic mail. A
 * deliberate change to the classic look updates them in the same commit.
 */

const brandings: readonly EmailBranding[] = [
  {
    siteName: 'Get Canada Sim',
    logoUrl: 'https://getcanadasim.com/logo-1.png',
    brandColor: '#d72638',
    footerText: 'Get Canada Sim\n123 Main St, Toronto',
  },
  { siteName: 'A <b>&</b> "site"', logoUrl: null, brandColor: '#f7e04b', footerText: '' },
];

/** Every block the markup has, so the pin covers each drawing. */
const ALL_BLOCKS = [
  '[badge success: Order received]',
  '# Thanks, {first name}\n# we got it',
  'Intro with a [link](https://example.com) and **bold**.',
  '[progress: Ordered | >Documents | Active]',
  '[button: Open your order]({tracking link})',
  '[badge: Later badge]',
  '## What happens next',
  '**Plan:** {plan}\n**Order number:** {order number}',
  '> A highlighted note\n> on two lines',
  'Your code\n`483920`',
  '`+1 647 555 0123`',
  '1. First step\nIts words.\n2. Second step',
  'Closing words.',
].join('\n\n');

function corpus(extra: Partial<EmailBranding> = {}): string {
  const parts: string[] = [];
  for (const base of brandings) {
    const branding = { ...base, ...extra };
    const values = sampleFillInValues({
      siteName: branding.siteName,
      siteUrl: 'https://example.com',
    });
    for (const template of CUSTOMER_EMAIL_TEMPLATES) {
      const starter = STARTER_TEMPLATES[template];
      const mail = renderCustomerEmail({ template, ...starter, branding, values });
      expect(mail.ok).toBe(true);
      parts.push(JSON.stringify(mail));
    }
    const all = renderCustomerEmail({
      template: 'order_received',
      subject: 'All blocks',
      body: ALL_BLOCKS,
      branding,
      values,
    });
    expect(all.ok).toBe(true);
    parts.push(JSON.stringify(all));
    parts.push(
      JSON.stringify(
        renderPlainCustomerEmail({ subject: 'Plain', body: 'Hi <there>\nLine two', branding }),
      ),
    );
  }
  return parts.join('\n');
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('classic layout pin', () => {
  it('renders byte for byte what it rendered before the style setting', () => {
    expect(sha(corpus())).toBe('54e090af166ff10e68405b39d85f00a688a80b8fbbc7b95cabcdf4c1c7f4af1e');
  });

  it('renders the same with style classic named and an accent colour set', () => {
    expect(sha(corpus({ style: 'classic', accentColor: '#c0ff72' }))).toBe(sha(corpus()));
    expect(sha(corpus({ style: 'hero' }))).not.toBe(sha(corpus()));
  });
});
