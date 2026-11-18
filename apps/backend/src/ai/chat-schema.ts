import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';

/**
 * Whether the database already holds what Ask AI's saved chat needs.
 *
 * Migrations are applied by hand, after the deploy (docs/RUNBOOKS/database.md),
 * so this backend may run against a database without 0034–0036 for a while.
 * Until then the assistant works exactly as before (memory-only, the browser
 * holds the conversation), capabilities never claim `conversations`, the
 * conversation and attachment routes answer 503, and a turn's usage row is
 * written without the `input_tokens` column. Like the erasure function's
 * check in `retention/abandoned-leads.ts`, this asks the catalogue, never the
 * migration journal (which the runtime role cannot read).
 *
 * The answer is cached: a ready schema stays ready (migrations are never
 * rolled back), a missing one is asked again after `recheckMs`.
 */
export interface AiChatSchemaState {
  /** 0034 and 0035: the three tables exist and the runtime role holds its grants on them. */
  readonly conversations: boolean;
  /** 0034: `app.ai_turns.input_tokens` exists. */
  readonly inputTokens: boolean;
  /** 0036: the unsent-attachment sweep function exists and the runtime role may run it. */
  readonly attachmentSweep: boolean;
}

export interface AiChatSchemaProbe {
  /** The current state; rejects only when the database cannot be asked. */
  state(scope: TenantContext): Promise<AiChatSchemaState>;
}

/** How long a not-yet-ready answer is kept before the catalogue is asked again. */
export const AI_CHAT_SCHEMA_RECHECK_MS = 5 * 60_000;

function ready(state: AiChatSchemaState): boolean {
  return state.conversations && state.inputTokens && state.attachmentSweep;
}

export class DatabaseAiChatSchemaProbe implements AiChatSchemaProbe {
  private cached: { state: AiChatSchemaState; at: number } | undefined;
  private pending: Promise<AiChatSchemaState> | undefined;

  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    private readonly options: { recheckMs?: number; now?: () => number } = {},
  ) {}

  async state(scope: TenantContext): Promise<AiChatSchemaState> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cached;
    if (
      cached &&
      (ready(cached.state) ||
        now - cached.at < (this.options.recheckMs ?? AI_CHAT_SCHEMA_RECHECK_MS))
    ) {
      return cached.state;
    }
    // One question at a time; a failure is not cached, so the next call asks again.
    this.pending ??= this.ask(scope)
      .then((state) => {
        this.cached = { state, at: (this.options.now ?? Date.now)() };
        return state;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private ask(scope: TenantContext): Promise<AiChatSchemaState> {
    return this.database.withTenantTx(scope, async (tx) => {
      // `has_table_privilege` raises for a missing table, so each is asked only
      // once its table is known to exist.
      const [row] = await tx.execute<{
        conversations: boolean;
        inputTokens: boolean;
        attachmentSweep: boolean;
      }>(sql`
        select
          (
            case when to_regclass('app.ai_conversations') is not null
              then has_table_privilege('app.ai_conversations', 'SELECT, INSERT, UPDATE, DELETE')
              else false end
            and case when to_regclass('app.ai_messages') is not null
              then has_table_privilege('app.ai_messages', 'SELECT, INSERT')
              else false end
            and case when to_regclass('app.ai_attachments') is not null
              then has_table_privilege('app.ai_attachments', 'SELECT, INSERT, UPDATE, DELETE')
              else false end
          ) as conversations,
          exists (
            select 1 from pg_catalog.pg_attribute a
            where a.attrelid = to_regclass('app.ai_turns')
              and a.attname = 'input_tokens' and not a.attisdropped
          ) as "inputTokens",
          case when to_regprocedure('app.sweep_unsent_ai_attachments(uuid,timestamptz,integer)') is not null
            then has_function_privilege(
              'app.sweep_unsent_ai_attachments(uuid,timestamptz,integer)', 'EXECUTE')
            else false end as "attachmentSweep"
      `);
      return {
        conversations: row?.conversations === true,
        inputTokens: row?.inputTokens === true,
        attachmentSweep: row?.attachmentSweep === true,
      };
    });
  }
}

/** A fixed answer, for tests and wiring that already know the schema. */
export function fixedAiChatSchema(state: Partial<AiChatSchemaState> = {}): AiChatSchemaProbe {
  const answer: AiChatSchemaState = {
    conversations: true,
    inputTokens: true,
    attachmentSweep: true,
    ...state,
  };
  return { state: async () => answer };
}
