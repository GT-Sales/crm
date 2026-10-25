import { buildLogRecord, type LogFields } from '@gt-sales/observability';

/**
 * Server-side structured-log emitter (REQ 40, IMPLEMENTATION_PLAN §10). Every
 * field is reduced/scrubbed by {@link buildLogRecord} before this ever calls
 * `console.*`, so a caller cannot accidentally print raw PII by passing it
 * through `extra`.
 */
export function logEvent(fields: LogFields): void {
  console.info(JSON.stringify(buildLogRecord(fields)));
}

export {
  buildLogRecord,
  scrubValue,
  type LogFields,
  type LogRecord,
} from '@gt-sales/observability';
