export { countCopyRows } from './copy-rows.js';

export {
  APP_SCHEMAS,
  AUTH_SCHEMA,
  AUTH_TABLES,
  HISTORY_SCHEMA,
  INTERNAL_SCHEMAS,
  PgDumpDatabaseExporter,
  filterData,
  filterRoles,
  filterSchema,
  parseConnectionUrl,
  pgConnectionEnv,
  type DatabaseDumpArtifacts,
  type DatabaseExporter,
  type PgConnection,
  type PgDumpOptions,
} from './pg-dump.js';

export {
  BackupIncompleteError,
  BackupSourceUnreadableError,
  BackupTooLargeError,
  BackupUploadVerificationError,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  MAX_LISTED_MISSING_OBJECTS,
  createBackupRunId,
  runBackup,
  type BackupRunDependencies,
  type BackupRunSummary,
} from './run.js';

export {
  FakeSourceCompletenessGuard,
  FakeStorageSourceReader,
  PsqlSourceCompletenessGuard,
  referencedObjectsFromDump,
  S3StorageSourceReader,
  UNREADABLE_TABLES_QUERY,
  unreadableTablesQuery,
  type ReferencedObject,
  type SourceCompletenessGuardOptions,
  type SourceCompletenessGuard,
  type StorageSourceReader,
} from './sources.js';
