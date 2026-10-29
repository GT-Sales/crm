import { describe, expect, it } from 'vitest';

import {
  CommandFailedError,
  nodeRunCommand,
  runOrThrow,
  stderrExcerpt,
  type RunCommand,
} from '../src/archive/command.js';

describe('stderrExcerpt', () => {
  it('stderrExcerpt drops image-pull progress, redacts URL passwords and keeps the end', () => {
    const stderr = `Digest: sha256:abc\npsql: error: connection to server at "h" failed: FATAL: password authentication failed for user "backup_reader.ref"\nconnection string postgresql://backup_reader.ref:s3cret@h:5432/postgres password=s3cret`;
    const excerpt = stderrExcerpt(stderr, 400);
    expect(excerpt).not.toContain('s3cret');
    expect(excerpt).not.toContain('Digest:');
    expect(excerpt).toContain('password authentication failed');
  });

  it('stderrExcerpt keeps the last `max` characters, prefixed with an ellipsis', () => {
    expect(stderrExcerpt('a'.repeat(500), 100)).toBe(`…${'a'.repeat(100)}`);
  });

  it('drops every kind of image-pull progress line and keeps only the real error', () => {
    const stderr = [
      'Dumping roles from remote database...',
      '17.6.1.141: Pulling from supabase/postgres',
      'd0c1d894c237: Pulling fs layer',
      '2a7fe997b3bc: Download complete',
      'Digest: sha256:abc',
      'Status: Downloaded newer image for ghcr.io/supabase/postgres:17.6.1.141',
      'pg_dump: error: query failed: ERROR:  permission denied for schema auth',
    ].join('\n');
    expect(stderrExcerpt(stderr)).toBe(
      'pg_dump: error: query failed: ERROR:  permission denied for schema auth',
    );
  });

  it('leaves the user name and host of a redacted connection string readable', () => {
    expect(
      stderrExcerpt(
        'failed to connect to postgresql://backup_reader.ref:s3cretPass@host:5432/postgres',
      ),
    ).toContain('postgresql://backup_reader.ref:[redacted]@host:5432/postgres');
  });
});

describe('runOrThrow', () => {
  it('runOrThrow returns stdout on exit 0 and throws CommandFailedError otherwise', async () => {
    const stdout = new TextEncoder().encode('dump bytes');
    const succeeding: RunCommand = async () => ({ stdout, stderr: '', exitCode: 0 });
    expect(await runOrThrow(succeeding, 'pg_dump', ['--schema-only'])).toEqual(stdout);

    const failing: RunCommand = async () => ({
      stdout: new Uint8Array(),
      stderr: 'x: Pulling from y\nconnection to postgresql://u:hunter2@h/db refused',
      exitCode: 2,
    });
    const error = await runOrThrow(failing, 'psql', ['-c', 'select 1']).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CommandFailedError);
    if (!(error instanceof CommandFailedError)) return;
    expect(error.command).toBe('psql');
    expect(error.exitCode).toBe(2);
    expect(error.message).toBe(
      'psql_failed:2:connection to postgresql://u:[redacted]@h/db refused',
    );
  });

  it('passes the command, arguments and options through unchanged', async () => {
    const calls: { command: string; args: readonly string[]; input?: Uint8Array }[] = [];
    const recording: RunCommand = async (command, args, options) => {
      calls.push({ command, args, input: options?.input });
      return { stdout: new Uint8Array(), stderr: '', exitCode: 0 };
    };
    const input = new Uint8Array([1, 2, 3]);
    await runOrThrow(recording, 'age', ['-r', 'age1example'], { input });
    expect(calls).toEqual([{ command: 'age', args: ['-r', 'age1example'], input }]);
  });
});

describe('nodeRunCommand', () => {
  it('nodeRunCommand runs a real process and captures stdout, stderr and exit code', async () => {
    const result = await nodeRunCommand(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ]);
    expect([new TextDecoder().decode(result.stdout), result.stderr, result.exitCode]).toEqual([
      'out',
      'err',
      3,
    ]);
  });

  it('feeds the input bytes to the process on stdin', async () => {
    const result = await nodeRunCommand(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: new TextEncoder().encode('piped') },
    );
    expect(new TextDecoder().decode(result.stdout)).toBe('piped');
    expect(result.exitCode).toBe(0);
  });

  it('rejects when the binary cannot be started', async () => {
    await expect(nodeRunCommand('gt-sales-no-such-binary', [])).rejects.toThrow(/ENOENT/);
  });
});
