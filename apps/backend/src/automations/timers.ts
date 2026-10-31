import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import { timerDueAt, triggerLeadTypes, type FlowTrigger } from '@gt-sales/contracts';

import { readLiveFlows, storedTrigger } from './engine.js';

/**
 * Time triggers' timers (spec §5 "Waits and time triggers"): written in the
 * transaction of the event that starts the clock, one per flow that is on and
 * whose active version has the matching time trigger, and only for a lead the
 * customer submitted. A flow switched on later never sees an earlier event,
 * so timers never back-fill (R3). Each is unique per flow, lead and
 * occurrence, so an event replayed writes nothing new.
 */

export type TimerEvent =
  /** A submitted lead entered `stage`; `occurrence` is the entry's (a move's activity id). */
  | { kind: 'stage_entered'; stage: string; occurrence: string; at: Date }
  /** The lead was submitted (by the website, or rescued by staff). */
  | { kind: 'submitted'; at: Date }
  /** A task of the lead is open with a due day, set or changed now. */
  | { kind: 'task_due'; taskId: string; dueDay: string };

interface TimerRow {
  triggerKind: 'time_in_stage' | 'task_overdue' | 'after_submitted';
  occurrence: string;
  subjectId: string | null;
  stage: string | null;
  eventAt: Date;
}

/** The timer an event starts for a trigger, or undefined when the trigger is not the event's. */
function timerFor(trigger: FlowTrigger, leadType: string, event: TimerEvent): TimerRow | undefined {
  if (event.kind === 'stage_entered') {
    if (trigger.kind !== 'time_in_stage') return undefined;
    if (trigger.leadType !== leadType || trigger.stage !== event.stage) return undefined;
    return {
      triggerKind: 'time_in_stage',
      occurrence: `stay:${event.occurrence}`,
      subjectId: null,
      stage: event.stage,
      eventAt: event.at,
    };
  }
  if (event.kind === 'submitted') {
    if (trigger.kind !== 'after_submitted' || !trigger.leadTypes.includes(leadType)) {
      return undefined;
    }
    return {
      triggerKind: 'after_submitted',
      occurrence: 'after_submitted',
      subjectId: null,
      stage: null,
      eventAt: event.at,
    };
  }
  if (trigger.kind !== 'task_overdue' || !triggerLeadTypes(trigger).includes(leadType)) {
    return undefined;
  }
  return {
    triggerKind: 'task_overdue',
    occurrence: `task:${event.taskId}:${event.dueDay}`,
    subjectId: event.taskId,
    stage: null,
    // The day the task is due, as stored (noon UTC).
    eventAt: new Date(`${event.dueDay}T12:00:00.000Z`),
  };
}

/**
 * For each live flow whose active trigger is the event's time trigger: one
 * pending timer, `on conflict do nothing`. Submitted leads only. Returns the
 * timers written.
 */
export async function writeTimers(
  tx: TenantTransaction,
  input: { workspaceId: string; leadId: string; leadType: string; event: TimerEvent },
): Promise<number> {
  const [lead] = await tx.execute<{ submitted: boolean }>(sql`
    select l.status <> 'incomplete' as submitted
    from app.leads l
    where l.workspace_id = ${input.workspaceId} and l.id = ${input.leadId}
      and l.deleted_at is null and l.customer_data_restricted_at is null
  `);
  if (!lead?.submitted) return 0;
  const flows = await readLiveFlows(tx, input.workspaceId);
  let written = 0;
  for (const flow of flows) {
    const trigger = storedTrigger(flow.definition);
    if (!trigger) continue;
    const timer = timerFor(trigger, input.leadType, input.event);
    if (!timer) continue;
    const dueDay = input.event.kind === 'task_due' ? input.event.dueDay : undefined;
    const dueAt = timerDueAt(trigger, { eventAt: timer.eventAt, ...(dueDay ? { dueDay } : {}) });
    if (!dueAt) continue;
    const rows = await tx.execute<{ id: string }>(sql`
      insert into app.automation_timers (
        workspace_id, automation_id, lead_id, trigger_kind, occurrence, subject_id, stage,
        event_at, due_at
      ) values (
        ${input.workspaceId}, ${flow.id}, ${input.leadId}, ${timer.triggerKind},
        ${timer.occurrence}, ${timer.subjectId}, ${timer.stage},
        ${timer.eventAt.toISOString()}::timestamptz, ${dueAt.toISOString()}::timestamptz
      )
      on conflict (workspace_id, automation_id, lead_id, occurrence) do nothing
      returning id
    `);
    written += rows.length;
  }
  return written;
}

/** The UTC calendar day of a stored task due time (tasks are stored at noon UTC). */
export function taskDueDay(dueAt: string | Date): string {
  return new Date(dueAt).toISOString().slice(0, 10);
}
