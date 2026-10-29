import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { CommandFailedError, type RunCommand, nodeRunCommand, stderrExcerpt } from './command.js';

/**
 * Every backup payload and its manifest is encrypted before it leaves the
 * runner, so the archive bucket (and anyone holding an archive key) sees only
 * ciphertext; the dump holds every lead's contact details. Two implementations:
 *
 * - `AgeCliEncryptor`/`AgeCliDecryptor`: the production path. It shells out to
 *   a pinned, supported `age` release as docs/RUNBOOKS/backup.md records,
 *   never reimplementing cryptography. The backup runner holds only the public
 *   recipient; the recovery private key stays with the owner and never enters
 *   GitHub (docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md
 *   §10).
 * - `TestEnvelopeEncryptor`/`TestEnvelopeDecryptor`: a disposable,
 *   dependency-free X25519 + HKDF-SHA-256 + AES-256-GCM envelope. It exists
 *   only so tests and local rehearsals can exercise the surrounding
 *   manifest/archive logic without the `age` binary installed. It must never
 *   be selected in production wiring. Its magic and HKDF info are this
 *   product's own, so it never accepts Canadian Plans' test envelopes.
 */

export interface Encryptor {
  readonly algorithm: string;
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
}

export interface Decryptor {
  readonly algorithm: string;
  /** Throws on any authentication failure (corrupt/tampered ciphertext, wrong key). */
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export class DecryptionFailedError extends Error {
  constructor(reason: string) {
    super(`decryption_failed:${reason}`);
    this.name = 'DecryptionFailedError';
  }
}

/** Production: age -r <recipient>. */
export class AgeCliEncryptor implements Encryptor {
  readonly algorithm = 'age';
  constructor(
    private readonly recipient: string,
    private readonly run: RunCommand = nodeRunCommand,
    private readonly binary = 'age',
  ) {
    if (!recipient.trim()) throw new Error('age recipient is required');
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const result = await this.run(this.binary, ['-r', this.recipient], { input: plaintext });
    if (result.exitCode !== 0)
      throw new CommandFailedError(this.binary, result.exitCode, result.stderr);
    return result.stdout;
  }
}

/**
 * Production restore-side decryption. The identity file path points at the
 * separately escrowed private key; it must never be a repository path or a
 * value baked into a workflow file (see docs/RUNBOOKS/backup.md).
 */
export class AgeCliDecryptor implements Decryptor {
  readonly algorithm = 'age';
  constructor(
    private readonly identityFilePath: string,
    private readonly run: RunCommand = nodeRunCommand,
    private readonly binary = 'age',
  ) {}

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    const result = await this.run(this.binary, ['-d', '-i', this.identityFilePath], {
      input: ciphertext,
    });
    if (result.exitCode !== 0) throw new DecryptionFailedError(stderrExcerpt(result.stderr, 200));
    return result.stdout;
  }
}

/**
 * Whether the `age` binary can be run here: `age --version` exits 0. False on
 * a spawn error or a non-zero exit, so tests that need the real tool can skip.
 */
export async function ageAvailable(run: RunCommand = nodeRunCommand): Promise<boolean> {
  try {
    return (await run('age', ['--version'])).exitCode === 0;
  } catch {
    return false;
  }
}

const TEST_ENVELOPE_INFO = 'gt-sales-backup-test-envelope-v1';
const TEST_ENVELOPE_MAGIC = new TextEncoder().encode('GTSV1');

export interface TestRecipientKeyPair {
  publicKeyBase64: string;
  privateKeyBase64: string;
}

/** Generates a disposable X25519 keypair for tests/local rehearsals only. */
export function generateTestRecipientKeyPair(): TestRecipientKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function deriveAesKey(sharedSecret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, TEST_ENVELOPE_INFO, 32));
}

/**
 * Non-production disposable envelope (see module doc). Format:
 * MAGIC(5) || ephemeralPublicKeyDer(len-prefixed u16) || iv(12) || authTag(16) || ciphertext
 */
export class TestEnvelopeEncryptor implements Encryptor {
  readonly algorithm = 'test-envelope-x25519-aesgcm';
  private readonly recipientPublicKey: ReturnType<typeof createPublicKey>;
  private readonly recipientPublicKeyDer: Buffer;

  constructor(recipientPublicKeyBase64: string) {
    this.recipientPublicKeyDer = Buffer.from(recipientPublicKeyBase64, 'base64');
    this.recipientPublicKey = createPublicKey({
      key: this.recipientPublicKeyDer,
      format: 'der',
      type: 'spki',
    });
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const ephemeral = generateKeyPairSync('x25519');
    const ephemeralPublicDer = ephemeral.publicKey.export({ format: 'der', type: 'spki' });
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: this.recipientPublicKey,
    });
    const key = deriveAesKey(
      shared,
      Buffer.concat([ephemeralPublicDer, this.recipientPublicKeyDer]),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const keyLen = Buffer.alloc(2);
    keyLen.writeUInt16BE(ephemeralPublicDer.byteLength, 0);
    return Buffer.concat([
      Buffer.from(TEST_ENVELOPE_MAGIC),
      keyLen,
      ephemeralPublicDer,
      iv,
      authTag,
      ciphertext,
    ]);
  }
}

export class TestEnvelopeDecryptor implements Decryptor {
  readonly algorithm = 'test-envelope-x25519-aesgcm';
  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  constructor(privateKeyBase64: string) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    try {
      const buf = Buffer.from(ciphertext);
      const magic = buf.subarray(0, TEST_ENVELOPE_MAGIC.byteLength);
      if (!magic.equals(Buffer.from(TEST_ENVELOPE_MAGIC))) throw new Error('bad_magic');
      let offset = TEST_ENVELOPE_MAGIC.byteLength;
      const keyLen = buf.readUInt16BE(offset);
      offset += 2;
      const ephemeralPublicDer = buf.subarray(offset, offset + keyLen);
      offset += keyLen;
      const iv = buf.subarray(offset, offset + 12);
      offset += 12;
      const authTag = buf.subarray(offset, offset + 16);
      offset += 16;
      const body = buf.subarray(offset);

      const ephemeralPublicKey = createPublicKey({
        key: ephemeralPublicDer,
        format: 'der',
        type: 'spki',
      });
      const shared = diffieHellman({ privateKey: this.privateKey, publicKey: ephemeralPublicKey });
      const recipientPublicDer = createPublicKey(this.privateKey)
        .export({ format: 'der', type: 'spki' })
        .subarray();
      const key = deriveAesKey(shared, Buffer.concat([ephemeralPublicDer, recipientPublicDer]));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch (error) {
      throw new DecryptionFailedError(error instanceof Error ? error.message : 'unknown');
    }
  }
}
