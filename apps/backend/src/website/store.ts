import { and, desc, eq } from 'drizzle-orm';
import { auditEvents, type DatabaseClient, serviceCredentials, withTenantTx } from '@gt-sales/db';
import { websiteScopeSchema } from '@gt-sales/contracts';
import type { WebsiteScopeName } from '@gt-sales/types';

export interface ServiceCredentialRecord {
  id: string;
  scopes: WebsiteScopeName[];
  createdAt: string;
  revokedAt: string | null;
}

export interface CreateCredentialInput {
  actorId: string;
  workspaceId: string;
  scopes: readonly WebsiteScopeName[];
  secretHash: string;
  requestId: string;
}

export interface RevokeCredentialInput {
  actorId: string;
  workspaceId: string;
  credentialId: string;
  requestId: string;
}

export type RevokeCredentialResult =
  | { status: 'revoked'; revokedAt: string }
  | { status: 'already_revoked'; revokedAt: string }
  | { status: 'not_found' };

export interface WebsiteCredentialStore {
  createCredential(input: CreateCredentialInput): Promise<ServiceCredentialRecord>;
  listCredentials(input: {
    actorId: string;
    workspaceId: string;
  }): Promise<ServiceCredentialRecord[]>;
  revokeCredential(input: RevokeCredentialInput): Promise<RevokeCredentialResult>;
}

type CredentialDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const defaultCredentialDatabase: CredentialDatabase = { withTenantTx };

function toRecord(row: {
  id: string;
  scopes: string[];
  createdAt: Date;
  revokedAt: Date | null;
}): ServiceCredentialRecord {
  return {
    id: row.id,
    // Persisted scopes are validated back to the known scope union, never trusted blindly.
    scopes: websiteScopeSchema.array().parse(row.scopes),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

export class DatabaseWebsiteCredentialStore implements WebsiteCredentialStore {
  constructor(private readonly database: CredentialDatabase = defaultCredentialDatabase) {}

  async createCredential(input: CreateCredentialInput): Promise<ServiceCredentialRecord> {
    return this.database.withTenantTx(
      { actorId: input.actorId, workspaceId: input.workspaceId },
      async (tx) => {
        const [row] = await tx
          .insert(serviceCredentials)
          .values({
            workspaceId: input.workspaceId,
            secretHash: input.secretHash,
            scopes: [...input.scopes],
          })
          .returning({
            id: serviceCredentials.id,
            scopes: serviceCredentials.scopes,
            createdAt: serviceCredentials.createdAt,
            revokedAt: serviceCredentials.revokedAt,
          });
        if (!row) throw new Error('service credential insert did not return a row');

        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'service_credential.created',
          entity: 'service_credential',
          entityId: row.id,
          requestId: input.requestId,
          after: { scopes: [...input.scopes] },
        });

        return toRecord(row);
      },
    );
  }

  async listCredentials(input: {
    actorId: string;
    workspaceId: string;
  }): Promise<ServiceCredentialRecord[]> {
    return this.database.withTenantTx(
      { actorId: input.actorId, workspaceId: input.workspaceId },
      async (tx) => {
        const rows = await tx
          .select({
            id: serviceCredentials.id,
            scopes: serviceCredentials.scopes,
            createdAt: serviceCredentials.createdAt,
            revokedAt: serviceCredentials.revokedAt,
          })
          .from(serviceCredentials)
          .where(eq(serviceCredentials.workspaceId, input.workspaceId))
          .orderBy(desc(serviceCredentials.createdAt));
        return rows.map(toRecord);
      },
    );
  }

  async revokeCredential(input: RevokeCredentialInput): Promise<RevokeCredentialResult> {
    return this.database.withTenantTx(
      { actorId: input.actorId, workspaceId: input.workspaceId },
      async (tx) => {
        const [existing] = await tx
          .select({ id: serviceCredentials.id, revokedAt: serviceCredentials.revokedAt })
          .from(serviceCredentials)
          .where(
            and(
              eq(serviceCredentials.workspaceId, input.workspaceId),
              eq(serviceCredentials.id, input.credentialId),
            ),
          )
          .limit(1);
        if (!existing) return { status: 'not_found' };
        if (existing.revokedAt) {
          return { status: 'already_revoked', revokedAt: existing.revokedAt.toISOString() };
        }

        const revokedAt = new Date();
        await tx
          .update(serviceCredentials)
          .set({ revokedAt })
          .where(
            and(
              eq(serviceCredentials.workspaceId, input.workspaceId),
              eq(serviceCredentials.id, input.credentialId),
            ),
          );
        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'service_credential.revoked',
          entity: 'service_credential',
          entityId: input.credentialId,
          requestId: input.requestId,
          after: { revokedAt: revokedAt.toISOString() },
        });
        return { status: 'revoked', revokedAt: revokedAt.toISOString() };
      },
    );
  }
}
