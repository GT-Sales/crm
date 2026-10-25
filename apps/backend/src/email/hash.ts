import { createHmac } from 'node:crypto';

/**
 * Keyed digest used everywhere an email address needs to be matched
 * (suppression, consent, follow-up eligibility) without storing the address
 * itself in the `email_messages`/`email_suppressions`/`marketing_consents`
 * tables (§4 invariant 12). HMAC (not plain SHA-256) so the digest cannot be
 * reversed by a dictionary/rainbow-table attack against the small space of
 * real email addresses.
 */
export function hashContact(email: string, secret: string): string {
  return createHmac('sha256', secret).update(normalizeEmail(email), 'utf8').digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Reads the required contact-hash secret from the environment. Throws rather
 * than falling back to a guessable default — an unset secret must fail the
 * deployment closed, not silently hash with a known value.
 */
export function requireContactHashSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.EMAIL_CONTACT_HASH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('EMAIL_CONTACT_HASH_SECRET must be set to a value of at least 16 characters.');
  }
  return secret;
}
