import { spawn } from 'node:child_process';

/**
 * Thin process-execution seam so every tool the backup, restore and retention
 * CLIs shell out to (`pg_dump`, `psql`, `age`) is injectable in tests without
 * the real binaries installed. The CLIs reach Postgres only through these
 * child processes, never through `@gt-sales/db`, which only the backend may
 * import (AGENTS.md rule 1). docs/RUNBOOKS/backup.md records the commands.
 * Production wiring uses `nodeRunCommand`; tests inject a fake that asserts
 * on `command`/`args` and returns fixed bytes.
 */
export interface RunCommandInput {
  input?: Uint8Array;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunCommandResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: RunCommandInput,
) => Promise<RunCommandResult>;

/** Real process execution. Never logs argv or stdin (may carry secrets/bytes). */
export const nodeRunCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: exitCode ?? -1,
      });
    });
    if (options.input) child.stdin.end(Buffer.from(options.input));
    else child.stdin.end();
  });

/** Docker image-pull progress the Supabase CLI prints before its real error. */
const PULL_PROGRESS =
  /^(?:[0-9a-f]{12}: |Digest: |Status: |[\w.-]+: Pulling from |Retrying after |Dumping roles from )/;

/**
 * The part of a tool's stderr worth logging: progress lines dropped, any
 * connection string's password blanked, and the END kept, because the cause
 * comes last (the first 200 characters of a `supabase db dump` failure were
 * only image-pull progress on 23 Oct 2026).
 */
export function stderrExcerpt(stderr: string, max = 400): string {
  const meaningful = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !PULL_PROGRESS.test(line))
    .join('\n')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1[redacted]@')
    .replace(/(password=)\S+/gi, '$1[redacted]');
  return meaningful.length > max ? `…${meaningful.slice(-max)}` : meaningful;
}

/** Raised when a required provider command exits non-zero or errors. */
export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    stderr: string,
  ) {
    super(`${command}_failed:${exitCode}:${stderrExcerpt(stderr)}`);
    this.name = 'CommandFailedError';
  }
}

export async function runOrThrow(
  run: RunCommand,
  command: string,
  args: readonly string[],
  options?: RunCommandInput,
): Promise<Uint8Array> {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) throw new CommandFailedError(command, result.exitCode, result.stderr);
  return result.stdout;
}
