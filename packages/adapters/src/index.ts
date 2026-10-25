/**
 * @gt-sales/adapters — server-only object-store, email, alert, error-tracking
 * and analytics provider adapters, with in-memory fakes for tests. Never
 * imported by a browser bundle.
 */
export const ADAPTERS_PACKAGE_PLACEHOLDER = true as const;

export {
  analyticsEventNames,
  FakeAnalyticsSink,
  FakeEmailAdapter,
  FakeSuppressionLedgerPublisher,
  ResendEmailAdapter,
  SesEmailAdapter,
  emailTemplates,
  messageClassForTemplate,
  transactionalEmailTemplates,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsSink,
  type EmailAdapter,
  type EmailMessage,
  type EmailMessageClass,
  type EmailTemplate,
  type ProviderDeliveryResult,
  type SenderIdentity,
  type SuppressionLedgerEvent,
  type SuppressionLedgerPublisher,
} from './messaging.js';

export {
  LogAnalyticsSink,
  UmamiAnalyticsSink,
  type AnalyticsLogLine,
  type AnalyticsLogger,
  type UmamiAnalyticsOptions,
} from './analytics.js';

export {
  InMemoryR2DocumentStore,
  detectDocumentType,
  documentObjectKey,
  sha256Hex,
  type CopyForExportInput,
  type CreateUploadInput,
  type DocumentMediaType,
  type IssueDownloadInput,
  type PresignedDownload,
  type PresignedUpload,
  type R2DocumentStore,
  type VerifyUploadInput,
  type VerifyUploadRejection,
  type VerifyUploadResult,
} from './r2.js';

export {
  S3R2DocumentStore,
  configFromEnv,
  createR2DocumentStoreFromEnv,
  presignUrl,
  type R2Config,
} from './r2-s3.js';

export {
  presignS3Url,
  signS3Request,
  type PresignS3Params,
  type S3SigningConfig,
  type SignS3RequestInput,
} from './sigv4.js';

export {
  createErrorTrackerFromEnv,
  NoopErrorTracker,
  parseSentryDsn,
  SentryHttpErrorTracker,
  FakeErrorTracker,
  buildErrorEvent,
  type CapturedErrorEvent,
  type CreateErrorTrackerOptions,
  type ErrorTracker,
  type ErrorTrackerContext,
  type SentryDsn,
  type SentryHttpErrorTrackerConfig,
} from './error-tracking.js';

export { logEvent, buildLogRecord, scrubValue, type LogFields, type LogRecord } from './logging.js';

export {
  createOwnerAlertChannelFromEnv,
  EmailOwnerAlertChannel,
  FakeOwnerAlertChannel,
  MultiOwnerAlertChannel,
  NoopOwnerAlertChannel,
  ownerAlertKinds,
  WebhookOwnerAlertChannel,
  type CreateOwnerAlertChannelOptions,
  type EmailOwnerAlertChannelConfig,
  type OwnerAlert,
  type OwnerAlertChannel,
  type OwnerAlertKind,
  type WebhookOwnerAlertChannelConfig,
} from './alerts.js';
