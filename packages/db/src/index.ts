import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { schema } from './schema.js';
import { postgresSsl, sslModeFromEnv, type SslMode } from './ssl.js';

export * from './schema.js';
export { postgresSsl, sslModeFromEnv, type SslMode } from './ssl.js';

export interface TenantContext {
  workspaceId: string;
  actorId: string;
}

export interface DatabaseClientOptions {
  connectionString: string;
  ssl?: SslMode;
  maxConnections?: number;
}

export type Database = PostgresJsDatabase<typeof schema>;
export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface WebsiteCredentialResolution {
  /** The credential's own row id — used as `actorId` for its tenant writes (no human actor exists). */
  credentialId: string;
  workspaceId: string;
  scopes: string[];
  revoked: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitInput {
  bucketKey: string;
  windowSeconds: number;
  maxCount: number;
}

/** A staff member's membership in one site, as `app.staff_access_snapshot` returns it (unvalidated). */
export interface StaffAccessRow {
  membershipId: string;
  status: string;
  roleNames: string[];
  permissionRows: Array<{ name: string; effect: string }>;
}

export interface DatabaseClient {
  db: Database;
  withActorTx<T>(actorId: string, fn: (tx: TenantTransaction) => Promise<T> | T): Promise<T>;
  withTenantTx<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T> | T): Promise<T>;
  resolveWebsiteCredential(secretHash: string): Promise<WebsiteCredentialResolution | undefined>;
  rateLimitHit(input: RateLimitInput): Promise<RateLimitResult>;
  /** The actor's staff membership in the site, any status; undefined when there is none. */
  staffAccessSnapshot(ctx: TenantContext): Promise<StaffAccessRow | undefined>;
  close(): Promise<void>;
}

interface CredentialRow {
  [key: string]: unknown;
  id: string;
  workspaceId: string;
  scopes: string[];
  revoked: boolean;
}

interface RateLimitRow {
  [key: string]: unknown;
  allowed: boolean;
  retryAfterSeconds: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidLiteral(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error('tenant context ids must be UUIDs');
  return `'${value}'`;
}

/**
 * The statement that opens every transaction's tenant context.
 * set_config(..., true) is PostgreSQL's equivalent of SET LOCAL: the values
 * vanish at transaction end.
 *
 * The ids are literals, not bind parameters. With prepared statements off
 * (see `createDatabaseClient`), postgres-js sends a statement that has bind
 * parameters in two round trips, describing the parameters first, and the
 * pooler is a long way off; a statement without them takes one. Only a UUID
 * gets through, and a UUID has no quote to end the literal with.
 */
export function tenantContextStatement(ctx: { workspaceId?: string; actorId: string }): string {
  const settings: string[] = [];
  if (ctx.workspaceId !== undefined) {
    settings.push(`set_config('app.workspace_id', ${uuidLiteral(ctx.workspaceId)}, true)`);
  }
  settings.push(`set_config('app.actor_id', ${uuidLiteral(ctx.actorId)}, true)`);
  return `select ${settings.join(', ')}`;
}

/**
 * The open transaction's site id, read back from its tenant context, for a
 * statement whose only bind parameter would be that id: without it the
 * statement skips the describe round trip (see `tenantContextStatement`). RLS
 * reads the same setting, so the statement sees exactly the rows it would
 * have seen.
 */
export const contextWorkspaceId = sql.raw(
  `nullif(current_setting('app.workspace_id', true), '')::uuid`,
);

/** What a rate-limit key may hold to travel as a literal: no quote, no backslash, nothing else. */
const LITERAL_BUCKET_KEY = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * One hit on a rate-limit window. Every staff request starts with this
 * statement, so a key of plain characters (a prefix, an IP address, ids and
 * hashes) and integer limits travel as literals, one round trip instead of
 * two (see `tenantContextStatement`); any other key is bound as before.
 */
export function rateLimitStatement({ bucketKey, windowSeconds, maxCount }: RateLimitInput): SQL {
  const columns = 'allowed, retry_after_seconds as "retryAfterSeconds"';
  if (
    LITERAL_BUCKET_KEY.test(bucketKey) &&
    Number.isSafeInteger(windowSeconds) &&
    Number.isSafeInteger(maxCount)
  ) {
    return sql.raw(
      `select ${columns} from app.rate_limit_hit('${bucketKey}', ${windowSeconds}, ${maxCount})`,
    );
  }
  return sql`select ${sql.raw(columns)} from app.rate_limit_hit(${bucketKey}, ${windowSeconds}, ${maxCount})`;
}

function createClient(options: DatabaseClientOptions) {
  return postgres(options.connectionString, {
    max: options.maxConnections ?? 1,
    prepare: false,
    ssl: postgresSsl(options.ssl, process.env.DATABASE_SSL_CA),
  });
}

/**
 * Creates the runtime client. The backend is a long-lived Railway process
 * (HTTP server plus the in-process scheduler) that shares one small
 * application-side pool, sized by `DATABASE_POOL_MAX` (see `runtimePoolMax`),
 * through the Supabase transaction-mode pooler. Supavisor transaction mode does
 * not support named prepared statements, so `prepare` is always disabled.
 */
export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const sqlClient = createClient(options);
  const db = drizzle(sqlClient, { schema });

  return {
    db,
    withActorTx: (actorId, fn) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(tenantContextStatement({ actorId })));
        return fn(tx);
      }),
    withTenantTx: (ctx, fn) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(tenantContextStatement(ctx)));
        return fn(tx);
      }),
    // Pre-tenant website bootstrap: resolve a credential
    // to its own workspace/scopes/revocation through the SECURITY DEFINER
    // function without any caller-supplied workspace and without tenant context.
    resolveWebsiteCredential: async (secretHash) => {
      const rows = await db.execute<CredentialRow>(sql`
        select
          id,
          workspace_id as "workspaceId",
          scopes,
          revoked
        from app.resolve_website_credential(${secretHash})
      `);
      const row = rows[0];
      return row
        ? {
            credentialId: row.id,
            workspaceId: row.workspaceId,
            scopes: row.scopes,
            revoked: row.revoked,
          }
        : undefined;
    },
    rateLimitHit: async (input) => {
      const rows = await db.execute<RateLimitRow>(rateLimitStatement(input));
      const row = rows[0];
      if (!row) throw new Error('rate_limit_hit returned no row');
      return { allowed: row.allowed, retryAfterSeconds: row.retryAfterSeconds };
    },
    // Every staff request's authorization read: one autocommit call with the
    // ids as literals, so one round trip instead of a transaction's four.
    staffAccessSnapshot: async (ctx) => {
      const rows = await db.execute<StaffAccessRow & { [key: string]: unknown }>(
        sql.raw(`
          select
            membership_id as "membershipId",
            status,
            role_names as "roleNames",
            permission_rows as "permissionRows"
          from app.staff_access_snapshot(${uuidLiteral(ctx.workspaceId)}, ${uuidLiteral(ctx.actorId)})
        `),
      );
      return rows[0];
    },
    close: () => sqlClient.end(),
  };
}

let defaultClient: DatabaseClient | undefined;

function runtimeSsl(): SslMode {
  return sslModeFromEnv('DATABASE_SSL_MODE', process.env.DATABASE_SSL_MODE);
}

const DEFAULT_POOL_MAX = 8;

/**
 * Shared-pool size for the long-lived backend. `DATABASE_POOL_MAX` must be an
 * integer from 1 to 50; anything else falls back to 8, which stays well below
 * the Supabase pooler's per-project client limit for one replica.
 */
export function runtimePoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DATABASE_POOL_MAX?.trim();
  if (!raw) return DEFAULT_POOL_MAX;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : DEFAULT_POOL_MAX;
}

function getDefaultClient(): DatabaseClient {
  if (defaultClient) return defaultClient;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  defaultClient = createDatabaseClient({
    connectionString,
    ssl: runtimeSsl(),
    maxConnections: runtimePoolMax(),
  });
  return defaultClient;
}

/**
 * Closes the shared runtime pool and clears the cached client. Intended for
 * graceful process shutdown (SIGTERM/SIGINT) on a long-lived host such as
 * Railway; a serverless instance simply lets the pool idle out. Safe to call
 * when no client was ever created. A later call recreates a fresh client.
 */
export async function closeDatabase(): Promise<void> {
  const client = defaultClient;
  defaultClient = undefined;
  if (client) await client.close();
}

/**
 * Runs exactly one tenant unit of work in a transaction on the pooled runtime
 * connection. Commit/rollback and tenant-context cleanup are automatic.
 */
export function withTenantTx<T>(
  ctx: TenantContext,
  fn: (tx: TenantTransaction) => Promise<T> | T,
): Promise<T> {
  return getDefaultClient().withTenantTx(ctx, fn);
}

/** Runs the narrow pre-tenant staff bootstrap functions as a verified actor. */
export function withActorTx<T>(
  actorId: string,
  fn: (tx: TenantTransaction) => Promise<T> | T,
): Promise<T> {
  return getDefaultClient().withActorTx(actorId, fn);
}

/** Website bootstrap: resolve a credential secret hash to its workspace/scopes/revocation. */
export function resolveWebsiteCredential(
  secretHash: string,
): Promise<WebsiteCredentialResolution | undefined> {
  return getDefaultClient().resolveWebsiteCredential(secretHash);
}

/** Records one hit against a bounded per-key rate-limit window and reports whether it is allowed. */
export function rateLimitHit(input: RateLimitInput): Promise<RateLimitResult> {
  return getDefaultClient().rateLimitHit(input);
}

/** Staff authorization read: the actor's membership in the site, in one call. */
export function staffAccessSnapshot(ctx: TenantContext): Promise<StaffAccessRow | undefined> {
  return getDefaultClient().staffAccessSnapshot(ctx);
}
