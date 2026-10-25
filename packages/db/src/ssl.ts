/**
 * TLS modes for every Postgres connection (runtime pool, migrations, seed).
 *
 * postgres.js treats the string `'require'` as "encrypt but never check the
 * server certificate". `verify-full` passes `rejectUnauthorized: true` (plus an
 * optional CA, e.g. Supabase's from Dashboard > Settings > Database > SSL) so
 * the server identity is verified too. `require` stays the default so a deploy
 * never breaks before the live host has been checked with `verify-full`.
 */
export type SslMode = 'require' | 'verify-full' | false;

export type PostgresSsl = 'require' | false | { rejectUnauthorized: true; ca?: string };

/** Parse a `*_SSL_MODE` variable: `require` (default), `verify-full` or `disable`. */
export function sslModeFromEnv(name: string, value: string | undefined): SslMode {
  const mode = value ?? 'require';
  if (mode === 'require') return 'require';
  if (mode === 'verify-full') return 'verify-full';
  if (mode === 'disable') return false;
  throw new Error(`${name} must be "require", "verify-full" or "disable"`);
}

/** The value handed to postgres.js for a mode; `ca` is PEM text, used only when verifying. */
export function postgresSsl(mode: SslMode | undefined, ca?: string): PostgresSsl {
  if (mode === 'verify-full') {
    const trimmed = ca?.trim();
    return trimmed ? { rejectUnauthorized: true, ca: trimmed } : { rejectUnauthorized: true };
  }
  return mode ?? 'require';
}
