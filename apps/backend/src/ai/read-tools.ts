import {
  aiSourceSchema,
  emailTemplateLabel,
  emailTemplateKeySchema,
  leadStageLabel,
  leadTypeCatalog,
  leadTypeLabel,
  planCommissionSchema,
  type AiSource,
  type Plan,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { withoutMoney, type AnalyticsStore } from '../analytics/store.js';
import type { WebAnalyticsReader } from '../analytics/web-analytics.js';
import type { DocumentReviewQueueStore } from '../documents/review-queue.js';
import type { MailboxStore } from '../email/mailbox.js';
import type { EmailSettingsStore } from '../email/settings-store.js';
import type { DeliverySummary } from '../email/store.js';
import type { JobAdminStore } from '../jobs/store.js';
import type { PlanStore } from '../plans/store.js';
import { decideAiAccess } from '../routes/ai-assistant.js';
import {
  decideAccess,
  type StaffAccessSnapshot,
  type StaffAction,
} from '../staff/authorization.js';
import { canSeeLeadDetails, moneyVisibilityOf } from '../staff/lead-visibility.js';
import type { Scope } from '../tenant-scope.js';
import type { TurnBudget } from './limits.js';
import {
  DISPLAY_NAME_MAX,
  LABEL_MAX,
  REFERENCE_MAX,
  NAME_MAX,
  toolResultSchema,
} from './projections.js';
import type { AiReadService } from './read-service.js';
import {
  RECORD_DATA_NOTICE,
  inertRecordLines,
  inertRecordText,
  neutralizeSerialized,
} from './record-text.js';
import type { AiSiteContext } from './site-context.js';
import type { AdminScreen, SourceRegistry } from './sources.js';
import { ADMIN_SCREENS } from './sources.js';
import { AssistantAccessRevokedError } from './tools.js';
import { businessDayLabel } from './windows.js';

/**
 * Ask AI's smaller reads (READS item 6): each answers with what the member
 * sees on the matching admin screen, decided by that screen's own route
 * action at the moment of the call, and reads through the store function that
 * route uses. A tool the member's access does not allow is not offered; called
 * anyway (an access change mid-turn), it answers a plain refusal, never data.
 *
 * Every answer is the shared tool envelope (`status`, `scope`, `data`,
 * `sources`, `notice` …), validated by a strict schema of its own data,
 * bounded by a small page and a hard page cap, charged to the turn's byte and
 * record budget, cleaned of raw format characters, and labelled as data.
 * Money follows `moneyVisibilityOf`; nothing here returns a contact's email,
 * phone or address, a document or its id, a mail's body, a job's payload, a
 * secret or a raw id the person has no use for.
 */

/** The stores behind the reads, each the one its staff route uses; a tool whose store is absent is not offered. */
export interface WideReadStores {
  readonly plans?: Pick<PlanStore, 'list'>;
  /** The site's property catalogue, as `GET /properties` builds it. */
  readonly propertyCatalog?: (scope: Scope) => Promise<PropertyCatalog>;
  readonly analytics?: Pick<AnalyticsStore, 'analytics'>;
  readonly webAnalytics?: WebAnalyticsReader;
  readonly documentReviewQueue?: DocumentReviewQueueStore;
  readonly mailbox?: MailboxStore;
  readonly deliverySummary?: (scope: Scope) => Promise<DeliverySummary>;
  readonly jobs?: Pick<JobAdminStore, 'listActive'>;
  /** The staff `GET /members` read: active members with their roles. */
  readonly members?: (scope: Scope) => Promise<
    readonly {
      actorId: string;
      displayName: string | null;
      roles: readonly string[];
      isSelf: boolean;
    }[]
  >;
  readonly emailSettings?: Pick<EmailSettingsStore, 'getSettings' | 'listTemplates'>;
}

export interface WideReadContext {
  readonly scope: Scope;
  readonly site: AiSiteContext;
  readonly requestId: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly budget: TurnBudget;
  readonly sources: SourceRegistry;
  readonly reads: Pick<AiReadService, 'leadLabels' | 'memberNames'>;
  readonly stores: WideReadStores;
  readonly loadAccess: () => Promise<StaffAccessSnapshot | undefined>;
  readonly onAccessRevoked?: () => void;
}

export const WIDE_READ_TOOL_NAMES = [
  'listPlans',
  'getPropertyCatalog',
  'getAnalytics',
  'getWebAnalytics',
  'getDocumentQueue',
  'listSentMail',
  'listJobs',
  'getMyAccess',
  'listMembers',
  'getEmailSettings',
  'getEmailTemplate',
  'linkToScreen',
] as const;
export type WideReadToolName = (typeof WIDE_READ_TOOL_NAMES)[number];

const PAGE_CAP = 5;
const PLANS_PAGE = 10;
const PROPERTIES_PAGE = 15;
const MEMBERS_PAGE = 20;
const MAIL_PAGE = 10;
const QUEUE_PAGE = 10;
const JOBS_LIMIT = 20;
const TEMPLATES_LIMIT = 30;
const TEMPLATE_TEXT_MAX = 3000;
const CHOICES_MAX = 20;

const pageSchema = z.int().min(1).max(PAGE_CAP).optional();
const leadTypeInput = z.string().min(1).max(64).optional();

export const wideReadInputSchemas = {
  listPlans: z
    .object({ leadType: leadTypeInput, includeInactive: z.boolean().optional(), page: pageSchema })
    .strict(),
  getPropertyCatalog: z
    .object({
      leadType: leadTypeInput,
      search: z.string().trim().min(1).max(60).optional(),
      page: pageSchema,
    })
    .strict(),
  getAnalytics: z
    .object({
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
      leadType: leadTypeInput,
    })
    .strict(),
  getWebAnalytics: z
    .object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() })
    .strict(),
  getDocumentQueue: z
    .object({ status: z.enum(['to_review', 'rejected']).optional(), page: pageSchema })
    .strict(),
  listSentMail: z.object({ leadId: z.uuid().optional(), page: pageSchema }).strict(),
  listJobs: z.object({}).strict(),
  getMyAccess: z.object({}).strict(),
  listMembers: z
    .object({ search: z.string().trim().min(1).max(60).optional(), page: pageSchema })
    .strict(),
  getEmailSettings: z.object({}).strict(),
  getEmailTemplate: z.object({ key: emailTemplateKeySchema }).strict(),
  linkToScreen: z
    .object({
      screen: z.enum([
        'plans',
        'properties',
        'analytics',
        'dashboard',
        'documents',
        'mail',
        'jobs',
        'team',
        'email_settings',
        'automations',
        'integrations',
        'leads',
      ]),
    })
    .strict(),
} as const satisfies Record<WideReadToolName, z.ZodType>;

/** Every action in words, for a member asking why something is refused (TM2). */
const ACTION_WORDS: Readonly<Record<StaffAction, string>> = {
  'workspace.read': 'see this site in the CRM',
  'lead.manage': 'work leads: move stages, assign, edit, add notes and tasks, email customers',
  'order.manage': 'review documents and manage plans',
  'order.override': 'move an order on without its required documents',
  'financial.read': 'see financial details',
  'revenue.view': 'see commission amounts and revenue',
  'lead.export': 'export leads to Excel',
  'document.download': 'download customer documents',
  'integration.manage': 'manage automations, email settings, site keys and background jobs',
  'property.manage': 'define the site’s properties and record layouts',
  'sensitive.reveal': 'open sealed values such as a SIN',
  'staff.invite': 'invite members',
  'staff.remove': 'remove members and see AI usage',
  'staff.roles.manage': 'change members’ roles',
  'export.bulk': 'bulk export',
  'record.delete': 'delete records',
  'invoice.approve': 'approve invoices',
};

type ToolEnvelope = z.infer<typeof toolResultSchema>;
type Status = ToolEnvelope['status'];

/** The shared envelope with one tool's own strict data. */
function envelopeFor(data: z.ZodType) {
  return toolResultSchema.omit({ data: true }).extend({ data: data.optional() }).strict();
}

const countsMinor = z.object({ current: z.int(), previous: z.int().nullable() }).strict();
const counted = z
  .object({ current: z.int().nonnegative(), previous: z.int().nonnegative().nullable() })
  .strict();
const labelled = z.object({ label: z.string().max(200), total: z.int().nonnegative() }).strict();

const dataSchemas = {
  listPlans: z
    .object({
      plans: z
        .array(
          z
            .object({
              name: z.string().max(NAME_MAX),
              leadType: z.string(),
              leadTypeLabel: z.string(),
              priceMinor: z.int().nonnegative(),
              currency: z.literal('CAD'),
              billingPeriod: z.string(),
              paymentRequired: z.boolean(),
              requiredDocuments: z.array(z.string().max(64)).max(16),
              active: z.boolean(),
              commission: planCommissionSchema.optional(),
            })
            .strict(),
        )
        .max(PLANS_PAGE),
    })
    .strict(),
  getPropertyCatalog: z
    .object({
      properties: z
        .array(
          z
            .object({
              key: z.string().max(64),
              label: z.string().max(LABEL_MAX),
              kind: z.string(),
              storage: z.string(),
              origin: z.string(),
              hidden: z.boolean(),
              sensitive: z.boolean(),
              filterable: z.boolean(),
              leadTypes: z.array(z.string()).max(20),
              choices: z
                .array(
                  z
                    .object({ value: z.string().max(200), label: z.string().max(LABEL_MAX) })
                    .strict(),
                )
                .max(CHOICES_MAX)
                .optional(),
            })
            .strict(),
        )
        .max(PROPERTIES_PAGE),
    })
    .strict(),
  getAnalytics: z
    .object({
      range: z.object({ from: z.string(), to: z.string(), days: z.int().positive() }).strict(),
      comparison: z.object({ from: z.string(), to: z.string() }).strict().nullable(),
      kpis: z
        .object({
          newLeads: counted,
          won: counted,
          paid: counted,
          followUpsDue: z.int().nonnegative(),
          followUpsOverdue: z.int().nonnegative(),
          documentsToReview: z.int().nonnegative(),
        })
        .strict(),
      stages: z
        .array(
          z
            .object({
              leadTypeLabel: z.string(),
              stageLabel: z.string(),
              total: z.int().nonnegative(),
            })
            .strict(),
        )
        .max(40),
      sources: z.array(labelled).max(10),
      partners: z.array(labelled).max(10),
      plans: z.array(labelled).max(11),
      delivery: z.array(labelled).max(10),
      paymentStatuses: z.array(labelled).max(10),
      commissionStatuses: z.array(labelled).max(10),
      team: z
        .array(
          z
            .object({
              member: z.string().max(DISPLAY_NAME_MAX),
              assigned: z.int().nonnegative(),
              won: z.int().nonnegative(),
              overdue: z.int().nonnegative(),
            })
            .strict(),
        )
        .max(30),
      commission: z
        .object({
          earnedMinor: countsMinor,
          expectedMinor: z.int(),
          wonWithoutCommission: z.int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  getWebAnalytics: z
    .object({
      available: z.boolean(),
      reason: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      totals: z.record(z.string(), z.int().nonnegative()).optional(),
      previous: z.record(z.string(), z.int().nonnegative()).optional(),
      pages: z.array(labelled).max(10).optional(),
      referrers: z.array(labelled).max(10).optional(),
      countries: z.array(labelled).max(10).optional(),
      devices: z.array(labelled).max(10).optional(),
      activeNow: z.int().nonnegative().nullable().optional(),
    })
    .strict(),
  getDocumentQueue: z
    .object({
      counts: z
        .object({ toReview: z.int().nonnegative(), rejected: z.int().nonnegative() })
        .strict(),
      documents: z
        .array(
          z
            .object({
              documentType: z.string().max(64),
              status: z.enum(['to_review', 'rejected']),
              required: z.boolean(),
              uploadedAt: z.string(),
              leadId: z.uuid(),
              leadReference: z.string().max(REFERENCE_MAX).nullable(),
              leadName: z.string().max(NAME_MAX).nullable(),
              leadTypeLabel: z.string(),
              stageLabel: z.string(),
            })
            .strict(),
        )
        .max(QUEUE_PAGE),
    })
    .strict(),
  listSentMail: z
    .object({
      delivery: z
        .object({
          sent: z.int().nonnegative(),
          delivered: z.int().nonnegative(),
          failed: z.int().nonnegative(),
          uncertain: z.int().nonnegative(),
        })
        .strict()
        .optional(),
      mails: z
        .array(
          z
            .object({
              direction: z.enum(['out', 'in']),
              at: z.string(),
              template: z.string().max(LABEL_MAX).optional(),
              subject: z.string().max(REFERENCE_MAX).optional(),
              status: z.string().max(20).optional(),
              byAutomation: z.string().max(LABEL_MAX).optional(),
              viaAi: z.literal(true).optional(),
              mailsToThisCustomer: z.int().positive().optional(),
              leadId: z.uuid(),
              leadReference: z.string().max(REFERENCE_MAX).nullable(),
              leadName: z.string().max(NAME_MAX).nullable(),
              leadTypeLabel: z.string(),
            })
            .strict(),
        )
        .max(MAIL_PAGE),
    })
    .strict(),
  listJobs: z
    .object({
      jobs: z
        .array(
          z
            .object({
              kind: z.string().max(64),
              status: z.string().max(20),
              attempts: z.int().nonnegative(),
              lastErrorCode: z.string().max(64).nullable(),
              createdAt: z.string(),
              updatedAt: z.string(),
            })
            .strict(),
        )
        .max(JOBS_LIMIT),
      canRetry: z.boolean(),
    })
    .strict(),
  getMyAccess: z
    .object({
      roles: z.array(z.string()).max(10),
      individualPermissions: z
        .array(z.object({ name: z.string(), effect: z.string() }).strict())
        .max(20),
      allowed: z.array(z.string()).max(20),
      notAllowed: z.array(z.string()).max(20),
    })
    .strict(),
  listMembers: z
    .object({
      members: z
        .array(
          z
            .object({
              displayName: z.string().max(DISPLAY_NAME_MAX).nullable(),
              roles: z.array(z.string()).max(10),
              isYou: z.boolean(),
            })
            .strict(),
        )
        .max(MEMBERS_PAGE),
    })
    .strict(),
  getEmailSettings: z
    .object({
      sender: z
        .object({
          fromName: z.string().max(DISPLAY_NAME_MAX),
          fromAddress: z.string().max(254),
          replyTo: z.string().max(254).nullable(),
          style: z.string(),
          footerText: z.string().max(500),
        })
        .strict()
        .nullable(),
      templates: z
        .array(
          z
            .object({
              key: z.string(),
              name: z.string().max(LABEL_MAX),
              subject: z.string().max(200),
              version: z.int().nonnegative(),
              archived: z.boolean(),
              sentByFlows: z.array(z.string().max(LABEL_MAX)).max(10),
            })
            .strict(),
        )
        .max(TEMPLATES_LIMIT),
    })
    .strict(),
  getEmailTemplate: z
    .object({
      key: z.string(),
      name: z.string().max(LABEL_MAX),
      subject: z.string().max(200),
      body: z.string().max(TEMPLATE_TEXT_MAX),
      version: z.int().nonnegative(),
      archived: z.boolean(),
    })
    .strict(),
  linkToScreen: z.object({ linked: z.string() }).strict(),
} as const satisfies Record<WideReadToolName, z.ZodType>;

interface ToolSpec {
  readonly description: string;
  /** The staff route's own rule, decided on the live snapshot of each call. */
  readonly allowed: (access: StaffAccessSnapshot) => boolean;
  /** Whether this deployment has the store the read needs. */
  readonly ready: boolean;
}

const lead = (access: StaffAccessSnapshot) => canSeeLeadDetails(access);
const read = (access: StaffAccessSnapshot) => decideAccess(access, 'workspace.read').allowed;
const integration = (access: StaffAccessSnapshot) =>
  decideAccess(access, 'integration.manage').allowed;

/** `YYYY-MM-DD` of the Toronto day `days - 1` before today, and today. */
function lastDays(now: Date, days: number): { from: string; to: string } {
  const to = businessDayLabel(now);
  const [y = '1970', m = '1', d = '1'] = to.split('-');
  const start = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) - (days - 1)));
  return { from: start.toISOString().slice(0, 10), to };
}

function label(value: string | null | undefined, max = 200): string {
  return inertRecordText(value ?? null, max) ?? '—';
}

function labelledRows(rows: readonly { key?: string; label?: string; total: number }[], max = 10) {
  return rows
    .slice(0, max)
    .map((row) => ({ label: label(row.label ?? row.key), total: row.total }));
}

export interface WideReadToolset {
  readonly definitions: ToolSet;
  readonly names: readonly WideReadToolName[];
  execute(name: WideReadToolName, input: unknown): Promise<string>;
}

/**
 * The small reads offered to this member now: only those whose route action
 * the member's access holds and whose store this deployment has.
 */
export function createWideReadTools(
  context: WideReadContext,
  access: StaffAccessSnapshot,
): WideReadToolset {
  const stores = context.stores;
  const asOf = () => context.now.toISOString();
  const specs: Record<WideReadToolName, ToolSpec> = {
    listPlans: {
      description:
        'The site’s plans, as Settings → Plans lists them: name, lead type, price (CAD cents), billing period, whether payment is required, the documents it needs, and whether it is active (inactive ones only with includeInactive). The commission only for members who see revenue. 10 per page.',
      allowed: read,
      ready: stores.plans !== undefined,
    },
    getPropertyCatalog: {
      description:
        'The site’s lead properties (Settings → Fields and layouts): key, label, kind, where it is stored, whether it is hidden or sensitive, whether findLeads can filter on it, and a choice property’s choices. Use it for findLeads where filters. 15 per page; search matches the label or key.',
      allowed: read,
      ready: stores.propertyCatalog !== undefined,
    },
    getAnalytics: {
      description:
        'The Analytics page’s figures over the last 7, 30 (default) or 90 days, compared with the period before: new leads, won, paid, follow-ups due and overdue, documents to review, stages, top sources, partners and plans, delivery, payment and commission states, and each member’s assigned, won and overdue counts. Commission earned and expected only for members who see revenue.',
      allowed: read,
      ready: stores.analytics !== undefined,
    },
    getWebAnalytics: {
      description:
        'The website traffic the Analytics page shows (Umami): pageviews, visitors, visits, bounces and time over 7, 30 (default) or 90 days, against the period before, with top pages, referrers, countries and devices.',
      allowed: read,
      ready: stores.webAnalytics !== undefined,
    },
    getDocumentQueue: {
      description:
        'The Documents review queue: how many documents wait for review and how many were rejected, and per page 10 of them with the document type, whether the lead’s plan requires it, when it came, and the lead’s reference, type and stage. Never the file itself; reviewing happens on the lead page.',
      allowed: lead,
      ready: stores.documentReviewQueue !== undefined,
    },
    listSentMail: {
      description:
        'The Mail page: mails sent to customers (each customer’s latest, or one lead’s mails with leadId), with the template or subject line, how the send went, when, who sent it (a flow or Ask AI) and the lead’s reference; replies are listed as received, without their words. Also the site’s delivery counters. Never a mail’s body. 10 per page.',
      allowed: lead,
      ready: stores.mailbox !== undefined,
    },
    listJobs: {
      description:
        'Background jobs that are waiting, running, failed or uncertain (Settings → Background jobs): kind, status, attempts, last error code and times; never their contents. Retrying and resolving happen on that screen.',
      allowed: read,
      ready: stores.jobs !== undefined,
    },
    getMyAccess: {
      description:
        'The signed-in member’s own roles, individual permissions and, in words, what they may and may not do on this site. Use it to explain why something is refused.',
      allowed: read,
      ready: true,
    },
    listMembers: {
      description:
        'The site’s active members: display name and roles, 20 per page; search matches the name.',
      allowed: read,
      ready: stores.members !== undefined,
    },
    getEmailSettings: {
      description:
        'Settings → Email: the sender (from name and address, reply-to, style, footer) and the templates (name, subject, version, which flows send it). Read one template’s words with getEmailTemplate. Changes are made on that screen.',
      allowed: integration,
      ready: stores.emailSettings !== undefined,
    },
    getEmailTemplate: {
      description:
        'One email template’s subject and body text as saved (its markup and {fill-ins}), by its key from getEmailSettings.',
      allowed: integration,
      ready: stores.emailSettings !== undefined,
    },
    linkToScreen: {
      description:
        'Give the person a link card to an admin screen for something they do there themselves (roles and invitations on team, site keys on integrations, document review on documents, plan and property changes, saved views and export on leads, template edits on email_settings, job retries on jobs, automation switches on automations). The server builds the link; never write a URL.',
      allowed: read,
      ready: true,
    },
  };

  const offered = WIDE_READ_TOOL_NAMES.filter(
    (name) => specs[name].ready && specs[name].allowed(access),
  );

  async function reauthorize(name: WideReadToolName): Promise<StaffAccessSnapshot | undefined> {
    context.signal?.throwIfAborted();
    const live = await context.loadAccess();
    context.signal?.throwIfAborted();
    const decision = decideAiAccess(live);
    if (!decision.allowed) {
      context.onAccessRevoked?.();
      throw new AssistantAccessRevokedError();
    }
    return specs[name].allowed(decision.access) ? decision.access : undefined;
  }

  function scopeOf(filters: Record<string, string | readonly string[]> = {}) {
    return {
      siteId: context.site.siteId,
      siteName: context.site.name,
      leadType: null,
      archivePolicy: 'active_only' as const,
      window: null,
      filters,
    };
  }

  function plain(status: Exclude<Status, 'ok'>, message: string, filters = {}): string {
    return JSON.stringify({ status, asOf: asOf(), scope: scopeOf(filters), sources: [], message });
  }

  /**
   * As the main tools' `finish`: trims whole rows until the result fits the
   * per-result and turn budgets, validates the exact envelope, cleans the text
   * the model receives, then charges it.
   */
  function finish<TRow>(
    name: WideReadToolName,
    filters: Record<string, string | readonly string[]>,
    rows: readonly TRow[],
    build: (kept: readonly TRow[]) => unknown,
    extra: { total?: number; hasMore?: boolean; records?: (kept: readonly TRow[]) => number } = {},
  ): string {
    const records = extra.records ?? ((kept: readonly TRow[]) => Math.max(1, kept.length));
    const schema = envelopeFor(dataSchemas[name]);
    let kept = [...rows];
    for (;;) {
      const candidate = schema.parse({
        status: 'ok',
        asOf: asOf(),
        scope: scopeOf(filters),
        data: build(kept),
        ...(extra.total === undefined ? {} : { total: extra.total }),
        returnedCount: kept.length,
        ...(kept.length < rows.length || extra.hasMore === true
          ? { truncated: kept.length < rows.length, hasMore: true }
          : {}),
        sources: context.sources.list().map((source: AiSource) => aiSourceSchema.parse(source)),
        notice: RECORD_DATA_NOTICE,
      });
      const text = neutralizeSerialized(JSON.stringify(candidate));
      const bytes = Buffer.byteLength(text, 'utf8');
      if (
        bytes <= context.budget.remainingBytes &&
        records(kept) <= context.budget.remainingRecords
      ) {
        context.budget.acceptResult({ bytes, records: records(kept) });
        return text;
      }
      if (kept.length === 0)
        return plain(
          'not_available',
          'The answer would exceed this turn’s data budget. Ask a narrower question.',
          filters,
        );
      kept = kept.slice(0, -1);
    }
  }

  const page = (value: number | undefined) => value ?? 1;

  async function listPlans(
    input: z.infer<(typeof wideReadInputSchemas)['listPlans']>,
    live: StaffAccessSnapshot,
  ) {
    const plans = stores.plans;
    if (!plans) return plain('not_available', 'Plans are not available here.');
    if (input.leadType !== undefined && !Object.hasOwn(leadTypeCatalog, input.leadType))
      return plain('invalid_filter', 'That is not a lead type in this CRM.');
    const all = await plans.list(
      { workspaceId: context.scope.workspaceId, actorId: context.scope.actorId },
      {
        ...(input.leadType === undefined ? {} : { leadType: input.leadType }),
        includeInactive: input.includeInactive === true,
      },
    );
    const revenue = moneyVisibilityOf(live).revenue;
    const at = (page(input.page) - 1) * PLANS_PAGE;
    const rows = all.slice(at, at + PLANS_PAGE).map((plan: Plan) => ({
      name: label(plan.name, NAME_MAX),
      leadType: plan.leadType,
      leadTypeLabel: leadTypeLabel(plan.leadType),
      priceMinor: plan.priceMinor,
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
      paymentRequired: plan.paymentRequired,
      requiredDocuments: plan.requiredDocuments.slice(0, 16),
      active: plan.active,
      ...(revenue && plan.commission !== undefined ? { commission: plan.commission } : {}),
    }));
    context.sources.screen('plans', `${context.site.name} · ${all.length} plans`);
    return finish(
      'listPlans',
      { page: String(page(input.page)) },
      rows,
      (kept) => ({ plans: kept }),
      {
        total: all.length,
        hasMore: at + PLANS_PAGE < all.length && page(input.page) < PAGE_CAP,
      },
    );
  }

  async function getPropertyCatalog(
    input: z.infer<(typeof wideReadInputSchemas)['getPropertyCatalog']>,
  ) {
    const load = stores.propertyCatalog;
    if (!load) return plain('not_available', 'The property catalogue is not available here.');
    if (input.leadType !== undefined && !Object.hasOwn(leadTypeCatalog, input.leadType))
      return plain('invalid_filter', 'That is not a lead type in this CRM.');
    const catalog = await load(context.scope);
    const filterable = new Set(catalog.filterable(input.leadType).map((entry) => entry.key));
    const needle = input.search?.toLowerCase();
    const matching = catalog.all.filter(
      (property) =>
        (input.leadType === undefined ||
          property.leadTypes.length === 0 ||
          property.leadTypes.includes(input.leadType)) &&
        (needle === undefined ||
          property.key.toLowerCase().includes(needle) ||
          property.label.toLowerCase().includes(needle)),
    );
    const at = (page(input.page) - 1) * PROPERTIES_PAGE;
    const rows = matching.slice(at, at + PROPERTIES_PAGE).map((property) => ({
      key: property.key,
      label: label(property.label, LABEL_MAX),
      kind: property.kind,
      storage: property.storage,
      origin: property.origin,
      hidden: property.hidden,
      sensitive: property.sensitive,
      filterable: filterable.has(property.key),
      leadTypes: property.leadTypes.slice(0, 20),
      ...(property.options === undefined || property.options.length === 0
        ? {}
        : {
            choices: property.options
              .filter((option) => option.hidden !== true)
              .slice(0, CHOICES_MAX)
              .map((option) => ({
                value: option.value.slice(0, 200),
                label: label(option.label, LABEL_MAX),
              })),
          }),
    }));
    context.sources.screen('properties', `${context.site.name} · lead properties`);
    return finish(
      'getPropertyCatalog',
      {
        page: String(page(input.page)),
        ...(input.search === undefined ? {} : { search: 'provided' }),
        ...(input.leadType === undefined ? {} : { leadType: input.leadType }),
      },
      rows,
      (kept) => ({ properties: kept }),
      {
        total: matching.length,
        hasMore: at + PROPERTIES_PAGE < matching.length && page(input.page) < PAGE_CAP,
      },
    );
  }

  async function getAnalytics(
    input: z.infer<(typeof wideReadInputSchemas)['getAnalytics']>,
    live: StaffAccessSnapshot,
  ) {
    const store = stores.analytics;
    if (!store) return plain('not_available', 'Analytics are not available here.');
    if (input.leadType !== undefined && !Object.hasOwn(leadTypeCatalog, input.leadType))
      return plain('invalid_filter', 'That is not a lead type in this CRM.');
    const days = input.days ?? 30;
    const range = lastDays(context.now, days);
    const raw = await store.analytics({
      workspaceId: context.scope.workspaceId,
      actorId: context.scope.actorId,
      ...range,
      compare: 'previous',
      group: 'day',
      ...(input.leadType === undefined ? {} : { leadType: input.leadType }),
    });
    // The route's own rule: money only with revenue.view.
    const figures = moneyVisibilityOf(live).revenue ? raw : withoutMoney(raw);
    const names =
      (await context.reads.memberNames?.(context.scope)) ?? new Map<string, string | null>();
    const data = {
      range: { from: figures.range.from, to: figures.range.to, days: figures.range.days },
      comparison: figures.comparison,
      kpis: {
        newLeads: figures.kpis.newLeads,
        won: figures.kpis.won,
        paid: figures.kpis.paid,
        followUpsDue: figures.kpis.followUps.due,
        followUpsOverdue: figures.kpis.followUps.overdue,
        documentsToReview: figures.kpis.documentsToReview,
      },
      stages: figures.stages.slice(0, 40).map((entry) => ({
        leadTypeLabel: leadTypeLabel(entry.leadType),
        stageLabel: leadStageLabel(entry.leadType, entry.stage),
        total: entry.total,
      })),
      sources: labelledRows(figures.sources.map((row) => ({ label: row.key, total: row.total }))),
      partners: labelledRows(
        figures.partners.map((row) => ({ label: row.name ?? row.code, total: row.total })),
      ),
      plans: labelledRows(
        figures.mix.plans.map((row) => ({ label: row.name, total: row.total })),
        11,
      ),
      delivery: labelledRows(
        figures.mix.delivery.map((row) => ({ label: row.key, total: row.total })),
      ),
      paymentStatuses: labelledRows(
        figures.statuses.payment.map((row) => ({ label: row.key, total: row.total })),
      ),
      commissionStatuses: labelledRows(
        figures.statuses.commission.map((row) => ({ label: row.key, total: row.total })),
      ),
      team: figures.team.slice(0, 30).map((row) => ({
        member:
          row.actorId === null
            ? 'Unassigned'
            : label(names.get(row.actorId) ?? 'A former member', DISPLAY_NAME_MAX),
        assigned: row.assigned,
        won: row.won,
        overdue: row.overdue,
      })),
      ...(figures.commission === undefined
        ? {}
        : {
            commission: {
              earnedMinor: figures.commission.earnedMinor,
              expectedMinor: figures.commission.expectedMinor,
              wonWithoutCommission: figures.commission.wonWithoutCommission,
            },
          }),
    };
    context.sources.screen(
      'analytics',
      `${context.site.name} · ${input.leadType === undefined ? 'all lead types' : leadTypeLabel(input.leadType)} · ${range.from} to ${range.to}, against the ${days} days before`,
    );
    return finish(
      'getAnalytics',
      { days: String(days), ...(input.leadType === undefined ? {} : { leadType: input.leadType }) },
      [data],
      () => data,
    );
  }

  async function getWebAnalytics(input: z.infer<(typeof wideReadInputSchemas)['getWebAnalytics']>) {
    const reader = stores.webAnalytics;
    if (!reader) return plain('not_available', 'Website traffic is not available here.');
    const days = input.days ?? 30;
    const outcome = await reader.read({
      workspaceId: context.scope.workspaceId,
      days,
      now: context.now,
    });
    context.sources.screen(
      'analytics',
      `${context.site.name} · website traffic · last ${days} days`,
    );
    if (outcome.status !== 'ok')
      return finish('getWebAnalytics', { days: String(days) }, [outcome], () => ({
        available: false,
        reason: outcome.status,
      }));
    const report = outcome.report;
    const rows = (list: readonly { label: string; total: number }[]) =>
      list.slice(0, 10).map((row) => ({ label: label(row.label), total: row.total }));
    const data = {
      available: true,
      from: report.from,
      to: report.to,
      totals: { ...report.totals },
      previous: { ...report.previous },
      pages: rows(report.pages),
      // A referrer is whatever a visitor's browser sent: data, never a link to follow.
      referrers: rows(report.referrers),
      countries: rows(report.countries),
      devices: rows(report.devices),
      activeNow: report.activeNow,
    };
    return finish('getWebAnalytics', { days: String(days) }, [data], () => data);
  }

  async function getDocumentQueue(
    input: z.infer<(typeof wideReadInputSchemas)['getDocumentQueue']>,
  ) {
    const queue = stores.documentReviewQueue;
    if (!queue) return plain('not_available', 'The review queue is not available here.');
    const status = input.status ?? 'to_review';
    const result = await queue.list(context.scope, { status, page: 1 });
    const at = (page(input.page) - 1) * QUEUE_PAGE;
    const items = result.items.slice(at, at + QUEUE_PAGE);
    // The queue names a lead by "name, else email": the lead's own reference
    // and name are read instead, so an address never reaches the model.
    const labels =
      (await context.reads.leadLabels?.(
        context.scope,
        items.map((item) => item.lead.id),
      )) ?? new Map();
    const rows = items.flatMap((item) => {
      const found = labels.get(item.lead.id);
      if (!found) return [];
      return [
        {
          documentType: item.document.documentType,
          status,
          required: item.required,
          uploadedAt: item.document.createdAt,
          leadId: item.lead.id,
          leadReference: inertRecordText(found.reference, REFERENCE_MAX),
          leadName: inertRecordText(found.name, NAME_MAX),
          leadTypeLabel: leadTypeLabel(found.leadType),
          stageLabel: leadStageLabel(found.leadType, found.stage),
        },
      ];
    });
    for (const row of rows)
      context.sources.lead(
        row.leadId,
        row.leadReference ?? row.leadName ?? 'Lead',
        `${context.site.name} · ${row.leadTypeLabel} · ${row.stageLabel} · ${row.documentType}`,
      );
    context.sources.screen(
      'documents',
      `${context.site.name} · documents ${status === 'to_review' ? 'to review' : 'rejected'}`,
    );
    return finish(
      'getDocumentQueue',
      { status, page: String(page(input.page)) },
      rows,
      (kept) => ({ counts: result.counts, documents: kept }),
      {
        total: status === 'to_review' ? result.counts.toReview : result.counts.rejected,
        hasMore: at + QUEUE_PAGE < Math.min(result.items.length, QUEUE_PAGE * PAGE_CAP),
      },
    );
  }

  async function listSentMail(input: z.infer<(typeof wideReadInputSchemas)['listSentMail']>) {
    const mailbox = stores.mailbox;
    if (!mailbox) return plain('not_available', 'The sent box is not available here.');
    const result = await mailbox.list(context.scope, {
      page: 1,
      ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
    });
    const at = (page(input.page) - 1) * MAIL_PAGE;
    const items = result.items.slice(at, at + MAIL_PAGE);
    const labels =
      (await context.reads.leadLabels?.(
        context.scope,
        items.map((item) => item.lead.id),
      )) ?? new Map();
    const delivery = await stores.deliverySummary?.(context.scope);
    const rows = items.flatMap((item) => {
      const found = labels.get(item.lead.id);
      if (!found) return [];
      const template =
        item.template === undefined
          ? null
          : inertRecordText(emailTemplateLabel(item.template, item.templateName), LABEL_MAX);
      // A hand-written mail's subject line staff typed; a reply's subject is the customer's, left out.
      const subject =
        item.direction === 'out' && template === null
          ? inertRecordText(item.subject ?? null, REFERENCE_MAX)
          : null;
      const byAutomation = inertRecordText(
        item.automationName ?? item.automation ?? null,
        LABEL_MAX,
      );
      return [
        {
          direction: item.direction,
          at: item.createdAt,
          ...(template === null ? {} : { template }),
          ...(subject === null ? {} : { subject }),
          ...(item.mailStatus === undefined ? {} : { status: item.mailStatus }),
          ...(byAutomation === null ? {} : { byAutomation }),
          ...(item.viaAi === true ? { viaAi: true as const } : {}),
          ...(item.mails === undefined ? {} : { mailsToThisCustomer: item.mails }),
          leadId: item.lead.id,
          leadReference: inertRecordText(found.reference, REFERENCE_MAX),
          leadName: inertRecordText(found.name, NAME_MAX),
          leadTypeLabel: leadTypeLabel(found.leadType),
        },
      ];
    });
    for (const row of rows)
      context.sources.lead(
        row.leadId,
        row.leadReference ?? row.leadName ?? 'Lead',
        `${context.site.name} · ${row.leadTypeLabel} · mail`,
      );
    context.sources.screen('mail', `${context.site.name} · sent mail`);
    return finish(
      'listSentMail',
      {
        page: String(page(input.page)),
        ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
      },
      rows,
      (kept) => ({ ...(delivery === undefined ? {} : { delivery }), mails: kept }),
      {
        total: result.total,
        hasMore: at + MAIL_PAGE < Math.min(result.items.length, MAIL_PAGE * PAGE_CAP),
      },
    );
  }

  async function listJobs(live: StaffAccessSnapshot) {
    const jobs = stores.jobs;
    if (!jobs) return plain('not_available', 'Background jobs are not available here.');
    const result = await jobs.listActive(context.scope.workspaceId, context.scope.actorId);
    const rows = result.jobs.slice(0, JOBS_LIMIT).map((job) => ({
      kind: job.jobType,
      status: job.status,
      attempts: job.attempts,
      lastErrorCode: job.lastErrorCode,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }));
    context.sources.screen('jobs', `${context.site.name} · ${result.total} active background jobs`);
    return finish('listJobs', {}, rows, (kept) => ({ jobs: kept, canRetry: integration(live) }), {
      total: result.total,
      hasMore: result.total > rows.length,
    });
  }

  function getMyAccess(live: StaffAccessSnapshot) {
    const actions = Object.keys(ACTION_WORDS).filter((action): action is StaffAction =>
      Object.hasOwn(ACTION_WORDS, action),
    );
    const allowed = actions.filter((action) => decideAccess(live, action).allowed);
    const data = {
      roles: [...live.roles],
      individualPermissions: live.permissions.map((permission) => ({
        name: permission.name,
        effect: permission.effect,
      })),
      allowed: allowed.map((action) => ACTION_WORDS[action]),
      notAllowed: actions
        .filter((action) => !allowed.includes(action))
        .map((action) => ACTION_WORDS[action]),
    };
    context.sources.screen(
      'team',
      `${context.site.name} · roles are changed by the owner on Settings → Team`,
    );
    return finish('getMyAccess', {}, [data], () => data);
  }

  async function listMembers(input: z.infer<(typeof wideReadInputSchemas)['listMembers']>) {
    const members = stores.members;
    if (!members) return plain('not_available', 'The member list is not available here.');
    const all = await members(context.scope);
    const needle = input.search?.toLowerCase();
    const matching = all.filter(
      (entry) => needle === undefined || (entry.displayName ?? '').toLowerCase().includes(needle),
    );
    const at = (page(input.page) - 1) * MEMBERS_PAGE;
    const rows = matching.slice(at, at + MEMBERS_PAGE).map((entry) => ({
      displayName: inertRecordText(entry.displayName, DISPLAY_NAME_MAX),
      roles: [...entry.roles].slice(0, 10),
      isYou: entry.isSelf,
    }));
    return finish(
      'listMembers',
      {
        page: String(page(input.page)),
        ...(input.search === undefined ? {} : { search: 'provided' }),
      },
      rows,
      (kept) => ({ members: kept }),
      {
        total: matching.length,
        hasMore: at + MEMBERS_PAGE < matching.length && page(input.page) < PAGE_CAP,
      },
    );
  }

  async function getEmailSettings() {
    const store = stores.emailSettings;
    if (!store) return plain('not_available', 'Email settings are not available here.');
    const [settings, templates] = await Promise.all([
      store.getSettings(context.scope),
      store.listTemplates(context.scope),
    ]);
    const rows = templates.slice(0, TEMPLATES_LIMIT).map((template) => ({
      key: template.key,
      name: label(emailTemplateLabel(template.key, template.name), LABEL_MAX),
      subject: inertRecordText(template.subject, 200) ?? '',
      version: template.version,
      archived: template.archived,
      sentByFlows: template.usedBy.slice(0, 10).map((flow) => label(flow.name, LABEL_MAX)),
    }));
    const sender =
      settings === undefined
        ? null
        : {
            fromName: label(settings.fromName, DISPLAY_NAME_MAX),
            fromAddress: settings.fromAddress,
            replyTo: settings.replyTo,
            style: settings.style,
            footerText: inertRecordLines(settings.footerText, 500) ?? '',
          };
    context.sources.screen('email_settings', `${context.site.name} · sender and templates`);
    return finish('getEmailSettings', {}, rows, (kept) => ({ sender, templates: kept }), {
      total: templates.length,
    });
  }

  async function getEmailTemplate(
    input: z.infer<(typeof wideReadInputSchemas)['getEmailTemplate']>,
  ) {
    const store = stores.emailSettings;
    if (!store) return plain('not_available', 'Email settings are not available here.');
    const templates = await store.listTemplates(context.scope);
    const template = templates.find((entry) => entry.key === input.key);
    if (!template) return plain('not_available', 'No template with that key on this site.');
    const data = {
      key: template.key,
      name: label(emailTemplateLabel(template.key, template.name), LABEL_MAX),
      subject: inertRecordText(template.subject, 200) ?? '',
      body: inertRecordLines(template.body, TEMPLATE_TEXT_MAX) ?? '',
      version: template.version,
      archived: template.archived,
    };
    context.sources.screen('email_settings', `${context.site.name} · template ${data.name}`);
    return finish('getEmailTemplate', { key: template.key }, [data], () => data);
  }

  function linkToScreen(input: z.infer<(typeof wideReadInputSchemas)['linkToScreen']>) {
    const screens: Record<typeof input.screen, AdminScreen | 'leads'> = {
      plans: 'plans',
      properties: 'properties',
      analytics: 'analytics',
      dashboard: 'dashboard',
      documents: 'documents',
      mail: 'mail',
      jobs: 'jobs',
      team: 'team',
      email_settings: 'email_settings',
      automations: 'automations',
      integrations: 'integrations',
      leads: 'leads',
    };
    const screen = screens[input.screen];
    const card =
      screen === 'leads'
        ? context.sources.leadsInbox(`${context.site.name} · the leads inbox`)
        : context.sources.screen(screen, `${context.site.name} · ${ADMIN_SCREENS[screen].label}`);
    return finish('linkToScreen', { screen: input.screen }, [card], () => ({ linked: card.label }));
  }

  async function run(name: WideReadToolName, raw: unknown): Promise<string> {
    if (!context.budget.reserveToolCall())
      return plain(
        'not_available',
        'This turn has already used its tool budget. Answer from what was read, and say the rest could not be checked.',
      );
    const live = await reauthorize(name);
    if (live === undefined)
      return plain(
        'not_available',
        'Your access does not include this screen. Do not answer from memory; getMyAccess explains what the person can do.',
      );
    const input = wideReadInputSchemas[name].parse(raw);
    try {
      switch (name) {
        case 'listPlans':
          return await listPlans(wideReadInputSchemas.listPlans.parse(input), live);
        case 'getPropertyCatalog':
          return await getPropertyCatalog(wideReadInputSchemas.getPropertyCatalog.parse(input));
        case 'getAnalytics':
          return await getAnalytics(wideReadInputSchemas.getAnalytics.parse(input), live);
        case 'getWebAnalytics':
          return await getWebAnalytics(wideReadInputSchemas.getWebAnalytics.parse(input));
        case 'getDocumentQueue':
          return await getDocumentQueue(wideReadInputSchemas.getDocumentQueue.parse(input));
        case 'listSentMail':
          return await listSentMail(wideReadInputSchemas.listSentMail.parse(input));
        case 'listJobs':
          return await listJobs(live);
        case 'getMyAccess':
          return getMyAccess(live);
        case 'listMembers':
          return await listMembers(wideReadInputSchemas.listMembers.parse(input));
        case 'getEmailSettings':
          return await getEmailSettings();
        case 'getEmailTemplate':
          return await getEmailTemplate(wideReadInputSchemas.getEmailTemplate.parse(input));
        case 'linkToScreen':
          return linkToScreen(wideReadInputSchemas.linkToScreen.parse(input));
      }
    } catch (error) {
      if (error instanceof AssistantAccessRevokedError) throw error;
      context.signal?.throwIfAborted();
      return plain('temporary_failure', 'That could not be read just now.');
    }
  }

  const definitions: ToolSet = {};
  for (const name of offered) {
    // Widened to one input type so a single loop defines them all; `run`
    // parses the input with the tool's own strict schema again.
    const inputSchema: z.ZodType<unknown> = wideReadInputSchemas[name];
    definitions[name] = tool({
      description: specs[name].description,
      inputSchema,
      execute: async (input: unknown) => run(name, input),
    });
  }

  return {
    definitions,
    names: offered,
    execute: (name, input) =>
      offered.includes(name)
        ? run(name, input)
        : Promise.resolve(
            plain('not_available', 'That tool is not available to this member on this site.'),
          ),
  };
}
