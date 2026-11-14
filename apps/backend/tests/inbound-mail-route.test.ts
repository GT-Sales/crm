import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createInboundMailRouter,
  resendReceivedEmailFetcher,
  type InboundMailDependencies,
  type InboundReplyStore,
} from '../src/email/inbound.js';
import { loadReplyAddressing } from '../src/email/reply-address.js';

const SITE = '10000000-0000-4000-8000-000000000101';
const LEAD = '90000000-0000-4000-8000-0000000000aa';
const KEY = Buffer.from('inbound-webhook-test-key-0123456789');
const SECRET = `whsec_${KEY.toString('base64')}`;
const replies = loadReplyAddressing({
  EMAIL_INBOUND_DOMAIN: 'reply.example.test',
  EMAIL_INBOUND_SITES: JSON.stringify([{ workspaceId: SITE, tag: 'gcs' }]),
  EMAIL_CONTACT_HASH_SECRET: 'inbound-route-test-secret-0123456789',
});
if (!replies) throw new Error('expected reply addressing');
const ADDRESS = replies.addressFor(SITE, LEAD) ?? '';

const record = vi.fn<InboundReplyStore['record']>();
const fetchEmail = vi.fn<InboundMailDependencies['fetchEmail']>();
let server: Server;
let url: string;

function start(overrides: Partial<InboundMailDependencies> = {}) {
  const app = express();
  app.use(
    '/hook',
    express.raw({ type: 'application/json' }),
    createInboundMailRouter({
      secret: SECRET,
      replies,
      fetchEmail,
      store: { record },
      ...overrides,
    }),
  );
  server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  url = `http://127.0.0.1:${address.port}/hook`;
}

beforeEach(() => {
  record.mockReset().mockResolvedValue('recorded');
  fetchEmail.mockReset().mockResolvedValue({
    subject: 'Re: Your install is booked',
    text: 'Yes, Tuesday works.\n\nOn Fri, Nov 14 CanadaWide wrote:\n> Your install is booked',
  });
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(body: unknown, options: { key?: Buffer; timestamp?: number } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', options.key ?? KEY)
    .update(`msg_1.${timestamp}.`)
    .update(raw)
    .digest('base64');
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': 'msg_1',
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    body: raw,
  });
}

const received = (to: string[], extra: Record<string, unknown> = {}) => ({
  type: 'email.received',
  created_at: '2026-11-14T18:40:00.000Z',
  data: { email_id: 'in_123', from: 'Nadia <nadia@example.test>', to, subject: 'Re: hi', ...extra },
});

describe('POST inbound mail webhook', () => {
  it('keeps a reply to a lead’s address on that lead, without the quoted mail', async () => {
    start();
    const response = await post(received([`CanadaWide <${ADDRESS}>`]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'recorded' });
    expect(fetchEmail).toHaveBeenCalledWith('in_123');
    expect(record).toHaveBeenCalledWith({
      workspaceId: SITE,
      leadId: LEAD,
      inboundId: 'in_123',
      subject: 'Re: Your install is booked',
      text: 'Yes, Tuesday works.',
    });
  });

  it('finds the address among several recipients', async () => {
    start();
    await post(received(['someone@else.test'], { received_for: [ADDRESS.toUpperCase()] }));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('ignores mail that is not a reply to a lead, and other events, without reading anything', async () => {
    start();
    expect(await (await post(received(['info@reply.example.test']))).json()).toEqual({
      status: 'ignored',
    });
    expect(await (await post({ type: 'email.delivered', data: {} })).json()).toEqual({
      status: 'ignored',
    });
    expect(fetchEmail).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a request it cannot verify', async () => {
    start();
    expect(
      (await post(received([ADDRESS]), { key: Buffer.from('another-key-0123456789abcdef') }))
        .status,
    ).toBe(401);
    expect(
      (await post(received([ADDRESS]), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status,
    ).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it('asks to be sent the event again when the mail cannot be read or kept', async () => {
    start();
    fetchEmail.mockResolvedValueOnce(undefined);
    expect((await post(received([ADDRESS]))).status).toBe(503);
    record.mockRejectedValueOnce(new Error('database away'));
    expect((await post(received([ADDRESS]))).status).toBe(500);
  });

  it('is not there at all until it is configured', async () => {
    start({ secret: undefined });
    expect((await post(received([ADDRESS]))).status).toBe(404);
  });
});

describe('resendReceivedEmailFetcher', () => {
  it('reads the words with the API key, falling back to the HTML part', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ subject: ' Re: hi ', text: '', html: '<p>Hello<br>there</p>' }),
    );
    const mail = await resendReceivedEmailFetcher('re_test', fetchMock)('in 1/2');
    expect(mail).toEqual({ subject: 'Re: hi', text: 'Hello\nthere' });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe('https://api.resend.com/emails/receiving/in%201%2F2');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer re_test');
  });

  it('answers nothing without a key or when the provider refuses', async () => {
    const refused = vi.fn(async () => new Response('no', { status: 404 }));
    expect(await resendReceivedEmailFetcher('re_test', refused)('x')).toBeUndefined();
    expect(await resendReceivedEmailFetcher(undefined, refused)('x')).toBeUndefined();
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
