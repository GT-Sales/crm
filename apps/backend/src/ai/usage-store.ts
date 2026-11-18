import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';
import type { AiUsageMember, AiUsagePeriod, AiUsageTotals } from '@gt-sales/contracts';

import { DatabaseAiChatSchemaProbe, type AiChatSchemaProbe } from './chat-schema.js';

/**
 * The owner's Ask AI usage view: turns and tokens per member over a period,
 * from `app.ai_turns`. The one read of the saved chat that spans members, and
 * it returns counts only: `ai_turns` holds no question, answer or file, and
 * conversations are never read here. `ai_turns` has a tenant policy, so the
 * owner's own transaction sees the site's rows.
 */
export interface AiUsageStore {
  usage(
    scope: TenantContext,
    period: AiUsagePeriod,
  ): Promise<{ totals: AiUsageTotals; members: AiUsageMember[] }>;
}

/** The most member rows the answer holds (the contract's bound). */
const AI_USAGE_MEMBERS_MAX = 1000;

export class DatabaseAiUsageStore implements AiUsageStore {
  private readonly schema: AiChatSchemaProbe;

  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    schema?: AiChatSchemaProbe,
  ) {
    this.schema = schema ?? new DatabaseAiChatSchemaProbe(database);
  }

  async usage(
    scope: TenantContext,
    period: AiUsagePeriod,
  ): Promise<{ totals: AiUsageTotals; members: AiUsageMember[] }> {
    // Before 0034 there is no input_tokens column: those turns count as 0.
    const inputTokens = (await this.schema.state(scope)).inputTokens ? sql`t.input_tokens` : sql`0`;
    const rows = await this.database.withTenantTx(scope, (tx) =>
      // One aggregate over the site's turns in the period (the
      // ai_turns_workspace_created_idx range), each member's display name
      // resolved as the assignee reads do: only while they are an active member.
      tx.execute<{
        actorId: string;
        displayName: string | null;
        turns: string;
        inputTokens: string;
        outputTokens: string;
        lastUsedAt: string;
      }>(sql`
        select u.actor_id as "actorId", m.display_name as "displayName",
          u.turns::text as turns, u.input_tokens::text as "inputTokens",
          u.output_tokens::text as "outputTokens", to_json(u.last_used_at)#>>'{}' as "lastUsedAt"
        from (
          select t.actor_id, count(*) as turns,
            coalesce(sum(${inputTokens}), 0) as input_tokens,
            coalesce(sum(t.output_tokens), 0) as output_tokens,
            max(t.created_at) as last_used_at
          from app.ai_turns t
          where t.workspace_id = ${scope.workspaceId}
            and t.created_at >= now() - ${period}::integer * interval '1 day'
          group by t.actor_id
        ) u
        left join app.memberships m
          on m.workspace_id = ${scope.workspaceId}
         and m.user_id = u.actor_id
         and m.status = 'active'
        order by u.input_tokens + u.output_tokens desc, u.turns desc, u.actor_id
        limit ${AI_USAGE_MEMBERS_MAX}
      `),
    );
    const members = rows.map((row): AiUsageMember => ({
      actorId: row.actorId,
      displayName: row.displayName,
      turns: Number(row.turns),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      lastUsedAt: new Date(row.lastUsedAt).toISOString(),
    }));
    return {
      totals: members.reduce(
        (totals, member) => ({
          turns: totals.turns + member.turns,
          inputTokens: totals.inputTokens + member.inputTokens,
          outputTokens: totals.outputTokens + member.outputTokens,
        }),
        { turns: 0, inputTokens: 0, outputTokens: 0 },
      ),
      members,
    };
  }
}
