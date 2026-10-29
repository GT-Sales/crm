import { describe, expect, it } from 'vitest';

import {
  CommandFailedError,
  type RunCommand,
  type RunCommandInput,
} from '../src/archive/command.js';
import {
  APP_SCHEMAS,
  AUTH_SCHEMA,
  AUTH_TABLES,
  HISTORY_SCHEMA,
  INTERNAL_SCHEMAS,
  PgDumpDatabaseExporter,
  filterData,
  filterRoles,
  filterSchema,
  parseConnectionUrl,
} from '../src/backup/pg-dump.js';

const URL_WITH_SECRET =
  'postgresql://backup_reader.xykrphbgpwisqacpyeiv:s3cretPassw0rd@aws-0-us-west-2.pooler.supabase.com:5432/postgres';

interface RecordedCall {
  command: string;
  args: readonly string[];
  options?: RunCommandInput;
}

function recordingRun(stdout = 'SELECT 1;\n') {
  const calls: RecordedCall[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: new TextEncoder().encode(stdout), stderr: '', exitCode: 0 };
  };
  return { run, calls };
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe('PgDumpDatabaseExporter', () => {
  it('runs roles, schema, data, auth-table and history dumps with explicit, strict schema and table lists and row security on', async () => {
    const { run, calls } = recordingRun();
    const artifacts = await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'include', history: 'include' },
      {},
    ).exportAll();

    expect(calls.map((call) => call.command)).toEqual([
      'pg_dumpall',
      'pg_dump',
      'pg_dump',
      'pg_dump',
      'pg_dump',
      'pg_dump',
    ]);
    expect(calls[0]?.args).toEqual([
      '--roles-only',
      '--quote-all-identifier',
      '--no-role-passwords',
      '--no-comments',
    ]);
    expect(calls[1]?.args).toEqual([
      '--schema-only',
      '--quote-all-identifier',
      '--strict-names',
      '--schema',
      'app',
      '--schema',
      'public',
      '--schema',
      'drizzle',
    ]);
    expect(calls[2]?.args).toEqual([
      '--data-only',
      '--quote-all-identifier',
      '--enable-row-security',
      '--strict-names',
      '--schema',
      'app',
      '--schema',
      'public',
      '--schema',
      'drizzle',
    ]);
    // pg_dump ignores every --schema once a --table is given, so the two auth
    // tables are their own dump, never added to the schema dump above.
    expect(calls[3]?.args).toEqual([
      '--data-only',
      '--quote-all-identifier',
      '--enable-row-security',
      '--strict-names',
      '--table',
      'auth.users',
      '--table',
      'auth.identities',
    ]);
    expect(calls[4]?.args).toEqual([
      '--schema-only',
      '--quote-all-identifier',
      '--strict-names',
      '--schema',
      'supabase_migrations',
    ]);
    expect(calls[5]?.args).toEqual([
      '--data-only',
      '--quote-all-identifier',
      '--strict-names',
      '--schema',
      'supabase_migrations',
    ]);
    for (const call of calls.slice(1)) {
      expect(call.args).not.toContain('--exclude-table');
      expect(call.args.filter((arg) => arg === '--table').length > 0).toBe(call === calls[3]);
    }
    for (const call of calls) expect(call.args).not.toContain('--role');

    expect(text(artifacts.roles)).toContain('RESET ALL;');
    expect(text(artifacts.schema)).toBe('SELECT 1;\n');
    expect(text(artifacts.data).startsWith('SET session_replication_role = replica;')).toBe(true);
    expect(text(artifacts.historySchema)).toBe('SELECT 1;\n');
    expect(text(artifacts.historyData)).toContain('RESET ALL;');
  });

  it('leaves auth out of the data dump when authData is skip', async () => {
    const { run, calls } = recordingRun();
    await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'skip', history: 'include' },
      {},
    ).exportAll();

    expect(calls.map((call) => call.command)).toEqual([
      'pg_dumpall',
      'pg_dump',
      'pg_dump',
      'pg_dump',
      'pg_dump',
    ]);
    expect(calls[2]?.args).toEqual([
      '--data-only',
      '--quote-all-identifier',
      '--enable-row-security',
      '--strict-names',
      '--schema',
      'app',
      '--schema',
      'public',
      '--schema',
      'drizzle',
    ]);
    for (const call of calls) {
      expect(call.args.some((arg) => arg.includes('auth'))).toBe(false);
    }
  });

  it('skips both history dumps when history is skip', async () => {
    const { run, calls } = recordingRun();
    const artifacts = await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'include', history: 'skip' },
      {},
    ).exportAll();

    // Roles, schema, app data, auth-table data.
    expect(calls.map((call) => call.command)).toEqual([
      'pg_dumpall',
      'pg_dump',
      'pg_dump',
      'pg_dump',
    ]);
    expect(calls.some((call) => call.args.includes('supabase_migrations'))).toBe(false);
    expect(artifacts.historySchema).toBeUndefined();
    expect(artifacts.historyData).toBeUndefined();
  });

  it('passes the connection only through PG* environment variables, never argv', async () => {
    const { run, calls } = recordingRun();
    await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'include', history: 'include' },
      { PATH: '/usr/bin' },
    ).exportAll();

    expect(calls).toHaveLength(6);
    for (const call of calls) {
      const argv = call.args.join(' ');
      expect(argv).not.toContain('postgres://');
      expect(argv).not.toContain('postgresql://');
      expect(argv).not.toContain('s3cretPassw0rd');
      expect(call.options?.env).toEqual({
        PATH: '/usr/bin',
        PGHOST: 'aws-0-us-west-2.pooler.supabase.com',
        PGPORT: '5432',
        PGUSER: 'backup_reader.xykrphbgpwisqacpyeiv',
        PGPASSWORD: 's3cretPassw0rd',
        PGDATABASE: 'postgres',
        PGSSLMODE: 'require',
      });
    }
  });

  it('keeps a PGSSLMODE the base environment sets', async () => {
    const { run, calls } = recordingRun();
    await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'skip', history: 'skip' },
      { PGSSLMODE: 'disable' },
    ).exportAll();

    for (const call of calls) expect(call.options?.env?.['PGSSLMODE']).toBe('disable');
  });

  it('a pooler username with a dot survives parsing', () => {
    expect(parseConnectionUrl(URL_WITH_SECRET)).toEqual({
      host: 'aws-0-us-west-2.pooler.supabase.com',
      port: '5432',
      user: 'backup_reader.xykrphbgpwisqacpyeiv',
      password: 's3cretPassw0rd',
      database: 'postgres',
    });
  });

  it('a percent-encoded password is decoded', () => {
    expect(
      parseConnectionUrl(
        'postgresql://backup_reader.ref:p%40ss%2Fw%3Ard@host.example:6543/postgres',
      ),
    ).toEqual({
      host: 'host.example',
      port: '6543',
      user: 'backup_reader.ref',
      password: 'p@ss/w:rd',
      database: 'postgres',
    });
  });

  it('throws CommandFailedError with a redacted excerpt when a dump exits non-zero', async () => {
    const run: RunCommand = async () => ({
      stdout: new Uint8Array(),
      stderr: `pg_dump: error: connection to server failed: ${URL_WITH_SECRET}`,
      exitCode: 1,
    });
    const error = await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'include', history: 'include' },
      {},
    )
      .exportAll()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandFailedError);
    if (!(error instanceof CommandFailedError)) return;
    expect(error.command).toBe('pg_dumpall');
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('pg_dumpall_failed:1:');
    expect(error.message).toContain('backup_reader.xykrphbgpwisqacpyeiv:[redacted]@');
    expect(error.message).not.toContain('s3cretPassw0rd');
  });

  it('names the schemas it dumps', () => {
    expect(APP_SCHEMAS).toEqual(['app', 'public', 'drizzle']);
    expect(HISTORY_SCHEMA).toBe('supabase_migrations');
    expect(AUTH_SCHEMA).toBe('auth');
    expect(AUTH_TABLES).toEqual(['auth.users', 'auth.identities']);
  });

  it("appends the auth tables' data to the one data artifact, inside the replica-mode wrapper", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (_command, args) => {
      calls.push([...args]);
      const sql = args.includes('--table')
        ? 'COPY "auth"."users" ("id") FROM stdin;\nu1\n\\.\n'
        : args.includes('--data-only') && args.includes('app')
          ? 'COPY "app"."leads" ("id") FROM stdin;\nl1\n\\.\n'
          : '';
      return { stdout: new TextEncoder().encode(sql), stderr: '', exitCode: 0 };
    };
    const artifacts = await new PgDumpDatabaseExporter(
      URL_WITH_SECRET,
      run,
      { authData: 'include', history: 'skip' },
      {},
    ).exportAll();

    const data = text(artifacts.data);
    expect(data.startsWith('SET session_replication_role = replica;')).toBe(true);
    expect(data.trimEnd().endsWith('RESET ALL;')).toBe(true);
    const leads = data.indexOf('COPY "app"."leads"');
    const users = data.indexOf('COPY "auth"."users"');
    expect(leads).toBeGreaterThan(0);
    expect(users).toBeGreaterThan(leads);
    expect(data.match(/SET session_replication_role = replica;/g)).toHaveLength(1);
  });
});

describe('parseConnectionUrl', () => {
  it('splits a pooler URL, decoding the user and password', () => {
    expect(
      parseConnectionUrl('postgresql://backup_reader.ref:p%40ss@host.example:6543/postgres'),
    ).toEqual({
      host: 'host.example',
      port: '6543',
      user: 'backup_reader.ref',
      password: 'p@ss',
      database: 'postgres',
    });
  });
  it('rejects anything but a postgres URL', () => {
    expect(() => parseConnectionUrl('https://example.test')).toThrow(/postgres:\/\//);
  });
});

describe('output filters (copied from the Supabase CLI scripts)', () => {
  it('roles: reserved roles and comments dropped, superuser-only attributes stripped', () => {
    const sql = [
      '\\restrict abc',
      '--',
      '-- Roles',
      'CREATE ROLE "postgres";',
      'ALTER ROLE "postgres" WITH SUPERUSER;',
      'CREATE ROLE "app_runtime";',
      'ALTER ROLE "app_runtime" WITH NOSUPERUSER INHERIT NOREPLICATION LOGIN;',
      '-- ALTER ROLE "app_runtime" SET "statement_timeout" TO \'8s\';',
      'GRANT "pg_read_all_data" TO "supabase_admin";',
      'GRANT "pg_read_all_data" TO "backup_reader";',
      'GRANT "pg_read_all_data" TO "backup_reader";',
      '',
    ].join('\n');
    expect(filterRoles(sql)).toBe(
      [
        'CREATE ROLE "app_runtime";',
        'ALTER ROLE "app_runtime" WITH INHERIT LOGIN;',
        'ALTER ROLE "app_runtime" SET "statement_timeout" TO \'8s\';',
        'GRANT "pg_read_all_data" TO "backup_reader";',
        '',
        'RESET ALL;',
        '',
      ].join('\n'),
    );
  });

  it('schema: idempotent creates, platform statements and comments dropped', () => {
    const sql = [
      '\\restrict abc',
      'SET transaction_timeout = 0;',
      'CREATE SCHEMA "app";',
      'CREATE TABLE "app"."leads" (',
      'CREATE OR REPLACE FUNCTION "app"."x"() RETURNS void',
      'CREATE FUNCTION "app"."y"() RETURNS void',
      'CREATE EVENT TRIGGER "issue_pg_graphql_access" ON "ddl_command_end"',
      'GRANT USAGE ON SCHEMA "auth" TO "anon";',
      'GRANT USAGE ON SCHEMA "app" TO "app_runtime";',
      'COMMENT ON EXTENSION "pgcrypto" IS \'x\';',
    ].join('\n');
    expect(filterSchema(sql, INTERNAL_SCHEMAS).split('\n')).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "app";',
      'CREATE TABLE IF NOT EXISTS "app"."leads" (',
      'CREATE OR REPLACE FUNCTION "app"."x"() RETURNS void',
      'CREATE OR REPLACE FUNCTION "app"."y"() RETURNS void',
      'GRANT USAGE ON SCHEMA "app" TO "app_runtime";',
    ]);
  });

  it('data: replica mode around the dump, comments kept, meta-commands disabled', () => {
    expect(
      filterData('\\restrict abc\n-- Data for Name: leads\nCOPY "app"."leads" FROM stdin;\n'),
    ).toBe(
      [
        'SET session_replication_role = replica;',
        '',
        '-- \\restrict abc',
        '-- Data for Name: leads',
        'COPY "app"."leads" FROM stdin;',
        '',
        'RESET ALL;',
        '',
      ].join('\n'),
    );
  });
});
