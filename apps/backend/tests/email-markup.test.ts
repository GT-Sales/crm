import { describe, expect, it } from 'vitest';

import { parseEmailBody, parseEmailSubject, templatePropertyKeys } from '../src/email/markup.js';

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
          label: [{ kind: 'text', text: 'Track your order' }],
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
      blocks: [
        {
          kind: 'button',
          label: [{ kind: 'text', text: 'Track' }],
          href: { kind: 'fillIn', key: 'tracking link' },
        },
      ],
    });
  });

  it('reads fill-ins in a button label as body text does', () => {
    expect(
      parseEmailBody("[button: Track {First Name}'s {plan}](https://a.test/track)", 'dispatched'),
    ).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'button',
          label: [
            { kind: 'text', text: 'Track ' },
            { kind: 'fillIn', key: 'first name' },
            { kind: 'text', text: "'s " },
            { kind: 'fillIn', key: 'plan' },
          ],
          href: { kind: 'url', url: 'https://a.test/track' },
        },
      ],
    });
  });

  it('refuses an unknown or disallowed fill-in in a button label', () => {
    expect(parseEmailBody('[button: Hi {frist name}](https://a.test)', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'frist name',
      where: 'body',
    });
    expect(parseEmailBody('[button: With {courier}](https://a.test)', 'cancelled')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'courier',
      where: 'body',
    });
  });

  it.each([
    '[x](https://a.test/t?p={plan})',
    '[button: Go](https://a.test/{courier})',
    '[x](https://a.test/?a={)',
    '[x](https://a.test/})',
    '[button: Go]({tracking link}/more)',
    '[x](https://a.test/{tracking link})',
  ])('refuses braces in the typed address in %s', (body) => {
    expect(parseEmailBody(body, 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_email_markup',
      reason: 'bad_link',
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

describe('email body blocks', () => {
  const text = (value: string) => ({ kind: 'text', text: value });
  const blocksOf = (
    body: string,
    template: Parameters<typeof parseEmailBody>[1] = 'order_received',
  ) => {
    const parsed = parseEmailBody(body, template);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    return parsed.blocks;
  };

  it('reads [badge: …] and [badge success: …] alone on a line, with fill-ins', () => {
    expect(blocksOf('[badge: Hi {first name}]\n\n[badge success:  Done ]')).toEqual([
      {
        kind: 'badge',
        tone: 'brand',
        label: [text('Hi '), { kind: 'fillIn', key: 'first name' }],
      },
      { kind: 'badge', tone: 'success', label: [text('Done')] },
    ]);
  });

  it('keeps a badge that is not alone, is empty or is a link literal', () => {
    expect(blocksOf('Say [badge: x] now')).toEqual([
      { kind: 'paragraph', inlines: [text('Say [badge: x] now')] },
    ]);
    expect(blocksOf('[badge: ]')).toEqual([{ kind: 'paragraph', inlines: [text('[badge: ]')] }]);
    expect(blocksOf('[badge: x]\nmore')[0]?.kind).toBe('paragraph');
    expect(blocksOf('[badge: x](https://a.test)')).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'link', label: [text('badge: x')], href: { kind: 'url', url: 'https://a.test' } },
        ],
      },
    ]);
  });

  it('refuses a fill-in a badge may not use', () => {
    expect(parseEmailBody('[badge: {code}]', 'order_received')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'code',
      where: 'body',
    });
  });

  it('reads [progress: …] with 2 to 5 steps and at most one current step', () => {
    expect(blocksOf('[progress: Ordered | > Docs {first name} |Active]')).toEqual([
      {
        kind: 'progress',
        steps: [
          [text('Ordered')],
          [text('Docs '), { kind: 'fillIn', key: 'first name' }],
          [text('Active')],
        ],
        current: 1,
      },
    ]);
    expect(blocksOf('[progress: A | B]')).toEqual([
      { kind: 'progress', steps: [[text('A')], [text('B')]], current: null },
    ]);
  });

  it('keeps a progress with one step, too many, two current, an empty step or more words literal', () => {
    for (const body of [
      '[progress: A]',
      '[progress: A | B | C | D | E | F]',
      '[progress: >A | >B]',
      '[progress: A | | B]',
      '[progress: A | >]',
      'Now [progress: A | B]',
      '[progress: A | B]\nmore',
    ]) {
      expect(blocksOf(body)[0]?.kind).toBe('paragraph');
    }
  });

  it('refuses a fill-in a progress step may not use', () => {
    expect(parseEmailBody('[progress: A | {code}]', 'order_received')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'code',
      where: 'body',
    });
  });

  it('reads # and ## headings, the leading lines with the same marker, and a paragraph after', () => {
    expect(blocksOf('# Thanks, {first name}!\n# All set.\nWe have it.\n# not a heading')).toEqual([
      {
        kind: 'heading',
        level: 1,
        inlines: [
          text('Thanks, '),
          { kind: 'fillIn', key: 'first name' },
          text('!'),
          { kind: 'break' },
          text('All set.'),
        ],
      },
      {
        kind: 'paragraph',
        inlines: [text('We have it.'), { kind: 'break' }, text('# not a heading')],
      },
    ]);
    expect(blocksOf('## Next')).toEqual([{ kind: 'heading', level: 2, inlines: [text('Next')] }]);
  });

  it('keeps #, ### and #word literal', () => {
    for (const body of ['#', '# ', '### Three', '#tag', 'Not # a heading']) {
      expect(blocksOf(body)[0]?.kind).toBe('paragraph');
    }
  });

  it('reads two or more **Label:** value lines as a details box', () => {
    expect(
      blocksOf(
        '**Courier:** {courier}\n**Tracking number:**  [{tracking number}](https://t.test)',
        'dispatched',
      ),
    ).toEqual([
      {
        kind: 'details',
        rows: [
          { label: [text('Courier')], value: [{ kind: 'fillIn', key: 'courier' }] },
          {
            label: [text('Tracking number')],
            value: [
              {
                kind: 'link',
                label: [{ kind: 'fillIn', key: 'tracking number' }],
                href: { kind: 'url', url: 'https://t.test' },
              },
            ],
          },
        ],
      },
    ]);
  });

  it('keeps a single **Label:** line, a line with no value or a line that is not a row a paragraph', () => {
    for (const body of [
      '**Plan:** {plan}',
      '**Plan:** {plan}\n**Order number:**',
      '**Plan:** {plan}\nThanks.',
      '**What this means:**\nThis is your number.',
      '**Plan** {plan}\n**Price** {price}',
    ]) {
      expect(blocksOf(body)[0]?.kind).toBe('paragraph');
    }
  });

  it('reads > lines as a highlighted box and keeps a paragraph with one > line literal', () => {
    expect(blocksOf('> **Wrong?** Reply.\n>We fix it.')).toEqual([
      {
        kind: 'callout',
        inlines: [
          { kind: 'bold', children: [text('Wrong?')] },
          text(' Reply.'),
          { kind: 'break' },
          text('We fix it.'),
        ],
      },
    ]);
    expect(blocksOf('Note\n> quoted')).toEqual([
      { kind: 'paragraph', inlines: [text('Note'), { kind: 'break' }, text('> quoted')] },
    ]);
    expect(blocksOf('>')[0]?.kind).toBe('paragraph');
  });

  it('reads a backticked last line as a code box, with at most one label line', () => {
    expect(blocksOf('`{code}`', 'tracking_code')).toEqual([
      { kind: 'code', label: null, value: [{ kind: 'fillIn', key: 'code' }] },
    ]);
    expect(blocksOf('Your number\n` {SIM number} `', 'sim_number_ready')).toEqual([
      {
        kind: 'code',
        label: [text('Your number')],
        value: [{ kind: 'fillIn', key: 'SIM number' }],
      },
    ]);
    for (const body of ['a\nb\n`c`', '`c` d', '``', '` `', 'Use `this` word']) {
      expect(blocksOf(body)[0]?.kind).toBe('paragraph');
    }
  });

  it('reads numbered lines as steps, joining steps in consecutive paragraphs', () => {
    expect(blocksOf('1. Placed\nWe have it.\nAll good.\n2) Shipped\n\n3. Active')).toEqual([
      {
        kind: 'steps',
        steps: [
          {
            number: '1',
            title: [text('Placed')],
            body: [text('We have it.'), { kind: 'break' }, text('All good.')],
          },
          { number: '2', title: [text('Shipped')], body: [] },
          { number: '3', title: [text('Active')], body: [] },
        ],
      },
    ]);
  });

  it('keeps a list under a first line that is not a step, and a number with no words, a paragraph', () => {
    expect(blocksOf('**What happens next:**\n1. Review\n2. Call')[0]?.kind).toBe('paragraph');
    expect(blocksOf('1.')[0]?.kind).toBe('paragraph');
    expect(blocksOf('100. Too many')[0]?.kind).toBe('paragraph');
    expect(blocksOf('2026. A year')[0]?.kind).toBe('paragraph');
  });

  it('keeps steps apart when something comes between them', () => {
    expect(blocksOf('1. A\n\nBetween\n\n2. B').map((block) => block.kind)).toEqual([
      'steps',
      'paragraph',
      'steps',
    ]);
  });

  it('refuses a button inside any block and a fill-in a block may not use', () => {
    for (const body of [
      '> [button: Go](https://a.test)',
      '# [button: Go](https://a.test)',
      '1. [button: Go](https://a.test)',
      'Label\n`[button: Go](https://a.test)`',
    ]) {
      expect(parseEmailBody(body, 'order_received')).toEqual({
        ok: false,
        error: 'invalid_email_markup',
        reason: 'button_not_alone',
      });
    }
    for (const body of [
      '> {code}',
      '# {code}',
      '1. {code}',
      '`{code}`',
      '**A:** {code}\n**B:** x',
    ]) {
      expect(parseEmailBody(body, 'order_received')).toEqual({
        ok: false,
        error: 'invalid_fill_in',
        fillIn: 'code',
        where: 'body',
      });
    }
  });

  it('still counts a button after a heading toward the one-button limit', () => {
    expect(
      parseEmailBody(
        '# Hi\n[button: A](https://a.test)\n\n[button: B](https://b.test)',
        'order_received',
      ),
    ).toEqual({ ok: false, error: 'invalid_email_markup', reason: 'two_buttons' });
  });

  it('finds property fill-ins inside blocks', () => {
    expect(
      templatePropertyKeys(
        'x',
        '[badge: {prop:custom_b}]\n\n[progress: {prop:custom_p} | x]\n\n# {prop:custom_h}\n\n**A:** {prop:custom_a}\n**B:** y\n\n> {prop:custom_c}\n\n`{prop:custom_d}`\n\n1. {prop:custom_s}',
      ),
    ).toEqual(['custom_a', 'custom_b', 'custom_c', 'custom_d', 'custom_h', 'custom_p', 'custom_s']);
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

describe('flow fill-ins', () => {
  const SITE_MADE = 'tpl_abcdefghij012345';

  it('{order number} parses in dispatched and is refused in tracking_code', () => {
    expect(parseEmailSubject('Order {order number} is on its way', 'dispatched')).toEqual({
      ok: true,
      parts: [
        { kind: 'text', text: 'Order ' },
        { kind: 'fillIn', key: 'order number' },
        { kind: 'text', text: ' is on its way' },
      ],
    });
    expect(parseEmailBody('Your code for {Order Number}', 'tracking_code')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'Order Number',
      where: 'body',
    });
  });

  it('{prop:custom_size} is refused in dispatched and accepted in a tpl_ template', () => {
    expect(parseEmailBody('Size {prop:custom_size}', 'dispatched')).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'prop:custom_size',
      where: 'body',
    });
    expect(parseEmailBody('Size {prop:custom_size}, {first name}', SITE_MADE)).toEqual({
      ok: true,
      blocks: [
        {
          kind: 'paragraph',
          inlines: [
            { kind: 'text', text: 'Size ' },
            { kind: 'fillIn', key: 'prop:custom_size' },
            { kind: 'text', text: ', ' },
            { kind: 'fillIn', key: 'first name' },
          ],
        },
      ],
    });
    expect(parseEmailSubject('Your {code}', SITE_MADE)).toMatchObject({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'code',
    });
    expect(parseEmailSubject('{prop:Not A Key}', SITE_MADE)).toMatchObject({
      ok: false,
      fillIn: 'prop:Not A Key',
    });
  });

  it('with options.property returning false it is invalid_fill_in naming prop:custom_size', () => {
    const property = (key: string) => key !== 'custom_size';
    expect(parseEmailBody('Size {prop:custom_size}', SITE_MADE, { property })).toEqual({
      ok: false,
      error: 'invalid_fill_in',
      fillIn: 'prop:custom_size',
      where: 'body',
    });
    expect(parseEmailSubject('{prop:custom_colour}', SITE_MADE, { property }).ok).toBe(true);
  });

  it('templatePropertyKeys sorts and dedupes', () => {
    expect(
      templatePropertyKeys(
        'About {prop:custom_size}',
        'Size {prop:custom_size}\n\n**{prop:custom_colour}** and [{prop:custom_b}](https://x.example)',
      ),
    ).toEqual(['custom_b', 'custom_colour', 'custom_size']);
    expect(templatePropertyKeys('No fill-ins', 'None here')).toEqual([]);
    expect(templatePropertyKeys('{code}', 'Body')).toEqual([]);
  });
});
