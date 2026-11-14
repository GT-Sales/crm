import { describe, expect, it } from 'vitest';

import { htmlToText, loadReplyAddressing, replyText } from '../src/email/reply-address.js';

const SITE = '10000000-0000-4000-8000-000000000101';
const OTHER = '10000000-0000-4000-8000-000000000102';
const LEAD = '90000000-0000-4000-8000-0000000000aa';
const ENV = {
  EMAIL_INBOUND_DOMAIN: 'Reply.Example.Test',
  EMAIL_INBOUND_SITES: JSON.stringify([
    { workspaceId: SITE, tag: 'gcs' },
    { workspaceId: OTHER, tag: 'cw' },
  ]),
  EMAIL_CONTACT_HASH_SECRET: 'reply-address-test-secret-0123456789',
};

describe('reply addresses', () => {
  const replies = loadReplyAddressing(ENV);
  if (!replies) throw new Error('expected reply addressing');
  const address = replies.addressFor(SITE, LEAD);
  if (!address) throw new Error('expected an address');

  it('makes one address per site and lead, on the inbound domain', () => {
    expect(address).toMatch(
      /^gcs-900000000000400080000000000000aa-[0-9a-f]{16}@reply\.example\.test$/,
    );
    expect(address.split('@')[0]?.length).toBeLessThanOrEqual(64);
    expect(replies.addressFor(SITE, LEAD)).toBe(address);
    expect(replies.addressFor(OTHER, LEAD)).not.toBe(address);
    expect(replies.addressFor('10000000-0000-4000-8000-000000000999', LEAD)).toBeUndefined();
    expect(replies.enabledFor(SITE)).toBe(true);
    expect(replies.enabledFor('10000000-0000-4000-8000-000000000999')).toBe(false);
  });

  it('reads its own address back, whatever case a mail program gave it', () => {
    expect(replies.resolve(address)).toEqual({ workspaceId: SITE, leadId: LEAD });
    expect(replies.resolve(`  ${address.toUpperCase()} `)).toEqual({
      workspaceId: SITE,
      leadId: LEAD,
    });
  });

  it('ignores an address it did not make', () => {
    const [local, domain] = address.split('@');
    const flipped = `${local?.slice(0, -1)}${local?.endsWith('0') ? '1' : '0'}@${domain}`;
    expect(replies.resolve(flipped)).toBeUndefined();
    // Another site's tag with this site's signature.
    expect(replies.resolve(address.replace(/^gcs-/, 'cw-'))).toBeUndefined();
    // Another lead under this lead's signature.
    expect(replies.resolve(address.replace('00aa-', '00ab-'))).toBeUndefined();
    expect(replies.resolve(address.replace('@reply.example.test', '@evil.test'))).toBeUndefined();
    expect(replies.resolve('info@reply.example.test')).toBeUndefined();
    expect(replies.resolve('')).toBeUndefined();
  });

  it('is signed with this deployment’s secret', () => {
    const other = loadReplyAddressing({
      ...ENV,
      EMAIL_CONTACT_HASH_SECRET: 'a-different-secret-0123456789',
    });
    expect(other?.resolve(address)).toBeUndefined();
  });

  it('is off unless every setting is valid', () => {
    expect(loadReplyAddressing({})).toBeUndefined();
    expect(loadReplyAddressing({ ...ENV, EMAIL_INBOUND_DOMAIN: 'not a domain' })).toBeUndefined();
    expect(loadReplyAddressing({ ...ENV, EMAIL_INBOUND_SITES: '{' })).toBeUndefined();
    expect(loadReplyAddressing({ ...ENV, EMAIL_INBOUND_SITES: '[]' })).toBeUndefined();
    expect(loadReplyAddressing({ ...ENV, EMAIL_CONTACT_HASH_SECRET: 'short' })).toBeUndefined();
    // Two sites under one tag could not be told apart.
    expect(
      loadReplyAddressing({
        ...ENV,
        EMAIL_INBOUND_SITES: JSON.stringify([
          { workspaceId: SITE, tag: 'x1' },
          { workspaceId: OTHER, tag: 'x1' },
        ]),
      }),
    ).toBeUndefined();
  });
});

describe('replyText', () => {
  it('keeps what the customer wrote and drops the mail they answered', () => {
    expect(
      replyText(
        'Yes, Tuesday works.\n\nThanks!\n\nOn Fri, Nov 14, 2026 at 6:38 PM CanadaWide <info@x.test> wrote:\n> Your install is booked\n> for Tuesday.',
      ),
    ).toBe('Yes, Tuesday works.\n\nThanks!');
    expect(
      replyText(
        'Sounds good\r\n\r\nOn Fri, Nov 14, 2026 at 6:38 PM CanadaWide\r\n<info@x.test> wrote:\r\n> hi',
      ),
    ).toBe('Sounds good');
    expect(replyText('Ok.\n\n-----Original Message-----\nFrom: x')).toBe('Ok.');
    expect(replyText('Ok.\n\nFrom: CanadaWide <info@x.test>\nSent: Friday\nSubject: hi')).toBe(
      'Ok.',
    );
    expect(replyText('See below\n> quoted\nmore')).toBe('See below');
  });

  it('leaves a plain message alone, and never returns nothing for a quote-only mail', () => {
    expect(replyText('  Just a note.\nOn second thought, call me.  ')).toBe(
      'Just a note.\nOn second thought, call me.',
    );
    expect(replyText('> only a quote')).toBe('> only a quote');
  });
});

describe('htmlToText', () => {
  it('reads a mail’s HTML as plain lines', () => {
    expect(
      htmlToText(
        '<head><style>p{color:red}</style></head><div>Hi &amp; hello<br>there</div><p>Line&nbsp;two &lt;ok&gt;</p>',
      ),
    ).toBe('Hi & hello\nthere\nLine two <ok>');
  });
});
