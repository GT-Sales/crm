import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient } from '@gt-sales/db';

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
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  async record(turn: AiTurnLog): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: turn.workspaceId, actorId: turn.actorId },
      (tx) =>
        tx.execute(sql`
          insert into app.ai_turns (
            workspace_id, actor_id, request_id, engine, model, prompt_version, outcome,
            failure_code, duration_ms, output_tokens, tool_calls, records, data_bytes,
            recovered_draft
          ) values (
            ${turn.workspaceId}, ${turn.actorId}, ${turn.requestId}, ${turn.engine},
            ${turn.modelId?.slice(0, 200) ?? null}, ${turn.promptVersion}, ${turn.outcome},
            ${turn.failureCode ?? null}, ${Math.max(0, Math.round(turn.durationMs))},
            ${turn.outputTokens ?? 0}, ${turn.toolCalls}, ${turn.records}, ${turn.dataBytes},
            ${turn.recoveredDraft === true}
          )
        `),
    );
  }
}
