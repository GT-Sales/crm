import { describe, expect, it } from 'vitest';

import { hashContact } from '../src/email/hash.js';
import {
  customerEmailEnvironmentFromEnv,
  customerEmailFromEnv,
  loadEmailSenders,
} from '../src/email/senders.js';

const GCS = '10000000-0000-4000-8000-0000000c0001';
const OTHER = '10000000-0000-4000-8000-0000000c0002';
const SECRET = 'ci-email-contact-hash-secret-0123456789';

const senders = JSON.stringify([
  {
    workspaceId: GCS,
    fromAddress: 'order@getcanadasim.example',
    fromName: 'Get Canada Sim',
    siteUrl: 'https://getcanadasim.example/',
  },
]);

describe('site senders', () => {
  it('reads each site’s own sender, its site address without a trailing slash', () => {
    const loaded = loadEmailSenders({ EMAIL_SENDERS_JSON: senders });
    expect(loaded.forWorkspace(GCS)).toEqual({
      fromAddress: 'order@getcanadasim.example',
      fromName: 'Get Canada Sim',
      replyToAddress: undefined,
      siteUrl: 'https://getcanadasim.example',
    });
    expect(loaded.forWorkspace(OTHER)).toBeUndefined();
  });

  it('has no sender at all when the setting is missing, malformed or ambiguous', () => {
    expect(loadEmailSenders({}).forWorkspace(GCS)).toBeUndefined();
    expect(loadEmailSenders({ EMAIL_SENDERS_JSON: 'not json' }).forWorkspace(GCS)).toBeUndefined();
    // One bad entry spoils the list: no guessing which entries were meant.
    const withBad = JSON.stringify([
      JSON.parse(senders)[0],
      { workspaceId: OTHER, fromAddress: 'not-an-address', fromName: 'X' },
    ]);
    expect(loadEmailSenders({ EMAIL_SENDERS_JSON: withBad }).forWorkspace(GCS)).toBeUndefined();
    const twice = JSON.stringify([JSON.parse(senders)[0], JSON.parse(senders)[0]]);
    expect(loadEmailSenders({ EMAIL_SENDERS_JSON: twice }).forWorkspace(GCS)).toBeUndefined();
  });

  it('can send customer mail only with a working provider and the hash secret', () => {
    const base = { EMAIL_SENDERS_JSON: senders, EMAIL_CONTACT_HASH_SECRET: SECRET };
    const ready = (env: NodeJS.ProcessEnv) => customerEmailEnvironmentFromEnv(env).providerReady;
    expect(ready({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic' })).toBe(true);
    expect(ready({ ...base, EMAIL_PROVIDER: 'resend' })).toBe(false);
    expect(ready({ ...base, EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' })).toBe(true);
    expect(ready({ ...base, EMAIL_PROVIDER: 'fake', NODE_ENV: 'production' })).toBe(false);
    expect(ready({ ...base })).toBe(false);
    expect(ready({ ...base, EMAIL_PROVIDER: 'fake', EMAIL_CONTACT_HASH_SECRET: 'short' })).toBe(
      false,
    );
  });

  it('answers unavailable without the database when the deployment cannot send', async () => {
    const untouchable = {
      withTenantTx: () => Promise.reject(new Error('the database was reached')),
    };
    const mail = customerEmailFromEnv(
      { EMAIL_SENDERS_JSON: senders, EMAIL_CONTACT_HASH_SECRET: SECRET },
      untouchable,
    );
    expect(await mail.available({ workspaceId: GCS, actorId: OTHER })).toBe(false);
  });

  it('offers the deployment’s sender as the fallback', () => {
    const mail = customerEmailFromEnv({ EMAIL_SENDERS_JSON: senders });
    expect(mail.fallback(GCS)).toMatchObject({
      fromName: 'Get Canada Sim',
      siteUrl: 'https://getcanadasim.example',
    });
    expect(mail.fallback(OTHER)).toBeUndefined();
  });

  it('hashes the address the way suppression matches it', () => {
    const environment = customerEmailEnvironmentFromEnv({ EMAIL_CONTACT_HASH_SECRET: SECRET });
    expect(environment.contactHash(' Arjun@Example.test ')).toBe(
      hashContact('arjun@example.test', SECRET),
    );
    expect(() => customerEmailEnvironmentFromEnv({}).contactHash('a@example.test')).toThrow();
  });
});
