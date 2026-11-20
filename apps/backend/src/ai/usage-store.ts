import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';
import {
  AI_USAGE_MAX_FAILURE_CODES,
  AI_USAGE_MAX_MODELS,
  type AiUsageDay,
  type AiUsageFailure,
  type AiUsageMember,
  type AiUsageModel,
  type AiUsagePeriod,
  type AiUsageTotals,
} from '@gt-sales/contracts';

import { todayInToronto } from '../leads/stage-move.js';
import { DatabaseAiChatSchemaProbe, type AiChatSchemaProbe } from './chat-schema.js';
import type { AiUsageTokenBreakdown } from './usage-cost.js';

/**
 * The owner's Ask AI usage view, from `app.ai_turns`: totals and how turns
 * ended, one row per member, one per (engine, model) that served turns, a
 * day-by-day series, the failure reasons and the tokens per model by day and
 * by member that the approximate cost is priced from (`usage-cost.ts`). The one read of the saved chat
 * that spans members, and it returns numbers and bounded codes only:
 * `ai_turns` holds no question, answer or file, and conversations are never
 * read here. `ai_turns` has a tenant policy, so the owner's own transaction
 * sees the site's rows.
 *
 * The period is calendar days in `America/Toronto`, the business time zone:
 * "last 7 days" is today and the six days before it, from midnight in
 * Toronto six days ago up to the end of today. Every number in the answer
 * (totals, members, models, the series, failures) counts exactly those
 * turns, so the daily series always adds up to the totals.
 */
export interface AiUsageResult {
  totals: AiUsageTotals;
  members: AiUsageMember[];
  /** Absent only from a store that does not compute them (tests). */
  models?: AiUsageModel[];
  daily?: AiUsageDay[];
  failures?: AiUsageFailure[];
  /**
   * The same turns' tokens per (engine, model) by Toronto day and by member,
   * exact, for the approximate cost (`usage-cost.ts`). Never sent as it is.
   */
  tokens?: AiUsageTokenBreakdown;
}

export interface AiUsageStore {
  usage(scope: TenantContext, period: AiUsagePeriod): Promise<AiUsageResult>;
}

/** The most member rows the answer holds (the contract's bound). */
const AI_USAGE_MEMBERS_MAX = 1000;

/** The business time zone a day of the period is read in. */
const USAGE_TIME_ZONE = 'America/Toronto';

/** A stored failure code the contract accepts as it is; anything else reads as `unknown`. */
const FAILURE_CODE_PATTERN = '^[a-z][a-z0-9_]{0,59}$';

const toInt = (value: string | number | null): number => (value === null ? 0 : Number(value));
const toAverage = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

/** A token row's counts, the sums kept exact as bigints. */
function tokenCounts(row: {
  engine: string;
  model: string | null;
  turns: string;
  inputTokens: string;
  outputTokens: string;
}) {
  return {
    engine: row.engine,
    model: row.model,
    turns: toInt(row.turns),
    inputTokens: BigInt(row.inputTokens),
    outputTokens: BigInt(row.outputTokens),
  };
}

export class DatabaseAiUsageStore implements AiUsageStore {
  private readonly schema: AiChatSchemaProbe;

  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    schema?: AiChatSchemaProbe,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.schema = schema ?? new DatabaseAiChatSchemaProbe(database);
  }

  async usage(scope: TenantContext, period: AiUsagePeriod): Promise<AiUsageResult> {
    // Before 0034 there is no input_tokens column: those turns count as 0.
    const state = await this.schema.state(scope);
    const inputTokens = state.inputTokens ? sql`t.input_tokens` : sql`0`;
    // Before 0037 there is no effort column: no turn counts as High.
    const highTurns = state.effort
      ? sql`count(*) filter (where t.effort = 'high')`
      : sql`0::bigint`;
    const today = todayInToronto(this.now());
    const zone = sql.raw(`'${USAGE_TIME_ZONE}'`);
    // The period's first day and the day after today, as instants: a Toronto
    // midnight each, so the range keeps to ai_turns_workspace_created_idx.
    const firstDay = sql`(${today}::date - ${period - 1}::integer)`;
    const from = sql`(${firstDay}::timestamp at time zone ${zone})`;
    const until = sql`((${today}::date + 1)::timestamp at time zone ${zone})`;
    const inPeriod = sql`t.workspace_id = ${scope.workspaceId}
      and t.created_at >= ${from} and t.created_at < ${until}`;

    return this.database.withTenantTx(scope, async (tx) => {
      // Each member, their display name resolved as the assignee reads do:
      // only while they are an active member.
      const memberRows = await tx.execute<{
        actorId: string;
        displayName: string | null;
        turns: string;
        inputTokens: string;
        outputTokens: string;
        highEffortTurns: string;
        lastUsedAt: string;
      }>(sql`
        select u.actor_id as "actorId", m.display_name as "displayName",
          u.turns::text as turns, u.input_tokens::text as "inputTokens",
          u.output_tokens::text as "outputTokens", u.high_turns::text as "highEffortTurns",
          to_json(u.last_used_at)#>>'{}' as "lastUsedAt"
        from (
          select t.actor_id, count(*) as turns, ${highTurns} as high_turns,
            coalesce(sum(${inputTokens}), 0) as input_tokens,
            coalesce(sum(t.output_tokens), 0) as output_tokens,
            max(t.created_at) as last_used_at
          from app.ai_turns t
          where ${inPeriod}
          group by t.actor_id
        ) u
        left join app.memberships m
          on m.workspace_id = ${scope.workspaceId}
         and m.user_id = u.actor_id
         and m.status = 'active'
        order by u.input_tokens + u.output_tokens desc, u.turns desc, u.actor_id
        limit ${AI_USAGE_MEMBERS_MAX}
      `);

      // The totals (the empty grouping set, always one row) and each
      // (engine, model) pair, in one pass; durations average completed turns.
      const modelRows = await tx.execute<{
        total: boolean;
        engine: string | null;
        model: string | null;
        turns: string;
        completed: string;
        failed: string;
        cancelled: string;
        inputTokens: string;
        outputTokens: string;
        toolCalls: string;
        highEffortTurns: string;
        averageDurationMs: string | null;
        lastUsedAt: string | null;
      }>(sql`
        select grouping(t.engine, t.model) <> 0 as total, t.engine, t.model,
          count(*)::text as turns,
          (${highTurns})::text as "highEffortTurns",
          (count(*) filter (where t.outcome = 'completed'))::text as completed,
          (count(*) filter (where t.outcome = 'failed'))::text as failed,
          (count(*) filter (where t.outcome = 'cancelled'))::text as cancelled,
          coalesce(sum(${inputTokens}), 0)::text as "inputTokens",
          coalesce(sum(t.output_tokens), 0)::text as "outputTokens",
          coalesce(sum(t.tool_calls), 0)::text as "toolCalls",
          round(avg(t.duration_ms) filter (where t.outcome = 'completed'))::bigint::text
            as "averageDurationMs",
          to_json(max(t.created_at))#>>'{}' as "lastUsedAt"
        from app.ai_turns t
        where ${inPeriod}
        group by grouping sets ((), (t.engine, t.model))
        order by total desc, count(*) desc, t.engine, t.model nulls last
        limit ${AI_USAGE_MAX_MODELS + 1}
      `);

      // Every Toronto day of the period, a day without a turn as zeros.
      const dayRows = await tx.execute<{
        day: string;
        turns: string;
        failed: string;
        inputTokens: string;
        outputTokens: string;
      }>(sql`
        select to_char(d.day, 'YYYY-MM-DD') as day,
          coalesce(a.turns, 0)::text as turns, coalesce(a.failed, 0)::text as failed,
          coalesce(a.input_tokens, 0)::text as "inputTokens",
          coalesce(a.output_tokens, 0)::text as "outputTokens"
        from generate_series(
          ${firstDay}::timestamp, ${today}::date::timestamp, interval '1 day'
        ) as d(day)
        left join (
          select (t.created_at at time zone ${zone})::date as day, count(*) as turns,
            count(*) filter (where t.outcome = 'failed') as failed,
            coalesce(sum(${inputTokens}), 0) as input_tokens,
            coalesce(sum(t.output_tokens), 0) as output_tokens
          from app.ai_turns t
          where ${inPeriod}
          group by 1
        ) a on a.day = d.day::date
        order by d.day
      `);

      // Why failed turns ended: the stored code, or `unknown` for none or a malformed one.
      const failureRows = await tx.execute<{ code: string; turns: string }>(sql`
        select f.code, count(*)::text as turns
        from (
          select case when t.failure_code ~ ${FAILURE_CODE_PATTERN} then t.failure_code
            else 'unknown' end as code
          from app.ai_turns t
          where ${inPeriod} and t.outcome = 'failed'
        ) f
        group by f.code
        order by count(*) desc, f.code
        limit ${AI_USAGE_MAX_FAILURE_CODES}
      `);

      // Tokens per (engine, model) by Toronto day and by member, for the
      // cost: the same turns, summed exactly (bigint text, read as bigint).
      const tokenRows = await tx.execute<{
        byDay: boolean;
        engine: string;
        model: string | null;
        day: string | null;
        actorId: string | null;
        turns: string;
        inputTokens: string;
        outputTokens: string;
      }>(sql`
        select grouping(t.actor_id) <> 0 as "byDay", t.engine, nullif(t.model, '') as model,
          to_char((t.created_at at time zone ${zone})::date, 'YYYY-MM-DD') as day,
          t.actor_id as "actorId", count(*)::text as turns,
          coalesce(sum(${inputTokens}), 0)::text as "inputTokens",
          coalesce(sum(t.output_tokens), 0)::text as "outputTokens"
        from app.ai_turns t
        where ${inPeriod}
        group by grouping sets (
          (t.engine, t.model, (t.created_at at time zone ${zone})::date),
          (t.engine, t.model, t.actor_id)
        )
      `);

      const [totalRow] = modelRows.filter((row) => row.total);
      const models = modelRows
        .filter((row): row is typeof row & { engine: string; lastUsedAt: string } => !row.total)
        .map((row): AiUsageModel => ({
          model: row.model === '' ? null : row.model,
          engine: row.engine,
          turns: toInt(row.turns),
          completedTurns: toInt(row.completed),
          failedTurns: toInt(row.failed),
          inputTokens: toInt(row.inputTokens),
          outputTokens: toInt(row.outputTokens),
          averageDurationMs: toAverage(row.averageDurationMs),
          lastUsedAt: new Date(row.lastUsedAt).toISOString(),
          highEffortTurns: toInt(row.highEffortTurns),
        }))
        .slice(0, AI_USAGE_MAX_MODELS);

      return {
        totals: {
          turns: toInt(totalRow?.turns ?? null),
          inputTokens: toInt(totalRow?.inputTokens ?? null),
          outputTokens: toInt(totalRow?.outputTokens ?? null),
          completedTurns: toInt(totalRow?.completed ?? null),
          failedTurns: toInt(totalRow?.failed ?? null),
          cancelledTurns: toInt(totalRow?.cancelled ?? null),
          toolCalls: toInt(totalRow?.toolCalls ?? null),
          averageDurationMs: toAverage(totalRow?.averageDurationMs ?? null),
          highEffortTurns: toInt(totalRow?.highEffortTurns ?? null),
        },
        members: memberRows.map((row): AiUsageMember => ({
          actorId: row.actorId,
          displayName: row.displayName,
          turns: toInt(row.turns),
          inputTokens: toInt(row.inputTokens),
          outputTokens: toInt(row.outputTokens),
          lastUsedAt: new Date(row.lastUsedAt).toISOString(),
          highEffortTurns: toInt(row.highEffortTurns),
        })),
        models,
        daily: dayRows.map((row): AiUsageDay => ({
          day: row.day,
          turns: toInt(row.turns),
          failedTurns: toInt(row.failed),
          inputTokens: toInt(row.inputTokens),
          outputTokens: toInt(row.outputTokens),
        })),
        failures: failureRows.map((row): AiUsageFailure => ({
          code: row.code,
          turns: toInt(row.turns),
        })),
        tokens: {
          byDay: tokenRows
            .filter((row): row is typeof row & { day: string } => row.byDay && row.day !== null)
            .map((row) => ({ ...tokenCounts(row), day: row.day })),
          byMember: tokenRows
            .filter(
              (row): row is typeof row & { actorId: string } => !row.byDay && row.actorId !== null,
            )
            .map((row) => ({ ...tokenCounts(row), actorId: row.actorId })),
        },
      };
    });
  }
}
