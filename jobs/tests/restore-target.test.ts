import { sha256Hex } from '@gt-sales/adapters';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RunCommand, RunCommandInput, RunCommandResult } from '../src/archive/command.js';
import type { DatabaseDumpArtifacts } from '../src/backup/pg-dump.js';
import {
  nodeWithTempDir,
  psqlErrorLines,
  PsqlAndS3RestoreTarget,
  rowCountsQuery,
  type WithTempDir,
} from '../src/restore/target.js';

const DATABASE_URL =
  'postgresql://postgres.targetref:t%40rget-secret@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';
const PASSWORD = 't@rget-secret';
const BASE_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
const STORAGE = {
  endpoint: 'https://targetref.storage.supabase.co/storage/v1/s3',
  region: 'ap-south-1',
  bucket: 'documents',
  accessKeyId: 'target-storage-key-id',
  secretAccessKey: 'target-storage-secret',
};

const encode = (text: string) => new TextEncoder().encode(text);

interface RecordedCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The contents of every `--file` argument, read while the call ran. */
  files: Record<string, string>;
}

/** Records each call and answers from `responses` in order (default: success, no output). */
function recordingRun(responses: Partial<RunCommandResult>[] = []) {
  const calls: RecordedCall[] = [];
  const run: RunCommand = async (command, args, options?: RunCommandInput) => {
    const files: Record<string, string> = {};
    for (const [index, arg] of args.entries()) {
      const path = args[index + 1];
      if (arg === '--file' && path) files[path] = await readFile(path, 'utf8');
    }
    calls.push({ command, args, env: options?.env ?? {}, files });
    const response = responses[calls.length - 1] ?? {};
    return {
      stdout: response.stdout ?? new Uint8Array(),
      stderr: response.stderr ?? '',
      exitCode: response.exitCode ?? 0,
    };
  };
  return { run, calls };
}

function stdout(text: string): Partial<RunCommandResult> {
  return { stdout: encode(text) };
}

function target(
  run: RunCommand,
  options: { skipRoles?: boolean; storage?: typeof STORAGE; fetchImpl?: typeof fetch } = {},
  withTempDir?: WithTempDir,
) {
  return new PsqlAndS3RestoreTarget({
    databaseUrl: DATABASE_URL,
    skipRoles: options.skipRoles ?? false,
    run,
    baseEnv: BASE_ENV,
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(withTempDir ? { withTempDir } : {}),
  });
}

/** Every psql call carries the connection in PG* variables only. */
function expectConnectionInEnvOnly(call: RecordedCall | undefined): void {
  expect(call?.command).toBe('psql');
  expect(call?.env).toMatchObject({
    PATH: '/usr/bin',
    PGHOST: 'aws-1-ap-south-1.pooler.supabase.com',
    PGPORT: '5432',
    PGUSER: 'postgres.targetref',
    PGPASSWORD: PASSWORD,
    PGDATABASE: 'postgres',
    PGSSLMODE: 'require',
  });
  const argv = call?.args.join(' ') ?? '';
  expect(argv).not.toContain('postgresql://');
  expect(argv).not.toContain(PASSWORD);
  expect(argv).not.toContain('t%40rget-secret');
  expect(call?.args).toContain('--no-psqlrc');
  expect(call?.args.join(' ')).toContain('--variable ON_ERROR_STOP=1');
}

const ROLE_QUERY = 'select (rolsuper or rolbypassrls) from pg_roles where rolname = current_user';
const NAMESPACE_QUERY = "select count(*) from pg_namespace where nspname in ('app','drizzle')";

function dump(overrides: Partial<DatabaseDumpArtifacts> = {}): DatabaseDumpArtifacts {
  return {
    roles: encode('CREATE ROLE "backup_reader";'),
    schema: encode('CREATE SCHEMA IF NOT EXISTS "app";'),
    data: encode('COPY "app"."leads" ("id") FROM stdin;\n1\n\\.\n'),
    ...overrides,
  };
}

/** The `--file` paths of one call, as basenames, in argv order. */
function fileSequence(call: RecordedCall | undefined): string[] {
  const args = call?.args ?? [];
  return args.flatMap((arg, index) => {
    const next = args[index + 1];
    if (arg === '--file' && next) return [`--file ${next.split('/').pop() ?? ''}`];
    if (arg === '--command' && next) return [`--command ${next}`];
    return [];
  });
}

describe('PsqlAndS3RestoreTarget.preflight', () => {
  it('preflight throws restore_target_role_cannot_bypass_rls when psql prints f', async () => {
    const { run, calls } = recordingRun([stdout('f\n')]);
    await expect(target(run).preflight()).rejects.toThrow('restore_target_role_cannot_bypass_rls');
    expect(calls).toHaveLength(1);
    expectConnectionInEnvOnly(calls[0]);
    expect(calls[0]?.args).toEqual([
      '--no-psqlrc',
      '--variable',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '--command',
      ROLE_QUERY,
    ]);
  });

  it('preflight treats an empty answer (no such role row) as unable to bypass RLS', async () => {
    const { run } = recordingRun([stdout('')]);
    await expect(target(run).preflight()).rejects.toThrow('restore_target_role_cannot_bypass_rls');
  });

  it('preflight throws restore_target_not_empty when app or drizzle exists', async () => {
    const { run, calls } = recordingRun([stdout('t\n'), stdout('1\n')]);
    await expect(target(run).preflight()).rejects.toThrow('restore_target_not_empty');
    expect(calls).toHaveLength(2);
    expectConnectionInEnvOnly(calls[1]);
    expect(calls[1]?.args).toEqual([
      '--no-psqlrc',
      '--variable',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '--command',
      NAMESPACE_QUERY,
    ]);
  });

  it('preflight passes for an RLS-bypassing role on an empty target', async () => {
    const { run, calls } = recordingRun([stdout('t\n'), stdout('0\n')]);
    await expect(target(run).preflight()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('a failing psql surfaces as psql_failed with the password redacted', async () => {
    const { run } = recordingRun([
      {
        exitCode: 2,
        stderr: `psql: error: connection to postgresql://postgres:${encodeURIComponent(PASSWORD)}@host:5432/postgres failed`,
      },
    ]);
    const error: unknown = await target(run)
      .preflight()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/^psql_failed:2:/);
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('rget-secret');
  });

  it('rejects a database URL that is not postgres:// without echoing it', () => {
    const { run } = recordingRun();
    expect(
      () =>
        new PsqlAndS3RestoreTarget({
          databaseUrl: `mysql://root:${PASSWORD}@host/db`,
          skipRoles: false,
          run,
        }),
    ).toThrow(/^TARGET_DATABASE_URL must be a postgres:\/\/ URL$/);
  });
});

describe('PsqlAndS3RestoreTarget.applyDatabase', () => {
  it('applyDatabase runs one single-transaction psql with roles, schema, replica role and data, in that order', async () => {
    const { run, calls } = recordingRun();
    await target(run).applyDatabase(dump());
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expectConnectionInEnvOnly(call);
    expect(call?.args.slice(0, 4)).toEqual([
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--no-psqlrc',
    ]);
    expect(fileSequence(call)).toEqual([
      '--file roles.sql',
      '--file schema.sql',
      '--command SET session_replication_role = replica',
      '--file data.sql',
    ]);
    expect(Object.values(call?.files ?? {})).toEqual([
      'CREATE ROLE "backup_reader";',
      'CREATE SCHEMA IF NOT EXISTS "app";',
      'COPY "app"."leads" ("id") FROM stdin;\n1\n\\.\n',
    ]);
  });

  it('applyDatabase omits roles.sql when skipRoles is true', async () => {
    const { run, calls } = recordingRun();
    await target(run, { skipRoles: true }).applyDatabase(dump());
    expect(calls).toHaveLength(1);
    expect(fileSequence(calls[0])).toEqual([
      '--file schema.sql',
      '--command SET session_replication_role = replica',
      '--file data.sql',
    ]);
    expect(Object.values(calls[0]?.files ?? {})).not.toContain('CREATE ROLE "backup_reader";');
  });

  it('applyDatabase runs the history pair in a second transaction only when both artifacts exist', async () => {
    const { run, calls } = recordingRun();
    await target(run).applyDatabase(
      dump({ historySchema: encode('history schema'), historyData: encode('history data') }),
    );
    expect(calls).toHaveLength(2);
    expectConnectionInEnvOnly(calls[1]);
    expect(calls[1]?.args.slice(0, 4)).toEqual([
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--no-psqlrc',
    ]);
    expect(fileSequence(calls[1])).toEqual([
      '--file history_schema.sql',
      '--file history_data.sql',
    ]);
    expect(Object.values(calls[1]?.files ?? {})).toEqual(['history schema', 'history data']);

    const withoutHistory = recordingRun();
    await target(withoutHistory.run).applyDatabase(dump());
    expect(withoutHistory.calls).toHaveLength(1);
  });

  it('refuses a run that holds only one history artifact, before running psql', async () => {
    for (const partial of [
      { historySchema: encode('history schema') },
      { historyData: encode('history data') },
    ]) {
      const { run, calls } = recordingRun();
      await expect(target(run).applyDatabase(dump(partial))).rejects.toThrow(
        'restore_history_artifacts_incomplete',
      );
      expect(calls).toEqual([]);
    }
  });

  it('does not run the history transaction when the main one fails', async () => {
    const { run, calls } = recordingRun([{ exitCode: 3, stderr: 'ERROR: boom' }]);
    await expect(
      target(run).applyDatabase(
        dump({ historySchema: encode('history schema'), historyData: encode('history data') }),
      ),
    ).rejects.toThrow(/^psql_failed:3:ERROR: boom$/);
    expect(calls).toHaveLength(1);
  });

  it('a load failure reports the ERROR line only, never the row values in DETAIL or CONTEXT', async () => {
    const stderr = [
      'psql:/tmp/gt-sales-restore-x/data.sql:12: ERROR:  duplicate key value violates unique constraint "leads_email_key"',
      'DETAIL:  Key (email)=(a@b.c) already exists.',
      'CONTEXT:  COPY leads, line 3: "3\tAda Lovelace\ta@b.c\t+1 604 555 0100"',
      'HINT:  Check the row for Ada Lovelace.',
      "LINE 1: insert into app.leads values ('Ada Lovelace')",
      '                                      ^',
    ].join('\n');
    const { run } = recordingRun([{ exitCode: 3, stderr }]);
    const error: unknown = await target(run)
      .applyDatabase(dump())
      .catch((caught: unknown) => caught);
    const message = error instanceof Error ? error.message : '';
    expect(message).toBe(
      'psql_failed:3:psql:/tmp/gt-sales-restore-x/data.sql:12: ERROR:  duplicate key value violates unique constraint "leads_email_key"',
    );
    for (const detail of [
      'a@b.c',
      'Ada Lovelace',
      '555 0100',
      'DETAIL',
      'CONTEXT',
      'HINT',
      'LINE 1',
    ]) {
      expect(message).not.toContain(detail);
    }
  });

  it("keeps psql's own script-mode error lines, so a failure reason is never empty", async () => {
    const lost = [
      'psql:/tmp/x/data.sql:1234: server closed the connection unexpectedly',
      '\tThis probably means the server terminated abnormally',
      '\tbefore or while processing the request.',
      'psql:/tmp/x/data.sql:1234: error: connection to server was lost',
    ].join('\n');
    expect(psqlErrorLines(lost)).toBe(
      'psql:/tmp/x/data.sql:1234: error: connection to server was lost',
    );
    const restrict = 'psql:/tmp/x/data.sql:5: error: invalid command \\restrict';
    expect(psqlErrorLines(restrict)).toBe(restrict);

    const { run } = recordingRun([{ exitCode: 2, stderr: lost }]);
    const error: unknown = await target(run)
      .applyDatabase(dump())
      .catch((caught: unknown) => caught);
    expect(error instanceof Error ? error.message : '').toBe(
      'psql_failed:2:psql:/tmp/x/data.sql:1234: error: connection to server was lost',
    );
  });

  it('drops a DETAIL continuation line that merely contains ERROR: mid-text', () => {
    const stderr = [
      'psql:/tmp/x/data.sql:12: ERROR:  new row for relation "leads" violates check constraint "leads_note_check"',
      'DETAIL:  Failing row contains (3, Ada Lovelace, note line one',
      'customer wrote ERROR: please call a@b.c back).',
      'CONTEXT:  COPY leads, line 3',
    ].join('\n');
    const kept = psqlErrorLines(stderr);
    expect(kept).toBe(
      'psql:/tmp/x/data.sql:12: ERROR:  new row for relation "leads" violates check constraint "leads_note_check"',
    );
    expect(kept).not.toContain('a@b.c');
    expect(kept).not.toContain('Ada Lovelace');
  });

  it('psqlErrorLines keeps connection and server error lines, with credentials still redacted', async () => {
    expect(
      psqlErrorLines(
        [
          'psql: error: connection to server at "h" (10.0.0.1), port 5432 failed: FATAL:  password authentication failed for user "postgres"',
          'DETAIL:  Role "postgres" does not exist.',
          'NOTICE:  relation exists, skipping',
        ].join('\n'),
      ),
    ).toBe(
      'psql: error: connection to server at "h" (10.0.0.1), port 5432 failed: FATAL:  password authentication failed for user "postgres"',
    );
    const { run } = recordingRun([
      {
        exitCode: 2,
        stderr: `psql: error: connection to postgresql://postgres:${encodeURIComponent(PASSWORD)}@host:5432/postgres failed\nDETAIL:  Key (email)=(a@b.c)`,
      },
    ]);
    const error: unknown = await target(run)
      .countRows(['app.leads'])
      .catch((caught: unknown) => caught);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(
      /^psql_failed:2:psql: error: connection to postgresql:\/\/postgres:\[redacted\]@host/,
    );
    expect(message).not.toContain('rget-secret');
    expect(message).not.toContain('a@b.c');
  });

  it('removes the temporary directory after success and after a failure', async () => {
    for (const exitCode of [0, 3]) {
      const { run, calls } = recordingRun([{ exitCode }]);
      await target(run)
        .applyDatabase(dump())
        .catch(() => undefined);
      const firstFile = Object.keys(calls[0]?.files ?? {})[0] ?? '';
      expect(firstFile).not.toBe('');
      expect(existsSync(dirname(firstFile))).toBe(false);
    }
  });

  it('uses an injected temporary directory', async () => {
    const dirs: string[] = [];
    const withTempDir: WithTempDir = (fn) =>
      nodeWithTempDir((dir) => {
        dirs.push(dir);
        return fn(dir);
      });
    const { run, calls } = recordingRun();
    await target(run, {}, withTempDir).applyDatabase(dump());
    expect(dirs).toHaveLength(1);
    expect(Object.keys(calls[0]?.files ?? {}).every((path) => dirname(path) === dirs[0])).toBe(
      true,
    );
  });
});

describe('nodeWithTempDir', () => {
  it('removes the directory when the callback throws', async () => {
    let seen = '';
    await expect(
      nodeWithTempDir(async (dir) => {
        seen = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });
});

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
}

function fakeStorage(status = 200) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = init?.body;
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(),
    });
    return new Response(null, { status });
  };
  return { fetchImpl, requests };
}

describe('PsqlAndS3RestoreTarget.applyObjects', () => {
  it('applyObjects PUTs workspaces/<ws>/<key> for each objects/<ws>/<key> artifact', async () => {
    const { fetchImpl, requests } = fakeStorage();
    const { run, calls } = recordingRun();
    const one = encode('%PDF-1 one');
    const two = encode('%PDF-1 two');
    await target(run, { storage: STORAGE, fetchImpl }).applyObjects(
      new Map([
        ['objects/ws-1/doc-1.pdf', one],
        ['objects/ws-2/nested/doc-2.pdf', two],
      ]),
    );
    expect(calls).toEqual([]);
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: 'PUT',
        url: 'https://targetref.storage.supabase.co/storage/v1/s3/documents/workspaces/ws-1/doc-1.pdf',
      },
      {
        method: 'PUT',
        url: 'https://targetref.storage.supabase.co/storage/v1/s3/documents/workspaces/ws-2/nested/doc-2.pdf',
      },
    ]);
    expect(requests[0]?.body).toEqual(one);
    expect(requests[1]?.body).toEqual(two);
    for (const [index, bytes] of [one, two].entries()) {
      const headers = requests[index]?.headers;
      expect(headers?.get('authorization')).toMatch(
        /^AWS4-HMAC-SHA256 Credential=target-storage-key-id\/\d{8}\/ap-south-1\/s3\/aws4_request, /,
      );
      expect(headers?.get('x-amz-content-sha256')).toBe(sha256Hex(bytes));
    }
  });

  it('applyObjects throws restore_storage_not_configured when objects exist but no storage is set', async () => {
    const { fetchImpl, requests } = fakeStorage();
    const { run } = recordingRun();
    await expect(
      target(run, { fetchImpl }).applyObjects(
        new Map([['objects/ws-1/doc-1.pdf', encode('%PDF')]]),
      ),
    ).rejects.toThrow('restore_storage_not_configured');
    expect(requests).toEqual([]);
  });

  it('applyObjects with no objects needs no storage', async () => {
    const { fetchImpl, requests } = fakeStorage();
    const { run } = recordingRun();
    await expect(target(run, { fetchImpl }).applyObjects(new Map())).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('applyObjects refuses an artifact name outside objects/<ws>/<key> before any PUT', async () => {
    const { fetchImpl, requests } = fakeStorage();
    const { run } = recordingRun();
    await expect(
      target(run, { storage: STORAGE, fetchImpl }).applyObjects(
        new Map([
          ['objects/ws-1/doc-1.pdf', encode('%PDF')],
          ['objects/ws-1', encode('%PDF')],
        ]),
      ),
    ).rejects.toThrow('restore_object_name_invalid');
    expect(requests).toEqual([]);
  });

  it('applyObjects fails on a rejected PUT', async () => {
    const { fetchImpl } = fakeStorage(403);
    const { run } = recordingRun();
    await expect(
      target(run, { storage: STORAGE, fetchImpl }).applyObjects(
        new Map([['objects/ws-1/doc-1.pdf', encode('%PDF')]]),
      ),
    ).rejects.toThrow('archive_put_failed:403');
  });
});

describe('PsqlAndS3RestoreTarget.countRows', () => {
  it('countRows parses the per-table counts and reports a missing table as -1', async () => {
    const { run, calls } = recordingRun([
      stdout('app.leads\t2\napp.missing\t-1\nauth.users\t3000000000\n'),
    ]);
    const counts = await target(run).countRows(['app.leads', 'app.missing', 'auth.users']);
    expect(counts).toEqual({ 'app.leads': 2, 'app.missing': -1, 'auth.users': 3_000_000_000 });
    expect(calls).toHaveLength(1);
    expectConnectionInEnvOnly(calls[0]);
    expect(calls[0]?.args).toEqual([
      '--no-psqlrc',
      '--variable',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '--field-separator',
      '\t',
      '--command',
      rowCountsQuery(['app.leads', 'app.missing', 'auth.users']),
    ]);
  });

  it('the count query counts every table in one round trip with query_to_xml', () => {
    const sql = rowCountsQuery(['app.leads', 'auth.users']);
    expect(sql).toContain("('app', 'leads', 'app.leads')");
    expect(sql).toContain("('auth', 'users', 'auth.users')");
    expect(sql).toContain(
      "(xpath('/row/cnt/text()', query_to_xml(format('select count(*) as cnt from %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text::bigint",
    );
    expect(sql).toMatch(/left join pg_tables t/);
    expect(sql).toMatch(/when t\.tablename is null then -1/);
  });

  it('refuses a table name that is not schema.table before running psql', async () => {
    for (const name of ['app.leads; drop table x', 'App.leads', 'leads', "app.le'ads", 'a.b.c']) {
      const { run, calls } = recordingRun();
      await expect(target(run).countRows(['app.leads', name])).rejects.toThrow(
        `restore_row_count_table_invalid:${name}`,
      );
      expect(calls).toEqual([]);
    }
  });

  it('counts nothing without a round trip when no table is named', async () => {
    const { run, calls } = recordingRun();
    await expect(target(run).countRows([])).resolves.toEqual({});
    expect(calls).toEqual([]);
  });

  it('fails on output it cannot parse', async () => {
    const { run } = recordingRun([stdout('app.leads\tmany\n')]);
    await expect(target(run).countRows(['app.leads'])).rejects.toThrow(
      'restore_row_count_output_malformed',
    );
  });
});
