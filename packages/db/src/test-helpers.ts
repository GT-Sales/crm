import type postgres from 'postgres';

/** Synthetic CI-only password shared by every disposable-database integration test. */
export const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// Adjacent to the migrations lock key (745284913) in migrations.ts.
const RUNTIME_PASSWORD_ADVISORY_LOCK_KEY = 745284914;

/**
 * Sets the app_runtime role's password to the shared CI-only value inside an
 * advisory-locked transaction. Vitest runs integration test files in
 * separate parallel processes against the same disposable database; without
 * this lock, two files' concurrent `ALTER ROLE` statements race and cause
 * intermittent authentication failures for a sibling file's runtime client.
 */
export async function setTestRuntimePassword(admin: postgres.Sql): Promise<void> {
  // This resets a role password to a value committed to the repo: fence it to
  // a disposable database even when a caller's URL guard is missing.
  const [row] = await admin<{ name: string }[]>`select current_database() as name`;
  assertDisposableDatabaseName(row?.name ?? '');
  await admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${RUNTIME_PASSWORD_ADVISORY_LOCK_KEY})`;
    await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
  });
}

/** Explicit, deliberately awkward opt-out for a remote throwaway database. */
const REMOTE_OVERRIDE = 'yes-i-understand';
const DISPOSABLE_NAME = /(_test|_e2e)$/i;

/** Throws unless the database name marks it as disposable (or the override is set). */
export function assertDisposableDatabaseName(name: string): void {
  if (DISPOSABLE_NAME.test(name)) return;
  if (process.env['E2E_ALLOW_REMOTE_DATABASE'] === REMOTE_OVERRIDE) return;
  throw new Error(
    `Refusing destructive test setup on database "${name}": its name must end in _test or _e2e (set E2E_ALLOW_REMOTE_DATABASE=${REMOTE_OVERRIDE} to override).`,
  );
}

/**
 * Throws unless a connection string points at localhost or a database whose
 * name ends in _test/_e2e. Used before any truncate or role change, so a URL
 * accidentally pointed at Supabase production fails before connecting.
 */
export function assertDisposableDatabaseUrl(connectionString: string): void {
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (local) return;
  assertDisposableDatabaseName(url.pathname.replace(/^\//, ''));
}
