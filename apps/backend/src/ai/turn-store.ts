import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient } from '@gt-sales/db';

import { DatabaseAiChatSchemaProbe, type AiChatSchemaProbe } from './chat-schema.js';
import type { AiTurnLog } from './logging.js';

/**
 * Ask AI usage, one row per turn (CHAT-6): the same allowlisted fields the
 * `ai_turn` log line carries, so "how many turns and tokens did this site use
 * this week" has an answer inside the CRM. Never a prompt, history, tool
 * input or answer. Rows are pruned after 90 days by operational retention.
 */
export interface AiTurnStore {
  record(turn: AiTurnLog): Promise<void>;
}

export class DatabaseAiTurnStore implements AiTurnStore {
  private readonly schema: AiChatSchemaProbe;

  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    schema?: AiChatSchemaProbe,
  ) {
    this.schema = schema ?? new DatabaseAiChatSchemaProbe(database);
  }

  async record(turn: AiTurnLog): Promise<void> {
    const scope = { workspaceId: turn.workspaceId, actorId: turn.actorId };
    // Until 0034 is applied the table has no input_tokens column; the row is
    // still written, without it (the log line carries the count either way).
    const inputTokens = await this.schema.state(scope).then(
      (state) => state.inputTokens,
      () => false,
    );
    const tokens = Math.max(0, Math.round(turn.inputTokens ?? 0));
    await this.database.withTenantTx(scope, (tx) =>
      tx.execute(sql`
        insert into app.ai_turns (
          workspace_id, actor_id, request_id, engine, model, prompt_version, outcome,
          failure_code, duration_ms, ${inputTokens ? sql`input_tokens, ` : sql``}output_tokens,
          tool_calls, records, data_bytes, recovered_draft
        ) values (
          ${turn.workspaceId}, ${turn.actorId}, ${turn.requestId}, ${turn.engine},
          ${turn.modelId?.slice(0, 200) ?? null}, ${turn.promptVersion}, ${turn.outcome},
          ${turn.failureCode ?? null}, ${Math.max(0, Math.round(turn.durationMs))},
          ${inputTokens ? sql`${tokens}, ` : sql``}${turn.outputTokens ?? 0},
          ${turn.toolCalls}, ${turn.records}, ${turn.dataBytes}, ${turn.recoveredDraft === true}
        )
      `),
    );
  }
}
