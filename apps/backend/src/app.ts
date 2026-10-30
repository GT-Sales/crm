import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { createErrorTrackerFromEnv, type ErrorTracker } from '@gt-sales/adapters';

import { sendStaffAuthError } from './http/staff-errors.js';
import { requestLog } from './http/requestLog.js';
import { requestId } from './requestId.js';
import { DatabasePlanStore } from './plans/store.js';
import { DatabasePropertyStore } from './properties/store.js';
import { getHealth } from './routes/health.js';
import {
  createDefaultStaffRouteDependencies,
  createStaffRouter,
  type StaffRouteDependencies,
} from './routes/staff.js';
import {
  createDefaultWebsiteRouteDependencies,
  createWebsiteRouter,
  type WebsiteRouteDependencies,
} from './routes/website.js';
import {
  createDefaultJobsRouteDependencies,
  createJobsRouter,
  type JobsRouteDependencies,
} from './routes/jobs.js';
import {
  createDefaultEmailRouteDependencies,
  createEmailRouter,
  createResendWebhookRouter,
  type EmailRouteDependencies,
} from './routes/email.js';

export interface CreateAppOptions {
  staff?: StaffRouteDependencies;
  website?: WebsiteRouteDependencies;
  jobs?: JobsRouteDependencies;
  email?: EmailRouteDependencies;
  errorTracker?: ErrorTracker;
}

function adminCors(): RequestHandler {
  const allowedOrigin = process.env.ADMIN_ORIGIN ?? 'http://localhost:3000';
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin === allowedOrigin) {
      res.setHeader('access-control-allow-origin', allowedOrigin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-request-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin === allowedOrigin ? 204 : 403);
      return;
    }
    next();
  };
}

function paramWorkspaceId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Last-resort handler for anything reaching Express's error path (a JSON
 * parse failure, or any handler that calls `next(error)`). The error is
 * always reported to the tracker with the request id before the client ever
 * sees a response, so an induced failure is diagnosable without needing PII
 * in the response body.
 */
function createInvalidBodyError(errorTracker: ErrorTracker): ErrorRequestHandler {
  return (error, req, res, _next) => {
    errorTracker.captureException(error, {
      requestId: req.id,
      workspaceId: req.websiteContext?.workspaceId ?? paramWorkspaceId(req.params?.workspaceId),
      actorId: req.staffSession?.actorId ?? req.websiteContext?.credentialId,
      route: req.path,
      release: process.env['RELEASE_SHA'] ?? 'unknown',
      environment: process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'],
    });
    if (res.headersSent) return;
    sendStaffAuthError(res, req.id, 'invalid_request', 400);
  };
}

/**
 * Builds the Express app without starting a listener — reused by the local
 * dev server (src/server.ts) and tests. Protected staff routes are mounted as
 * one router so session verification cannot be omitted from an individual
 * handler.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  // Behind Railway's edge every socket carries the proxy address, so the
  // pre-auth IP limiter would otherwise share one bucket across all callers.
  // Only a deployment-declared hop count makes X-Forwarded-For trustworthy;
  // the default (0) keeps forwarded headers ignored.
  const trustProxyHops = Number(process.env['TRUST_PROXY_HOPS'] ?? 0);
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  const errorTracker = options.errorTracker ?? createErrorTrackerFromEnv();

  app.use(requestId);
  app.use(requestLog);
  app.use(adminCors());
  const emailDependencies = options.email ?? createDefaultEmailRouteDependencies();
  app.use(
    '/api/v1/webhooks/resend',
    express.raw({ type: 'application/json', limit: '64kb' }),
    createResendWebhookRouter(emailDependencies),
  );
  app.use(express.json({ limit: '64kb' }));
  app.get('/api/v1/health', getHealth);
  app.use(
    '/api/internal/jobs',
    createJobsRouter(options.jobs ?? createDefaultJobsRouteDependencies()),
  );
  const staffDependencies = options.staff ?? createDefaultStaffRouteDependencies();
  const propertyStore = staffDependencies.propertyStore ?? new DatabasePropertyStore();
  const planStore = staffDependencies.planStore ?? new DatabasePlanStore();
  app.use(
    '/api/v1/staff',
    createStaffRouter({
      ...staffDependencies,
      propertyStore,
      planStore,
      // Saved views are cleaned against the site's own catalogue.
      loadPropertyCatalog:
        staffDependencies.loadPropertyCatalog ?? ((ctx) => propertyStore.catalog(ctx)),
    }),
  );
  // Website intake surface. Server-to-server, so CORS does not apply and is
  // never treated as authentication; the service credential is the only proof.
  const websiteDependencies = options.website ?? createDefaultWebsiteRouteDependencies();
  app.use(
    '/api/v1/website',
    createWebsiteRouter({
      ...websiteDependencies,
      plans: websiteDependencies.plans ?? { store: planStore },
    }),
  );
  app.use('/api/v1/email', createEmailRouter(emailDependencies));
  app.use(createInvalidBodyError(errorTracker));

  return app;
}
