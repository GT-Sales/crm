/**
 * @gt-sales/observability — browser-safe structured logging and error
 * reporting primitives (REQ 40, IMPLEMENTATION_PLAN §10). Pure functions only
 * (no network, no Node-only APIs), so backend, admin, jobs and every
 * storefront can share one scrubber and one log/event shape instead of each
 * inventing its own PII allowlist (PLATFORM_CONTEXT §4a).
 *
 * `@gt-sales/adapters` builds the server-only transports (an HTTP
 * Sentry-class client, owner alert email/webhook senders) on top of the pure
 * functions here; this package never sends anything itself.
 */

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;
const REDACTED = '[redacted]';
const TRUNCATED_SUFFIX = '…[truncated]';

/**
 * Field-name fragments that mark a value as PII regardless of its shape.
 * Matched against a normalized (lowercased, non-alphanumeric-stripped) key,
 * so `full_name`, `fullName` and `FULLNAME` all match `fullname`.
 */
const PII_FIELD_NAME_FRAGMENTS: readonly string[] = [
  'email',
  'phone',
  'mobile',
  'fullname',
  'firstname',
  'lastname',
  'customername',
  'contactname',
  'name',
  'address',
  'street',
  'postcode',
  'postalcode',
  'zipcode',
  'dob',
  'dateofbirth',
  'birthdate',
  'passport',
  'ssn',
  'sin',
  'nationalid',
  'idnumber',
  'documentnumber',
  'document',
  'documenturl',
  'filename',
  'fileurl',
  'uploadpath',
  'token',
  'apikey',
  'secret',
  'password',
  'authorization',
  'creditcard',
  'cardnumber',
  'cvv',
  'iban',
  'accountnumber',
  'ipaddress',
];

/** Matches an email address anywhere inside a longer string value. */
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Matches a run of 7+ digits allowing spaces/dashes/parentheses/leading
 * `+` — broad enough to catch international phone numbers without also
 * catching short bounded identifiers (order references, short codes).
 */
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPiiFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  return PII_FIELD_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Redacts email/phone-shaped substrings inside a string that survives by key. */
function scrubStringContent(value: string): string {
  const bounded =
    value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_SUFFIX}`
      : value;
  return bounded.replace(EMAIL_PATTERN, REDACTED).replace(PHONE_PATTERN, REDACTED);
}

/**
 * Deep-scrubs a value for logging/error reporting: any key matching a PII
 * fragment is fully redacted; every surviving string is still scanned for
 * email/phone-shaped content. Depth- and length-bounded so a malformed or
 * adversarial payload cannot blow up log volume.
 */
function scrubObjectFields(value: object, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isPiiFieldName(key) ? REDACTED : scrubValue(item, depth + 1);
  }
  return result;
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubStringContent(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrubValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return scrubObjectFields(value, depth);
  }
  // functions, symbols, bigint: never serialize as-is.
  return REDACTED;
}

/** Scrubs an object's own enumerable fields in place, returning a new object. */
export function scrubRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return value;
  return scrubObjectFields(value, 0);
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_./:-]{1,128}$/;

/** Bounds a request/workspace/actor identifier to a safe token, or drops it. */
export function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

const ROUTE_PATTERN = /^[A-Za-z0-9_./:{}-]{1,200}$/;

/** Bounds a route/path label to a safe token, or drops it. */
export function safeRoute(value: unknown): string | undefined {
  return typeof value === 'string' && ROUTE_PATTERN.test(value) ? value : undefined;
}

/**
 * The one structured-log envelope every app emits (REQ 40: "requestId,
 * workspaceId, actorId, route, duration"). `extra` is free-form context
 * (e.g. an outbox job's failed count) and is always scrubbed before it can
 * reach a log line.
 */
export interface LogFields {
  event: string;
  requestId: string;
  workspaceId?: string;
  actorId?: string;
  route?: string;
  durationMs?: number;
  extra?: Record<string, unknown>;
}

export interface LogRecord {
  event: string;
  requestId: string;
  workspaceId: string;
  actorId: string;
  route: string;
  durationMs?: number;
  [key: string]: unknown;
}

/** Builds the JSON-safe record a logger prints; never call `console.*` directly on raw fields. */
export function buildLogRecord(fields: LogFields): LogRecord {
  const record: LogRecord = {
    event: safeIdentifier(fields.event) ?? 'unknown_event',
    requestId: safeIdentifier(fields.requestId) ?? 'unknown',
    workspaceId: safeIdentifier(fields.workspaceId) ?? 'unknown',
    actorId: safeIdentifier(fields.actorId) ?? 'unknown',
    route: safeRoute(fields.route) ?? 'unknown',
  };
  if (typeof fields.durationMs === 'number' && Number.isFinite(fields.durationMs)) {
    record.durationMs = Math.max(0, Math.round(fields.durationMs));
  }
  const extra = scrubRecord(fields.extra);
  if (extra) Object.assign(record, extra);
  return record;
}

/** Context attached to every reported exception (REQ 40: "release tags"). */
export interface ErrorTrackerContext {
  requestId: string;
  workspaceId?: string;
  actorId?: string;
  route?: string;
  /** Deployed release identifier — a git SHA or package version, never a free-text label. */
  release: string;
  /** `production`, `preview`, `development`, etc. */
  environment?: string;
}

export interface CapturedErrorEvent {
  event_id: string;
  timestamp: string;
  platform: 'node' | 'javascript';
  release: string;
  environment: string;
  tags: Record<string, string>;
  exception: { values: [{ type: string; value: string }] };
}

/**
 * Sentry's classic ingest expects a 32-char hex id with no dashes. This isn't
 * a secret — it just needs to be unique enough to dedupe an ingest retry — so
 * `Math.random` is fine and keeps this module free of `lib.dom`/Node crypto
 * type dependencies (browser and Node both run it unchanged).
 */
function eventId(): string {
  let id = '';
  for (let index = 0; index < 32; index += 1) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

/**
 * Reduces a thrown value to the minimal event shape a Sentry-class store
 * endpoint accepts, scrubbing the message so a PII-carrying error (an
 * unexpected `Error(email)` from a careless throw, say) can never leak
 * (invariant 12). Never carries a stack trace with interpolated values,
 * request bodies, or any other free-form payload.
 */
export function buildErrorEvent(
  error: unknown,
  context: ErrorTrackerContext,
  platform: 'node' | 'javascript' = 'node',
): CapturedErrorEvent {
  const type = error instanceof Error ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = scrubStringContent(rawMessage).slice(0, 500);
  return {
    event_id: eventId(),
    timestamp: new Date().toISOString(),
    platform,
    release: safeIdentifier(context.release) ?? 'unknown',
    environment: context.environment ?? 'unknown',
    tags: {
      requestId: safeIdentifier(context.requestId) ?? 'unknown',
      workspaceId: safeIdentifier(context.workspaceId) ?? 'unknown',
      actorId: safeIdentifier(context.actorId) ?? 'unknown',
      route: safeRoute(context.route) ?? 'unknown',
    },
    exception: { values: [{ type, value: message }] },
  };
}

/** Minimal interface every app's error-tracker wiring implements. */
export interface ErrorTracker {
  captureException(error: unknown, context: ErrorTrackerContext): void;
}

/** In-memory tracker for tests and any environment with no DSN configured. */
export class FakeErrorTracker implements ErrorTracker {
  readonly events: CapturedErrorEvent[] = [];

  captureException(error: unknown, context: ErrorTrackerContext): void {
    this.events.push(buildErrorEvent(error, context));
  }
}
