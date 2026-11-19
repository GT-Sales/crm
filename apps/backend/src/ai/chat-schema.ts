import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';

/**
 * Whether the database already holds what Ask AI's saved chat needs.
 *
 * Migrations are applied by hand, after the deploy (docs/RUNBOOKS/database.md),
 * so this backend may run against a database without 0034–0039 for a while.
 * Until then the assistant works exactly as before (memory-only, the browser
 * holds the conversation), capabilities never claim `conversations`, the
 * conversation and attachment routes answer 503, and a turn's usage row is
 * written without the `input_tokens` column. Before 0037 the rows of a turn
 * are written without their `effort` columns: High turns still run, and the
 * usage page counts no High turns. Like the erasure function's check in
 * `retention/abandoned-leads.ts`, this asks the catalogue, never the migration
 * journal (which the runtime role cannot read).
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
  /** 0037: `app.ai_turns.effort` exists (and with it `app.ai_messages.effort`). */
  readonly effort: boolean;
  /**
   * 0039: `app.ai_messages.erased_at` exists and the runtime role may run the
   * chat erasure and departed-member functions. Until then the scheduler's
   * cleanup of erased files and of departed members' chats is skipped; a
   * restriction still keeps the turns out of every replay (history reads the
   * lead's state itself).
   */
  readonly chatErasure: boolean;
}

export interface AiChatSchemaProbe {
  /** The current state; rejects only when the database cannot be asked. */
  state(scope: TenantContext): Promise<AiChatSchemaState>;
}

/** How long a not-yet-ready answer is kept before the catalogue is asked again. */
export const AI_CHAT_SCHEMA_RECHECK_MS = 5 * 60_000;

/** Every grant 0035 gives the runtime role on the saved chat's tables, one by one. */
const REQUIRED_GRANTS: readonly (readonly [string, string])[] = [
  ...['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map(
    (privilege) => ['ai_conversations', privilege] as const,
  ),
  ...['SELECT', 'INSERT'].map((privilege) => ['ai_messages', privilege] as const),
  ...['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map(
    (privilege) => ['ai_attachments', privilege] as const,
  ),
];

function ready(state: AiChatSchemaState): boolean {
  return (
    state.conversations &&
    state.inputTokens &&
    state.attachmentSweep &&
    state.effort &&
    state.chatErasure
  );
}

/** The functions 0039 adds, each of which the runtime role must be able to run. */
const ERASURE_FUNCTIONS: readonly string[] = [
  'app.erase_restricted_lead_ai_turns(uuid,uuid[])',
  'app.erased_ai_attachments(uuid,integer)',
  'app.delete_erased_ai_attachments(uuid,uuid[])',
  'app.departed_ai_conversations(uuid,timestamptz,integer)',
  'app.delete_departed_ai_conversations(uuid,timestamptz,uuid[])',
];

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
      // once its table is known to exist; and it is true for a list when ANY
      // listed privilege is held, so every privilege is asked on its own (a
      // half-applied 0035 must read as not ready).
      const [row] = await tx.execute<{
        conversations: boolean;
        inputTokens: boolean;
        attachmentSweep: boolean;
        effort: boolean;
        chatErasure: boolean;
      }>(sql`
        select
          (
            ${sql.join(
              REQUIRED_GRANTS.map(([table, privilege]) =>
                sql.raw(
                  `case when to_regclass('app.${table}') is not null then has_table_privilege('app.${table}', '${privilege}') else false end`,
                ),
              ),
              sql` and `,
            )}
          ) as conversations,
          exists (
            select 1 from pg_catalog.pg_attribute a
            where a.attrelid = to_regclass('app.ai_turns')
              and a.attname = 'input_tokens' and not a.attisdropped
          ) as "inputTokens",
          case when to_regprocedure('app.sweep_unsent_ai_attachments(uuid,timestamptz,integer)') is not null
            then has_function_privilege(
              'app.sweep_unsent_ai_attachments(uuid,timestamptz,integer)', 'EXECUTE')
            else false end as "attachmentSweep",
          exists (
            select 1 from pg_catalog.pg_attribute a
            where a.attrelid = to_regclass('app.ai_turns')
              and a.attname = 'effort' and not a.attisdropped
          ) and (
            to_regclass('app.ai_messages') is null or exists (
              select 1 from pg_catalog.pg_attribute a
              where a.attrelid = to_regclass('app.ai_messages')
                and a.attname = 'effort' and not a.attisdropped
            )
          ) as effort,
          exists (
            select 1 from pg_catalog.pg_attribute a
            where a.attrelid = to_regclass('app.ai_messages')
              and a.attname = 'erased_at' and not a.attisdropped
          ) and ${sql.join(
            ERASURE_FUNCTIONS.map((signature) =>
              sql.raw(
                `case when to_regprocedure('${signature}') is not null then has_function_privilege('${signature}', 'EXECUTE') else false end`,
              ),
            ),
            sql` and `,
          )} as "chatErasure"
      `);
      return {
        conversations: row?.conversations === true,
        inputTokens: row?.inputTokens === true,
        attachmentSweep: row?.attachmentSweep === true,
        effort: row?.effort === true,
        chatErasure: row?.chatErasure === true,
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
    effort: true,
    chatErasure: true,
    ...state,
  };
  return { state: async () => answer };
}
