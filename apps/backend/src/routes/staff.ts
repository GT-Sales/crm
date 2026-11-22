import { DatabaseAiTurnStore, type AiTurnStore } from '../ai/turn-store.js';
import { createAiChatDependenciesFromEnv } from '../ai/chat-factory.js';
import { DatabaseAiChatSchemaProbe } from '../ai/chat-schema.js';
import type { AiChatDependencies, AiModelDependencies } from './ai-assistant.js';
import { createGatewayModelCatalogue } from '../ai/model-catalogue.js';
import { DatabaseAiModelSettingsStore } from '../ai/model-settings-store.js';
import { AutomationAuthoringStore } from '../ai/automation-authoring.js';
import { createErrorTrackerFromEnv, type ErrorTracker } from '@gt-sales/adapters';
import { Router, type Request } from 'express';
import { updateStaffProfileRequestSchema, type PropertyCatalog } from '@gt-sales/contracts';
import {
  rateLimitHit,
  withTenantTx,
  type DatabaseClient,
  type RateLimitInput,
  type RateLimitResult,
  type TenantContext,
} from '@gt-sales/db';
import { z } from 'zod';
import { createDocumentServiceFromEnv } from '../documents/factory.js';
import type { DocumentService } from '../documents/service.js';
import {
  defaultStaffSessionVerifier,
  requireStaffSession,
  type StaffRateLimit,
  type StaffSessionVerifier,
} from '../auth/session.js';
import { isConnectionLevelError, logRequestError } from '../http/logger.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sensitiveFieldsKey } from '../crypto/cipher.js';
import { DatabaseFlowStore, type FlowStore } from '../automations/flow-store.js';
import { customerEmailFromEnv, type CustomerEmail } from '../email/senders.js';
import type { ChangeRequestService } from '../tracking/change-requests.js';
import { DatabaseEmailSettingsStore, type EmailSettingsStore } from '../email/settings-store.js';
import { DatabaseIdentityStore, type IdentityStore } from '../leads/identity-store.js';
import { DatabaseLeadExportStore, type LeadExportStore } from '../leads/export/store.js';
import { DatabaseLeadStore, type LeadStore } from '../leads/store.js';
import { DatabaseLeadWorkStore } from '../leads/work-store.js';
import { type LeadWorkStore } from '../leads/work-types.js';
import { DatabaseOutboxStore, type JobAdminStore } from '../jobs/store.js';
import { DatabasePlanStore, type PlanStore } from '../plans/store.js';
import { DatabaseAnalyticsStore, type AnalyticsStore } from '../analytics/store.js';
import { DatabaseReportStore, type ReportStore } from '../reports/store.js';
import type { PropertyStore } from '../properties/store.js';
import { createAuthorize, denyReasonOf, type StaffAction } from '../staff/authorization.js';
import { DatabaseStaffStore, type StaffStore } from '../staff/store.js';
import { DatabaseSavedViewStore, type SavedViewStore } from '../views/store.js';
import { createSavedViewRoutes } from './views.js';
import { DatabaseWebsiteCredentialStore, type WebsiteCredentialStore } from '../website/store.js';
import {
  DatabaseDocumentReviewQueue,
  type DocumentReviewQueueStore,
} from '../documents/review-queue.js';
import { DatabaseMailbox, type MailboxStore } from '../email/mailbox.js';
import { DatabaseEmailStore, type DeliverySummary } from '../email/store.js';
import { loadReplyAddressing, type ReplyAddressing } from '../email/reply-address.js';
import { loadWebAnalyticsReader, type WebAnalyticsReader } from '../analytics/web-analytics.js';
import { createAutomationRoutes } from './automations.js';
import { createAiAssistantRoutes } from './ai-assistant.js';
import { DatabaseAiCardStore, type AiCardStore } from '../ai/card-store.js';
import { createEmailSettingsRoutes } from './email-settings.js';
import { createPlanRoutes } from './plans.js';
import { createPropertyRoutes } from './properties.js';
import { createAnalyticsRoutes } from './analytics.js';
import { createLeadExportRoutes } from './lead-export.js';
import { createReportRoutes } from './reports.js';
import { loadAiAssistantConfig, type AiAssistantConfig } from '../ai/config.js';
import { createGatewayEngine, type AssistantEngine } from '../ai/engine.js';
import { DatabaseAiReadService, type AiReadService } from '../ai/read-service.js';
import { DatabaseAiSiteContextStore, type AiSiteContextStore } from '../ai/site-context.js';
import { canSeeContacts, session, type StaffRouteContext } from './staff-context.js';
import { createStaffFileRoutes } from './staff-files.js';
import { createStaffLeadRoutes } from './staff-leads.js';
import { createStaffSiteRoutes } from './staff-site.js';

export interface StaffRouteDependencies {
  sessionVerifier: StaffSessionVerifier;
  /** Per-IP limit applied before any session check; omitted in route tests. */
  rateLimit?: StaffRateLimit;
  store: StaffStore;
  credentialStore: WebsiteCredentialStore;
  leadStore: LeadStore;
  /** The lead page, board, notes and tasks; omitted in route tests that do not reach them. */
  leadWorkStore?: LeadWorkStore;
  /** Leads as an Excel file; omitted in route tests that do not reach it. */
  leadExportStore?: LeadExportStore;
  jobStore?: JobAdminStore;
  documentService?: Pick<DocumentService, 'review' | 'issueDownload'>;
  /** Opens a lead's sealed SIN for an owner; absent without `SENSITIVE_FIELDS_KEY`. */
  identityStore?: Pick<IdentityStore, 'revealSin'>;
  /** Mail to a lead's customer; absent, no site can send. */
  customerEmail?: CustomerEmail;
  /** Each staff member's private saved views; omitted in route tests that do not reach them. */
  savedViewStore?: SavedViewStore;
  /** The site's property catalogue; `createApp` supplies the default. */
  loadPropertyCatalog?: (ctx: TenantContext) => Promise<PropertyCatalog>;
  /** Receives every unexpected handler failure; optional so tests can omit it. */
  errorTracker?: ErrorTracker;
  /**
   * The site's property definitions and layouts; the lead list, board, detail
   * and edit read the site's catalogue from it. `createApp` supplies the
   * database store when this is omitted.
   */
  propertyStore?: PropertyStore;
  /** The site's plans; `createApp` supplies the database store when this is omitted. */
  planStore?: PlanStore;
  /** The site's reports (counts only); omitted in route tests that do not reach them. */
  reportStore?: ReportStore;
  /** The analytics dashboard's figures; omitted in route tests that do not reach them. */
  analyticsStore?: AnalyticsStore;
  /** The site's automation flows, their versions and runs; omitted in route tests that do not reach them. */
  flowStore?: FlowStore;
  /** Documents → review queue; the database store when absent. */
  documentReviewQueue?: DocumentReviewQueueStore;
  mailbox?: MailboxStore;
  webAnalytics?: WebAnalyticsReader;
  replyAddressing?: ReplyAddressing;
  /** The site's email settings and templates; omitted in route tests that do not reach them. */
  emailSettingsStore?: EmailSettingsStore;
  /** The transaction runner the test mail is composed and queued in; the database's by default. */
  withTenantTx?: DatabaseClient['withTenantTx'];
  /** Decides customers' change requests; `createApp` supplies the tracking one when omitted. */
  changeRequests?: Pick<ChangeRequestService, 'approve' | 'reject'>;
  /**
   * Ask AI: its validated configuration, the site lookup the panel header
   * needs, the reads behind its tools, the model adapter and the distributed
   * limiter. `createApp` supplies all of them; tests inject fakes so a
   * disabled, enabled or failing assistant can be exercised offline.
   */
  ai?: {
    config: AiAssistantConfig;
    siteContext: AiSiteContextStore;
    reads?: AiReadService;
    engine?: AssistantEngine;
    rateLimit?: (input: RateLimitInput) => Promise<RateLimitResult>;
    /** Per-turn usage records; the default dependencies write `app.ai_turns`. */
    turns?: AiTurnStore;
    /**
     * The saved chat: conversations, attachments and usage. Absent (as in
     * most route tests) the assistant is memory-only, exactly as before.
     */
    chat?: AiChatDependencies;
    /**
     * Settings → AI models: the site's saved models and the Gateway catalogue.
     * Absent (as in most route tests), every turn uses the deployment's model.
     */
    models?: AiModelDependencies;
    /** The wider cards' reads and the lead edit's write; absent, those kinds are not offered. */
    cards?: AiCardStore;
    now?: () => Date;
    /** The site's delivery counters for Ask AI's sent-mail read (the email route's own store). */
    deliverySummary?: (scope: { workspaceId: string; actorId: string }) => Promise<DeliverySummary>;
  };
}

export function createDefaultStaffRouteDependencies(): StaffRouteDependencies {
  const aiConfig = loadAiAssistantConfig();
  // The deploy keeps working without the dedicated secret, but says so once;
  // a secret that is too short has switched Ask AI off, and says so too.
  if (aiConfig.signingSecretInvalid) {
    console.warn(JSON.stringify({ event: 'ai_signing_secret_invalid' }));
  } else if (aiConfig.enabled && aiConfig.signingKeySource !== 'dedicated') {
    console.warn(JSON.stringify({ event: 'ai_signing_secret_missing' }));
  }
  // One catalogue check shared by the saved chat and the turn records.
  const aiSchema = new DatabaseAiChatSchemaProbe();
  const deliveryStore = new DatabaseEmailStore();
  return {
    sessionVerifier: defaultStaffSessionVerifier(),
    rateLimit: rateLimitHit,
    store: new DatabaseStaffStore(),
    credentialStore: new DatabaseWebsiteCredentialStore(),
    leadStore: new DatabaseLeadStore(),
    leadWorkStore: new DatabaseLeadWorkStore(),
    leadExportStore: new DatabaseLeadExportStore(),
    jobStore: new DatabaseOutboxStore(),
    documentService: createDocumentServiceFromEnv(),
    identityStore: identityStoreFromEnv(),
    customerEmail: customerEmailFromEnv(),
    savedViewStore: new DatabaseSavedViewStore(),
    planStore: new DatabasePlanStore(),
    reportStore: new DatabaseReportStore(),
    analyticsStore: new DatabaseAnalyticsStore(),
    flowStore: new DatabaseFlowStore(),
    emailSettingsStore: new DatabaseEmailSettingsStore(),
    errorTracker: createErrorTrackerFromEnv(),
    ai: {
      config: aiConfig,
      siteContext: new DatabaseAiSiteContextStore(),
      reads: new DatabaseAiReadService(),
      deliverySummary: (scope) => deliveryStore.deliverySummary(scope.workspaceId, scope.actorId),
      cards: new DatabaseAiCardStore(),
      // Only a fully configured deployment builds a provider; otherwise the
      // chat route reports the feature unavailable and never calls a model.
      ...(aiConfig.enabled && aiConfig.apiKey !== undefined && aiConfig.modelId !== undefined
        ? {
            engine: createGatewayEngine({
              apiKey: aiConfig.apiKey,
              modelId: aiConfig.modelId,
              ...(aiConfig.providers ? { providers: aiConfig.providers } : {}),
              ...(aiConfig.highEffort ? { highEffort: aiConfig.highEffort } : {}),
            }),
          }
        : {}),
      rateLimit: rateLimitHit,
      turns: new DatabaseAiTurnStore(undefined, aiSchema),
      chat: createAiChatDependenciesFromEnv(process.env, aiSchema),
      models: {
        settings: new DatabaseAiModelSettingsStore(),
        // The catalogue needs the Gateway key; without one Settings says it is unavailable.
        ...(aiConfig.enabled && aiConfig.apiKey !== undefined
          ? { catalogue: createGatewayModelCatalogue(aiConfig.apiKey) }
          : {}),
      },
    },
  };
}
function identityStoreFromEnv(): IdentityStore | undefined {
  const secret = sensitiveFieldsKey();
  return secret ? new DatabaseIdentityStore(secret) : undefined;
}

/** Stand-ins for a deployment built without them: each request is a logged 500. */
function notConfigured(what: string): Promise<never> {
  return Promise.reject(new Error(`${what} is not configured`));
}
const unconfiguredPropertyStore: PropertyStore = {
  catalog: () => notConfigured('property store'),
  model: () => notConfigured('property store'),
  create: () => notConfigured('property store'),
  update: () => notConfigured('property store'),
  remove: () => notConfigured('property store'),
  saveLayout: () => notConfigured('property store'),
};
const unconfiguredSavedViewStore: SavedViewStore = {
  list: () => notConfigured('saved view store'),
  create: () => notConfigured('saved view store'),
  update: () => notConfigured('saved view store'),
  delete: () => notConfigured('saved view store'),
};
const unconfiguredPlanStore: PlanStore = {
  list: () => notConfigured('plan store'),
  get: () => notConfigured('plan store'),
  create: () => notConfigured('plan store'),
  update: () => notConfigured('plan store'),
  listForWebsite: () => notConfigured('plan store'),
  options: () => notConfigured('plan store'),
};
const unconfiguredLeadExportStore: LeadExportStore = {
  export: () => notConfigured('lead export store'),
};
const unconfiguredReportStore: ReportStore = {
  sourceReport: () => notConfigured('report store'),
};
const unconfiguredAnalyticsStore: AnalyticsStore = {
  analytics: () => notConfigured('analytics store'),
};
const unconfiguredFlowStore: FlowStore = {
  list: () => notConfigured('flow store'),
  get: () => notConfigured('flow store'),
  create: () => notConfigured('flow store'),
  updateDetails: () => notConfigured('flow store'),
  setEnabled: () => notConfigured('flow store'),
  archive: () => notConfigured('flow store'),
  restore: () => notConfigured('flow store'),
  listRuns: () => notConfigured('flow store'),
  getRun: () => notConfigured('flow store'),
  saveDraft: () => notConfigured('flow store'),
  discardDraft: () => notConfigured('flow store'),
  activate: () => notConfigured('flow store'),
  reset: () => notConfigured('flow store'),
  getVersion: () => notConfigured('flow store'),
  versions: () => notConfigured('flow store'),
  catalog: () => notConfigured('flow store'),
  detail: () => notConfigured('flow store'),
};
const unconfiguredEmailSettingsStore: EmailSettingsStore = {
  getSettings: () => notConfigured('email settings store'),
  putSettings: () => notConfigured('email settings store'),
  listTemplates: () => notConfigured('email settings store'),
  listArchivedTemplates: () => notConfigured('email settings store'),
  putTemplate: () => notConfigured('email settings store'),
  createTemplate: () => notConfigured('email settings store'),
  setTemplateArchived: () => notConfigured('email settings store'),
};
/** A deployment with no customer mail: no provider, so no site can send. */
const unconfiguredCustomerEmail: CustomerEmail = {
  environment: {
    providerReady: false,
    contactHash: () => {
      throw new Error('customer email is not configured');
    },
  },
  available: async () => false,
};
const unconfiguredCatalog = () => notConfigured('property catalogue');

export function createStaffRouter(dependencies: StaffRouteDependencies): Router {
  // One reader for the process: it keeps a short cache of each site's report.
  const defaultWebAnalytics = loadWebAnalyticsReader();
  // Whether a site's customers' replies come back to the CRM (email/reply-address.ts).
  const replyAddressing = dependencies.replyAddressing ?? loadReplyAddressing();
  const router = Router();
  router.use(requireStaffSession(dependencies.sessionVerifier, dependencies.rateLimit));

  const authorize = createAuthorize({ accessStore: dependencies.store });
  const propertyStore = dependencies.propertyStore ?? unconfiguredPropertyStore;

  /**
   * Every handler's last-resort failure path: a scrubbed log record plus the
   * error tracker, so a staff-side 500 is never silent. Neither the body, the
   * headers nor the error message reach the log.
   */
  function reportFailure(req: Request, error: unknown): void {
    const workspaceId =
      typeof req.params['workspaceId'] === 'string' ? req.params['workspaceId'] : undefined;
    const routePath: unknown = req.route?.path;
    const route = `${req.baseUrl}${typeof routePath === 'string' ? routePath : req.path}`;
    const connection = isConnectionLevelError(error);
    logRequestError({
      requestId: req.id,
      workspaceId,
      route,
      code: connection ? 'persistence_unavailable' : 'internal_error',
      flag: connection ? 'retryable' : 'not_retryable',
    });
    dependencies.errorTracker?.captureException(error, {
      requestId: req.id,
      workspaceId,
      actorId: req.staffSession?.actorId,
      route,
      release: process.env['RELEASE_SHA'] ?? 'unknown',
      environment: process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'],
    });
  }

  /** One live authorization decision for this actor and workspace. */
  async function decide(req: Request, workspaceId: string, action: StaffAction) {
    const actor = session(req);
    const decision = await authorize({ actorId: actor.actorId, workspaceId, action });
    return { actor, decision };
  }

  router.get('/workspaces', async (req, res) => {
    try {
      const actor = session(req);
      const workspaces = await dependencies.store.bootstrapStaff({
        actorId: actor.actorId,
        verifiedEmail: actor.verifiedEmail,
        requestId: req.id,
      });
      res.json({ workspaces, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/access', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const workspaces = await dependencies.store.bootstrapStaff({
        actorId: actor.actorId,
        verifiedEmail: actor.verifiedEmail,
        requestId: req.id,
      });
      const workspace = workspaces.find((item) => item.id === workspaceId.data);
      if (!workspace) {
        sendStaffAuthError(res, req.id, 'workspace_not_found', 404);
        return;
      }
      res.json({
        workspace,
        permissions: decision.access.permissions
          .filter((permission) => permission.effect === 'allow')
          .map((permission) => permission.name),
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  /** The caller's own display name, on every site they actively belong to. */
  router.patch('/profile', async (req, res) => {
    const body = updateStaffProfileRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const actor = session(req);
      const memberships = await dependencies.store.setDisplayName({
        actorId: actor.actorId,
        displayName: body.data.displayName,
        requestId: req.id,
      });
      res.json({ displayName: body.data.displayName, memberships, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  const context: StaffRouteContext = {
    dependencies,
    authorize,
    decide,
    reportFailure,
    propertyStore,
    replyAddressing,
    defaultWebAnalytics,
  };
  router.use(createStaffLeadRoutes(context));
  router.use(createStaffSiteRoutes(context));
  router.use(createStaffFileRoutes(context));

  router.use(createPropertyRoutes({ store: propertyStore, decide, reportFailure }));

  router.use(
    createEmailSettingsRoutes({
      store: dependencies.emailSettingsStore ?? unconfiguredEmailSettingsStore,
      customerEmail: dependencies.customerEmail ?? unconfiguredCustomerEmail,
      withTenantTx: dependencies.withTenantTx ?? withTenantTx,
      decide,
      reportFailure,
      ...(dependencies.loadPropertyCatalog
        ? { loadCatalog: dependencies.loadPropertyCatalog }
        : {}),
    }),
  );

  router.use(
    createPlanRoutes({
      store: dependencies.planStore ?? unconfiguredPlanStore,
      decide,
      reportFailure,
    }),
  );

  router.use(
    createReportRoutes({
      store: dependencies.reportStore ?? unconfiguredReportStore,
      decide,
      reportFailure,
    }),
  );

  router.use(
    createLeadExportRoutes({
      store: dependencies.leadExportStore ?? unconfiguredLeadExportStore,
      decide,
      reportFailure,
      canSeeContacts,
      loadCatalog: (ctx) => propertyStore.catalog(ctx),
      ...(dependencies.rateLimit === undefined ? {} : { rateLimit: dependencies.rateLimit }),
    }),
  );

  router.use(
    createAnalyticsRoutes({
      store: dependencies.analyticsStore ?? unconfiguredAnalyticsStore,
      decide,
      reportFailure,
    }),
  );

  router.use(
    createAutomationRoutes({
      store: dependencies.flowStore ?? unconfiguredFlowStore,
      customerEmail: dependencies.customerEmail,
      withTenantTx: dependencies.withTenantTx ?? withTenantTx,
      decide,
      canSeeContacts,
      reportFailure,
      ...(dependencies.rateLimit === undefined ? {} : { rateLimit: dependencies.rateLimit }),
    }),
  );

  router.use(
    createSavedViewRoutes({
      store: dependencies.savedViewStore ?? unconfiguredSavedViewStore,
      loadCatalog: dependencies.loadPropertyCatalog ?? unconfiguredCatalog,
      decide,
      canSeeContacts,
      reportFailure,
    }),
  );

  const ai = dependencies.ai ?? {
    config: loadAiAssistantConfig(),
    siteContext: new DatabaseAiSiteContextStore(),
  };
  router.use(
    createAiAssistantRoutes({
      flows: dependencies.flowStore ?? unconfiguredFlowStore,
      automationAuthoring: new AutomationAuthoringStore(),
      ...(dependencies.leadWorkStore === undefined ? {} : { work: dependencies.leadWorkStore }),
      listAssignees: (scope) =>
        dependencies.store.listAssignableMembers(scope.workspaceId, scope.actorId),
      config: ai.config,
      loadAccess: (actorId, workspaceId) =>
        dependencies.store.loadStaffAccess(actorId, workspaceId),
      siteContext: ai.siteContext,
      reads: ai.reads ?? new DatabaseAiReadService(),
      reports: dependencies.reportStore ?? unconfiguredReportStore,
      // Ask AI's smaller reads, through the stores their staff routes use.
      wideReads: {
        ...(dependencies.planStore === undefined ? {} : { plans: dependencies.planStore }),
        ...(dependencies.propertyStore === undefined
          ? {}
          : {
              propertyCatalog: (scope: { workspaceId: string; actorId: string }) =>
                propertyStore.catalog({ ...scope, requestId: 'ai-read' }),
            }),
        ...(dependencies.analyticsStore === undefined
          ? {}
          : { analytics: dependencies.analyticsStore }),
        webAnalytics: dependencies.webAnalytics ?? defaultWebAnalytics,
        documentReviewQueue: dependencies.documentReviewQueue ?? new DatabaseDocumentReviewQueue(),
        mailbox: dependencies.mailbox ?? new DatabaseMailbox(),
        ...(ai.deliverySummary === undefined ? {} : { deliverySummary: ai.deliverySummary }),
        ...(dependencies.jobStore === undefined ? {} : { jobs: dependencies.jobStore }),
        members: (scope: { workspaceId: string; actorId: string }) =>
          dependencies.store.listAssignableMembers(scope.workspaceId, scope.actorId),
        ...(dependencies.emailSettingsStore === undefined
          ? {}
          : { emailSettings: dependencies.emailSettingsStore }),
      },
      ...(ai.engine === undefined ? {} : { engine: ai.engine }),
      rateLimit: ai.rateLimit ?? rateLimitHit,
      ...(ai.turns === undefined ? {} : { turns: ai.turns }),
      ...(ai.chat === undefined ? {} : { chat: ai.chat }),
      ...(ai.models === undefined ? {} : { models: ai.models }),
      ...(ai.now === undefined ? {} : { now: ai.now }),
      ...(ai.cards === undefined ? {} : { cards: ai.cards }),
      // C2: a lead edit is checked and saved against the site's own catalogue.
      ...(dependencies.propertyStore === undefined
        ? {}
        : {
            loadCatalog: (ctx: import('../tenant-scope.js').WriteScope) =>
              propertyStore.catalog(ctx),
          }),
      reportFailure,
    }),
  );

  return router;
}
