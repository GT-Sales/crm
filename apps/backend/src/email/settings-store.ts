import { and, asc, desc, eq, isNotNull, isNull, like, sql, type SQL } from 'drizzle-orm';
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
  EMAIL_TEMPLATE_MAX_SITE_MADE,
  customerEmailTemplateSchema,
  emailTemplateKeySchema,
  generateTemplateKey,
  isSiteTemplateKey,
  leadTypeCatalog,
  type CreateEmailTemplateRequest,
  type CustomerEmailTemplate,
  type EmailTemplateKey,
  type PropertyCatalog,
  type UpdateEmailSettingsRequest,
  type UpdateEmailTemplateRequest,
} from '@gt-sales/contracts';

import { flowsSendingTemplates, type FlowNameRef } from '../automations/flow-store.js';
import { loadPropertyCatalog } from '../properties/catalog.js';
import {
  parseEmailBody,
  parseEmailSubject,
  type MarkupError,
  type MarkupOptions,
} from './markup.js';
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
  key: EmailTemplateKey;
  /** A site-made template's name; null for the nine built-ins. */
  name: string | null;
  /** Site-made templates only; a built-in is never archived. */
  archived: boolean;
  subject: string;
  body: string;
  /** 0 for the starter text, which is never saved. */
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** A template as Settings → Email lists it: with the flows whose active version sends it. */
export interface ListedEmailTemplate extends StoredEmailTemplate {
  usedBy: FlowNameRef[];
}

export type PutTemplateOutcome =
  | { kind: 'saved'; template: ListedEmailTemplate }
  | { kind: 'version_conflict' }
  /** A site-made key with no row, or an archived one. */
  | { kind: 'not_found' }
  | ({ kind: 'invalid' } & MarkupError);

export type CreateTemplateOutcome =
  | { kind: 'saved'; template: ListedEmailTemplate }
  | { kind: 'limit_reached' }
  | ({ kind: 'invalid' } & MarkupError);

export type ArchiveTemplateOutcome =
  | { kind: 'saved'; template: ListedEmailTemplate }
  | { kind: 'not_found' | 'builtin' | 'limit_reached' };

/** The archived site-made templates come a page at a time: archiving has no limit. */
export const ARCHIVED_TEMPLATE_PAGE = 50;

export interface EmailSettingsStore {
  getSettings(ctx: Scope): Promise<StoredEmailSettings | undefined>;
  /** Saves the whole form; audit `email.settings_updated` names the fields that changed. */
  putSettings(ctx: WriteScope, input: UpdateEmailSettingsRequest): Promise<StoredEmailSettings>;
  /**
   * The nine in CUSTOMER_EMAIL_TEMPLATES order (an unsaved one is its starter
   * at version 0), then the site-made ones not archived, by name; each with
   * the flows that send it.
   */
  listTemplates(ctx: Scope): Promise<ListedEmailTemplate[]>;
  /** A page of the archived site-made templates, most recently archived first, before `before`. */
  listArchivedTemplates(
    ctx: Scope,
    options: { before?: string },
  ): Promise<{ templates: ListedEmailTemplate[]; nextBefore: string | null }>;
  /**
   * Saves `expectedVersion + 1` when that is still the stored version; audit
   * `email.template_saved`. A site-made template's `{prop:…}` must name a
   * property a customer email may show (`catalog`, loaded when not given).
   */
  putTemplate(
    ctx: WriteScope,
    key: EmailTemplateKey,
    input: UpdateEmailTemplateRequest,
    catalog?: PropertyCatalog,
  ): Promise<PutTemplateOutcome>;
  /** A site-made template at version 1; at most `EMAIL_TEMPLATE_MAX_SITE_MADE` not archived (P13). */
  createTemplate(
    ctx: WriteScope,
    input: CreateEmailTemplateRequest,
    catalog?: PropertyCatalog,
  ): Promise<CreateTemplateOutcome>;
  /** Archives or restores a site-made template; a restore counts against the limit. */
  setTemplateArchived(
    ctx: WriteScope,
    key: EmailTemplateKey,
    archived: boolean,
  ): Promise<ArchiveTemplateOutcome>;
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
  key: emailTemplateKeySchema.parse(record.key),
  name: record.name,
  archived: record.archivedAt !== null,
  subject: record.subject,
  body: record.body,
  version: record.version,
  updatedAt: record.updatedAt,
  updatedBy: record.updatedBy,
});

const starter = (key: CustomerEmailTemplate): StoredEmailTemplate => ({
  key,
  name: null,
  archived: false,
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

/**
 * The site's current copy of `key`: the saved version, else (a built-in) the
 * starter at version 0. Undefined only for a site-made key with no row or an
 * archived one.
 */
export async function readEmailTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: CustomerEmailTemplate,
): Promise<StoredEmailTemplate>;
export async function readEmailTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: EmailTemplateKey,
): Promise<StoredEmailTemplate | undefined>;
export async function readEmailTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: EmailTemplateKey,
): Promise<StoredEmailTemplate | undefined> {
  const [record] = await tx
    .select()
    .from(emailTemplates)
    .where(and(eq(emailTemplates.workspaceId, workspaceId), eq(emailTemplates.key, key)));
  const builtIn = customerEmailTemplateSchema.safeParse(key);
  if (builtIn.success) return record ? toTemplate(record) : starter(builtIn.data);
  return record && record.archivedAt === null ? toTemplate(record) : undefined;
}

/** One save of a template at a time per site and key, so two editors cannot both write version n + 1. */
async function lockTemplate(
  tx: TenantTransaction,
  workspaceId: string,
  key: EmailTemplateKey,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('email_templates:' || ${workspaceId}::text || ':' || ${key}::text, 0))`,
  );
}

/** Serialises the site-made template count of one site (P13). */
async function lockTemplateCount(tx: TenantTransaction, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('email_templates:' || ${workspaceId}::text, 0))`,
  );
}

const SITE_MADE = like(emailTemplates.key, 'tpl\\_%');

async function countLiveSiteTemplates(tx: TenantTransaction, workspaceId: string) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.workspaceId, workspaceId),
        SITE_MADE,
        isNull(emailTemplates.archivedAt),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Whether a site-made template may show the property `key`: one the
 * catalogue has, not hidden, not sensitive and not staff-only for any type it
 * applies to (P12; a customer reads the mail).
 */
export function customerPropertyCheck(catalog: PropertyCatalog): MarkupOptions {
  return {
    property: (key) => {
      const property = catalog.get(key);
      if (!property || property.hidden || property.sensitive || property.staffOnly) return false;
      const types =
        property.leadTypes.length > 0 ? property.leadTypes : Object.keys(leadTypeCatalog);
      return types.every((leadType) => {
        const entry = catalog.forType(leadType).find((candidate) => candidate.key === key);
        return entry === undefined || (!entry.staffOnly && !entry.sensitive);
      });
    },
  };
}

/** The subject's or the body's first markup problem, as the parsers report it. */
function markupProblem(
  key: EmailTemplateKey,
  input: Pick<UpdateEmailTemplateRequest, 'subject' | 'body'>,
  options?: MarkupOptions,
): MarkupError | undefined {
  const subject = parseEmailSubject(input.subject, key, options);
  if (!subject.ok) {
    const { ok: _ok, ...problem } = subject;
    return problem;
  }
  const body = parseEmailBody(input.body, key, options);
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

  listTemplates(ctx: Scope): Promise<ListedEmailTemplate[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const records = await tx
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.workspaceId, ctx.workspaceId),
            // Archived site-made templates have no limit: they are listed a page at a time.
            sql`(${emailTemplates.key} not like 'tpl\\_%' or ${emailTemplates.archivedAt} is null)`,
          ),
        )
        .orderBy(sql`lower(${emailTemplates.name})`, asc(emailTemplates.key));
      const usedBy = await flowsSendingTemplates(tx, ctx.workspaceId);
      const byKey = new Map(records.map((record) => [record.key, record]));
      const builtIns = CUSTOMER_EMAIL_TEMPLATES.map((key) => {
        const record = byKey.get(key);
        return record ? toTemplate(record) : starter(key);
      });
      const siteMade = records.filter((record) => isSiteTemplateKey(record.key)).map(toTemplate);
      return [...builtIns, ...siteMade].map((template) => ({
        ...template,
        usedBy: usedBy.get(template.key) ?? [],
      }));
    });
  }

  listArchivedTemplates(
    ctx: Scope,
    options: { before?: string },
  ): Promise<{ templates: ListedEmailTemplate[]; nextBefore: string | null }> {
    return this.database.withTenantTx(ctx, async (tx) => {
      let after: SQL | undefined;
      if (options.before !== undefined) {
        const [cursor] = await tx
          .select({ id: emailTemplates.id })
          .from(emailTemplates)
          .where(
            and(
              eq(emailTemplates.workspaceId, ctx.workspaceId),
              eq(emailTemplates.key, options.before),
              isNotNull(emailTemplates.archivedAt),
            ),
          );
        if (!cursor) return { templates: [], nextBefore: null };
        after = sql`(${emailTemplates.archivedAt}, ${emailTemplates.id}) < (select c.archived_at, c.id from app.email_templates c where c.workspace_id = ${ctx.workspaceId} and c.id = ${cursor.id})`;
      }
      const records = await tx
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.workspaceId, ctx.workspaceId),
            SITE_MADE,
            isNotNull(emailTemplates.archivedAt),
            after,
          ),
        )
        .orderBy(desc(emailTemplates.archivedAt), desc(emailTemplates.id))
        .limit(ARCHIVED_TEMPLATE_PAGE + 1);
      const page = records.slice(0, ARCHIVED_TEMPLATE_PAGE);
      const last = page.at(-1);
      return {
        // Archived, no flow can send them: nothing uses them.
        templates: page.map((record) => ({ ...toTemplate(record), usedBy: [] })),
        nextBefore: records.length > ARCHIVED_TEMPLATE_PAGE && last ? last.key : null,
      };
    });
  }

  putTemplate(
    ctx: WriteScope,
    key: EmailTemplateKey,
    input: UpdateEmailTemplateRequest,
    catalog?: PropertyCatalog,
  ): Promise<PutTemplateOutcome> {
    return this.database.withTenantTx(ctx, async (tx): Promise<PutTemplateOutcome> => {
      await lockTemplate(tx, ctx.workspaceId, key);
      const current = await readEmailTemplate(tx, ctx.workspaceId, key);
      if (!current) return { kind: 'not_found' };
      if (current.version !== input.expectedVersion) return { kind: 'version_conflict' };
      const siteMade = isSiteTemplateKey(key);
      const options = siteMade
        ? customerPropertyCheck(catalog ?? (await loadPropertyCatalog(tx, 'lead')))
        : undefined;
      const problem = markupProblem(key, input, options);
      if (problem) return { kind: 'invalid', ...problem };

      const version = current.version + 1;
      const changes = {
        subject: input.subject,
        body: input.body,
        version,
        updatedBy: ctx.actorId,
        updatedAt: new Date(),
      };
      // A site-made template always has its row (and its name); a built-in may not yet.
      const [saved] = siteMade
        ? await tx
            .update(emailTemplates)
            .set(changes)
            .where(
              and(eq(emailTemplates.workspaceId, ctx.workspaceId), eq(emailTemplates.key, key)),
            )
            .returning()
        : await tx
            .insert(emailTemplates)
            .values({ workspaceId: ctx.workspaceId, key, ...changes })
            .onConflictDoUpdate({
              target: [emailTemplates.workspaceId, emailTemplates.key],
              set: changes,
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
      const usedBy = await flowsSendingTemplates(tx, ctx.workspaceId);
      return { kind: 'saved', template: { ...toTemplate(saved), usedBy: usedBy.get(key) ?? [] } };
    });
  }

  createTemplate(
    ctx: WriteScope,
    input: CreateEmailTemplateRequest,
    catalog?: PropertyCatalog,
  ): Promise<CreateTemplateOutcome> {
    return this.database.withTenantTx(ctx, async (tx): Promise<CreateTemplateOutcome> => {
      const options = customerPropertyCheck(catalog ?? (await loadPropertyCatalog(tx, 'lead')));
      // Any site-made key reads the same way: the markup check needs no key yet.
      const problem = markupProblem('tpl_aaaaaaaaaaaaaaaa', input, options);
      if (problem) return { kind: 'invalid', ...problem };
      await lockTemplateCount(tx, ctx.workspaceId);
      if ((await countLiveSiteTemplates(tx, ctx.workspaceId)) >= EMAIL_TEMPLATE_MAX_SITE_MADE) {
        return { kind: 'limit_reached' };
      }
      let saved: TemplateRecord | undefined;
      // A clash of two random keys is next to impossible; try again if it happens.
      for (let attempt = 0; attempt < 5 && !saved; attempt += 1) {
        [saved] = await tx
          .insert(emailTemplates)
          .values({
            workspaceId: ctx.workspaceId,
            key: generateTemplateKey(),
            name: input.name,
            subject: input.subject,
            body: input.body,
            version: 1,
            updatedBy: ctx.actorId,
          })
          .onConflictDoNothing({ target: [emailTemplates.workspaceId, emailTemplates.key] })
          .returning();
      }
      if (!saved) throw new Error('no free template key was found');
      await tx.insert(emailTemplateVersions).values({
        workspaceId: ctx.workspaceId,
        key: saved.key,
        version: 1,
        subject: input.subject,
        body: input.body,
        createdBy: ctx.actorId,
      });
      await tx.insert(auditEvents).values({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        actorLabel: AUDIT_ACTOR_LABEL,
        action: 'email.template_created',
        entity: 'email_template',
        entityId: saved.id,
        requestId: ctx.requestId,
        after: { key: saved.key, version: 1 },
      });
      return { kind: 'saved', template: { ...toTemplate(saved), usedBy: [] } };
    });
  }

  setTemplateArchived(
    ctx: WriteScope,
    key: EmailTemplateKey,
    archived: boolean,
  ): Promise<ArchiveTemplateOutcome> {
    return this.database.withTenantTx(ctx, async (tx): Promise<ArchiveTemplateOutcome> => {
      if (!isSiteTemplateKey(key)) return { kind: 'builtin' };
      if (!archived) await lockTemplateCount(tx, ctx.workspaceId);
      const [current] = await tx
        .select()
        .from(emailTemplates)
        .where(and(eq(emailTemplates.workspaceId, ctx.workspaceId), eq(emailTemplates.key, key)))
        .for('update');
      if (!current) return { kind: 'not_found' };
      const listed = async (record: TemplateRecord): Promise<ArchiveTemplateOutcome> => ({
        kind: 'saved',
        template: {
          ...toTemplate(record),
          usedBy: (await flowsSendingTemplates(tx, ctx.workspaceId)).get(record.key) ?? [],
        },
      });
      if ((current.archivedAt !== null) === archived) return listed(current);
      if (
        !archived &&
        (await countLiveSiteTemplates(tx, ctx.workspaceId)) >= EMAIL_TEMPLATE_MAX_SITE_MADE
      ) {
        return { kind: 'limit_reached' };
      }
      const [saved] = await tx
        .update(emailTemplates)
        .set({ archivedAt: archived ? new Date() : null })
        .where(
          and(eq(emailTemplates.workspaceId, ctx.workspaceId), eq(emailTemplates.id, current.id)),
        )
        .returning();
      if (!saved) throw new Error('the template vanished inside its own transaction');
      await tx.insert(auditEvents).values({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        actorLabel: AUDIT_ACTOR_LABEL,
        action: archived ? 'email.template_archived' : 'email.template_restored',
        entity: 'email_template',
        entityId: saved.id,
        requestId: ctx.requestId,
        before: { key, archived: !archived },
        after: { key, archived },
      });
      return listed(saved);
    });
  }
}
