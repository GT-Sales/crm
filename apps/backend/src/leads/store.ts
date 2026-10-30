import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  auditEvents,
  contacts,
  draftGrants,
  leads,
  withTenantTx,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  automationsForSubmit,
  initialLeadStage,
  isOrderLeadType,
  leadContactSchema,
  leadFormSchema,
  leadStatusSchema,
  leadTypeSchema,
  type LeadAssigneeFilter,
  type LeadContact,
  type LeadForm,
  type LeadDraft,
  type LeadListItem,
  type LeadOrderIntake,
  type LeadPropertyFilter,
  type LeadStatus,
  type LeadSummary,
  type LeadView,
  type PropertyCatalog,
  type RawAttribution,
} from '@gt-sales/contracts';

import { readAutomationLead, runAutomations } from '../automations/run.js';
import { DatabaseAutomationStore, type AutomationStore } from '../automations/store.js';
import {
  customerEmailEnvironmentFromEnv,
  type CustomerEmailEnvironment,
} from '../email/senders.js';
import { loadPlanForFreeze } from '../plans/store.js';
import { sanitizeAttribution } from './attribution.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyError,
  type IdempotencyInput,
} from './idempotency.js';
import { isPlanAvailable, submittedOrder, toLeadOrder } from './order.js';
import { selectLeadPage } from './staff-queries.js';
import { generateDraftGrantToken, hashDraftGrantToken } from './token.js';
import { checkLeadForm, checkLeadSubmit, type LeadIntakeProblem } from './types.js';

/** Long enough for a customer to leave and resume the form later. */
const DEFAULT_DRAFT_GRANT_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Why a website lead with an order was refused: `invalid_request`, its type
 * takes no order; `plan_not_available`, the plan is not one this site sells
 * for the type right now (another site's, inactive or of another type). Thrown
 * inside the intake transaction, so nothing is stored, and kept out of
 * `CreateLeadResult` so every caller keeps reading the lead it created.
 */
export class OrderIntakeError extends Error {
  constructor(readonly code: 'invalid_request' | 'plan_not_available') {
    super(`lead order refused: ${code}`);
    this.name = 'OrderIntakeError';
  }
}

export interface CreateLeadInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  leadType: string;
  externalRef?: string;
  contact?: LeadContact;
  form?: LeadForm;
  attribution?: RawAttribution;
  consentVersion: string;
  /** Create the lead already `submitted`, with no draft grant (a one-shot form). */
  submit?: boolean;
  /** An order lead type's plan; frozen when the lead is submitted. */
  order?: LeadOrderIntake;
  /**
   * The hashed idempotency key and body fingerprint of a website submit. A
   * retry with both replays the first lead; a key reused with another body
   * throws `IdempotencyError`.
   */
  idempotency?: IdempotencyInput;
}

export interface CreateLeadResult {
  lead: LeadSummary;
  /**
   * `null` for a lead created submitted: there is no draft to resume. A
   * replayed draft gets a fresh grant, since the first token is never stored.
   */
  grant: { token: string; expiresAt: string } | null;
  /** True when the idempotency key had already created this lead. */
  replayed: boolean;
}

export type UpdateLeadOutcome =
  /** `replayed`: the idempotency key had already submitted this lead; nothing was written. */
  | { status: 'updated'; lead: LeadSummary; replayed?: true }
  | { status: 'grant_invalid' }
  | { status: 'grant_expired' }
  | { status: 'draft_submitted' }
  /** The lead's type takes no order. */
  | { status: 'order_not_allowed' }
  /** The plan named, or the one the draft holds at submission, is not one the site sells now. */
  | { status: 'plan_not_available' }
  /** The idempotency key was used with another body or for another lead. */
  | { status: 'idempotency_conflict' }
  /** The idempotency key is claimed by a request that never completed. */
  | { status: 'idempotency_in_progress' }
  /**
   * The save would leave the lead unfit for its type: its form is not the
   * type's (`form`), or a submission lacks what the type needs to be worked
   * (`checkLeadSubmit`). Nothing was written; `problem` names the part only.
   */
  | { status: 'submission_incomplete'; problem: LeadIntakeProblem };

export interface UpdateLeadInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  leadId: string;
  grantToken: string;
  contact?: LeadContact;
  form?: LeadForm;
  attribution?: RawAttribution;
  consentVersion?: string;
  /** An order lead type's plan; replaces the draft's, frozen at submission. */
  order?: LeadOrderIntake;
  /** Submit the draft with this save: its plan is frozen and the grant edits nothing more. */
  submit?: boolean;
  /** As on `CreateLeadInput`; honoured only with `submit: true`. */
  idempotency?: IdempotencyInput;
}

export interface ListLeadsInput {
  workspaceId: string;
  actorId: string;
  status?: LeadStatus;
  leadType?: string;
  stage?: string;
  assignee?: LeadAssigneeFilter;
  /** Name, email, phone or external reference; only for callers who may see contacts. */
  search?: string;
  view?: LeadView;
  /** Only leads with a follow-up due by this calendar day, the most overdue first. */
  dueBy?: string;
  /** Validated property filters; only for callers who may see contacts. */
  where?: readonly LeadPropertyFilter[];
  /** Validated sort string (`<field>:<asc|desc>`); property sorts require contact access. */
  sort?: string;
  /** Validated property keys to include in each row's `properties` map (at most 6). */
  columns?: readonly string[];
  /** The site's property catalogue the filters, sort and columns were validated against. */
  catalog: PropertyCatalog;
  page?: number;
  pageSize?: number;
}

export interface ListLeadsResult {
  leads: LeadListItem[];
  page: { page: number; pageSize: number; total: number };
}

export interface LeadStore {
  readLead(
    input: Pick<UpdateLeadInput, 'workspaceId' | 'actorId' | 'leadId' | 'grantToken'>,
  ): Promise<ReadLeadOutcome>;
  createLead(input: CreateLeadInput): Promise<CreateLeadResult>;
  updateLead(input: UpdateLeadInput): Promise<UpdateLeadOutcome>;
  listLeads(input: ListLeadsInput): Promise<ListLeadsResult>;
}

export type ReadLeadOutcome =
  | { status: 'read'; draft: LeadDraft }
  | { status: 'grant_invalid' | 'grant_expired' | 'draft_submitted' };

type LeadDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

const defaultLeadDatabase: LeadDatabase = { withTenantTx };

function toSummary(row: {
  id: string;
  workspaceId: string;
  status: string;
  updatedAt: Date;
}): LeadSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: leadStatusSchema.parse(row.status),
    externalRef: null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The merge key for contacts (owner decision 2026-10-25): email only, trimmed
 * and lower-cased. Gmail dots and `+tags` are deliberately kept — stripping
 * them would merge people who never shared an address.
 */
export function normalizeContactEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Finds or creates the global contact for an email and refreshes the name,
 * phone and country from the latest submission when they are present. Runs
 * inside the tenant transaction; the `contacts` policy only requires a
 * verified actor, which `withTenantTx` guarantees.
 */
export async function upsertContact(
  tx: TenantTransaction,
  contact: LeadContact & { email: string },
): Promise<string> {
  const [row] = await tx
    .insert(contacts)
    .values({
      email: normalizeContactEmail(contact.email),
      fullName: contact.fullName ?? null,
      phone: contact.phone ?? null,
      countryCode: contact.countryCode ?? null,
    })
    .onConflictDoUpdate({
      target: contacts.email,
      set: {
        fullName: sql`coalesce(excluded.full_name, ${contacts.fullName})`,
        phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
        countryCode: sql`coalesce(excluded.country_code, ${contacts.countryCode})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error('contact upsert did not return a row');
  return row.id;
}

/**
 * The order a new website lead stores, or undefined when it names no plan:
 * submitted, the plan frozen now; a draft, the plan and quantity only (frozen
 * at its submission). Throws `OrderIntakeError` for a type with no order or a
 * plan the site does not sell for it now.
 */
async function intakeOrder(
  tx: TenantTransaction,
  input: CreateLeadInput,
): Promise<Record<string, unknown> | undefined> {
  if (!input.order) return undefined;
  if (!isOrderLeadType(input.leadType)) throw new OrderIntakeError('invalid_request');
  const found = await loadPlanForFreeze(tx, input.workspaceId, input.order.planId);
  if (!isPlanAvailable(found, input.leadType)) throw new OrderIntakeError('plan_not_available');
  return input.submit
    ? submittedOrder(found, input.order.quantity, new Date())
    : { planId: input.order.planId, quantity: input.order.quantity };
}

/** A new draft grant for a lead; only its hash is stored, so the token is returned once. */
async function issueDraftGrant(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<{ token: string; expiresAt: string }> {
  const { token, tokenHash } = generateDraftGrantToken();
  const expiresAt = new Date(Date.now() + DEFAULT_DRAFT_GRANT_TTL_SECONDS * 1000);
  await tx.insert(draftGrants).values({ workspaceId, leadId, tokenHash, expiresAt });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * The result a replayed keyed create returns: the lead the key created, as a
 * fresh create would have described it. A draft still open gets a new grant
 * (the first token was never stored); a submitted, deleted or restricted lead
 * gets none. Nothing else is written.
 */
async function replayCreatedLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<CreateLeadResult> {
  const [row] = await tx
    .select({
      id: leads.id,
      workspaceId: leads.workspaceId,
      status: leads.status,
      updatedAt: leads.updatedAt,
      deletedAt: leads.deletedAt,
      customerDataRestrictedAt: leads.customerDataRestrictedAt,
    })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .limit(1);
  if (!row) throw new Error('idempotency_lead_missing');
  const open =
    row.status === 'incomplete' && row.deletedAt === null && row.customerDataRestrictedAt === null;
  return {
    lead: toSummary(row),
    grant: open ? await issueDraftGrant(tx, workspaceId, row.id) : null,
    replayed: true,
  };
}

/**
 * A refused update, thrown so its transaction rolls back: an idempotency key
 * claimed earlier in it is then never left pending. `updateLead` returns the
 * outcome.
 */
class UpdateRefused extends Error {
  constructor(readonly outcome: UpdateLeadOutcome) {
    super(`lead update refused: ${outcome.status}`);
    this.name = 'UpdateRefused';
  }
}

/** The `payload` of a stored form envelope, or null when the lead holds none. */
function storedPayload(stored: unknown): Readonly<Record<string, unknown>> | null {
  const form = leadFormSchema.safeParse(stored);
  return form.success ? form.data.payload : null;
}

/** The plan and quantity a draft of an order type was saved with, when it names a plan. */
function resumedOrder(leadType: string, stored: unknown): { order?: LeadOrderIntake } {
  if (!isOrderLeadType(leadType)) return {};
  const order = toLeadOrder(stored);
  return order.planId === null ? {} : { order: { planId: order.planId, quantity: order.quantity } };
}

export class DatabaseLeadStore implements LeadStore {
  constructor(
    private readonly database: LeadDatabase = defaultLeadDatabase,
    /** What customer mail needs from the deployment: the provider, the hash secret, fallback senders. */
    private readonly emailEnvironment: CustomerEmailEnvironment = customerEmailEnvironmentFromEnv(),
    private readonly automations: AutomationStore = new DatabaseAutomationStore(database),
  ) {}

  /**
   * The rules a website submission fires, once per lead (`submitted`), as
   * the website's credential. Their skips are recorded as runs; nobody on
   * the website is told. A replayed submit never reaches here.
   */
  private async fireSubmitAutomations(
    tx: TenantTransaction,
    input: { workspaceId: string; actorId: string; requestId: string },
    leadId: string,
    leadType: string,
  ): Promise<void> {
    const automations = automationsForSubmit(leadType);
    if (automations.length === 0) return;
    await runAutomations(tx, {
      ...input,
      lead: await readAutomationLead(tx, input.workspaceId, leadId),
      automations,
      occurrence: 'submitted',
      environment: this.emailEnvironment,
      store: this.automations,
    });
  }

  async readLead(
    input: Pick<UpdateLeadInput, 'workspaceId' | 'actorId' | 'leadId' | 'grantToken'>,
  ): Promise<ReadLeadOutcome> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [row] = await tx
          .select({
            lead: leads,
            expiresAt: draftGrants.expiresAt,
            revokedAt: draftGrants.revokedAt,
          })
          .from(draftGrants)
          .innerJoin(
            leads,
            and(eq(leads.workspaceId, draftGrants.workspaceId), eq(leads.id, draftGrants.leadId)),
          )
          .where(
            and(
              eq(draftGrants.workspaceId, input.workspaceId),
              isNull(leads.customerDataRestrictedAt),
              isNull(leads.deletedAt),
              eq(draftGrants.leadId, input.leadId),
              eq(draftGrants.tokenHash, hashDraftGrantToken(input.grantToken)),
            ),
          )
          .limit(1);
        if (!row) return { status: 'grant_invalid' };
        if (row.revokedAt || row.expiresAt.getTime() <= Date.now())
          return { status: 'grant_expired' };
        if (row.lead.status !== 'incomplete') return { status: 'draft_submitted' };
        return {
          status: 'read',
          draft: {
            leadId: row.lead.id,
            leadType: leadTypeSchema.parse(row.lead.leadType),
            contact: leadContactSchema.parse({
              fullName: row.lead.fullName ?? undefined,
              email: row.lead.email ?? undefined,
              phone: row.lead.phone ?? undefined,
              countryCode: row.lead.countryCode ?? undefined,
            }),
            form: row.lead.payload === null ? null : leadFormSchema.parse(row.lead.payload),
            ...resumedOrder(row.lead.leadType, row.lead.orderDetails),
          },
        };
      },
    );
  }

  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const now = new Date();
        // The claim comes first: a concurrent duplicate waits here, on the
        // key's unique index, before touching the contact or the lead.
        let claimId: string | undefined;
        if (input.idempotency) {
          const claim = await claimIdempotencyKey(tx, {
            ...input.idempotency,
            workspaceId: input.workspaceId,
            now,
          });
          if (claim.kind === 'conflict') throw new IdempotencyError('idempotency_conflict');
          if (claim.kind === 'in_progress') throw new IdempotencyError('idempotency_in_progress');
          if (claim.kind === 'replay')
            return replayCreatedLead(tx, input.workspaceId, claim.leadId);
          claimId = claim.id;
        }

        const attribution = sanitizeAttribution(input.attribution);
        const status = input.submit ? 'submitted' : 'incomplete';
        const orderDetails = await intakeOrder(tx, input);
        const contactId = input.contact?.email
          ? await upsertContact(tx, { ...input.contact, email: input.contact.email })
          : null;

        const [leadRow] = await tx
          .insert(leads)
          .values({
            workspaceId: input.workspaceId,
            leadType: input.leadType,
            status,
            stage: initialLeadStage(input.leadType),
            fullName: input.contact?.fullName,
            email: input.contact?.email,
            phone: input.contact?.phone,
            countryCode: input.contact?.countryCode,
            contactId,
            externalRef: input.externalRef ?? null,
            payload: input.form ?? null,
            attribution,
            consentVersion: input.consentVersion,
            ...(orderDetails ? { orderDetails } : {}),
          })
          .returning({
            id: leads.id,
            workspaceId: leads.workspaceId,
            status: leads.status,
            updatedAt: leads.updatedAt,
          });
        if (!leadRow) throw new Error('lead insert did not return a row');

        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'website credential',
          action: 'lead.created',
          entity: 'lead',
          entityId: leadRow.id,
          requestId: input.requestId,
          after: {
            status,
            leadType: input.leadType,
            externalRef: input.externalRef ?? null,
            contactId,
            consentVersion: input.consentVersion,
            ...(orderDetails ? { order: orderDetails } : {}),
          },
        });
        if (input.submit) {
          await this.fireSubmitAutomations(tx, input, leadRow.id, input.leadType);
        }

        if (claimId) {
          await completeIdempotencyKey(tx, {
            workspaceId: input.workspaceId,
            id: claimId,
            leadId: leadRow.id,
            now,
          });
        }

        // Websites keep their own conversion events until phase 3 (docs/PLAN.md
        // §5.8, §5.10: the server-side analytics sink was dropped), so intake
        // queues no analytics job; one with no provider would only fail.
        if (input.submit) return { lead: toSummary(leadRow), grant: null, replayed: false };

        return {
          lead: toSummary(leadRow),
          grant: await issueDraftGrant(tx, input.workspaceId, leadRow.id),
          replayed: false,
        };
      },
    );
  }

  async updateLead(input: UpdateLeadInput): Promise<UpdateLeadOutcome> {
    try {
      return await this.updateLeadInTransaction(input);
    } catch (error) {
      if (error instanceof UpdateRefused) return error.outcome;
      throw error;
    }
  }

  private async updateLeadInTransaction(input: UpdateLeadInput): Promise<UpdateLeadOutcome> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const tokenHash = hashDraftGrantToken(input.grantToken);
        // Matching on lead_id AND token_hash together means a real grant that
        // simply belongs to a *different* lead is indistinguishable from a
        // forged token — both resolve to zero rows. Joining the lead lets a
        // submitted draft be rejected before any write. Lock through the save
        // so submission and edits cannot act on an earlier incomplete status.
        const [grant] = await tx
          .select({
            id: draftGrants.id,
            expiresAt: draftGrants.expiresAt,
            revokedAt: draftGrants.revokedAt,
            leadStatus: leads.status,
            leadUpdatedAt: leads.updatedAt,
            leadFullName: leads.fullName,
            leadEmail: leads.email,
            leadPhone: leads.phone,
            leadType: leads.leadType,
            leadPayload: leads.payload,
            orderDetails: leads.orderDetails,
          })
          .from(draftGrants)
          .innerJoin(
            leads,
            and(eq(leads.workspaceId, draftGrants.workspaceId), eq(leads.id, draftGrants.leadId)),
          )
          .where(
            and(
              eq(draftGrants.workspaceId, input.workspaceId),
              isNull(leads.customerDataRestrictedAt),
              isNull(leads.deletedAt),
              eq(draftGrants.leadId, input.leadId),
              eq(draftGrants.tokenHash, tokenHash),
            ),
          )
          .limit(1)
          .for('update');

        if (!grant) return { status: 'grant_invalid' };

        // A keyed submit claims its key under the grant lock, so a retry of
        // the same submit waits for the first and then replays it. Every
        // refusal below throws `UpdateRefused`, rolling the claim back.
        const now = new Date();
        const idempotency = input.submit ? input.idempotency : undefined;
        let claimId: string | undefined;
        if (idempotency) {
          const claim = await claimIdempotencyKey(tx, {
            ...idempotency,
            workspaceId: input.workspaceId,
            now,
          });
          if (claim.kind === 'conflict') return { status: 'idempotency_conflict' };
          if (claim.kind === 'in_progress') return { status: 'idempotency_in_progress' };
          if (claim.kind === 'replay') {
            // The key submitted another lead, or never submitted this one.
            if (claim.leadId !== input.leadId || grant.leadStatus === 'incomplete') {
              return { status: 'idempotency_conflict' };
            }
            const lead = toSummary({
              id: input.leadId,
              workspaceId: input.workspaceId,
              status: grant.leadStatus,
              updatedAt: grant.leadUpdatedAt,
            });
            return { status: 'updated', lead, replayed: true };
          }
          claimId = claim.id;
        }

        if (grant.revokedAt !== null || grant.expiresAt.getTime() <= Date.now()) {
          throw new UpdateRefused({ status: 'grant_expired' });
        }
        // A submitted draft's grant must not authorise further edits to the
        // lead's contact, form or attribution.
        if (grant.leadStatus !== 'incomplete') {
          throw new UpdateRefused({ status: 'draft_submitted' });
        }

        // The form, the submission and the order are settled before anything
        // is written, so a refusal changes nothing.
        const form = checkLeadForm(grant.leadType, input.form);
        if (!form.ok) {
          throw new UpdateRefused({ status: 'submission_incomplete', problem: form.problem });
        }
        const updates: Partial<typeof leads.$inferInsert> = { updatedAt: now };
        const changedFields: string[] = [];
        if (input.order && !isOrderLeadType(grant.leadType)) {
          throw new UpdateRefused({ status: 'order_not_allowed' });
        }
        const draftOrder = toLeadOrder(grant.orderDetails);
        const planId = input.order?.planId ?? draftOrder.planId;
        const quantity = input.order?.quantity ?? draftOrder.quantity;
        if (input.submit) {
          const ready = checkLeadSubmit(grant.leadType, {
            contact: {
              fullName: input.contact?.fullName ?? grant.leadFullName ?? undefined,
              email: input.contact?.email ?? grant.leadEmail ?? undefined,
              phone: input.contact?.phone ?? grant.leadPhone ?? undefined,
            },
            payload: input.form?.payload ?? storedPayload(grant.leadPayload),
            planId,
          });
          if (!ready.ok) {
            throw new UpdateRefused({ status: 'submission_incomplete', problem: ready.problem });
          }
        }
        if (planId !== null && (input.order || input.submit)) {
          const found = await loadPlanForFreeze(tx, input.workspaceId, planId);
          if (!isPlanAvailable(found, grant.leadType)) {
            throw new UpdateRefused({ status: 'plan_not_available' });
          }
          // A draft keeps the plan and quantity only; submission freezes the plan as sold now.
          updates.orderDetails = input.submit
            ? submittedOrder(found, quantity, now)
            : { planId, quantity };
          changedFields.push('order');
        }
        if (input.submit) {
          updates.status = 'submitted';
          changedFields.push('status');
        }
        if (input.contact) {
          if (input.contact.fullName !== undefined) updates.fullName = input.contact.fullName;
          if (input.contact.email !== undefined) updates.email = input.contact.email;
          if (input.contact.phone !== undefined) updates.phone = input.contact.phone;
          if (input.contact.countryCode !== undefined) {
            updates.countryCode = input.contact.countryCode;
          }
          changedFields.push('contact');
          // Re-resolve the person whenever an email is known: a draft that
          // started anonymous joins its contact as soon as the address arrives.
          const email = input.contact.email ?? grant.leadEmail ?? undefined;
          if (email) {
            updates.contactId = await upsertContact(tx, { ...input.contact, email });
            changedFields.push('contactId');
          }
        }
        if (input.form !== undefined) {
          updates.payload = input.form;
          changedFields.push('form');
        }
        if (input.consentVersion !== undefined) {
          updates.consentVersion = input.consentVersion;
          changedFields.push('consentVersion');
        }
        if (input.attribution !== undefined) {
          updates.attribution = sanitizeAttribution(input.attribution);
          changedFields.push('attribution');
        }

        const [row] = await tx
          .update(leads)
          .set(updates)
          .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)))
          .returning({
            id: leads.id,
            workspaceId: leads.workspaceId,
            status: leads.status,
            updatedAt: leads.updatedAt,
          });
        // The grant resolved but the lead itself is gone — treat identically
        // to an invalid grant.
        if (!row) throw new UpdateRefused({ status: 'grant_invalid' });

        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'website credential',
          action: 'lead.updated',
          entity: 'lead',
          entityId: input.leadId,
          requestId: input.requestId,
          after: {
            changedFields,
            ...(updates.orderDetails ? { order: updates.orderDetails } : {}),
          },
        });
        if (input.submit) {
          await this.fireSubmitAutomations(tx, input, input.leadId, grant.leadType);
        }

        if (claimId) {
          await completeIdempotencyKey(tx, {
            workspaceId: input.workspaceId,
            id: claimId,
            leadId: input.leadId,
            now,
          });
        }

        return { status: 'updated', lead: toSummary(row) };
      },
    );
  }

  async listLeads(input: ListLeadsInput): Promise<ListLeadsResult> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const page = input.page ?? 1;
        const pageSize = input.pageSize ?? 25;
        const result = await selectLeadPage(
          tx,
          {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            status: input.status,
            leadType: input.leadType,
            stage: input.stage,
            assignee: input.assignee,
            search: input.search,
            view: input.view,
            dueBy: input.dueBy,
            where: input.where,
            sort: input.sort,
            columns: input.columns,
            catalog: input.catalog,
          },
          page,
          pageSize,
        );
        return { leads: result.leads, page: { page, pageSize, total: result.total } };
      },
    );
  }
}
