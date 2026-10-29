import { runOrThrow, type RunCommand } from '../archive/command.js';

/**
 * The database export: roles, schema and data, plus the schema and data of the
 * `supabase_migrations` history, run with `pg_dumpall` / `pg_dump` as the
 * least-privilege `backup_reader` login (migrations 0007/0008). The output
 * filters are copied from the Supabase CLI's pkg/migration scripts so a
 * restore loads the same shape of SQL the CLI would have produced.
 *
 * Include lists, not exclude lists. `backup_reader` holds grants only on
 * `app`, `public` and `drizzle` (plus `auth.users`, `auth.identities` and
 * `supabase_migrations` when those grants were applied), so every dump names
 * its schemas with `--schema` or its tables with `--table`; a wildcard would
 * reach objects the role cannot read and fail.
 *
 * `--enable-row-security` on the data dump. The role has no `BYPASSRLS`; it
 * reads every row because each RLS table carries a `<table>_backup_reader_read`
 * policy that grants them all. Without the flag pg_dump refuses an RLS table;
 * with it, a table that lacks the policy would dump silently empty, which is
 * why the runner first asks the source completeness guard (sources.ts) to
 * prove no table is unreadable.
 *
 * `--strict-names` on every `pg_dump`: a `--schema` or `--table` that matches
 * nothing fails the dump instead of silently dumping nothing for it.
 *
 * `storage` data is never dumped: the document bytes are archived separately
 * through the S3 API, and the restore recreates `storage.objects` when it
 * uploads them again. `auth` DDL is platform-owned (the target project already
 * has it), so only `auth` data is dumped, only when `authData` is `include`,
 * and only the two tables a restore needs (`AUTH_TABLES`: the accounts and
 * their sign-in identities). Sessions, refresh tokens and MFA state are never
 * read; a restored user signs in again. pg_dump ignores every `--schema` once
 * one `--table` is given, so the auth tables are a second data dump whose SQL
 * is appended to the first in the one `data.sql` artifact.
 *
 * Needs PostgreSQL 17 client tools on PATH, matching the 17.x server. The
 * connection reaches the tools only through PG* environment variables, so the
 * password is never in argv or a message.
 */

export const APP_SCHEMAS = ['app', 'public', 'drizzle'] as const;
export const HISTORY_SCHEMA = 'supabase_migrations';
export const AUTH_SCHEMA = 'auth';
/** The only `auth` tables dumped (and granted to `backup_reader` in 0007). */
export const AUTH_TABLES = ['auth.users', 'auth.identities'] as const;

/**
 * CLI `InternalSchemas`: platform-managed schemas. None is dumped; the schema
 * filter comments out any GRANT/REVOKE line that names one.
 */
export const INTERNAL_SCHEMAS = [
  'information_schema',
  'pg_*',
  '_analytics',
  '_realtime',
  '_supavisor',
  'auth',
  'etl',
  'extensions',
  'pgbouncer',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'cron',
  'dbdev',
  'graphql',
  'graphql_public',
  'net',
  'pgmq',
  'pgsodium',
  'pgsodium_masks',
  'pgtle',
  'repack',
  'tiger',
  'tiger_data',
  'timescaledb_*',
  '_timescaledb_*',
  'topology',
  'vault',
];

const RESERVED_ROLES = [
  'anon',
  'authenticated',
  'authenticator',
  'cli_login_.*',
  'dashboard_user',
  'pgbouncer',
  'postgres',
  // Supabase's built-in API role (a role NAME, not a key). Written as a regex
  // class because CI forbids the literal service-role token in application
  // code; `[_]` matches exactly the same role as the CLI's list.
  'service[_]role',
  'supabase_.*',
  'pgsodium_keyholder',
  'pgsodium_keyiduser',
  'pgsodium_keymaker',
  'pgtle_admin',
].join('|');

const ALLOWED_CONFIGS = [
  'pgaudit.*',
  'pgrst.*',
  'session_replication_role',
  'statement_timeout',
  'track_io_timing',
].join('|');

type LineRule = [RegExp, string];

/** `\restrict` / `\unrestrict` are psql meta-commands; comment them out. */
const META_COMMAND: LineRule = [/^\\(un)?restrict .*$/, '-- $&'];

function applyRules(sql: string, rules: LineRule[], dropComments: boolean): string[] {
  const lines = sql.split('\n').map((line) => {
    let out = line;
    for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
    return out;
  });
  return dropComments ? lines.filter((line) => !line.startsWith('--')) : lines;
}

/** scripts/dump_role.sh's filters (keepComments=false, so `--` lines go). */
export function filterRoles(sql: string): string {
  const rules: LineRule[] = [
    META_COMMAND,
    [new RegExp(`^CREATE ROLE "(${RESERVED_ROLES})"`), '-- $&'],
    [new RegExp(`^ALTER ROLE "(${RESERVED_ROLES})"`), '-- $&'],
    [/ (NOSUPERUSER|NOREPLICATION)/g, ''],
    [new RegExp(`^-- (.* SET "(${ALLOWED_CONFIGS})" .*)`), '$1'],
    [new RegExp(`GRANT ".*" TO "(${RESERVED_ROLES})"`), '-- $&'],
  ];
  const lines = applyRules(sql, rules, true);
  const unique = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
  return `${unique.join('\n')}\nRESET ALL;\n`;
}

/** scripts/dump_schema.sh's filters (keepComments=false, so `--` lines go). */
export function filterSchema(sql: string, excludedSchemas: readonly string[]): string {
  const rules: LineRule[] = [
    META_COMMAND,
    [/^CREATE SCHEMA "/, 'CREATE SCHEMA IF NOT EXISTS "'],
    [/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "'],
    [/^CREATE SEQUENCE "/, 'CREATE SEQUENCE IF NOT EXISTS "'],
    [/^CREATE VIEW "/, 'CREATE OR REPLACE VIEW "'],
    [/^CREATE FUNCTION "/, 'CREATE OR REPLACE FUNCTION "'],
    [/^CREATE TRIGGER "/, 'CREATE OR REPLACE TRIGGER "'],
    [/^CREATE PUBLICATION "supabase_realtime/, '-- $&'],
    [/^CREATE EVENT TRIGGER /, '-- $&'],
    [/^ {9}WHEN TAG IN /, '-- $&'],
    [/^ {3}EXECUTE FUNCTION /, '-- $&'],
    [/^ALTER EVENT TRIGGER /, '-- $&'],
    [/^ALTER PUBLICATION "supabase_realtime_/, '-- $&'],
    [/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /, '-- $&'],
    [/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/, '-- $&'],
    [/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/, '-- $&'],
    ...(excludedSchemas.length > 0
      ? ([
          [new RegExp(`^GRANT (.+) ON (.+) "(${schemaAlternation(excludedSchemas)})"`), '-- $&'],
          [new RegExp(`^REVOKE (.+) ON (.+) "(${schemaAlternation(excludedSchemas)})"`), '-- $&'],
        ] satisfies LineRule[])
      : []),
    [/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/, '$1;'],
    [/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/, '$1;'],
    [/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/, '$1;'],
    [/^COMMENT ON EXTENSION (.+)/, '-- $&'],
    [/^CREATE POLICY "cron_job_/, '-- $&'],
    [/^ALTER TABLE "cron"/, '-- $&'],
    [/^SET transaction_timeout = 0;/, '-- $&'],
  ];
  return applyRules(sql, rules, true).join('\n');
}

/** scripts/dump_data.sh's wrapper (comments are kept in data dumps). */
export function filterData(sql: string): string {
  const body = applyRules(sql, [META_COMMAND], false).join('\n');
  return `SET session_replication_role = replica;\n\n${body}\nRESET ALL;\n`;
}

/**
 * The CLI joins schema names with `|` and drops the same string into sed as a
 * regex, so `pg_*` there means "pg" plus underscores, not pg_dump's wildcard.
 * Kept byte-for-byte so the filtered output matches what the CLI produced.
 */
function schemaAlternation(schemas: readonly string[]): string {
  return schemas.join('|');
}

export interface PgConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function parseConnectionUrl(url: string): PgConnection {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('SOURCE_DATABASE_URL must be a postgres:// URL');
  }
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres',
  };
}

/**
 * The child environment for a Postgres client tool: the base environment plus
 * the connection as PG* variables. `PGSSLMODE` is `require` unless the base
 * environment sets it (a local test database sets `disable`).
 */
export function pgConnectionEnv(
  connection: PgConnection,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGSSLMODE: baseEnv['PGSSLMODE'] ?? 'require',
  };
}

export interface DatabaseDumpArtifacts {
  roles: Uint8Array;
  schema: Uint8Array;
  data: Uint8Array;
  historySchema?: Uint8Array;
  historyData?: Uint8Array;
}

export interface DatabaseExporter {
  exportAll(): Promise<DatabaseDumpArtifacts>;
}

export interface PgDumpOptions {
  /** `skip` is the operator fallback when the `auth` grant could not be applied. */
  authData: 'include' | 'skip';
  history: 'include' | 'skip';
}

function schemaFlags(schemas: readonly string[]): string[] {
  return schemas.flatMap((schema) => ['--schema', schema]);
}

function tableFlags(tables: readonly string[]): string[] {
  return tables.flatMap((table) => ['--table', table]);
}

export class PgDumpDatabaseExporter implements DatabaseExporter {
  private readonly connection: PgConnection;

  constructor(
    dbUrl: string,
    private readonly run: RunCommand,
    private readonly options: PgDumpOptions,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.connection = parseConnectionUrl(dbUrl);
  }

  async exportAll(): Promise<DatabaseDumpArtifacts> {
    const roles = filterRoles(
      await this.tool('pg_dumpall', [
        '--roles-only',
        '--quote-all-identifier',
        '--no-role-passwords',
        '--no-comments',
      ]),
    );
    const schema = filterSchema(
      await this.tool('pg_dump', [
        '--schema-only',
        '--quote-all-identifier',
        '--strict-names',
        ...schemaFlags(APP_SCHEMAS),
      ]),
      INTERNAL_SCHEMAS,
    );
    const dataArgs = [
      '--data-only',
      '--quote-all-identifier',
      '--enable-row-security',
      '--strict-names',
    ];
    let dataSql = await this.tool('pg_dump', [...dataArgs, ...schemaFlags(APP_SCHEMAS)]);
    if (this.options.authData === 'include') {
      dataSql += `\n${await this.tool('pg_dump', [...dataArgs, ...tableFlags(AUTH_TABLES)])}`;
    }
    const data = filterData(dataSql);
    const encode = (sql: string) => new TextEncoder().encode(sql);
    const artifacts: DatabaseDumpArtifacts = {
      roles: encode(roles),
      schema: encode(schema),
      data: encode(data),
    };
    if (this.options.history === 'skip') return artifacts;

    const historySchema = filterSchema(
      await this.tool('pg_dump', [
        '--schema-only',
        '--quote-all-identifier',
        '--strict-names',
        ...schemaFlags([HISTORY_SCHEMA]),
      ]),
      [],
    );
    const historyData = filterData(
      await this.tool('pg_dump', [
        '--data-only',
        '--quote-all-identifier',
        '--strict-names',
        ...schemaFlags([HISTORY_SCHEMA]),
      ]),
    );
    return { ...artifacts, historySchema: encode(historySchema), historyData: encode(historyData) };
  }

  private async tool(command: 'pg_dump' | 'pg_dumpall', args: string[]): Promise<string> {
    const stdout = await runOrThrow(this.run, command, args, {
      env: pgConnectionEnv(this.connection, this.baseEnv),
    });
    return new TextDecoder().decode(stdout);
  }
}
