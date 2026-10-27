import { createErrorTrackerFromEnv, type ErrorTracker } from '@gt-sales/adapters';
import { Router, type Request, type Response } from 'express';
import {
  createLeadNoteRequestSchema,
  createLeadTaskRequestSchema,
  createServiceCredentialRequestSchema,
  inviteStaffRequestSchema,
  leadBoardQuerySchema,
  leadsSummaryQuerySchema,
  listWorkspaceLeadsQuerySchema,
  listWorkspaceTasksQuerySchema,
  resolveUncertainJobRequestSchema,
  reviewFileRequestSchema,
  updateLeadTaskRequestSchema,
  updateStaffProfileRequestSchema,
  updateWorkspaceLeadRequestSchema,
  type LeadAccess,
  type LeadDetail,
  type LeadListItem,
} from '@gt-sales/contracts';
import { rateLimitHit } from '@gt-sales/db';
import { z } from 'zod';

import { createDocumentServiceFromEnv } from '../documents/factory.js';
import type { DocumentService } from '../documents/service.js';
import { toStaffFile } from '../documents/summary.js';

import {
  defaultStaffSessionVerifier,
  requireStaffSession,
  type StaffRateLimit,
  type StaffSessionVerifier,
} from '../auth/session.js';
import { isConnectionLevelError, logRequestError } from '../http/logger.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { sensitiveFieldsKey } from '../crypto/cipher.js';
import { DatabaseIdentityStore, type IdentityStore } from '../leads/identity-store.js';
import { DatabaseLeadStore, type LeadStore } from '../leads/store.js';
import {
  DatabaseLeadWorkStore,
  type LeadWorkStore,
  type TaskOutcome,
} from '../leads/work-store.js';
import { DatabaseOutboxStore, type JobAdminStore } from '../jobs/store.js';
import {
  createAuthorize,
  decideAccess,
  denyReasonOf,
  type StaffAccessSnapshot,
  type StaffAction,
} from '../staff/authorization.js';
import { DatabaseStaffStore, type StaffStore } from '../staff/store.js';
import { generateServiceSecret } from '../website/credential.js';
import {
  DatabaseWebsiteCredentialStore,
  type ServiceCredentialRecord,
  type WebsiteCredentialStore,
} from '../website/store.js';

export interface StaffRouteDependencies {
  sessionVerifier: StaffSessionVerifier;
  /** Per-IP limit applied before any session check; omitted in route tests. */
  rateLimit?: StaffRateLimit;
  store: StaffStore;
  credentialStore: WebsiteCredentialStore;
  leadStore: LeadStore;
  /** The lead page, board, notes and tasks; omitted in route tests that do not reach them. */
  leadWorkStore?: LeadWorkStore;
  jobStore?: JobAdminStore;
  documentService?: Pick<DocumentService, 'review' | 'issueDownload'>;
  /** Opens a lead's sealed SIN for an owner; absent without `SENSITIVE_FIELDS_KEY`. */
  identityStore?: Pick<IdentityStore, 'revealSin'>;
  /** Receives every unexpected handler failure; optional so tests can omit it. */
  errorTracker?: ErrorTracker;
}

export function createDefaultStaffRouteDependencies(): StaffRouteDependencies {
  return {
    sessionVerifier: defaultStaffSessionVerifier(),
    rateLimit: rateLimitHit,
    store: new DatabaseStaffStore(),
    credentialStore: new DatabaseWebsiteCredentialStore(),
    leadStore: new DatabaseLeadStore(),
    leadWorkStore: new DatabaseLeadWorkStore(),
    jobStore: new DatabaseOutboxStore(),
    documentService: createDocumentServiceFromEnv(),
    identityStore: identityStoreFromEnv(),
    errorTracker: createErrorTrackerFromEnv(),
  };
}

function identityStoreFromEnv(): IdentityStore | undefined {
  const secret = sensitiveFieldsKey();
  return secret ? new DatabaseIdentityStore(secret) : undefined;
}

function credentialSummary(record: ServiceCredentialRecord) {
  return {
    id: record.id,
    scopes: record.scopes,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

function session(req: Request) {
  const value = req.staffSession;
  if (!value) throw new Error('staff session middleware did not run');
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (!('cause' in error) || typeof error.cause !== 'object' || error.cause === null) return false;
  return 'code' in error.cause && error.cause.code === '23505';
}

export function createStaffRouter(dependencies: StaffRouteDependencies): Router {
  const router = Router();
  router.use(requireStaffSession(dependencies.sessionVerifier, dependencies.rateLimit));

  const authorize = createAuthorize({ accessStore: dependencies.store });

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

  /**
   * Whether this actor may see a lead's name, email and phone. Only roles that
   * work leads or money see contact details; read-only roles get leads without
   * them. Decided from the access snapshot the request's own authorization
   * already loaded, so it adds no database round trips: three extra membership
   * reads here were most of the leads inbox's latency.
   */
  function canSeeContacts(access: StaffAccessSnapshot): boolean {
    return (['lead.manage', 'order.manage', 'financial.read'] as const).some(
      (action) => decideAccess(access, action).allowed,
    );
  }

  function leadAccessOf(access: StaffAccessSnapshot): LeadAccess {
    return {
      contacts: canSeeContacts(access),
      manage: decideAccess(access, 'lead.manage').allowed,
      revealSensitive: decideAccess(access, 'sensitive.reveal').allowed,
    };
  }

  // The countdown date comes from the form, which these roles never see.
  function withoutContact(lead: LeadListItem): LeadListItem {
    return { ...lead, contact: {}, countdownDate: null };
  }

  function withoutPersonalDetails(lead: LeadDetail): LeadDetail {
    return { ...lead, contact: {}, form: null, countdownDate: null };
  }

  /** The lead work store, or a logged 500 when this deployment was built without it. */
  function leadWork(req: Request, res: Response): LeadWorkStore | undefined {
    if (dependencies.leadWorkStore) return dependencies.leadWorkStore;
    reportFailure(req, new Error('lead work store is not configured'));
    sendStaffAuthError(res, req.id, 'internal_error', 500);
    return undefined;
  }

  /** Two route parameters as uuids, or a 400 already sent. */
  function uuidParams(
    req: Request,
    res: Response,
    second: 'leadId' | 'taskId',
  ): { workspaceId: string; id: string } | undefined {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const id = z.uuid().safeParse(req.params[second]);
    if (!workspaceId.success || !id.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return undefined;
    }
    return { workspaceId: workspaceId.data, id: id.data };
  }

  function sendTaskOutcome(req: Request, res: Response, outcome: TaskOutcome, created: boolean) {
    switch (outcome.status) {
      case 'saved':
        res.status(created ? 201 : 200).json({ task: outcome.task, requestId: req.id });
        return;
      case 'not_found':
        sendDomainError(res, req.id, created ? 'lead_not_found' : 'task_not_found', 404);
        return;
      case 'trashed':
        sendDomainError(res, req.id, 'lead_trashed', 409);
        return;
      case 'assignee_not_found':
        sendDomainError(res, req.id, 'assignee_not_found', 422);
        return;
    }
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

  router.get('/workspaces/:workspaceId/leads', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = listWorkspaceLeadsQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const access = leadAccessOf(decision.access);
      // A search by name or email would reveal who is a lead.
      if (query.data.q !== undefined && !access.contacts) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }

      const result = await dependencies.leadStore.listLeads({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        status: query.data.status,
        leadType: query.data.type,
        stage: query.data.stage,
        assignee: query.data.assignee,
        search: query.data.q,
        view: query.data.view,
        dueBy: query.data.dueBy,
        page: query.data.page,
        pageSize: query.data.pageSize,
      });
      const leads = access.contacts ? result.leads : result.leads.map(withoutContact);
      res.json({ leads, page: result.page, access, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // Registered before `/leads/:leadId` so the literal segments win.
  router.get('/workspaces/:workspaceId/leads/summary', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = leadsSummaryQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const summary = await store.summary({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        dueBy: query.data.dueBy,
      });
      res.json({ ...summary, access: leadAccessOf(decision.access), requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/leads/board', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = leadBoardQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const access = leadAccessOf(decision.access);
      if (query.data.q !== undefined && !access.contacts) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const columns = await store.board(
        {
          workspaceId: workspaceId.data,
          actorId: actor.actorId,
          leadType: query.data.type,
          assignee: query.data.assignee,
          search: query.data.q,
        },
        query.data.perStage ?? 50,
      );
      res.json({
        leadType: query.data.type,
        columns: access.contacts
          ? columns
          : columns.map((column) => ({ ...column, leads: column.leads.map(withoutContact) })),
        access,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/leads/:leadId', async (req, res) => {
    const params = uuidParams(req, res, 'leadId');
    if (!params) return;
    try {
      const { actor, decision } = await decide(req, params.workspaceId, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const access = leadAccessOf(decision.access);
      // Form details, notes and tasks carry personal details as freely as
      // the contact fields do, so they travel only with contact visibility.
      const result = await store.getLead({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        leadId: params.id,
        includeWork: access.contacts,
      });
      if (!result) {
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      res.json({
        lead: access.contacts ? result.lead : withoutPersonalDetails(result.lead),
        activities: result.activities,
        tasks: result.tasks,
        // Which requests belong to one person is personal data as well.
        related: access.contacts ? result.related : [],
        identities: access.contacts ? result.identities : [],
        access,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.patch('/workspaces/:workspaceId/leads/:leadId', async (req, res) => {
    const params = uuidParams(req, res, 'leadId');
    if (!params) return;
    const body = updateWorkspaceLeadRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, params.workspaceId, 'lead.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const outcome = await store.updateLead({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requestId: req.id,
        leadId: params.id,
        stage: body.data.stage,
        assignedActorId: body.data.assignedActorId,
        contact: body.data.contact,
        form: body.data.form,
      });
      switch (outcome.status) {
        case 'updated':
          res.json({ lead: outcome.lead, activities: outcome.activities, requestId: req.id });
          return;
        case 'invalid_field':
          sendDomainError(res, req.id, 'validation_error', 400, { field: outcome.field });
          return;
        case 'not_found':
          sendDomainError(res, req.id, 'lead_not_found', 404);
          return;
        case 'trashed':
          sendDomainError(res, req.id, 'lead_trashed', 409);
          return;
        case 'invalid_stage':
          sendDomainError(res, req.id, 'validation_error', 400, { field: 'stage' });
          return;
        case 'assignee_not_found':
          sendDomainError(res, req.id, 'assignee_not_found', 422);
          return;
      }
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  for (const [path, trashed] of [
    ['trash', true],
    ['restore', false],
  ] as const) {
    router.post(`/workspaces/:workspaceId/leads/:leadId/${path}`, async (req, res) => {
      const params = uuidParams(req, res, 'leadId');
      if (!params) return;
      try {
        const { actor, decision } = await decide(req, params.workspaceId, 'lead.manage');
        if (!decision.allowed) {
          sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
          return;
        }
        const store = leadWork(req, res);
        if (!store) return;
        const outcome = await store.setTrashed({
          workspaceId: params.workspaceId,
          actorId: actor.actorId,
          requestId: req.id,
          leadId: params.id,
          trashed,
        });
        if (outcome.status === 'not_found') {
          sendDomainError(res, req.id, 'lead_not_found', 404);
          return;
        }
        res.json({ lead: outcome.lead, activity: outcome.activity, requestId: req.id });
      } catch (error) {
        reportFailure(req, error);
        sendStaffAuthError(res, req.id, 'internal_error', 500);
      }
    });
  }

  // The lead page reports that someone who works leads opened the lead, which
  // clears its "New" badge for the whole team. Only the first open writes.
  router.post('/workspaces/:workspaceId/leads/:leadId/opened', async (req, res) => {
    const params = uuidParams(req, res, 'leadId');
    if (!params) return;
    try {
      const { actor, decision } = await decide(req, params.workspaceId, 'lead.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const outcome = await store.markOpened({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requestId: req.id,
        leadId: params.id,
      });
      if (outcome.status === 'not_found') {
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      res.json({ activity: outcome.activity, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // An owner opening a customer's SIN for the credit check. Audited in the
  // transaction that reads it, and never cached anywhere on the way back.
  router.post(
    '/workspaces/:workspaceId/leads/:leadId/identities/:identityId/reveal',
    async (req, res) => {
      res.setHeader('cache-control', 'private, no-store');
      const params = uuidParams(req, res, 'leadId');
      if (!params) return;
      const identityId = z.uuid().safeParse(req.params['identityId']);
      if (!identityId.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      try {
        const { actor, decision } = await decide(req, params.workspaceId, 'sensitive.reveal');
        if (!decision.allowed) {
          sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
          return;
        }
        const store = dependencies.identityStore;
        if (!store) {
          sendDomainError(res, req.id, 'feature_not_ready', 409);
          return;
        }
        const outcome = await store.revealSin({
          workspaceId: params.workspaceId,
          actorId: actor.actorId,
          requestId: req.id,
          leadId: params.id,
          identityId: identityId.data,
        });
        if (outcome.status === 'revealed') {
          res.json({ sin: outcome.sin, requestId: req.id });
          return;
        }
        if (outcome.status === 'not_found') {
          sendDomainError(res, req.id, 'identity_not_found', 404);
          return;
        }
        // Sealed under another key: the key was changed, which loses every SIN.
        reportFailure(req, new Error('sealed identity cannot be opened'));
        sendStaffAuthError(res, req.id, 'internal_error', 500);
      } catch (error) {
        reportFailure(req, error);
        sendStaffAuthError(res, req.id, 'internal_error', 500);
      }
    },
  );

  router.post('/workspaces/:workspaceId/leads/:leadId/notes', async (req, res) => {
    const params = uuidParams(req, res, 'leadId');
    if (!params) return;
    const body = createLeadNoteRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, params.workspaceId, 'lead.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const outcome = await store.addNote({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requestId: req.id,
        leadId: params.id,
        body: body.data.body,
      });
      if (outcome.status === 'not_found') {
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      if (outcome.status === 'trashed') {
        sendDomainError(res, req.id, 'lead_trashed', 409);
        return;
      }
      res.status(201).json({ activity: outcome.activity, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/leads/:leadId/tasks', async (req, res) => {
    const params = uuidParams(req, res, 'leadId');
    if (!params) return;
    const body = createLeadTaskRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, params.workspaceId, 'lead.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const outcome = await store.createTask({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requestId: req.id,
        leadId: params.id,
        title: body.data.title,
        dueAt: body.data.dueAt,
        assignedActorId: body.data.assignedActorId,
      });
      sendTaskOutcome(req, res, outcome, true);
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.patch('/workspaces/:workspaceId/tasks/:taskId', async (req, res) => {
    const params = uuidParams(req, res, 'taskId');
    if (!params) return;
    const body = updateLeadTaskRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, params.workspaceId, 'lead.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const outcome = await store.updateTask({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requestId: req.id,
        taskId: params.id,
        ...body.data,
      });
      sendTaskOutcome(req, res, outcome, false);
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/tasks', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = listWorkspaceTasksQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      // Task titles name people and what was agreed with them.
      const access = leadAccessOf(decision.access);
      if (!access.contacts) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const page = query.data.page ?? 1;
      const pageSize = query.data.pageSize ?? 50;
      const result = await store.listTasks(
        {
          workspaceId: workspaceId.data,
          actorId: actor.actorId,
          assignee: query.data.assignee ?? 'me',
          status: query.data.status ?? 'open',
          dueBy: query.data.dueBy,
        },
        page,
        pageSize,
      );
      res.json({
        tasks: result.tasks,
        page: { page, pageSize, total: result.total },
        access,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  /** Active staff members of this workspace, for the assignment controls. */
  router.get('/workspaces/:workspaceId/members', async (req, res) => {
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
      const members = await dependencies.store.listAssignableMembers(
        workspaceId.data,
        actor.actorId,
      );
      res.json({ members, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/jobs', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const actor = session(req);
      const decision = await authorize({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        action: 'workspace.read',
      });
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.jobStore) {
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }
      const { jobs, total } = await dependencies.jobStore.listActive(
        workspaceId.data,
        actor.actorId,
      );
      const retryDecision = await authorize({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        action: 'integration.manage',
      });
      res.json({
        jobs: jobs.map((job) => ({
          ...job,
          availableAt: job.availableAt.toISOString(),
          leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        })),
        total,
        canRetry: retryDecision.allowed,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/jobs/:jobId/retry', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const jobId = z.uuid().safeParse(req.params['jobId']);
    if (!workspaceId.success || !jobId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.jobStore) {
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }
      const outcome = await dependencies.jobStore.retry({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        jobId: jobId.data,
        requestId: req.id,
      });
      if (outcome === 'not_found') {
        sendDomainError(res, req.id, 'job_not_found', 404);
        return;
      }
      if (outcome === 'not_failed') {
        sendDomainError(res, req.id, 'job_not_retryable', 409);
        return;
      }
      res.json({ jobId: jobId.data, status: 'pending', requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // Staff record whether an uncertain job reached the provider.
  router.post('/workspaces/:workspaceId/jobs/:jobId/resolve', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const jobId = z.uuid().safeParse(req.params['jobId']);
    const body = resolveUncertainJobRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !jobId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.jobStore) {
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }
      const outcome = await dependencies.jobStore.resolveUncertain({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        jobId: jobId.data,
        requestId: req.id,
        delivered: body.data.delivered,
      });
      if (outcome === 'not_found') {
        sendDomainError(res, req.id, 'job_not_found', 404);
        return;
      }
      if (outcome === 'not_uncertain') {
        sendDomainError(res, req.id, 'job_not_uncertain', 409);
        return;
      }
      res.json({ jobId: jobId.data, status: outcome, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/invitations', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = inviteStaffRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'staff.invite');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const membershipId = await dependencies.store.inviteStaff({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        normalizedEmail: body.data.email.trim().toLowerCase(),
        roleNames: body.data.roles,
        requestId: req.id,
      });
      res.status(201).json({ membershipId, status: 'pending', requestId: req.id });
    } catch (error) {
      if (!isUniqueViolation(error)) reportFailure(req, error);
      sendStaffAuthError(
        res,
        req.id,
        isUniqueViolation(error) ? 'membership_conflict' : 'internal_error',
        isUniqueViolation(error) ? 409 : 500,
      );
    }
  });

  router.delete('/workspaces/:workspaceId/memberships/:membershipId', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const membershipId = z.uuid().safeParse(req.params['membershipId']);
    if (!workspaceId.success || !membershipId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'staff.remove');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const result = await dependencies.store.revokeStaff({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        membershipId: membershipId.data,
        requestId: req.id,
      });
      if (result === 'not_found') {
        sendStaffAuthError(res, req.id, 'membership_not_found', 404);
        return;
      }
      if (result === 'self') {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      res.json({ membershipId: membershipId.data, status: 'revoked', requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/service-credentials', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = createServiceCredentialRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      // The plaintext secret exists only in this response; only its hash persists.
      const { secret, secretHash } = generateServiceSecret();
      const record = await dependencies.credentialStore.createCredential({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        scopes: body.data.scopes,
        secretHash,
        requestId: req.id,
      });
      res.status(201).json({ credential: credentialSummary(record), secret, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/service-credentials', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const records = await dependencies.credentialStore.listCredentials({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
      });
      res.json({ credentials: records.map(credentialSummary), requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.delete('/workspaces/:workspaceId/service-credentials/:credentialId', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const credentialId = z.uuid().safeParse(req.params['credentialId']);
    if (!workspaceId.success || !credentialId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const result = await dependencies.credentialStore.revokeCredential({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        credentialId: credentialId.data,
        requestId: req.id,
      });
      if (result.status === 'not_found') {
        sendWebsiteError(res, req.id, 'credential_not_found', 404);
        return;
      }
      // Idempotent: revoking an already-revoked credential returns its first revocation time.
      res.json({ id: credentialId.data, revokedAt: result.revokedAt, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // ---- Documents -----------------------------------------------------------
  // Downloading an original requires the separately-grantable
  // `document.download` permission; approve/reject is a lead-management action.

  router.post('/workspaces/:workspaceId/files/:fileId/review', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const fileId = z.uuid().safeParse(req.params['fileId']);
    const body = reviewFileRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !fileId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'order.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.documentService) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const outcome = await dependencies.documentService.review({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        requestId: req.id,
        fileId: fileId.data,
        decision: body.data.decision,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      if (outcome.status === 'not_found') {
        sendDomainError(res, req.id, 'file_not_found', 404);
        return;
      }
      res.json({ file: toStaffFile(outcome.file), requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/files/:fileId/download-link', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const fileId = z.uuid().safeParse(req.params['fileId']);
    if (!workspaceId.success || !fileId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      // Download of an original is gated on the explicit document.download
      // permission — not merely workspace membership.
      const { actor, decision } = await decide(req, workspaceId.data, 'document.download');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.documentService) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const outcome = await dependencies.documentService.issueDownload({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        fileId: fileId.data,
        requestId: req.id,
      });
      if (outcome.status === 'issued') {
        res.json({
          url: outcome.url,
          expiresAt: outcome.expiresAt.toISOString(),
          requestId: req.id,
        });
        return;
      }
      if (outcome.status === 'not_available') {
        sendDomainError(res, req.id, 'file_not_available', 409);
        return;
      }
      sendDomainError(res, req.id, 'file_not_found', 404);
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  return router;
}
