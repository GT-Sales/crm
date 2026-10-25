/**
 * Privacy-preserving structured error logging for the backend
 * (PLATFORM_CONTEXT.md invariant 12 — "No PII in logs, errors, analytics, or
 * URLs"). A record carries only a request id, workspace id, route identifier,
 * a regex-safe error code and a flag from a fixed allowlist. There is
 * deliberately no message field, so a raw error message, SQL statement, token
 * or customer detail cannot reach the log even by mistake.
 */

/**
 * The only flags a log record may carry. `retryable` marks a failure the
 * caller can safely retry with the same idempotency key; everything else is
 * explicitly not retryable.
 */
export const LOG_SAFE_FLAGS = ['retryable', 'not_retryable'] as const;
export type LogSafeFlag = (typeof LOG_SAFE_FLAGS)[number];

/** The code used whenever a candidate is missing or unsafe. */
export const FALLBACK_ERROR_CODE = 'internal_error';

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_./:-]{1,128}$/;
const safeFlags = new Set<string>(LOG_SAFE_FLAGS);

/**
 * Reduce any candidate to a safe, regex-bounded error code. Raw error
 * messages, PII-like text, SQL, SQLSTATE values that start with a digit and
 * any other out-of-shape value collapse to {@link FALLBACK_ERROR_CODE}.
 */
export function sanitizeErrorCode(value: unknown): string {
  if (typeof value === 'string' && ERROR_CODE_PATTERN.test(value)) return value;
  return FALLBACK_ERROR_CODE;
}

function isLogSafeFlag(value: unknown): value is LogSafeFlag {
  return typeof value === 'string' && safeFlags.has(value);
}

/** Return a safe flag from the fixed allowlist, or the non-retryable default. */
export function sanitizeLogFlag(value: unknown): LogSafeFlag {
  return isLogSafeFlag(value) ? value : 'not_retryable';
}

/**
 * Reduce an identifier (request id, workspace id, route) to a bounded token.
 * A value with spaces, punctuation outside the identifier shape or unbounded
 * length is dropped rather than logged.
 */
export function sanitizeLogIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

export interface RequestErrorLogRecord {
  readonly event: 'request_error';
  readonly requestId: string;
  readonly workspaceId: string;
  readonly route: string;
  readonly code: string;
  readonly flag: LogSafeFlag;
}

export interface RequestErrorLogInput {
  readonly requestId: unknown;
  readonly workspaceId?: unknown;
  readonly route: unknown;
  readonly code: unknown;
  readonly flag: unknown;
}

/** Emit one scrubbed error record. Never accepts or serializes free text. */
export function logRequestError(input: RequestErrorLogInput): void {
  const record: RequestErrorLogRecord = {
    event: 'request_error',
    requestId: sanitizeLogIdentifier(input.requestId) ?? 'unknown',
    workspaceId: sanitizeLogIdentifier(input.workspaceId) ?? 'unknown',
    route: sanitizeLogIdentifier(input.route) ?? 'unknown',
    code: sanitizeErrorCode(input.code),
    flag: sanitizeLogFlag(input.flag),
  };
  console.error(JSON.stringify(record));
}

/**
 * Driver/server codes that mean the connection itself failed or the server is
 * unavailable. SQLSTATE class `08` ("connection exception") is matched by
 * prefix; drizzle wraps the driver error, so the SQLSTATE usually lives on
 * `error.cause`.
 */
const CONNECTION_ERROR_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECT_TIMEOUT',
  '57P01', // admin_shutdown
  '53300', // too_many_connections
]);

const MAX_CAUSE_DEPTH = 8;

function isConnectionErrorCode(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('08')) return true;
  return CONNECTION_ERROR_CODES.has(value);
}

/**
 * Classify an unknown thrown value as a PostgreSQL connection/availability
 * failure or not, inspecting `code` and nested `cause`. Only this class of
 * failure is retryable; a logic bug, validation failure or snapshot parse
 * failure is not.
 */
export function isConnectionLevelError(error: unknown): boolean {
  return hasConnectionCode(error, 0, new Set<object>());
}

function hasConnectionCode(error: unknown, depth: number, seen: Set<object>): boolean {
  if (depth > MAX_CAUSE_DEPTH) return false;
  if (typeof error !== 'object' || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if ('code' in error && isConnectionErrorCode(error.code)) return true;
  if ('cause' in error) return hasConnectionCode(error.cause, depth + 1, seen);
  return false;
}
