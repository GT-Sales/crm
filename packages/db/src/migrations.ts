import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { postgresSsl, type SslMode } from './ssl.js';

export interface MigrationOptions {
  connectionString: string;
  ssl?: SslMode;
}

export const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../drizzle',
);

/** Runs checked-in migrations with the separate privileged migration URL. */
export async function applyMigrations(options: MigrationOptions): Promise<void> {
  const client = postgres(options.connectionString, {
    max: 1,
    prepare: false,
    ssl: postgresSsl(options.ssl, process.env.MIGRATION_DATABASE_SSL_CA),
  });

  try {
    // Integration projects share one disposable database and Vitest may start
    // them concurrently. Serialize migration setup on that database so two
    // suites cannot update Drizzle's journal or PostgreSQL catalogs at once.
    await client`select pg_advisory_lock(745284913)`;
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client`select pg_advisory_unlock(745284913)`.catch(() => undefined);
    await client.end();
  }
}
