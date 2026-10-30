import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  emailTemplates,
  emailTemplateVersions,
  workspaceEmailSettings,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  CUSTOMER_EMAIL_TEMPLATES,
  customerEmailTemplateSchema,
  type CustomerEmailTemplate,
  type UpdateEmailSettingsRequest,
  type UpdateEmailTemplateRequest,
} from '@gt-sales/contracts';

import { parseEmailBody, parseEmailSubject, type MarkupError } from './markup.js';
import { STARTER_TEMPLATES } from './starters.js';
import type { Scope, WriteScope } from '../tenant-scope.js';

/**
 * A site's customer email settings (Settings → Email: its sender and look)
 * and its nine templates. A template is content only, versioned: a site that
 * never saved one has its starter text at version 0, and each save writes
 * version + 1 and appends that version to `app.email_template_versions`, so a
 * sent mail's version always names the words it was rendered from. Audit
 * events carry the template key, its version and the names of the settings
 * that changed, never a subject, a body or an address.
 */

export interface StoredEmailSettings {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  logoUrl: string | null;
  brandColor: string;
  footerText: string;
  siteUrl: string | null;
  updatedAt: Date;
  updatedBy: string;
}

export interface StoredEmailTemplate {
  key: CustomerEmailTemplate;
  subject: string;
  body: string;
  /** 0 for the starter text, which is never saved. */
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export type PutTemplateOutcome =
  | { kind: 'saved'; template: StoredEmailTemplate }
  | { kind: 'version_conflict' }
  | ({ kind: 'invalid' } & MarkupError);

export interface EmailSettingsStore {
  getSettings(ctx: Scope): Promise<StoredEmailSettings | undefined>;
  /** Saves the whole form; audit `email.settings_updated` names the fields that changed. */
  putSettings(ctx: WriteScope, input: UpdateEmailSettingsRequest): Promise<StoredEmailSettings>;
  /** The nine, in CUSTOMER_EMAIL_TEMPLATES order; an unsaved one is its starter at version 0. */
  listTemplates(ctx: Scope): Promise<StoredEmailTemplate[]>;
  /** Saves `expectedVersion + 1` when that is still the stored version; audit `email.template_saved`. */
  putTemplate(
    ctx: WriteScope,
    key: CustomerEmailTemplate,
    input: UpdateEmailTemplateRequest,
  ): Promise<PutTemplateOutcome>;
}

type EmailSettingsDatabase = Pick<DatabaseClient, 'withTenantTx'>;
type SettingsRecord = typeof workspaceEmailSettings.$inferSelect;
type TemplateRecord = typeof emailTemplates.$inferSelect;

const AUDIT_ACTOR_LABEL = 'staff actor';

/** The settings the form saves, in the order an audit event lists the changed ones. */
const SETTINGS_FIELDS = [
  'fromName',
  'fromAddress',
  'replyTo',
  'logoUrl',
  'brandColor',
  'footerText',
  'siteUrl',
] as const;

const toSettings = (record: SettingsRecord): StoredEmailSettings => ({
  fromName: record.fromName,
  fromAddress: record.fromAddress,
  replyTo: record.replyTo,
  logoUrl: record.logoUrl,
  brandColor: record.brandColor,
  footerText: record.footerText,
  siteUrl: record.siteUrl,
  updatedAt: record.updatedAt,
  updatedBy: record.updatedBy,
});

const toTemplate = (record: TemplateRecord): StoredEmailTemplate => ({
  key: customerEmailTemplateSchema.parse(record.key),
  subject: record.subject,
  body: record.body,
  version: record.version,
  updatedAt: record.updatedAt,
  updatedBy: record.updatedBy,
});

const starter = (key: CustomerEmailTemplate): StoredEmailTemplate => ({
  key,
  subject: STARTER_TEMPLATES[key].subject,
  body: STARTER_TEMPLATES[key].body,
  version: 0,
  updatedAt: null,
  updatedBy: null,
});

/** The site's saved settings, or `undefined` until an owner saves them. */
export async function readEmailSettings(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<StoredEmailSettings | undefined> {
  const [record] = await tx
    .select()
    .from(workspaceEmailSettings)
    .where(eq(workspaceEmailSettings.workspaceId, workspaceId));
  return record ? toSettings(record) : undefined;
}

/** The site's current copy of `key`: the saved version, else the starter at version 0. */
export async function readEmailTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: CustomerEmailTemplate,
): Promise<StoredEmailTemplate> {
  const [record] = await tx
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.workspaceId, workspaceId), eq(emailTemplates.key, key)));
  return record ? toTemplate(record) : starter(key);
}

/** One save of a template at a time per site and key, so two editors cannot both write version n + 1. */
async function lockTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: CustomerEmailTemplate,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('email_templates:' || ${workspaceId}::text || ':' || ${key}::text, 0))`,
  );
}

/** The subject's or the body's first markup problem, as the parsers report it. */
function markupProblem(
  key: CustomerEmailTemplate,
  input: Pick<UpdateEmailTemplateRequest, 'subject' | 'body'>,
): MarkupError | undefined {
  const subject = parseEmailSubject(input.subject, key);
  if (!subject.ok) {
    const { ok: _ok, ...problem } = subject;
    return problem;
  }
  const body = parseEmailBody(input.body, key);
  if (!body.ok) {
    const { ok: _ok, ...problem } = body;
    return problem;
  }
  return undefined;
}

export class DatabaseEmailSettingsStore implements EmailSettingsStore {
  constructor(private readonly database: EmailSettingsDatabase = { withTenantTx }) {}

  getSettings(ctx: Scope): Promise<StoredEmailSettings | undefined> {
    return this.database.withTenantTx(ctx, (tx) => readEmailSettings(tx, ctx.workspaceId));
  }

  putSettings(ctx: WriteScope, input: UpdateEmailSettingsRequest): Promise<StoredEmailSettings> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const [existing] = await tx
        .select()
        .from(workspaceEmailSettings)
        .where(eq(workspaceEmailSettings.workspaceId, ctx.workspaceId))
        .for('update');
      const values = {
        fromName: input.fromName,
        fromAddress: input.fromAddress,
        replyTo: input.replyTo,
        logoUrl: input.logoUrl,
        brandColor: input.brandColor.toLowerCase(),
        footerText: input.footerText,
        siteUrl: input.siteUrl,
      };
      const [saved] = await tx
        .insert(workspaceEmailSettings)
        .values({ workspaceId: ctx.workspaceId, ...values, updatedBy: ctx.actorId })
        .onConflictDoUpdate({
          target: workspaceEmailSettings.workspaceId,
          set: { ...values, updatedBy: ctx.actorId, updatedAt: new Date() },
        })
        .returning();
      if (!saved) throw new Error('email settings upsert did not return a row');
      await tx.insert(auditEvents).values({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        actorLabel: AUDIT_ACTOR_LABEL,
        action: 'email.settings_updated',
        entity: 'email_settings',
        entityId: ctx.workspaceId,
        requestId: ctx.requestId,
        // The names of what changed only: the values include addresses.
        before: null,
        after: {
          fields: SETTINGS_FIELDS.filter((field) => existing?.[field] !== values[field]),
        },
      });
      return toSettings(saved);
    });
  }

  listTemplates(ctx: Scope): Promise<StoredEmailTemplate[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const records = await tx
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.workspaceId, ctx.workspaceId));
      const byKey = new Map(records.map((record) => [record.key, record]));
      return CUSTOMER_EMAIL_TEMPLATES.map((key) => {
        const record = byKey.get(key);
        return record ? toTemplate(record) : starter(key);
      });
    });
  }

  putTemplate(
    ctx: WriteScope,
    key: CustomerEmailTemplate,
    input: UpdateEmailTemplateRequest,
  ): Promise<PutTemplateOutcome> {
    return this.database.withTenantTx(ctx, async (tx): Promise<PutTemplateOutcome> => {
      await lockTemplate(tx, ctx.workspaceId, key);
      const current = await readEmailTemplate(tx, ctx.workspaceId, key);
      if (current.version !== input.expectedVersion) return { kind: 'version_conflict' };
      const problem = markupProblem(key, input);
      if (problem) return { kind: 'invalid', ...problem };

      const version = current.version + 1;
      const [saved] = await tx
        .insert(emailTemplates)
        .values({
          workspaceId: ctx.workspaceId,
          key,
          subject: input.subject,
          body: input.body,
          version,
          updatedBy: ctx.actorId,
        })
        .onConflictDoUpdate({
          target: [emailTemplates.workspaceId, emailTemplates.key],
          set: {
            subject: input.subject,
            body: input.body,
            version,
            updatedBy: ctx.actorId,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!saved) throw new Error('email template upsert did not return a row');
      await tx.insert(emailTemplateVersions).values({
        workspaceId: ctx.workspaceId,
        key,
        version,
        subject: input.subject,
        body: input.body,
        createdBy: ctx.actorId,
      });
      await tx.insert(auditEvents).values({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        actorLabel: AUDIT_ACTOR_LABEL,
        action: 'email.template_saved',
        entity: 'email_template',
        entityId: saved.id,
        requestId: ctx.requestId,
        after: { key, version },
      });
      return { kind: 'saved', template: toTemplate(saved) };
    });
  }
}
