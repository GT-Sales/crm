import { Router, type Request, type Response } from 'express';
import {
  DEFAULT_EMAIL_BRAND_COLOR,
  customerEmailTemplateSchema,
  previewEmailTemplateRequestSchema,
  updateEmailSettingsRequestSchema,
  updateEmailTemplateRequestSchema,
  type CustomerEmailTemplate,
  type EmailSettings,
  type EmailSettingsResponse,
  type EmailTemplate,
} from '@gt-sales/contracts';
import type { DatabaseClient } from '@gt-sales/db';
import { z } from 'zod';

import { composeCustomerEmail } from '../email/compose.js';
import { sampleFillInValues } from '../email/fill-in-values.js';
import { renderCustomerEmail, type EmailBranding } from '../email/layout.js';
import { queueComposedEmail } from '../email/queue.js';
import type { CustomerEmail } from '../email/senders.js';
import type {
  EmailSettingsStore,
  StoredEmailSettings,
  StoredEmailTemplate,
} from '../email/settings-store.js';
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
}

const toSettings = (stored: StoredEmailSettings): EmailSettings => ({
  ...stored,
  updatedAt: stored.updatedAt.toISOString(),
});

const toTemplate = (stored: StoredEmailTemplate): EmailTemplate => ({
  ...stored,
  updatedAt: stored.updatedAt?.toISOString() ?? null,
});

/** `YYYYMMDDHHmm` in UTC: one test mail per template, staff member and minute. */
function minuteStamp(at: Date): string {
  return at.toISOString().slice(0, 16).replace(/\D/g, '');
}

/**
 * Settings → Email, under `/workspaces/:workspaceId/email`: the site's sender
 * and look, its seven templates, a preview of unsaved words and a test mail to
 * the signed-in staff member. Every route needs `integration.manage` (owner).
 * The preview renders sample values and never reads a lead.
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
  const templateKeyOf = (req: Request) => customerEmailTemplateSchema.safeParse(req.params['key']);

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
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedScope(req, res, workspaceId.data);
      if (!allowed) return;
      const { scope } = allowed;
      const templates = await store.listTemplates(scope);
      res.json({ templates: templates.map(toTemplate), requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

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
        sendDomainError(res, req.id, 'not_found', 404);
        return;
      }
      const outcome = await store.putTemplate(scope, key.data, body.data);
      switch (outcome.kind) {
        case 'saved':
          res.json({ template: toTemplate(outcome.template), requestId: req.id });
          return;
        case 'version_conflict':
          sendDomainError(res, req.id, 'version_conflict', 409);
          return;
        case 'invalid':
          if (outcome.error === 'invalid_fill_in') {
            sendDomainError(res, req.id, 'invalid_fill_in', 400, {
              fillIn: outcome.fillIn,
              where: outcome.where,
            });
          } else {
            sendDomainError(res, req.id, 'invalid_email_markup', 400, { reason: outcome.reason });
          }
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
        sendDomainError(res, req.id, 'not_found', 404);
        return;
      }
      const { branding, siteUrl } = await previewLook(scope);
      const rendered = renderCustomerEmail({
        template: key.data,
        subject: body.data.subject,
        body: body.data.body,
        branding,
        values: sampleFillInValues({ siteName: branding.siteName, siteUrl }),
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
      if (rendered.error === 'invalid_fill_in') {
        sendDomainError(res, req.id, 'invalid_fill_in', 400, {
          fillIn: rendered.fillIn,
          where: rendered.where,
        });
      } else {
        sendDomainError(res, req.id, 'invalid_email_markup', 400, { reason: rendered.reason });
      }
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
        sendDomainError(res, req.id, 'not_found', 404);
        return;
      }
      const template: CustomerEmailTemplate = key.data;
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
      // Sample values fill every fill-in and the address is the verified one.
      throw new Error(`the test mail was skipped: ${result.reason}`);
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
