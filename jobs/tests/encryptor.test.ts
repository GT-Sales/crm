import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeRunCommand, runOrThrow, type RunCommand } from '../src/archive/command.js';
import {
  AgeCliDecryptor,
  AgeCliEncryptor,
  DecryptionFailedError,
  TestEnvelopeDecryptor,
  TestEnvelopeEncryptor,
  ageAvailable,
  generateTestRecipientKeyPair,
} from '../src/archive/encryptor.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('TestEnvelopeEncryptor / TestEnvelopeDecryptor', () => {
  it('test envelope round-trips bytes', async () => {
    const { publicKeyBase64, privateKeyBase64 } = generateTestRecipientKeyPair();
    const plaintext = encode('synthetic backup payload');
    const ciphertext = await new TestEnvelopeEncryptor(publicKeyBase64).encrypt(plaintext);
    expect(ciphertext).not.toEqual(plaintext);
    expect(new TextDecoder().decode(ciphertext.subarray(0, 5))).toBe('GTSV1');
    const decrypted = await new TestEnvelopeDecryptor(privateKeyBase64).decrypt(ciphertext);
    expect(new TextDecoder().decode(decrypted)).toBe('synthetic backup payload');
  });

  it('test envelope rejects a flipped ciphertext byte with DecryptionFailedError', async () => {
    const { publicKeyBase64, privateKeyBase64 } = generateTestRecipientKeyPair();
    const ciphertext = Buffer.from(
      await new TestEnvelopeEncryptor(publicKeyBase64).encrypt(encode('secret')),
    );
    const last = ciphertext.length - 1;
    ciphertext.writeUInt8(ciphertext.readUInt8(last) ^ 0xff, last);
    await expect(
      new TestEnvelopeDecryptor(privateKeyBase64).decrypt(ciphertext),
    ).rejects.toBeInstanceOf(DecryptionFailedError);
  });

  it('test envelope rejects the wrong private key', async () => {
    const recipient = generateTestRecipientKeyPair();
    const other = generateTestRecipientKeyPair();
    const ciphertext = await new TestEnvelopeEncryptor(recipient.publicKeyBase64).encrypt(
      encode('secret'),
    );
    await expect(
      new TestEnvelopeDecryptor(other.privateKeyBase64).decrypt(ciphertext),
    ).rejects.toBeInstanceOf(DecryptionFailedError);
  });

  it('test envelope rejects truncated or foreign bytes', async () => {
    const { privateKeyBase64 } = generateTestRecipientKeyPair();
    const decryptor = new TestEnvelopeDecryptor(privateKeyBase64);
    await expect(decryptor.decrypt(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'decryption_failed:bad_magic',
    );
    // Another product's envelope (different magic) is never accepted.
    await expect(decryptor.decrypt(encode('CPTV1 envelope bytes'))).rejects.toThrow(
      'decryption_failed:bad_magic',
    );
  });
});

describe('AgeCliEncryptor / AgeCliDecryptor (command wiring, no age binary needed)', () => {
  it('AgeCliEncryptor passes -r <recipient> and the plaintext on stdin', async () => {
    const calls: { command: string; args: readonly string[]; input?: Uint8Array }[] = [];
    const recording: RunCommand = async (command, args, options) => {
      calls.push({ command, args, input: options?.input });
      return { stdout: encode('age ciphertext'), stderr: '', exitCode: 0 };
    };
    const plaintext = encode('payload');
    const ciphertext = await new AgeCliEncryptor('age1recipientexample', recording).encrypt(
      plaintext,
    );
    expect(ciphertext).toEqual(encode('age ciphertext'));
    expect(calls).toEqual([
      { command: 'age', args: ['-r', 'age1recipientexample'], input: plaintext },
    ]);
  });

  it('AgeCliEncryptor refuses an empty recipient', () => {
    expect(() => new AgeCliEncryptor('')).toThrow('age recipient is required');
    expect(() => new AgeCliEncryptor('  ')).toThrow('age recipient is required');
  });

  it('AgeCliEncryptor throws CommandFailedError when age exits non-zero', async () => {
    const failing: RunCommand = async () => ({
      stdout: new Uint8Array(),
      stderr: 'age: error: malformed recipient',
      exitCode: 1,
    });
    await expect(
      new AgeCliEncryptor('age1recipientexample', failing).encrypt(encode('x')),
    ).rejects.toThrow('age_failed:1:age: error: malformed recipient');
  });

  it('AgeCliDecryptor uses -d -i <identity file> and surfaces failure as DecryptionFailedError', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const failing: RunCommand = async (command, args) => {
      calls.push({ command, args });
      return { stdout: new Uint8Array(), stderr: 'age: error: no identity matched', exitCode: 1 };
    };
    await expect(
      new AgeCliDecryptor('/escrow/recovery-identity.txt', failing).decrypt(new Uint8Array([9])),
    ).rejects.toThrow(new DecryptionFailedError('age: error: no identity matched'));
    expect(calls).toEqual([
      { command: 'age', args: ['-d', '-i', '/escrow/recovery-identity.txt'] },
    ]);
  });
});

describe('ageAvailable', () => {
  it('is true when age --version exits 0', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const ok: RunCommand = async (command, args) => {
      calls.push({ command, args });
      return { stdout: encode('v1.2.1'), stderr: '', exitCode: 0 };
    };
    expect(await ageAvailable(ok)).toBe(true);
    expect(calls).toEqual([{ command: 'age', args: ['--version'] }]);
  });

  it('is false when age exits non-zero or cannot be started', async () => {
    const nonZero: RunCommand = async () => ({ stdout: new Uint8Array(), stderr: '', exitCode: 1 });
    const spawnError: RunCommand = async () => {
      throw new Error('spawn age ENOENT');
    };
    expect(await ageAvailable(nonZero)).toBe(false);
    expect(await ageAvailable(spawnError)).toBe(false);
  });
});

describe('real age', () => {
  it('real age round-trips when the binary is installed', async ({ skip }) => {
    // CI installs age with the backup rehearsal; a machine without it skips.
    if (!(await ageAvailable())) skip('age is not installed');
    const directory = await mkdtemp(join(tmpdir(), 'gt-sales-age-'));
    try {
      const identityFile = join(directory, 'identity.txt');
      await runOrThrow(nodeRunCommand, 'age-keygen', ['-o', identityFile]);
      const recipient = new TextDecoder()
        .decode(await runOrThrow(nodeRunCommand, 'age-keygen', ['-y', identityFile]))
        .trim();
      const plaintext = encode('synthetic backup payload');
      const ciphertext = await new AgeCliEncryptor(recipient).encrypt(plaintext);
      expect(ciphertext).not.toEqual(plaintext);
      expect(await new AgeCliDecryptor(identityFile).decrypt(ciphertext)).toEqual(plaintext);

      const otherIdentity = join(directory, 'other.txt');
      await runOrThrow(nodeRunCommand, 'age-keygen', ['-o', otherIdentity]);
      await expect(new AgeCliDecryptor(otherIdentity).decrypt(ciphertext)).rejects.toBeInstanceOf(
        DecryptionFailedError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
