import { Router, type Request, type Response } from 'express';
import {
  DEFAULT_EMAIL_BRAND_COLOR,
  createEmailTemplateRequestSchema,
  emailTemplateKeySchema,
  emailTemplateLabel,
  isSiteTemplateKey,
  listEmailTemplatesQuerySchema,
  previewEmailTemplateRequestSchema,
  updateEmailSettingsRequestSchema,
  updateEmailTemplateRequestSchema,
  type EmailSettings,
  type EmailSettingsResponse,
  type PropertyCatalog,
  type SiteEmailTemplate,
} from '@gt-sales/contracts';
import type { DatabaseClient, TenantContext } from '@gt-sales/db';
import { z } from 'zod';

import { composeCustomerEmail } from '../email/compose.js';
import { sampleFillInValues } from '../email/fill-in-values.js';
import { renderCustomerEmail, type EmailBranding } from '../email/layout.js';
import { templatePropertyKeys } from '../email/markup.js';
import { queueComposedEmail } from '../email/queue.js';
import type { CustomerEmail } from '../email/senders.js';
import type {
  EmailSettingsStore,
  ListedEmailTemplate,
  StoredEmailSettings,
} from '../email/settings-store.js';
import type { MarkupError } from '../email/markup.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { denyReasonOf } from '../staff/authorization.js';
import type { Scope, WriteScope } from '../tenant-scope.js';
import type { PlanRouteDependencies } from './plans.js';

export interface EmailSettingsRouteDependencies {
  store: EmailSettingsStore;
  customerEmail: CustomerEmail;
  withTenantTx: DatabaseClient['withTenantTx'];
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
  /**
   * The site's property catalogue, read only for a site-made template (its
   * `{prop:…}` fill-ins); absent, the store reads it itself and a preview shows
   * the key.
   */
  loadCatalog?: (ctx: TenantContext) => Promise<PropertyCatalog>;
}

const toSettings = (stored: StoredEmailSettings): EmailSettings => ({
  ...stored,
  updatedAt: stored.updatedAt.toISOString(),
});

/** A template as Settings → Email shows it: a built-in by its label, a site-made one by its name. */
const toTemplate = (stored: ListedEmailTemplate): SiteEmailTemplate => ({
  key: stored.key,
  name: emailTemplateLabel(stored.key, stored.name),
  subject: stored.subject,
  body: stored.body,
  version: stored.version,
  updatedAt: stored.updatedAt?.toISOString() ?? null,
  updatedBy: stored.updatedBy,
  archived: stored.archived,
  usedBy: stored.usedBy,
});

/** `YYYYMMDDHHmm` in UTC: one test mail per template, staff member and minute. */
function minuteStamp(at: Date): string {
  return at.toISOString().slice(0, 16).replace(/\D/g, '');
}

/**
 * Settings → Email, under `/workspaces/:workspaceId/email`: the site's sender
 * and look, its nine built-in templates and the ones it made (`tpl_…`, at most
 * 50 not archived), a preview of unsaved words and a test mail to the
 * signed-in staff member. Every route needs `integration.manage` (owner); a
 * template key in the path is checked after the permission. The preview
 * renders sample values and never reads a lead.
 */
export function createEmailSettingsRoutes(dependencies: EmailSettingsRouteDependencies): Router {
  const router = Router();
  const { store, customerEmail } = dependencies;

  function failed(req: Request, res: Response, error: unknown): void {
    dependencies.reportFailure(req, error);
    sendStaffAuthError(res, req.id, 'internal_error', 500);
  }

  /** The caller's write scope when allowed `integration.manage` on the site, or the 403 already sent. */
  async function allowedScope(
    req: Request,
    res: Response,
    workspaceId: string,
  ): Promise<{ scope: WriteScope; verifiedEmail: string } | undefined> {
    const { actor, decision } = await dependencies.decide(req, workspaceId, 'integration.manage');
    if (!decision.allowed) {
      sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
      return undefined;
    }
    return {
      scope: { workspaceId, actorId: actor.actorId, requestId: req.id },
      verifiedEmail: actor.verifiedEmail,
    };
  }

  function settingsResponse(
    req: Request,
    saved: StoredEmailSettings | undefined,
  ): EmailSettingsResponse {
    return {
      settings: saved ? toSettings(saved) : null,
      requestId: req.id,
    };
  }

  const workspaceIdOf = (req: Request) => z.uuid().safeParse(req.params['workspaceId']);
  const templateKeyOf = (req: Request) => emailTemplateKeySchema.safeParse(req.params['key']);

  /** The catalogue a site-made template is checked against, when the router has one. */
  async function catalogFor(scope: Scope, key: string): Promise<PropertyCatalog | undefined> {
    if (!isSiteTemplateKey(key) || !dependencies.loadCatalog) return undefined;
    return dependencies.loadCatalog(scope);
  }

  function sendMarkupError(req: Request, res: Response, problem: MarkupError): void {
    if (problem.error === 'invalid_fill_in') {
      sendDomainError(res, req.id, 'invalid_fill_in', 400, {
        fillIn: problem.fillIn,
        where: problem.where,
      });
    } else {
      sendDomainError(res, req.id, 'invalid_email_markup', 400, { reason: problem.reason });
    }
  }

  router.get('/workspaces/:workspaceId/email/settings', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      res.json(settingsResponse(req, await store.getSettings(scope)));
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.put('/workspaces/:workspaceId/email/settings', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = updateEmailSettingsRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      res.json(settingsResponse(req, await store.putSettings(scope, body.data)));
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get('/workspaces/:workspaceId/email/templates', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const query = listEmailTemplatesQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      if (query.data.archived === '1') {
        const page = await store.listArchivedTemplates(scope, {
          ...(query.data.before ? { before: query.data.before } : {}),
        });
        res.json({
          templates: page.templates.map(toTemplate),
          nextBefore: page.nextBefore,
          requestId: req.id,
        });
        return;
      }
      const templates = await store.listTemplates(scope);
      res.json({ templates: templates.map(toTemplate), nextBefore: null, requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post('/workspaces/:workspaceId/email/templates', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = createEmailTemplateRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      const catalog = dependencies.loadCatalog ? await dependencies.loadCatalog(scope) : undefined;
      const outcome = await store.createTemplate(scope, body.data, catalog);
      switch (outcome.kind) {
        case 'saved':
          res.status(201).json({ template: toTemplate(outcome.template), requestId: req.id });
          return;
        case 'limit_reached':
          sendDomainError(res, req.id, 'email_template_limit_reached', 409);
          return;
        case 'invalid':
          sendMarkupError(req, res, outcome);
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  for (const [action, archived] of [
    ['archive', true],
    ['restore', false],
  ] as const) {
    router.post(`/workspaces/:workspaceId/email/templates/:key/${action}`, async (req, res) => {
      const workspaceId = workspaceIdOf(req);
      const key = templateKeyOf(req);
      if (!workspaceId.success) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      try {
        const allowed = await allowedScope(req, res, workspaceId.data);
        if (!allowed) return;
        if (!key.success) {
          sendDomainError(res, req.id, 'email_template_not_found', 404);
          return;
        }
        const outcome = await store.setTemplateArchived(allowed.scope, key.data, archived);
        switch (outcome.kind) {
          case 'saved':
            res.json({ template: toTemplate(outcome.template), requestId: req.id });
            return;
          case 'not_found':
            sendDomainError(res, req.id, 'email_template_not_found', 404);
            return;
          case 'builtin':
            sendDomainError(res, req.id, 'email_template_builtin', 409);
            return;
          case 'limit_reached':
            sendDomainError(res, req.id, 'email_template_limit_reached', 409);
            return;
        }
      } catch (error) {
        failed(req, res, error);
      }
    });
  }

  router.put('/workspaces/:workspaceId/email/templates/:key', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const key = templateKeyOf(req);
    const body = updateEmailTemplateRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      if (!key.success) {
        sendDomainError(res, req.id, 'email_template_not_found', 404);
        return;
      }
      const catalog = await catalogFor(scope, key.data);
      const outcome = catalog
        ? await store.putTemplate(scope, key.data, body.data, catalog)
        : await store.putTemplate(scope, key.data, body.data);
      switch (outcome.kind) {
        case 'saved':
          res.json({ template: toTemplate(outcome.template), requestId: req.id });
          return;
        case 'not_found':
          sendDomainError(res, req.id, 'email_template_not_found', 404);
          return;
        case 'version_conflict':
          sendDomainError(res, req.id, 'version_conflict', 409);
          return;
        case 'invalid':
          sendMarkupError(req, res, outcome);
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  /** The look the site's mails have: its saved settings, else the deployment's sender, else a plain default. */
  async function previewLook(scope: Scope): Promise<{
    branding: EmailBranding;
    siteUrl: string | null;
  }> {
    const saved = await store.getSettings(scope);
    if (saved) {
      return {
        branding: {
          siteName: saved.fromName,
          logoUrl: saved.logoUrl,
          brandColor: saved.brandColor,
          footerText: saved.footerText,
        },
        siteUrl: saved.siteUrl,
      };
    }
    return {
      branding: {
        siteName: 'Your site',
        logoUrl: null,
        brandColor: DEFAULT_EMAIL_BRAND_COLOR,
        footerText: '',
      },
      siteUrl: null,
    };
  }

  router.post('/workspaces/:workspaceId/email/templates/:key/preview', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const key = templateKeyOf(req);
    const body = previewEmailTemplateRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      if (!key.success) {
        sendDomainError(res, req.id, 'email_template_not_found', 404);
        return;
      }
      const { branding, siteUrl } = await previewLook(scope);
      // A site-made template's properties show as their label in brackets.
      const propertyKeys = isSiteTemplateKey(key.data)
        ? templatePropertyKeys(body.data.subject, body.data.body)
        : [];
      const catalog = propertyKeys.length > 0 ? await catalogFor(scope, key.data) : undefined;
      const props = Object.fromEntries(
        propertyKeys.map((property) => [
          property,
          `[${catalog?.get(property)?.label ?? property}]`,
        ]),
      );
      const rendered = renderCustomerEmail({
        template: key.data,
        subject: body.data.subject,
        body: body.data.body,
        branding,
        values: {
          ...sampleFillInValues({ siteName: branding.siteName, siteUrl }),
          ...(propertyKeys.length > 0 ? { props } : {}),
        },
      });
      if (rendered.ok) {
        const { subject, html, text } = rendered;
        res.json({ subject, html, text, requestId: req.id });
        return;
      }
      if ('missing' in rendered) {
        // The samples have a value for every fill-in: this is a bug, not the editor's words.
        throw new Error('the sample values leave a fill-in empty');
      }
      sendMarkupError(req, res, rendered);
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post('/workspaces/:workspaceId/email/templates/:key/test', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const key = templateKeyOf(req);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      if (!key.success) {
        sendDomainError(res, req.id, 'email_template_not_found', 404);
        return;
      }
      const template = key.data;
      const toAddress = allowed.verifiedEmail;
      const dedupeKey = `test:${template}:${scope.actorId}:${minuteStamp(new Date())}`;
      const result = await dependencies.withTenantTx(scope, async (tx) => {
        const composed = await composeCustomerEmail(tx, customerEmail.environment, {
          workspaceId: scope.workspaceId,
          template,
          recipient: { kind: 'staff_test', toAddress },
        });
        if (composed.kind !== 'ready') return composed;
        const queued = await queueComposedEmail(tx, {
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
          requestId: scope.requestId,
          leadId: null,
          dedupeKey,
          payload: composed.payload,
          automation: null,
        });
        return { kind: 'queued' as const, queued: queued.queued };
      });
      if (result.kind === 'queued') {
        res.status(202).json({ queued: result.queued, requestId: req.id });
        return;
      }
      if (result.reason === 'no_sender') {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      if (result.reason === 'template_unavailable') {
        sendDomainError(res, req.id, 'email_template_not_found', 404);
        return;
      }
      if (result.reason === 'missing_fill_in' && isSiteTemplateKey(template)) {
        // The sample values have no property values: a site-made template that
        // shows properties is tried on a real lead, not as a test.
        sendDomainError(res, req.id, 'feature_not_ready', 409, { reason: 'property_fill_ins' });
        return;
      }
      // Sample values fill every fill-in and the address is the verified one.
      throw new Error(`the test mail was skipped: ${result.reason}`);
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
