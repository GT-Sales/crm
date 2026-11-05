/** How often the scheduler's `automations` task runs. */
export const AUTOMATION_TICK_INTERVAL_MS = 5 * 60_000;
/** Pending work this long past due is overdue: two ticks (ENG-4, ENG-9). */
export const AUTOMATION_OVERDUE_AFTER_MS = 2 * AUTOMATION_TICK_INTERVAL_MS;
