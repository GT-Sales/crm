import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface TrackingCodeBinding {
  workspaceId: string;
  orderId: string;
  challengeId: string;
}

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('gt-sales-crm:sealed-value:v1').digest();
}
function aad(binding: TrackingCodeBinding): Buffer {
  return Buffer.from(JSON.stringify([binding.workspaceId, binding.orderId, binding.challengeId]));
}

/** The queue needs a recoverable code for delivery, but never stores it in plaintext. */
export function sealTrackingCode(
  secret: string,
  binding: TrackingCodeBinding,
  code: string,
): string {
  if (!/^\d{6}$/.test(code)) throw new Error('invalid_tracking_code');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return [iv, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

export function openTrackingCode(
  secret: string,
  binding: TrackingCodeBinding,
  sealed: string,
): string | undefined {
  if (!/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{22}$/.test(sealed)) return undefined;
  const parts = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secret), parts[0]!);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(parts[2]!);
    const code = Buffer.concat([decipher.update(parts[1]!), decipher.final()]).toString('utf8');
    return /^\d{6}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
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
