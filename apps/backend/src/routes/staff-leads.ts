import { Router, type Request, type Response } from 'express';
import {
  allowedStageMoves,
  areValidLeadColumns,
  areValidLeadPropertyFilters,
  isValidLeadSort,
  parseLeadSort,
  createLeadNoteRequestSchema,
  createLeadTaskRequestSchema,
  createPlainTaskRequestSchema,
  leadBoardQuerySchema,
  searchLeadBoardRequestSchema,
  searchWorkspaceLeadsRequestSchema,
  type LeadBoardQuery,
  type ListWorkspaceLeadsQuery,
  leadStatsQuerySchema,
  leadsSummaryQuerySchema,
  listWorkspaceLeadsQuerySchema,
  listWorkspaceTasksQuerySchema,
  queueCustomerEmailRequestSchema,
  updateLeadTaskRequestSchema,
  updateWorkspaceLeadRequestSchema,
  resolveChangeRequestRequestSchema,
  type LeadDetail,
  type LeadListItem,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { z } from 'zod';
import { sendLeadUpdateRefusal } from '../http/lead-update-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendDomainError } from '../http/domain-errors.js';
import { type LeadWorkStore, type TaskOutcome } from '../leads/work-store.js';
import { decideAccess, denyReasonOf, type StaffAccessSnapshot } from '../staff/authorization.js';
import { moneyVisibilityOf } from '../staff/lead-visibility.js';
import { leadAccessOf, type StaffRouteContext } from './staff-context.js';

/**
 * Staff lead work under `/workspaces/:workspaceId`: the leads list, summary,
 * stats and board, a lead's page and its changes (stage, assignee, values,
 * change-request decisions), notes, customer mail and tasks.
 */
export function createStaffLeadRoutes(context: StaffRouteContext): Router {
  const { dependencies, decide, reportFailure, propertyStore, replyAddressing } = context;
  const router = Router();

  /** The site's property catalogue, read once per request after the caller is authorized. */
  function siteCatalog(
    req: Request,
    workspaceId: string,
    actorId: string,
  ): Promise<PropertyCatalog> {
    return propertyStore.catalog({ workspaceId, actorId, requestId: req.id });
  }

  // The countdown date comes from the form, which these roles never see; a
  // row's property columns carry form and custom values alike. The contact ID
  // also links requests for the same person, which is contact data.
  function withoutContact(lead: LeadListItem): LeadListItem {
    const { properties: _properties, ...rest } = lead;
    return { ...rest, contact: {}, contactId: null, countdownDate: null };
  }

  /**
   * The lead as a caller without `revenue.view` sees it: the frozen plan's
   * commission left out of its order details (the key, not a null).
   */
  function withMoneyFor(access: StaffAccessSnapshot, lead: LeadDetail): LeadDetail {
    if (moneyVisibilityOf(access).revenue || !lead.order?.plan) return lead;
    const { commission: _commission, ...plan } = lead.order.plan;
    return { ...lead, order: { ...lead.order, plan } };
  }

  // Custom values and the order travel with contact visibility, as the form does.
  function withoutPersonalDetails(lead: LeadDetail): LeadDetail {
    const { customValues: _customValues, order: _order, ...rest } = lead;
    return { ...withoutContact(rest), form: null };
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

  /**
   * The leads list, for the `GET` (filters in the query string) and for the
   * searched `POST` (the same filters and the search text in the body, so a
   * customer's name, email or phone is never in a URL: issue #83).
   */
  async function sendLeadList(
    req: Request,
    res: Response,
    workspaceId: string,
    filters: ListWorkspaceLeadsQuery & { q?: string },
  ): Promise<void> {
    try {
      const { actor, decision } = await decide(req, workspaceId, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const access = leadAccessOf(decision.access);
      const parsedSort = filters.sort ? parseLeadSort(filters.sort) : undefined;
      // Searching, filtering, sorting by name or a property, or requesting
      // property columns reveals contact or form details these roles never see,
      // whatever the keys: refused before the catalogue is read.
      if (
        !access.contacts &&
        (filters.q !== undefined ||
          filters.where !== undefined ||
          filters.columns !== undefined ||
          parsedSort?.field === 'fullName' ||
          parsedSort?.propertyKey !== undefined)
      ) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      // Filters, sort and columns name the site's properties, as it defines them now.
      const catalog = await siteCatalog(req, workspaceId, actor.actorId);
      if (
        (filters.where !== undefined &&
          !areValidLeadPropertyFilters(filters.where, filters.type, catalog)) ||
        (filters.sort !== undefined && !isValidLeadSort(filters.sort, filters.type, catalog)) ||
        (filters.columns !== undefined &&
          !areValidLeadColumns(filters.columns, filters.type, catalog))
      ) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }

      const result = await dependencies.leadStore.listLeads({
        workspaceId: workspaceId,
        actorId: actor.actorId,
        status: filters.status,
        leadType: filters.type,
        stage: filters.stage,
        assignee: filters.assignee,
        search: filters.q,
        view: filters.view,
        dueBy: filters.dueBy,
        where: filters.where,
        sort: filters.sort,
        columns: filters.columns,
        catalog,
        page: filters.page,
        pageSize: filters.pageSize,
      });
      const leads = access.contacts ? result.leads : result.leads.map(withoutContact);
      res.json({ leads, page: result.page, access, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  }

  router.get('/workspaces/:workspaceId/leads', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = listWorkspaceLeadsQuerySchema.safeParse(req.query);
    // A search in the query string is refused, not ignored: an unfiltered list would look like its answer.
    if (!workspaceId.success || !query.success || req.query['q'] !== undefined) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    await sendLeadList(req, res, workspaceId.data, query.data);
  });

  // Registered before the `/leads/:leadId/…` posts so the literal segment wins.
  router.post('/workspaces/:workspaceId/leads/search', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = searchWorkspaceLeadsRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    await sendLeadList(req, res, workspaceId.data, body.data);
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
      res.json({
        ...summary,
        // `trash` is the deprecated twin of `archived`: the same number.
        trash: summary.archived,
        access: leadAccessOf(decision.access),
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // Counts only (no lead, no contact), so every role that reads the site may see them.
  router.get('/workspaces/:workspaceId/leads/stats', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = leadStatsQuerySchema.safeParse(req.query);
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
      const stats = await store.stats({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        leadType: query.data.leadType,
        days: query.data.days,
      });
      res.json({
        leadType: query.data.leadType,
        days: query.data.days ?? null,
        ...stats,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  /** The board, for the `GET` and for the searched `POST` (as `sendLeadList`). */
  async function sendLeadBoard(
    req: Request,
    res: Response,
    workspaceId: string,
    filters: LeadBoardQuery & { q?: string },
  ): Promise<void> {
    try {
      const { actor, decision } = await decide(req, workspaceId, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const access = leadAccessOf(decision.access);
      if (!access.contacts && (filters.q !== undefined || filters.where !== undefined)) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      const catalog = await siteCatalog(req, workspaceId, actor.actorId);
      if (
        filters.where !== undefined &&
        !areValidLeadPropertyFilters(filters.where, filters.type, catalog)
      ) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const columns = await store.board(
        {
          workspaceId: workspaceId,
          actorId: actor.actorId,
          leadType: filters.type,
          assignee: filters.assignee,
          search: filters.q,
          where: filters.where,
          catalog,
        },
        filters.perStage ?? 50,
      );
      res.json({
        leadType: filters.type,
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
  }

  router.get('/workspaces/:workspaceId/leads/board', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = leadBoardQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success || req.query['q'] !== undefined) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    await sendLeadBoard(req, res, workspaceId.data, query.data);
  });

  router.post('/workspaces/:workspaceId/leads/board/search', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = searchLeadBoardRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    await sendLeadBoard(req, res, workspaceId.data, body.data);
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
      const access = {
        ...leadAccessOf(decision.access),
        emailCustomer:
          decideAccess(decision.access, 'lead.manage').allowed &&
          ((await dependencies.customerEmail?.available({
            workspaceId: params.workspaceId,
            actorId: actor.actorId,
          })) ??
            false),
        emailReplies: replyAddressing?.enabledFor(params.workspaceId) ?? false,
        downloadDocuments: decideAccess(decision.access, 'document.download').allowed,
        reviewDocuments: decideAccess(decision.access, 'order.manage').allowed,
        overrideDocuments: decideAccess(decision.access, 'order.override').allowed,
        decideChanges: decideAccess(decision.access, 'lead.manage').allowed,
      };
      // Form details, notes and tasks carry personal details as freely as
      // the contact fields do, so they travel only with contact visibility.
      const result = await store.getLead({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        leadId: params.id,
        includeWork: access.contacts,
        catalog: await siteCatalog(req, params.workspaceId, actor.actorId),
      });
      if (!result) {
        sendDomainError(res, req.id, 'lead_not_found', 404);
        return;
      }
      res.json({
        lead: access.contacts
          ? withMoneyFor(decision.access, result.lead)
          : withoutPersonalDetails(result.lead),
        activities: result.activities,
        tasks: result.tasks,
        allowedMoves: allowedStageMoves(result.lead.leadType, result.lead.stage),
        // Which requests belong to one person is personal data as well.
        related: access.contacts ? result.related : [],
        identities: access.contacts ? result.identities : [],
        documents: access.contacts ? result.documents : [],
        // The customer's own values: with contact visibility only.
        changeRequest: access.contacts ? result.changeRequest : null,
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
      // Only the owner and Orders members may move an order on without its
      // documents approved; refused before the store is asked.
      if (
        body.data.documentsOverrideReason !== undefined &&
        !decideAccess(decision.access, 'order.override').allowed
      ) {
        sendDomainError(res, req.id, 'documents_override_not_allowed', 409);
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
        expectedContact: body.data.expectedContact,
        form: body.data.form,
        customValues: body.data.customValues,
        order: body.data.order,
        documentsOverrideReason: body.data.documentsOverrideReason,
        catalog: await siteCatalog(req, params.workspaceId, actor.actorId),
      });
      if (outcome.status !== 'updated') {
        sendLeadUpdateRefusal(res, req.id, outcome);
        return;
      }
      res.json({
        lead: withMoneyFor(decision.access, outcome.lead),
        activities: outcome.activities,
        allowedMoves: allowedStageMoves(outcome.lead.leadType, outcome.lead.stage),
        ...(outcome.emailSkipped ? { emailSkipped: outcome.emailSkipped } : {}),
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // A customer's change request (Get Canada Sim's `/track`): staff who work
  // leads approve it, applying the values as their own edit, or reject it.
  for (const decision of ['approve', 'reject'] as const) {
    router.post(
      `/workspaces/:workspaceId/leads/:leadId/change-requests/:changeRequestId/${decision}`,
      async (req, res) => {
        const params = uuidParams(req, res, 'leadId');
        if (!params) return;
        const changeRequestId = z.uuid().safeParse(req.params['changeRequestId']);
        const body = resolveChangeRequestRequestSchema.safeParse(req.body);
        if (!changeRequestId.success || !body.success) {
          sendStaffAuthError(res, req.id, 'invalid_request', 400);
          return;
        }
        try {
          const { actor, decision: allowed } = await decide(req, params.workspaceId, 'lead.manage');
          if (!allowed.allowed) {
            sendStaffAuthError(res, req.id, denyReasonOf(allowed), 403);
            return;
          }
          const service = dependencies.changeRequests;
          if (!service) {
            reportFailure(req, new Error('change request service is not configured'));
            sendStaffAuthError(res, req.id, 'internal_error', 500);
            return;
          }
          const input = {
            workspaceId: params.workspaceId,
            actorId: actor.actorId,
            requestId: req.id,
            leadId: params.id,
            changeRequestId: changeRequestId.data,
            expectedVersion: body.data.expectedVersion,
            catalog: await siteCatalog(req, params.workspaceId, actor.actorId),
          };
          const outcome =
            decision === 'approve' ? await service.approve(input) : await service.reject(input);
          switch (outcome.status) {
            case 'approved':
            case 'rejected':
              res.json({
                lead: withMoneyFor(allowed.access, outcome.lead),
                activities: outcome.activities,
                allowedMoves: allowedStageMoves(outcome.lead.leadType, outcome.lead.stage),
                ...(outcome.emailSkipped ? { emailSkipped: outcome.emailSkipped } : {}),
                requestId: req.id,
              });
              return;
            case 'not_found':
              sendDomainError(res, req.id, 'change_request_not_found', 404);
              return;
            case 'resolved':
              sendDomainError(res, req.id, 'change_request_resolved', 409);
              return;
            case 'version_conflict':
              sendDomainError(res, req.id, 'version_conflict', 409);
              return;
            case 'trashed':
              sendDomainError(res, req.id, 'lead_trashed', 409);
              return;
            case 'invalid_field':
              sendDomainError(res, req.id, 'validation_error', 400, { field: outcome.field });
              return;
          }
        } catch (error) {
          reportFailure(req, error);
          sendStaffAuthError(res, req.id, 'internal_error', 500);
        }
      },
    );
  }

  // `trash` is the old name of `archive`; both archive the lead with one handler.
  for (const [path, archived] of [
    ['archive', true],
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
        const outcome = await store.setArchived({
          workspaceId: params.workspaceId,
          actorId: actor.actorId,
          requestId: req.id,
          leadId: params.id,
          archived,
        });
        if (outcome.status === 'not_found') {
          sendDomainError(res, req.id, 'lead_not_found', 404);
          return;
        }
        res.json({
          lead: withMoneyFor(decision.access, outcome.lead),
          activity: outcome.activity,
          requestId: req.id,
        });
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

  // A mail to the lead's customer (a SIM order's number, or a message staff
  // wrote in the Mail tab), queued for the
  // outbox and sent from the site's own sender. Refused while the site cannot
  // send, so staff learn it now rather than from a failed job.
  router.post('/workspaces/:workspaceId/leads/:leadId/customer-emails', async (req, res) => {
    const params = uuidParams(req, res, 'leadId');
    if (!params) return;
    const body = queueCustomerEmailRequestSchema.safeParse(req.body);
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
      const mail = dependencies.customerEmail;
      if (
        !mail ||
        !(await mail.available({ workspaceId: params.workspaceId, actorId: actor.actorId }))
      ) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const scope = {
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requestId: req.id,
        leadId: params.id,
      };
      const outcome =
        'template' in body.data
          ? await store.queueCustomerEmail({ ...scope, template: body.data.template })
          : await store.queueWrittenEmail({
              ...scope,
              subject: body.data.subject,
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
      if (outcome.status === 'no_sender') {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      if (outcome.status === 'missing') {
        sendDomainError(res, req.id, 'conflict', 409, { missing: outcome.missing });
        return;
      }
      res.status(202).json({ activity: outcome.activity, requestId: req.id });
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

  // A plain task: work that belongs to no lead, with the lead task form's
  // checks and its permission (tasks are lead work, shown only to the roles
  // that see it). Audited like a lead's task; no lead, so no timeline entry.
  router.post('/workspaces/:workspaceId/tasks', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = createPlainTaskRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'lead.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const store = leadWork(req, res);
      if (!store) return;
      const outcome = store.createPlainTask
        ? await store.createPlainTask({
            workspaceId: workspaceId.data,
            actorId: actor.actorId,
            requestId: req.id,
            title: body.data.title,
            dueAt: body.data.dueAt,
            assignedActorId: body.data.assignedActorId,
          })
        : ({ status: 'unavailable' } as const);
      if (outcome.status !== 'saved') {
        if (outcome.status === 'unavailable')
          // Migration 0038 is not applied yet: a clean refusal, never a 500.
          sendDomainError(res, req.id, 'plain_tasks_unavailable', 503);
        else sendDomainError(res, req.id, 'assignee_not_found', 422);
        return;
      }
      res.status(201).json({ task: outcome.task, requestId: req.id });
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
          status: query.data.status ?? 'active',
          dueBy: query.data.dueBy,
          completedSince: query.data.completedSince,
          // Only a caller that asked: an older admin's list cannot read a plain task.
          includePlain: query.data.plain === 'include',
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

  return router;
}
