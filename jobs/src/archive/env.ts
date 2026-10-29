/**
 * Environment readers shared by the backup, monitor, retention and restore
 * CLIs. Every credential reaches those CLIs as a GitHub Environment secret
 * (docs/RUNBOOKS/backup.md), so a missing or blank one must stop the run with
 * the variable's name and never its value. The `env` parameter keeps them
 * testable without mutating `process.env`.
 */

/** A set, non-blank value; throws `NAME is required` otherwise. */
export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

/** The trimmed value, or `undefined` when unset or blank. */
export function optionalEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** A positive whole number, or `undefined` when unset or blank; anything else throws. */
export function optionalPositiveInteger(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const value = optionalEnv(name, env);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return parsed;
}

/** True only for `1`, `true` or `yes` (any case); unset and anything else is false. */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = optionalEnv(name, env)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
