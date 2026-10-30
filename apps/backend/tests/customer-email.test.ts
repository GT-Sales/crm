import { describe, expect, it } from 'vitest';

import { hashContact } from '../src/email/hash.js';
import { customerEmailEnvironmentFromEnv, customerEmailFromEnv } from '../src/email/senders.js';

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

describe('customer mail environment', () => {
  it('has no deployment sender list: EMAIL_SENDERS_JSON is ignored', () => {
    const env = { EMAIL_SENDERS_JSON: senders, EMAIL_CONTACT_HASH_SECRET: SECRET };
    expect(customerEmailEnvironmentFromEnv(env)).not.toHaveProperty('fallbackSenders');
    expect(customerEmailFromEnv(env)).not.toHaveProperty('fallback');
  });

  it('can send customer mail only with a working provider and the hash secret', () => {
    const base = { EMAIL_CONTACT_HASH_SECRET: SECRET };
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
    const mail = customerEmailFromEnv({ EMAIL_CONTACT_HASH_SECRET: SECRET }, untouchable);
    expect(await mail.available({ workspaceId: GCS, actorId: OTHER })).toBe(false);
  });

  it('hashes the address the way suppression matches it', () => {
    const environment = customerEmailEnvironmentFromEnv({ EMAIL_CONTACT_HASH_SECRET: SECRET });
    expect(environment.contactHash(' Arjun@Example.test ')).toBe(
      hashContact('arjun@example.test', SECRET),
    );
    expect(() => customerEmailEnvironmentFromEnv({}).contactHash('a@example.test')).toThrow();
  });
});
