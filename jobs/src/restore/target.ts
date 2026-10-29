import { documentObjectKey, type S3SigningConfig } from '@gt-sales/adapters';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3ArchiveWriter } from '../archive/archive-store.js';
import { CommandFailedError, type RunCommand } from '../archive/command.js';
import {
  parseConnectionUrl,
  pgConnectionEnv,
  type DatabaseDumpArtifacts,
  type PgConnection,
} from '../backup/pg-dump.js';
import type { RestoreTarget } from './run.js';

/**
 * The production restore target: an isolated Supabase project reached with
 * `psql` (as its `postgres` login, through the session pooler) and its
 * Storage S3 endpoint. The connection reaches `psql` only through PG*
 * environment variables, never argv, so the password is not visible to other
 * processes and never in a message; every call skips `~/.psqlrc` and stops at
 * the first error. The dump is written to a private temporary directory that
 * is removed afterwards whatever happens, because it holds every lead's
 * contact details.
 */

export type WithTempDir = <T>(fn: (dir: string) => Promise<T>) => Promise<T>;

/** A fresh `0700` directory under the OS temp dir, removed when `fn` settles. */
export const nodeWithTempDir: WithTempDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'gt-sales-restore-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface PsqlAndS3RestoreTargetOptions {
  databaseUrl: string;
  /** Leave out `roles.sql` (the target already holds the roles). */
  skipRoles: boolean;
  /** The target project's Storage bucket; required only when the run holds documents. */
  storage?: S3SigningConfig;
  run: RunCommand;
  withTempDir?: WithTempDir;
  fetchImpl?: typeof fetch;
  /** The environment the PG* variables are added to; default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

const PSQL_BASE = ['--no-psqlrc', '--variable', 'ON_ERROR_STOP=1'] as const;
const PSQL_SCRIPT = ['--single-transaction', '--variable', 'ON_ERROR_STOP=1', '--no-psqlrc'];

export const ROLE_BYPASSES_RLS_QUERY =
  'select (rolsuper or rolbypassrls) from pg_roles where rolname = current_user';
export const TARGET_SCHEMAS_QUERY =
  "select count(*) from pg_namespace where nspname in ('app','drizzle')";

/** A document is one PUT; bounded well inside a restore session. */
const OBJECT_PUT_TIMEOUT_MS = 10 * 60_000;

const QUALIFIED_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const OBJECT_ARTIFACT = /^objects\/([^/]+)\/(.+)$/;
/** `psql: error: …` (connection) or a server `ERROR:`/`FATAL:`/`PANIC:` line. */
const PSQL_ERROR_LINE = /^\s*psql: error:|\b(?:ERROR|FATAL|PANIC):/;
/** Never logged, even when one also mentions an error. */
const PSQL_DETAIL_LINE = /^\s*(?:psql:\S*:\d+:\s*)?(?:DETAIL|HINT|CONTEXT|LINE \d+):/;
const COUNT_LINE = /^([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\t(-?\d+)$/;

/**
 * The row count of every named table in one round trip: `query_to_xml` runs
 * a `count(*)` per table inside the one statement. A table the target lacks
 * is left-joined away from `pg_tables` and counts as -1, so it mismatches
 * visibly instead of failing the whole query. Each name is checked against
 * `schema.table` of lower-case identifiers before it is quoted into the SQL.
 */
export function rowCountsQuery(tables: readonly string[]): string {
  const rows = tables.map((name) => {
    if (!QUALIFIED_TABLE.test(name)) throw new Error(`restore_row_count_table_invalid:${name}`);
    const [schema = '', table = ''] = name.split('.');
    return `('${schema}', '${table}', '${name}')`;
  });
  return `
  select r.name,
    case when t.tablename is null then -1
    else (xpath('/row/cnt/text()', query_to_xml(format('select count(*) as cnt from %I.%I', t.schemaname, t.tablename), false, true, '')))[1]::text::bigint
    end
  from (values ${rows.join(', ')}) as r(schema_name, table_name, name)
  left join pg_tables t on t.schemaname = r.schema_name and t.tablename = r.table_name
  order by r.name
`;
}

/**
 * The part of psql's stderr a restore may log: its error lines only. A load
 * error's `DETAIL:` (`Key (email)=(…)`), `CONTEXT:` (`COPY …, line N: "<row>"`),
 * `HINT:` and `LINE n:` lines (and the caret under a quoted line) carry
 * customer values, so every line that is not an error line is dropped before
 * `CommandFailedError` applies the usual credential redaction.
 */
export function psqlErrorLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => PSQL_ERROR_LINE.test(line) && !PSQL_DETAIL_LINE.test(line))
    .join('\n');
}

export class PsqlAndS3RestoreTarget implements RestoreTarget {
  private readonly connection: PgConnection;
  private readonly skipRoles: boolean;
  private readonly storage: S3SigningConfig | undefined;
  private readonly run: RunCommand;
  private readonly withTempDir: WithTempDir;
  private readonly fetchImpl: typeof fetch;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: PsqlAndS3RestoreTargetOptions) {
    try {
      this.connection = parseConnectionUrl(options.databaseUrl);
    } catch {
      throw new Error('TARGET_DATABASE_URL must be a postgres:// URL');
    }
    this.skipRoles = options.skipRoles;
    this.storage = options.storage;
    this.run = options.run;
    this.withTempDir = options.withTempDir ?? nodeWithTempDir;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async preflight(): Promise<void> {
    // The data load must see and write every row: a role subject to RLS
    // would restore a silently partial database.
    if ((await this.queryValue(ROLE_BYPASSES_RLS_QUERY)) !== 't') {
      throw new Error('restore_target_role_cannot_bypass_rls');
    }
    // Never load over an existing CRM database.
    if ((await this.queryValue(TARGET_SCHEMAS_QUERY)) !== '0') {
      throw new Error('restore_target_not_empty');
    }
  }

  async applyDatabase(artifacts: DatabaseDumpArtifacts): Promise<void> {
    const { historySchema, historyData } = artifacts;
    if ((historySchema === undefined) !== (historyData === undefined)) {
      throw new Error('restore_history_artifacts_incomplete');
    }
    await this.withTempDir(async (dir) => {
      const file = async (name: string, bytes: Uint8Array): Promise<string> => {
        const path = join(dir, name);
        await writeFile(path, bytes, { mode: 0o600 });
        return path;
      };
      const roles = this.skipRoles ? [] : ['--file', await file('roles.sql', artifacts.roles)];
      await this.psql([
        ...PSQL_SCRIPT,
        ...roles,
        '--file',
        await file('schema.sql', artifacts.schema),
        '--command',
        'SET session_replication_role = replica',
        '--file',
        await file('data.sql', artifacts.data),
      ]);
      if (historySchema && historyData) {
        await this.psql([
          ...PSQL_SCRIPT,
          '--file',
          await file('history_schema.sql', historySchema),
          '--file',
          await file('history_data.sql', historyData),
        ]);
      }
    });
  }

  async applyObjects(objects: ReadonlyMap<string, Uint8Array>): Promise<void> {
    if (objects.size === 0) return;
    if (!this.storage) throw new Error('restore_storage_not_configured');
    const puts = [...objects].map(([name, bytes]) => {
      const match = OBJECT_ARTIFACT.exec(name);
      const workspaceId = match?.[1];
      const key = match?.[2];
      if (!workspaceId || !key) throw new Error('restore_object_name_invalid');
      return { key: documentObjectKey(workspaceId, key), bytes };
    });
    const writer = new S3ArchiveWriter(this.storage, this.fetchImpl, OBJECT_PUT_TIMEOUT_MS);
    for (const { key, bytes } of puts) await writer.putObject(key, bytes);
  }

  async countRows(tables: readonly string[]): Promise<Record<string, number>> {
    if (tables.length === 0) return {};
    const sql = rowCountsQuery(tables);
    const text = await this.psql([
      ...PSQL_BASE,
      '--tuples-only',
      '--no-align',
      '--field-separator',
      '\t',
      '--command',
      sql,
    ]);
    const counts: Record<string, number> = {};
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const match = COUNT_LINE.exec(line);
      const name = match?.[1];
      const count = match?.[2];
      if (!name || !count) throw new Error('restore_row_count_output_malformed');
      counts[name] = Number(count);
    }
    return counts;
  }

  private async queryValue(sql: string): Promise<string> {
    const text = await this.psql([...PSQL_BASE, '--tuples-only', '--no-align', '--command', sql]);
    return text.trim();
  }

  private async psql(args: readonly string[]): Promise<string> {
    const result = await this.run('psql', args, {
      env: pgConnectionEnv(this.connection, this.baseEnv),
    });
    if (result.exitCode !== 0) {
      throw new CommandFailedError('psql', result.exitCode, psqlErrorLines(result.stderr));
    }
    return new TextDecoder().decode(result.stdout);
  }
}
