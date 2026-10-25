import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  auditEvents,
  contacts,
  draftGrants,
  leads,
  outboxJobs,
  withTenantTx,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  attributionSchema,
  leadContactSchema,
  leadFormSchema,
  leadStatusSchema,
  leadTypeSchema,
  type LeadContact,
  type LeadForm,
  type LeadDraft,
  type LeadListItem,
  type LeadStatus,
  type LeadSummary,
  type RawAttribution,
} from '@gt-sales/contracts';

import { sanitizeAttribution } from './attribution.js';
import { deriveSource } from './source.js';
import { generateDraftGrantToken, hashDraftGrantToken } from './token.js';

/** Long enough for a customer to leave and resume the form later. */
const DEFAULT_DRAFT_GRANT_TTL_SECONDS = 60 * 60 * 24 * 30;

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
}

export interface CreateLeadResult {
  lead: LeadSummary;
  grant: { token: string; expiresAt: string };
}

export type UpdateLeadOutcome =
  | { status: 'updated'; lead: LeadSummary }
  | { status: 'grant_invalid' }
  | { status: 'grant_expired' }
  | { status: 'draft_submitted' };

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
}

export interface ListLeadsInput {
  workspaceId: string;
  actorId: string;
  status?: LeadStatus;
  leadType?: string;
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

export class DatabaseLeadStore implements LeadStore {
  constructor(private readonly database: LeadDatabase = defaultLeadDatabase) {}

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
          },
        };
      },
    );
  }

  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const attribution = sanitizeAttribution(input.attribution);
        const contactId = input.contact?.email
          ? await upsertContact(tx, { ...input.contact, email: input.contact.email })
          : null;

        const [leadRow] = await tx
          .insert(leads)
          .values({
            workspaceId: input.workspaceId,
            leadType: input.leadType,
            status: 'incomplete',
            fullName: input.contact?.fullName,
            email: input.contact?.email,
            phone: input.contact?.phone,
            countryCode: input.contact?.countryCode,
            contactId,
            externalRef: input.externalRef ?? null,
            payload: input.form ?? null,
            attribution,
            consentVersion: input.consentVersion,
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
            status: 'incomplete',
            leadType: input.leadType,
            externalRef: input.externalRef ?? null,
            contactId,
            consentVersion: input.consentVersion,
          },
        });

        const { token, tokenHash } = generateDraftGrantToken();
        const expiresAt = new Date(Date.now() + DEFAULT_DRAFT_GRANT_TTL_SECONDS * 1000);
        await tx.insert(draftGrants).values({
          workspaceId: input.workspaceId,
          leadId: leadRow.id,
          tokenHash,
          expiresAt,
        });

        // The lead conversion event is emitted once from the outbox (never from
        // the browser), deduped per lead by (workspace, job type, dedupe key).
        await tx.insert(outboxJobs).values({
          workspaceId: input.workspaceId,
          jobType: 'analytics_lead_saved',
          dedupeKey: leadRow.id,
          payload: { leadId: leadRow.id },
        });

        return { lead: toSummary(leadRow), grant: { token, expiresAt: expiresAt.toISOString() } };
      },
    );
  }

  async updateLead(input: UpdateLeadInput): Promise<UpdateLeadOutcome> {
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
            leadEmail: leads.email,
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
        if (grant.revokedAt !== null || grant.expiresAt.getTime() <= Date.now()) {
          return { status: 'grant_expired' };
        }
        // A submitted draft's grant must not authorise further edits to the
        // lead's contact, form or attribution.
        if (grant.leadStatus !== 'incomplete') return { status: 'draft_submitted' };

        const updates: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
        const changedFields: string[] = [];
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
        // to an invalid grant rather than throwing.
        if (!row) return { status: 'grant_invalid' };

        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'website credential',
          action: 'lead.updated',
          entity: 'lead',
          entityId: input.leadId,
          requestId: input.requestId,
          after: { changedFields },
        });

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
        const offset = (page - 1) * pageSize;

        const conditions = and(
          eq(leads.workspaceId, input.workspaceId),
          isNull(leads.customerDataRestrictedAt),
          isNull(leads.deletedAt),
          input.status ? eq(leads.status, input.status) : undefined,
          input.leadType ? eq(leads.leadType, input.leadType) : undefined,
        );

        const rows = await tx
          .select({
            id: leads.id,
            workspaceId: leads.workspaceId,
            leadType: leads.leadType,
            status: leads.status,
            fullName: leads.fullName,
            email: leads.email,
            phone: leads.phone,
            countryCode: leads.countryCode,
            contactId: leads.contactId,
            assignedActorId: leads.assignedActorId,
            externalRef: leads.externalRef,
            attribution: leads.attribution,
            consentVersion: leads.consentVersion,
            createdAt: leads.createdAt,
            updatedAt: leads.updatedAt,
          })
          .from(leads)
          .where(conditions)
          .orderBy(desc(leads.updatedAt))
          .limit(pageSize)
          .offset(offset);

        const [totalRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(leads)
          .where(conditions);

        const items: LeadListItem[] = rows.map((row) => {
          const attribution = attributionSchema.parse(row.attribution ?? {});
          return {
            id: row.id,
            workspaceId: row.workspaceId,
            leadType: leadTypeSchema.parse(row.leadType),
            status: leadStatusSchema.parse(row.status),
            contact: leadContactSchema.parse({
              fullName: row.fullName ?? undefined,
              email: row.email ?? undefined,
              phone: row.phone ?? undefined,
              countryCode: row.countryCode ?? undefined,
            }),
            contactId: row.contactId,
            assignedActorId: row.assignedActorId,
            externalRef: row.externalRef,
            source: deriveSource(attribution),
            attribution,
            consentVersion: row.consentVersion,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        });

        return { leads: items, page: { page, pageSize, total: totalRow?.count ?? 0 } };
      },
    );
  }
}
