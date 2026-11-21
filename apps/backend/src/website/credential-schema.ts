import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';

/**
 * Whether the database holds each website key's permitted lead types:
 * migration 0043 adds `app.service_credentials.lead_types` (issue #84).
 *
 * Migrations are applied by hand, after the deploy (docs/RUNBOOKS/database.md),
 * so this backend may run against a database without the column. Until then
 * no key is limited (intake works as it did before), the key list shows no
 * lead types, and issuing a key answers `503 credential_lead_types_unavailable`
 * rather than store a key whose chosen types would be lost. Like
 * `leads/task-schema.ts` this asks the catalogue, never the migration journal
 * (which the runtime role cannot read), and caches the answer the same way: a
 * ready schema stays ready (migrations are never rolled back), a missing one
 * is asked again after `recheckMs`.
 */
export interface CredentialLeadTypesSchemaProbe {
  /** True once the column exists; asked inside the caller's own transaction. */
  ready(tx: Pick<TenantTransaction, 'execute'>): Promise<boolean>;
}

/** How long a not-yet-ready answer is kept before the catalogue is asked again. */
export const CREDENTIAL_LEAD_TYPES_RECHECK_MS = 5 * 60_000;

export class DatabaseCredentialLeadTypesSchemaProbe implements CredentialLeadTypesSchemaProbe {
  private cached: { ready: boolean; at: number } | undefined;

  constructor(private readonly options: { recheckMs?: number; now?: () => number } = {}) {}

  async ready(tx: Pick<TenantTransaction, 'execute'>): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cached;
    if (
      cached &&
      (cached.ready ||
        now - cached.at < (this.options.recheckMs ?? CREDENTIAL_LEAD_TYPES_RECHECK_MS))
    )
      return cached.ready;
    const [row] = await tx.execute<{ ready: boolean }>(sql`
      select exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = to_regclass('app.service_credentials')
          and a.attname = 'lead_types' and not a.attisdropped
      ) as ready
    `);
    const ready = row?.ready === true;
    this.cached = { ready, at: (this.options.now ?? Date.now)() };
    return ready;
  }
}

/** A fixed answer, for tests and wiring that already know the schema. */
export function fixedCredentialLeadTypesSchema(ready = true): CredentialLeadTypesSchemaProbe {
  return { ready: async () => ready };
}

/** The one probe the process shares, so the catalogue is asked once, not once per store. */
export const credentialLeadTypesSchema: CredentialLeadTypesSchemaProbe =
  new DatabaseCredentialLeadTypesSchemaProbe();

/**
 * Whether the website key `credentialId` may create or save a lead of
 * `leadType`, read inside the write's own transaction so the answer and the
 * write are one. A key with no list (`null`: made before the column) and a
 * database without the column limit nothing; a key that is not in this site
 * is permitted nothing.
 */
export async function credentialPermitsLeadType(
  tx: Pick<TenantTransaction, 'execute'>,
  input: { workspaceId: string; credentialId: string; leadType: string },
  probe: CredentialLeadTypesSchemaProbe = credentialLeadTypesSchema,
): Promise<boolean> {
  if (!(await probe.ready(tx))) return true;
  const [row] = await tx.execute<{ leadTypes: string[] | null }>(sql`
    select lead_types as "leadTypes" from app.service_credentials
    where workspace_id = ${input.workspaceId} and id = ${input.credentialId}
  `);
  if (!row) return false;
  return row.leadTypes === null || row.leadTypes.includes(input.leadType);
}
