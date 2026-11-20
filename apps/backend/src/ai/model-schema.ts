import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';

/**
 * Whether the database already holds a site's Ask AI model settings
 * (migration 0040, `app.ai_model_settings`).
 *
 * Migrations are applied by hand, after the deploy (docs/RUNBOOKS/database.md),
 * so this backend may run against a database without 0040 for a while. Until
 * then Ask AI works exactly as before: every turn is served by
 * `AI_GATEWAY_MODEL` (and High's own model), capabilities list no `models`, a
 * chat naming a `model` is refused as `model_unavailable`, and Settings → AI
 * models says model choice is not switched on yet and cannot save. Like
 * `chat-schema.ts` this asks the catalogue, never the migration journal
 * (which the runtime role cannot read), and caches the answer the same way: a
 * ready schema stays ready (migrations are never rolled back), a missing one
 * is asked again after `recheckMs`.
 */
export interface AiModelSchemaProbe {
  /** True once the table exists and the runtime role holds every grant 0040 gives it; rejects only when the database cannot be asked. */
  ready(scope: TenantContext): Promise<boolean>;
}

/** How long a not-yet-ready answer is kept before the catalogue is asked again. */
export const AI_MODEL_SCHEMA_RECHECK_MS = 5 * 60_000;

/** The grants 0040 gives the runtime role, each asked on its own (a list is true when ANY is held). */
const REQUIRED_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE'] as const;

export class DatabaseAiModelSchemaProbe implements AiModelSchemaProbe {
  private cached: { ready: boolean; at: number } | undefined;
  private pending: Promise<boolean> | undefined;

  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    private readonly options: { recheckMs?: number; now?: () => number } = {},
  ) {}

  async ready(scope: TenantContext): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cached;
    if (
      cached &&
      (cached.ready || now - cached.at < (this.options.recheckMs ?? AI_MODEL_SCHEMA_RECHECK_MS))
    )
      return cached.ready;
    // One question at a time; a failure is not cached, so the next call asks again.
    this.pending ??= this.ask(scope)
      .then((ready) => {
        this.cached = { ready, at: (this.options.now ?? Date.now)() };
        return ready;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private ask(scope: TenantContext): Promise<boolean> {
    return this.database.withTenantTx(scope, async (tx) => {
      // `has_table_privilege` raises for a missing table, so it is asked only
      // once the table is known to exist.
      const [row] = await tx.execute<{ ready: boolean }>(sql`
        select case when to_regclass('app.ai_model_settings') is not null then (
          ${sql.join(
            REQUIRED_PRIVILEGES.map((privilege) =>
              sql.raw(`has_table_privilege('app.ai_model_settings', '${privilege}')`),
            ),
            sql` and `,
          )}
        ) else false end as ready
      `);
      return row?.ready === true;
    });
  }
}

/** A fixed answer, for tests and wiring that already know the schema. */
export function fixedAiModelSchema(ready = true): AiModelSchemaProbe {
  return { ready: async () => ready };
}
