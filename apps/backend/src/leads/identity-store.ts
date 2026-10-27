import { randomUUID } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';
import {
  auditEvents,
  leadIdentities,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  MAX_IDENTITIES_PER_LEAD,
  identityLeadTypes,
  type LeadIdentityType,
} from '@gt-sales/contracts';

import { openSensitiveValue, sealSensitiveValue } from '../crypto/cipher.js';
import { iso } from './staff-queries.js';

/**
 * The identity a customer gives for a credit check, sent by the website's
 * server right after the lead. A SIN is sealed under `SENSITIVE_FIELDS_KEY`
 * and bound to its own row, so the database holds nothing readable but the
 * last three digits; a licence is a verified `files` row. Until staff leave
 * the old admin, each identity on a CanadaWide mobility lead is also written
 * to its legacy table (migration 0006), in the same transaction.
 */

/** How long after a lead arrives its website may still send the customer's ID. */
export const IDENTITY_WINDOW_HOURS = 24;

/** The old admin's ID-photo bucket, which the transitional copy writes into. */
export const LEGACY_IDENTITY_BUCKET = 'mobility-ids';

interface Scope {
  workspaceId: string;
  actorId: string;
}

interface WriteScope extends Scope {
  requestId: string;
}

export type IdentityEligibility =
  | {
      status: 'eligible';
      /** The identity also belongs in the old admin, so a licence photo must be copied there first. */
      legacy: boolean;
    }
  | { status: 'not_found' | 'limit_reached' };

export interface RecordedIdentity {
  id: string;
  idType: LeadIdentityType;
  createdAt: string;
}

export type RecordIdentityOutcome =
  | {
      status: 'recorded';
      identity: RecordedIdentity;
      /** Written to the old admin's table as well. */
      mirrored: boolean;
      /** The same identity was already on the lead (a retried request); nothing new was written. */
      replayed: boolean;
    }
  | { status: 'not_found' | 'limit_reached' | 'file_not_usable' };

export type RevealIdentityOutcome =
  | { status: 'revealed'; sin: string }
  | { status: 'not_found' }
  /** Sealed under another key or damaged: nothing can open it. */
  | { status: 'unreadable' };

export interface RecordSinInput extends WriteScope {
  leadId: string;
  sin: string;
  dateOfBirth: string;
  consentedAt: Date;
}

export interface RecordLicenceInput extends WriteScope {
  leadId: string;
  fileId: string;
  /** The photo's key in the old admin's bucket when it was copied there, else null. */
  legacyPath: string | null;
  consentedAt: Date;
}

export interface IdentityStore {
  eligibility(input: Scope & { leadId: string }): Promise<IdentityEligibility>;
  recordSin(input: RecordSinInput): Promise<RecordIdentityOutcome>;
  recordLicence(input: RecordLicenceInput): Promise<RecordIdentityOutcome>;
  revealSin(
    input: WriteScope & { leadId: string; identityId: string },
  ): Promise<RevealIdentityOutcome>;
}

type IdentityDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const WEBSITE_ACTOR_LABEL = 'website credential';

/**
 * The lead, if its website may still add an identity: a type that takes one,
 * not trashed or restricted, and recent. Locked when `lock` is set, so two
 * submissions for one lead count each other.
 */
function eligibleLead(workspaceId: string, leadId: string, lock: boolean): SQL {
  const types = sql.join(
    identityLeadTypes.map((leadType) => sql`${leadType}`),
    sql`, `,
  );
  return sql`
    select
      l.id,
      (
        select count(*)::int
        from app.lead_identities i
        where i.workspace_id = l.workspace_id and i.lead_id = l.id
      ) as "identityCount"
      ${lock ? sql`` : sql`, app.canadawide_legacy_identity_applies(l.id) as legacy`}
    from app.leads l
    where l.workspace_id = ${workspaceId}
      and l.id = ${leadId}
      and l.lead_type in (${types})
      and l.deleted_at is null
      and l.customer_data_restricted_at is null
      and l.created_at > now() - make_interval(hours => ${IDENTITY_WINDOW_HOURS})
    ${lock ? sql`for update of l` : sql``}
  `;
}

async function lockEligibleLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<{ identityCount: number } | undefined> {
  const [row] = await tx.execute<{ id: string; identityCount: number }>(
    eligibleLead(workspaceId, leadId, true),
  );
  return row;
}

async function mirror(
  tx: TenantTransaction,
  input: {
    identityId: string;
    leadId: string;
    idType: LeadIdentityType;
    filePath: string | null;
    sin: string | null;
    dateOfBirth: string | null;
    consentedAt: Date;
  },
): Promise<boolean> {
  const [row] = await tx.execute<{ mirrored: boolean }>(sql`
    select app.mirror_canadawide_legacy_identity(
      ${input.identityId}::uuid,
      ${input.leadId}::uuid,
      ${input.idType}::text,
      ${input.filePath}::text,
      ${input.sin}::text,
      ${input.dateOfBirth}::date,
      ${input.consentedAt.toISOString()}::timestamptz
    ) as mirrored
  `);
  return row?.mirrored === true;
}

async function auditReceived(
  tx: TenantTransaction,
  input: WriteScope & { leadId: string; identityId: string; idType: LeadIdentityType },
  mirrored: boolean,
): Promise<void> {
  // The audit trail names the identity, never its contents.
  await tx.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorLabel: WEBSITE_ACTOR_LABEL,
    action: 'lead.identity_received',
    entity: 'lead',
    entityId: input.leadId,
    requestId: input.requestId,
    after: { identityId: input.identityId, idType: input.idType, legacyCopy: mirrored },
  });
}

export class DatabaseIdentityStore implements IdentityStore {
  constructor(
    private readonly secret: string,
    private readonly database: IdentityDatabase = { withTenantTx },
  ) {}

  eligibility(input: Scope & { leadId: string }): Promise<IdentityEligibility> {
    return this.database.withTenantTx(input, async (tx) => {
      const [row] = await tx.execute<{ id: string; identityCount: number; legacy: boolean }>(
        eligibleLead(input.workspaceId, input.leadId, false),
      );
      if (!row) return { status: 'not_found' };
      if (row.identityCount >= MAX_IDENTITIES_PER_LEAD) return { status: 'limit_reached' };
      return { status: 'eligible', legacy: row.legacy === true };
    });
  }

  recordSin(input: RecordSinInput): Promise<RecordIdentityOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockEligibleLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };

      // A retried request carries the same SIN: answer with the identity
      // already on file instead of keeping it twice.
      const candidates = await tx.execute<{ id: string; sinSealed: string; createdAt: string }>(sql`
        select i.id, i.sin_sealed as "sinSealed", ${iso('i.created_at')} as "createdAt"
        from app.lead_identities i
        where i.workspace_id = ${input.workspaceId}
          and i.lead_id = ${input.leadId}
          and i.id_type = 'sin'
          and i.sin_last3 = ${input.sin.slice(-3)}
          and i.date_of_birth = ${input.dateOfBirth}::date
      `);
      for (const candidate of candidates) {
        const opened = openSensitiveValue(
          this.secret,
          { workspaceId: input.workspaceId, recordId: candidate.id, field: 'sin' },
          candidate.sinSealed,
        );
        if (opened === input.sin) {
          return {
            status: 'recorded',
            identity: { id: candidate.id, idType: 'sin', createdAt: candidate.createdAt },
            mirrored: false,
            replayed: true,
          };
        }
      }
      if (lead.identityCount >= MAX_IDENTITIES_PER_LEAD) return { status: 'limit_reached' };

      const identityId = randomUUID();
      const [row] = await tx
        .insert(leadIdentities)
        .values({
          id: identityId,
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          idType: 'sin',
          sinSealed: sealSensitiveValue(
            this.secret,
            { workspaceId: input.workspaceId, recordId: identityId, field: 'sin' },
            input.sin,
          ),
          sinLast3: input.sin.slice(-3),
          dateOfBirth: input.dateOfBirth,
          creditCheckConsentAt: input.consentedAt,
          createdBy: input.actorId,
        })
        .returning({ createdAt: leadIdentities.createdAt });
      const mirrored = await mirror(tx, {
        identityId,
        leadId: input.leadId,
        idType: 'sin',
        filePath: null,
        sin: input.sin,
        dateOfBirth: input.dateOfBirth,
        consentedAt: input.consentedAt,
      });
      await auditReceived(tx, { ...input, identityId, idType: 'sin' }, mirrored);
      return {
        status: 'recorded',
        identity: { id: identityId, idType: 'sin', createdAt: row!.createdAt.toISOString() },
        mirrored,
        replayed: false,
      };
    });
  }

  recordLicence(input: RecordLicenceInput): Promise<RecordIdentityOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockEligibleLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };

      const [existing] = await tx.execute<{ id: string; createdAt: string }>(sql`
        select i.id, ${iso('i.created_at')} as "createdAt"
        from app.lead_identities i
        where i.workspace_id = ${input.workspaceId}
          and i.lead_id = ${input.leadId}
          and i.file_id = ${input.fileId}
        limit 1
      `);
      if (existing) {
        return {
          status: 'recorded',
          identity: { id: existing.id, idType: 'drivers_licence', createdAt: existing.createdAt },
          mirrored: false,
          replayed: true,
        };
      }
      if (lead.identityCount >= MAX_IDENTITIES_PER_LEAD) return { status: 'limit_reached' };

      // Only this lead's own verified licence photo can become its identity.
      const identityId = randomUUID();
      const [row] = await tx.execute<{ createdAt: string }>(sql`
        insert into app.lead_identities
          (id, workspace_id, lead_id, id_type, file_id, credit_check_consent_at, created_by)
        select
          ${identityId}::uuid, f.workspace_id, ${input.leadId}::uuid, 'drivers_licence', f.id,
          ${input.consentedAt.toISOString()}::timestamptz, ${input.actorId}::uuid
        from app.files f
        where f.workspace_id = ${input.workspaceId}
          and f.id = ${input.fileId}
          and f.record_type = 'lead'
          and f.record_id = ${input.leadId}
          and f.document_type = 'drivers_licence'
          and f.status = 'available'
        returning ${iso('created_at')} as "createdAt"
      `);
      if (!row) return { status: 'file_not_usable' };
      const mirrored = await mirror(tx, {
        identityId,
        leadId: input.leadId,
        idType: 'drivers_licence',
        filePath: input.legacyPath,
        sin: null,
        dateOfBirth: null,
        consentedAt: input.consentedAt,
      });
      await auditReceived(tx, { ...input, identityId, idType: 'drivers_licence' }, mirrored);
      return {
        status: 'recorded',
        identity: { id: identityId, idType: 'drivers_licence', createdAt: row.createdAt },
        mirrored,
        replayed: false,
      };
    });
  }

  revealSin(
    input: WriteScope & { leadId: string; identityId: string },
  ): Promise<RevealIdentityOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const [row] = await tx.execute<{ sinSealed: string }>(sql`
        select i.sin_sealed as "sinSealed"
        from app.lead_identities i
        inner join app.leads l on l.workspace_id = i.workspace_id and l.id = i.lead_id
        where i.workspace_id = ${input.workspaceId}
          and i.id = ${input.identityId}
          and i.lead_id = ${input.leadId}
          and i.id_type = 'sin'
          and l.customer_data_restricted_at is null
      `);
      if (!row) return { status: 'not_found' };
      const sin = openSensitiveValue(
        this.secret,
        { workspaceId: input.workspaceId, recordId: input.identityId, field: 'sin' },
        row.sinSealed,
      );
      if (sin === undefined) return { status: 'unreadable' };
      // Recorded before the number leaves: no audit row, no reveal.
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.identity_revealed',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        after: { identityId: input.identityId },
      });
      return { status: 'revealed', sin };
    });
  }
}
