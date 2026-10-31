import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** What a queued tracking code is bound to: one challenge of one site (ruling T8). */
export interface TrackingCodeBinding {
  workspaceId: string;
  challengeId: string;
}

/** What a grant's sealed email is bound to: one site and the email's keyed hash. */
export interface TrackingEmailBinding {
  workspaceId: string;
  emailHash: string;
}

// Ported from Canadian Plans' tracking/cipher.ts: AES-256-GCM, a fresh IV per
// value, the key derived per purpose so a sealed code never opens as a sealed
// email, and the binding as additional data so a value moved to another
// challenge, site or email does not open: `<iv>.<ciphertext>.<tag>`.
const CODE_PURPOSE = 'gt-sales-crm:tracking-code:v2';
const EMAIL_PURPOSE = 'gt-sales-crm:tracking-grant-email:v1';
/** A sealed six-digit code is 47 characters; anything near this is not one. */
const MAX_SEALED_CODE_LENGTH = 100;

function purposeKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(purpose).digest();
}

function seal(secret: string, purpose: string, aad: readonly string[], plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', purposeKey(secret, purpose), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

function open(
  secret: string,
  purpose: string,
  aad: readonly string[],
  sealed: string,
): string | undefined {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
  const [iv, encrypted, tag] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !encrypted || !tag || iv.length !== 12 || tag.length !== 16) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', purposeKey(secret, purpose), iv);
    decipher.setAAD(Buffer.from(JSON.stringify(aad)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** The code mail needs a recoverable code at send time, but the outbox never holds it readable. */
export function sealTrackingCode(
  secret: string,
  binding: TrackingCodeBinding,
  code: string,
): string {
  if (!/^\d{6}$/.test(code)) throw new Error('invalid_tracking_code');
  return seal(secret, CODE_PURPOSE, [binding.workspaceId, binding.challengeId], code);
}

/** The code, or undefined for a wrong key, another challenge or site, or anything tampered with. */
export function openTrackingCode(
  secret: string,
  binding: TrackingCodeBinding,
  sealed: string,
): string | undefined {
  if (sealed.length > MAX_SEALED_CODE_LENGTH) return undefined;
  const code = open(secret, CODE_PURPOSE, [binding.workspaceId, binding.challengeId], sealed);
  return code !== undefined && /^\d{6}$/.test(code) ? code : undefined;
}

/** Seals the verified email into a grant, so the website never holds it readable. */
export function sealTrackingEmail(
  secret: string,
  binding: TrackingEmailBinding,
  normalizedEmail: string,
): string {
  return seal(secret, EMAIL_PURPOSE, [binding.workspaceId, binding.emailHash], normalizedEmail);
}

export function openTrackingEmail(
  secret: string,
  binding: TrackingEmailBinding,
  sealed: string,
): string | undefined {
  const email = open(secret, EMAIL_PURPOSE, [binding.workspaceId, binding.emailHash], sealed);
  return email !== undefined && email.length > 0 && email.length <= 254 ? email : undefined;
}

/** Which row and field a sealed value belongs to; moved anywhere else, it does not open. */
export interface SensitiveFieldBinding {
  workspaceId: string;
  recordId: string;
  field: 'sin';
}

const SENSITIVE_FIELD_LABEL = 'gt-sales-crm:sensitive-field:v1';
const SEALED_FIELD = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/;

function sensitiveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(SENSITIVE_FIELD_LABEL).digest();
}

function sensitiveAad(binding: SensitiveFieldBinding): Buffer {
  return Buffer.from(JSON.stringify([binding.workspaceId, binding.recordId, binding.field]));
}

/**
 * `SENSITIVE_FIELDS_KEY` (docs/PLAN.md §5.9), or undefined when it is unset or
 * too short to be a real key. A caller without a key refuses the value: a
 * sensitive field is sealed or not stored at all.
 */
export function sensitiveFieldsKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.SENSITIVE_FIELDS_KEY?.trim();
  return value && value.length >= 32 ? value : undefined;
}

/** AES-256-GCM, a fresh IV per value, bound to its row and field: `v1.<iv>.<ciphertext>.<tag>`. */
export function sealSensitiveValue(
  secret: string,
  binding: SensitiveFieldBinding,
  value: string,
): string {
  if (value.length === 0) throw new Error('empty_sensitive_value');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sensitiveKey(secret), iv);
  cipher.setAAD(sensitiveAad(binding));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    ...[iv, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')),
  ].join('.');
}

/** The value, or undefined for a wrong key, a foreign binding or anything tampered with. */
export function openSensitiveValue(
  secret: string,
  binding: SensitiveFieldBinding,
  sealed: string,
): string | undefined {
  if (!SEALED_FIELD.test(sealed)) return undefined;
  const [, iv, encrypted, tag] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !encrypted || !tag) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sensitiveKey(secret), iv);
    decipher.setAAD(sensitiveAad(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
