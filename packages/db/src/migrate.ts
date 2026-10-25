import { applyMigrations } from './migrations.js';
import { sslModeFromEnv } from './ssl.js';

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');

await applyMigrations({
  connectionString,
  ssl: sslModeFromEnv('MIGRATION_DATABASE_SSL_MODE', process.env.MIGRATION_DATABASE_SSL_MODE),
});
