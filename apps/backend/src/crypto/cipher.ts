import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface TrackingCodeBinding {
  workspaceId: string;
  orderId: string;
  challengeId: string;
}

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('canadian-plans:tracking-outbox:v1').digest();
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
