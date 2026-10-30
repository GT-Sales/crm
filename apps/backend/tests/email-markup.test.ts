import { describe, expect, it } from 'vitest';

import { parseEmailBody, parseEmailSubject } from '../src/email/markup.js';

describe('email body markup', () => {
  it('splits paragraphs on blank lines and a single newline into a break', () => {
    expect(parseEmailBody('Hi there,\nthanks.\n\n  \nSecond one.', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'Hi there,' },
            { kind: 'break' },
            { kind: 'text', text: 'thanks.' },
          ],
        },
        { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Second one.' }] },
      ],
    });
  });

  it('reads CRLF line endings as plain newlines', () => {
    expect(parseEmailBody('One\r\ntwo\r\n\r\nThree', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'One' },
            { kind: 'break' },
            { kind: 'text', text: 'two' },
          ],
        },
        { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Three' }] },
      ],
    });
  });

  it('reads **…** as bold, with fill-ins inside', () => {
    expect(parseEmailBody('Your plan is **{plan} now**.', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'Your plan is ' },
            {
              kind: 'bold',
              children: [
                { kind: 'fillIn', key: 'plan' },
                { kind: 'text', text: ' now' },
              ],
            },
            { kind: 'text', text: '.' },
          ],
        },
      ],
    });
  });

  it('keeps an unclosed ** literal', () => {
    expect(parseEmailBody('Half **bold here', 'order_received')).toEqual({
      ok: true,
      blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'Half **bold here' }] }],
    });
  });

  it('does not close bold across a line break', () => {
    expect(parseEmailBody('a **b\nc** d', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'a **b' },
            { kind: 'break' },
            { kind: 'text', text: 'c** d' },
          ],
        },
      ],
    });
  });

  it('reads a link and a button', () => {
    expect(
      parseEmailBody(
        'Read [our **guide**](https://example.test/guide?a=1&b=2).\n\n[button: Track your order](https://example.test/track)',
        'dispatched',
      ),
    ).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'Read ' },
            {
              kind: 'link',
              label: [
                { kind: 'text', text: 'our ' },
                { kind: 'bold', children: [{ kind: 'text', text: 'guide' }] },
              ],
              href: { kind: 'url', url: 'https://example.test/guide?a=1&b=2' },
            },
            { kind: 'text', text: '.' },
          ],
        },
        {
          kind: 'button',
          label: 'Track your order',
          href: { kind: 'url', url: 'https://example.test/track' },
        },
      ],
    });
  });

  it('keeps balanced parentheses inside a link address', () => {
    expect(parseEmailBody('[w](https://example.test/a_(b))', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            {
              kind: 'link',
              label: [{ kind: 'text', text: 'w' }],
              href: { kind: 'url', url: 'https://example.test/a_(b)' },
            },
          ],
        },
      ],
    });
  });

  it('keeps brackets that are not a link literal', () => {
    expect(parseEmailBody('A [note] and [half](https://x.test', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [{ kind: 'text', text: 'A [note] and [half](https://x.test' }],
        },
      ],
    });
  });

  it('refuses a second button', () => {
    expect(
      parseEmailBody('[button: A](https://a.test)\n\n[button: B](https://b.test)', 'dispatched'),
    ).toEqual({ ok: false, error: 'invalid_email_markup', reason: 'two_buttons' });
  });

  it('refuses a button that shares its paragraph', () => {
    expect(parseEmailBody('See [button: A](https://a.test) now', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_email_markup',
      reason: 'button_not_alone',
    });
    expect(parseEmailBody('[button: A](https://a.test)\nnext line', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_email_markup',
      reason: 'button_not_alone',
    });
    expect(parseEmailBody('**[button: A](https://a.test)**', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_email_markup',
      reason: 'button_not_alone',
    });
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](mailto:a@b.test)',
    '[x](example.test)',
    '[x]()',
    '[x]({courier})',
    '[button: Go](ftp://a.test)',
  ])('refuses the link address in %s', (body) => {
    expect(parseEmailBody(body, 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_email_markup',
      reason: 'bad_link',
    });
  });

  it('accepts {tracking link} as a link or button address', () => {
    expect(parseEmailBody('[x]({tracking link})', 'dispatched')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            {
              kind: 'link',
              label: [{ kind: 'text', text: 'x' }],
              href: { kind: 'fillIn', key: 'tracking link' },
            },
          ],
        },
      ],
    });
    expect(parseEmailBody('[button: Track]({Tracking  Link})', 'dispatched')).toEqual({
      ok: true,
      blocks: [{ kind: 'button', label: 'Track', href: { kind: 'fillIn', key: 'tracking link' } }],
    });
  });

  it('refuses {tracking link} as an address where the template cannot use it', () => {
    expect(parseEmailBody('[x]({tracking link})', 'tracking_code')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'tracking link',
      where: 'body',
    });
  });

  it('forgives case and spacing in a fill-in', () => {
    expect(parseEmailBody('Hi {First  Name}', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'Hi ' },
            { kind: 'fillIn', key: 'first name' },
          ],
        },
      ],
    });
  });

  it('refuses an unknown fill-in, naming the text inside the braces', () => {
    expect(parseEmailBody('Number: {tracking nmber}', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'tracking nmber',
      where: 'body',
    });
  });

  it('refuses a fill-in the template may not use', () => {
    expect(parseEmailBody('Sent with {courier}', 'cancelled')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'courier',
      where: 'body',
    });
    expect(parseEmailBody('[{courier}](https://a.test)', 'cancelled')).toMatchObject({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'courier',
    });
  });

  it('accepts {code} in tracking_code only', () => {
    expect(parseEmailBody('Your code is {code}', 'tracking_code')).toMatchObject({ ok: true });
    expect(parseEmailBody('Your code is {code}', 'order_received')).toMatchObject({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'code',
    });
  });

  it('keeps a { with no } on its line literal', () => {
    expect(parseEmailBody('{ oops\nand } later', 'order_received')).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: '{ oops' },
            { kind: 'break' },
            { kind: 'text', text: 'and } later' },
          ],
        },
      ],
    });
  });

  it('reports the first problem in reading order', () => {
    expect(
      parseEmailBody(
        '{nope}\n\n[button: A](https://a.test)\n\n[button: B](https://b.test)',
        'dispatched',
      ),
    ).toMatchObject({ error: 'invalid_fill_in', fillIn: 'nope' });
  });
});

describe('email subject markup', () => {
  it('takes fill-ins and leaves everything else as text', () => {
    expect(parseEmailSubject('**{Site Name}** [order](https://a.test)', 'dispatched')).toEqual({
      ok: true,
      parts: [
        { kind: 'text', text: '**' },
        { kind: 'fillIn', key: 'site name' },
        { kind: 'text', text: '** [order](https://a.test)' },
      ],
    });
  });

  it('refuses an unknown or disallowed fill-in, where: subject', () => {
    expect(parseEmailSubject('Hi {frist name}', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'frist name',
      where: 'subject',
    });
    expect(parseEmailSubject('{courier}', 'activated')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'courier',
      where: 'subject',
    });
  });

  it('keeps an unclosed { literal', () => {
    expect(parseEmailSubject('Order { soon', 'activated')).toEqual({
      ok: true,
      parts: [{ kind: 'text', text: 'Order { soon' }],
    });
  });
});
