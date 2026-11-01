/*
 * The assistant's reads against real SQL (the counterpart of ai-tools.test.ts,
 * which exercises the same tools over fakes).
 *
 * Each site below gets its own fixed id range, is emptied before the run and
 * deleted after it, so the suite is re-runnable on a persistent `_test`
 * database and its counts never depend on another file's rows. The block skips
 * cleanly when the integration database is not configured, exactly like the
 * other `*.integration.test.ts` suites.
 */
import postgres from 'postgres';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AI_ASSISTANT_LIMITS } from '@gt-sales/contracts';
import {
  createDatabaseClient,
  type DatabaseClient,
  type TenantContext,
  type TenantTransaction,
} from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';
import { z } from 'zod';

import { TurnBudget } from '../src/ai/limits.js';
import { DatabaseAiReadService } from '../src/ai/read-service.js';
import { DatabaseAiSiteContextStore } from '../src/ai/site-context.js';
import { SourceRegistry } from '../src/ai/sources.js';
import { createAssistantTools } from '../src/ai/tools.js';
import {
  AI_BUSINESS_TIME_ZONE,
  businessDayLabel,
  resolvePeriod,
  resolveTaskDueWindow,
} from '../src/ai/windows.js';
import { DatabaseReportStore } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';

function getDisposableTestDatabaseUrl(): string | undefined {
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const destructiveTestsEnabled = process.env.DB_TEST_ALLOW_DESTRUCTIVE === '1';
  if (!migrationUrl && !destructiveTestsEnabled && !process.env.CI) return undefined;
  if (!migrationUrl || !destructiveTestsEnabled) {
    throw new Error(
      'Database integration tests require TEST_MIGRATION_DATABASE_URL and DB_TEST_ALLOW_DESTRUCTIVE=1 together.',
    );
  }
  const databaseName = decodeURIComponent(new URL(migrationUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_MIGRATION_DATABASE_URL must name a disposable database ending in _test.');
  }
  return migrationUrl;
}

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// A distinct id range from every other integration test file sharing this database.
const SITE_A = 'a1000000-0000-4000-8000-0000000000a1';
const SITE_B = 'a2000000-0000-4000-8000-0000000000a2';
const OVERVIEW_SITE = 'a3000000-0000-4000-8000-0000000000a3';
const SUMMARY_SITE = 'a4000000-0000-4000-8000-0000000000a4';
const TASKS_SITE = 'a5000000-0000-4000-8000-0000000000a5';
const READONLY_SITE = 'a6000000-0000-4000-8000-0000000000a6';
const ACTOR = 'b1000000-0000-4000-8000-0000000000b1';
const COLLEAGUE = 'b2000000-0000-4000-8000-0000000000b2';
const ACTOR_MEMBERSHIP_A = 'c1000000-0000-4000-8000-0000000000c1';
const COLLEAGUE_MEMBERSHIP_A = 'c2000000-0000-4000-8000-0000000000c2';
const ACTOR_MEMBERSHIP_B = 'c3000000-0000-4000-8000-0000000000c3';
const ACTOR_MEMBERSHIP_OVERVIEW = 'c4000000-0000-4000-8000-0000000000c4';
const ACTOR_MEMBERSHIP_SUMMARY = 'c5000000-0000-4000-8000-0000000000c5';
const ACTOR_MEMBERSHIP_TASKS = 'c6000000-0000-4000-8000-0000000000c6';
const COLLEAGUE_MEMBERSHIP_TASKS = 'c7000000-0000-4000-8000-0000000000c7';
const ACTOR_MEMBERSHIP_READONLY = 'c8000000-0000-4000-8000-0000000000c8';

const WORKSPACE_IDS = [SITE_A, SITE_B, OVERVIEW_SITE, SUMMARY_SITE, TASKS_SITE, READONLY_SITE];

const WORKSPACES = [
  { id: SITE_A, slug: 'ai-reads-a', name: 'AI Reads A' },
  { id: SITE_B, slug: 'ai-reads-b', name: 'AI Reads B' },
  { id: OVERVIEW_SITE, slug: 'ai-reads-overview', name: 'AI Reads Overview' },
  { id: SUMMARY_SITE, slug: 'ai-reads-summary', name: 'AI Reads Summary' },
  { id: TASKS_SITE, slug: 'ai-reads-tasks', name: 'AI Reads Tasks' },
  { id: READONLY_SITE, slug: 'ai-reads-readonly', name: 'AI Reads Read Only' },
];

const MEMBERSHIPS = [
  { id: ACTOR_MEMBERSHIP_A, workspaceId: SITE_A, userId: ACTOR, displayName: 'Ava Owner' },
  {
    id: COLLEAGUE_MEMBERSHIP_A,
    workspaceId: SITE_A,
    userId: COLLEAGUE,
    displayName: 'Casey Colleague',
  },
  { id: ACTOR_MEMBERSHIP_B, workspaceId: SITE_B, userId: ACTOR, displayName: 'Ava Owner' },
  {
    id: ACTOR_MEMBERSHIP_OVERVIEW,
    workspaceId: OVERVIEW_SITE,
    userId: ACTOR,
    displayName: 'Ava Owner',
  },
  {
    id: ACTOR_MEMBERSHIP_SUMMARY,
    workspaceId: SUMMARY_SITE,
    userId: ACTOR,
    displayName: 'Ava Owner',
  },
  {
    id: ACTOR_MEMBERSHIP_TASKS,
    workspaceId: TASKS_SITE,
    userId: ACTOR,
    displayName: 'Ava Owner',
  },
  {
    id: COLLEAGUE_MEMBERSHIP_TASKS,
    workspaceId: TASKS_SITE,
    userId: COLLEAGUE,
    displayName: 'Casey Colleague',
  },
  {
    id: ACTOR_MEMBERSHIP_READONLY,
    workspaceId: READONLY_SITE,
    userId: ACTOR,
    displayName: 'Ava Owner',
  },
];

/** One instant for the whole run, so a turn of the Toronto day cannot split it. */
const NOW = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK = resolvePeriod('last_7_days', NOW);
const MONTH = resolvePeriod('last_30_days', NOW);
const DUE_ANY = resolveTaskDueWindow('any', NOW);
const DUE_OVERDUE = resolveTaskDueWindow('overdue', NOW);
const DUE_TODAY = resolveTaskDueWindow('due_today', NOW);
const DUE_TODAY_OR_EARLIER = resolveTaskDueWindow('due_today_or_earlier', NOW);
/** The read service's own per-statement deadline, a product constant (5 s today). */
const STATEMENT_DEADLINE_MS = AI_ASSISTANT_LIMITS.toolQueryTimeoutMs;

/**
 * Noon UTC on a day offset from the Toronto business-day label. That is how a
 * task's calendar day is stored (`dueCutoff` in `leads/staff-queries.ts`), so
 * the label — not the UTC date — is the day the task names.
 */
function noonUtcOn(dayOffset: number): Date {
  const label = businessDayLabel(NOW, AI_BUSINESS_TIME_ZONE);
  const [yearText = '1970', monthText = '1', dayText = '1'] = label.split('-');
  return new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + dayOffset, 12),
  );
}

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

interface LeadSeed {
  readonly workspaceId: string;
  readonly createdAt: Date;
  readonly leadType?: string;
  readonly status?: string;
  readonly stage?: string;
  readonly fullName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly externalRef?: string;
  readonly assignedActorId?: string;
  readonly archived?: boolean;
  readonly restricted?: boolean;
}

interface TaskSeed {
  readonly workspaceId: string;
  readonly leadId: string;
  readonly title: string;
  readonly dueAt?: Date | null;
  readonly assignedActorId?: string | null;
  readonly status?: 'open' | 'done' | 'cancelled';
}

interface ActivitySeed {
  readonly workspaceId: string;
  readonly leadId: string;
  readonly kind: string;
  readonly body: string | null;
  readonly createdAt: Date;
}

/** The tool envelope, parsed rather than asserted: tests may not cast. */
const toolSourceSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  href: z.string(),
  scope: z.string(),
  asOf: z.string(),
});

const toolEnvelopeSchema = z.object({
  status: z.enum(['ok', 'not_available', 'invalid_filter', 'temporary_failure']),
  asOf: z.string(),
  total: z.number().optional(),
  returnedCount: z.number().optional(),
  truncated: z.boolean().optional(),
  hasMore: z.boolean().optional(),
  data: z.unknown().optional(),
  sources: z.array(toolSourceSchema),
  message: z.string().optional(),
});

type ToolEnvelope = z.infer<typeof toolEnvelopeSchema>;

const leadSummaryDataSchema = z.object({
  lead: z.object({
    leadId: z.uuid(),
    name: z.string().nullable(),
    reference: z.string().nullable(),
  }),
  openTasks: z.array(
    z.object({ taskId: z.uuid(), title: z.string(), dueDay: z.string().nullable() }),
  ),
  recentActivity: z.array(z.object({ kind: z.string(), at: z.string() })),
});

function parseTool(text: string): ToolEnvelope {
  return toolEnvelopeSchema.parse(JSON.parse(text));
}

databaseTest('the assistant’s database reads (ai/read-service)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let reads: DatabaseAiReadService;
  let reports: DatabaseReportStore;
  let siteContexts: DatabaseAiSiteContextStore;

  // Site A: isolation and findLeads.
  let dupA = '';
  let aSecond = '';
  let filterInternet = '';
  let filterStage = '';
  let summaryLead = '';
  let restrictedSummaryLead = '';
  let roLead = '';

  const scopeA = { workspaceId: SITE_A, actorId: ACTOR };
  const scopeB = { workspaceId: SITE_B, actorId: ACTOR };
  const overviewScope = { workspaceId: OVERVIEW_SITE, actorId: ACTOR };
  const summaryScope = { workspaceId: SUMMARY_SITE, actorId: ACTOR };
  const tasksScope = { workspaceId: TASKS_SITE, actorId: ACTOR };
  const readOnlyScope = { workspaceId: READONLY_SITE, actorId: ACTOR };

  async function insertLead(seed: LeadSeed): Promise<string> {
    const deletedAt = seed.archived === true ? seed.createdAt : null;
    const restrictedAt = seed.restricted === true ? seed.createdAt : null;
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (
        workspace_id, lead_type, status, stage, full_name, email, phone, external_ref,
        assigned_actor_id, consent_version, deleted_at, customer_data_restricted_at,
        created_at, updated_at
      ) values (
        ${seed.workspaceId}, ${seed.leadType ?? 'sim_order'}, ${seed.status ?? 'submitted'},
        ${seed.stage ?? 'pending'}, ${seed.fullName ?? null}, ${seed.email ?? null},
        ${seed.phone ?? null}, ${seed.externalRef ?? null}, ${seed.assignedActorId ?? null},
        'ci', ${deletedAt}, ${restrictedAt}, ${seed.createdAt}, ${seed.createdAt}
      )
      returning id
    `;
    if (!row) throw new Error('the lead insert returned no row');
    return row.id;
  }

  async function insertTask(seed: TaskSeed): Promise<void> {
    const status = seed.status ?? 'open';
    const completedAt = status === 'done' ? NOW : null;
    await admin`
      insert into app.lead_tasks (
        workspace_id, lead_id, title, due_at, assigned_actor_id, status, completed_at, created_by
      ) values (
        ${seed.workspaceId}, ${seed.leadId}, ${seed.title}, ${seed.dueAt ?? null},
        ${seed.assignedActorId ?? null}, ${status}, ${completedAt}, ${ACTOR}
      )
    `;
  }

  async function insertActivity(seed: ActivitySeed): Promise<void> {
    await admin`
      insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body, created_at)
      values (
        ${seed.workspaceId}, ${seed.leadId}, ${ACTOR}, ${seed.kind}, ${seed.body}, ${seed.createdAt}
      )
    `;
  }

  // Migrating runs behind a shared advisory lock and the seed is a few dozen
  // statements, so the default ten-second hook timeout is tight on a busy CI box.
  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);

    // Each run starts from empty sites; the cascade clears their leads, tasks,
    // timeline, jobs and memberships.
    await admin`delete from app.workspaces where id in ${admin(WORKSPACE_IDS)}`;
    for (const workspace of WORKSPACES) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${workspace.id}, ${workspace.slug}, ${workspace.name})
      `;
    }
    for (const member of MEMBERSHIPS) {
      await admin`
        insert into app.memberships (
          id, workspace_id, user_id, membership_type, status, display_name, accepted_at
        ) values (
          ${member.id}, ${member.workspaceId}, ${member.userId}, 'staff', 'active',
          ${member.displayName}, ${NOW}
        )
      `;
    }

    // --- Site A: the same person and the same order number on two sites, plus
    // the rows the findLeads filters sort through. ---
    dupA = await insertLead({
      workspaceId: SITE_A,
      createdAt: daysBefore(1),
      fullName: 'Dana Duplicate',
      email: 'dana.duplicate@example.test',
      phone: '403 555 0101',
      externalRef: 'MS-DUP-1',
      assignedActorId: ACTOR,
    });
    aSecond = await insertLead({
      workspaceId: SITE_A,
      createdAt: daysBefore(2),
      leadType: 'internet',
      stage: 'new',
      fullName: 'Only In Site A',
      email: 'only.a@example.test',
      phone: '403 555 0102',
      externalRef: 'MS-A-2',
    });
    filterInternet = await insertLead({
      workspaceId: SITE_A,
      createdAt: daysBefore(3),
      leadType: 'internet',
      stage: 'contacted',
      fullName: 'Filter Internet',
      externalRef: 'WEB-1',
    });
    filterStage = await insertLead({
      workspaceId: SITE_A,
      createdAt: daysBefore(4),
      stage: 'verified',
      fullName: 'Filter Verified',
      externalRef: 'MS-A-3',
      assignedActorId: COLLEAGUE,
    });
    await insertLead({
      workspaceId: SITE_A,
      createdAt: daysBefore(5),
      stage: 'cancelled',
      fullName: 'Filter Archived',
      externalRef: 'MS-A-ARCH',
      archived: true,
    });
    await insertLead({
      workspaceId: SITE_A,
      createdAt: daysBefore(6),
      stage: 'pending',
      fullName: 'Filter Restricted',
      externalRef: 'MS-A-RES',
      restricted: true,
    });
    await insertLead({
      workspaceId: SITE_B,
      createdAt: daysBefore(1),
      fullName: 'Dana Duplicate',
      email: 'dana.duplicate@example.test',
      phone: '403 555 0201',
      externalRef: 'MS-DUP-1',
    });

    // --- Overview site: what a window counts, and what it never counts. ---
    await insertLead({
      workspaceId: OVERVIEW_SITE,
      createdAt: daysBefore(2),
      status: 'incomplete',
      stage: 'incomplete',
    });
    await insertLead({ workspaceId: OVERVIEW_SITE, createdAt: daysBefore(2), stage: 'pending' });
    await insertLead({ workspaceId: OVERVIEW_SITE, createdAt: daysBefore(3), stage: 'pending' });
    await insertLead({ workspaceId: OVERVIEW_SITE, createdAt: daysBefore(3), stage: 'verified' });
    await insertLead({
      workspaceId: OVERVIEW_SITE,
      createdAt: daysBefore(1),
      stage: 'cancelled',
      archived: true,
    });
    await insertLead({ workspaceId: OVERVIEW_SITE, createdAt: daysBefore(1), restricted: true });
    // Outside the 7-day window (but inside 30 days).
    await insertLead({ workspaceId: OVERVIEW_SITE, createdAt: daysBefore(10), stage: 'completed' });

    // --- Summary site: a lead with more tasks and activity than one summary shows. ---
    summaryLead = await insertLead({
      workspaceId: SUMMARY_SITE,
      createdAt: daysBefore(1),
      stage: 'contacted',
      fullName: 'Summary Lead',
      externalRef: 'MS-SUM-1',
      assignedActorId: ACTOR,
    });
    restrictedSummaryLead = await insertLead({
      workspaceId: SUMMARY_SITE,
      createdAt: daysBefore(1),
      restricted: true,
      fullName: 'Restricted Summary',
    });
    for (let index = 1; index <= 12; index += 1) {
      await insertTask({
        workspaceId: SUMMARY_SITE,
        leadId: summaryLead,
        title: `Summary task ${String(index).padStart(2, '0')}`,
        dueAt: new Date(NOW.getTime() + index * 60 * 60 * 1000),
        assignedActorId: ACTOR,
      });
      await insertActivity({
        workspaceId: SUMMARY_SITE,
        leadId: summaryLead,
        kind: index % 2 === 1 ? 'note' : 'call',
        body: `Summary activity ${String(index).padStart(2, '0')}`,
        createdAt: new Date(NOW.getTime() - index * 60 * 1000),
      });
    }
    await insertTask({
      workspaceId: SUMMARY_SITE,
      leadId: summaryLead,
      title: 'Summary task done',
      dueAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      status: 'done',
    });

    // --- Tasks site: open, due windows, assignees, and rows never listed. ---
    const taskLead = await insertLead({
      workspaceId: TASKS_SITE,
      createdAt: daysBefore(1),
      fullName: 'Task Lead',
      externalRef: 'MS-TASK-1',
    });
    const archivedTaskLead = await insertLead({
      workspaceId: TASKS_SITE,
      createdAt: daysBefore(2),
      fullName: 'Archived Task Lead',
      archived: true,
    });
    const restrictedTaskLead = await insertLead({
      workspaceId: TASKS_SITE,
      createdAt: daysBefore(2),
      fullName: 'Restricted Task Lead',
      restricted: true,
    });
    const today = noonUtcOn(0);
    const yesterday = noonUtcOn(-1);
    const tomorrow = noonUtcOn(1);
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Due today, mine',
      dueAt: today,
      assignedActorId: ACTOR,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Due today, unassigned',
      dueAt: today,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Due today, colleague',
      dueAt: today,
      assignedActorId: COLLEAGUE,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Due yesterday',
      dueAt: yesterday,
      assignedActorId: ACTOR,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Due tomorrow',
      dueAt: tomorrow,
      assignedActorId: ACTOR,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'No due date',
      dueAt: null,
      assignedActorId: ACTOR,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Done today',
      dueAt: today,
      assignedActorId: ACTOR,
      status: 'done',
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: taskLead,
      title: 'Cancelled today',
      dueAt: today,
      assignedActorId: ACTOR,
      status: 'cancelled',
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: archivedTaskLead,
      title: 'On an archived lead',
      dueAt: today,
      assignedActorId: ACTOR,
    });
    await insertTask({
      workspaceId: TASKS_SITE,
      leadId: restrictedTaskLead,
      title: 'On a restricted lead',
      dueAt: today,
      assignedActorId: ACTOR,
    });

    // --- Read-only site: a lead, one follow-up, two activity entries and one
    // queued job, so a full tool turn has real state it must leave untouched. ---
    roLead = await insertLead({
      workspaceId: READONLY_SITE,
      createdAt: daysBefore(1),
      fullName: 'Rowan Readonly',
      email: 'rowan.readonly@example.test',
      phone: '403 555 0188',
      externalRef: 'MS-RO-1',
      assignedActorId: ACTOR,
    });
    await insertLead({
      workspaceId: READONLY_SITE,
      createdAt: daysBefore(2),
      leadType: 'internet',
      stage: 'new',
      fullName: 'Ivy Internet',
      externalRef: 'WEB-RO-2',
    });
    await insertTask({
      workspaceId: READONLY_SITE,
      leadId: roLead,
      title: 'Call Rowan back',
      dueAt: noonUtcOn(0),
      assignedActorId: ACTOR,
    });
    await insertActivity({
      workspaceId: READONLY_SITE,
      leadId: roLead,
      kind: 'note',
      body: 'Left a voicemail.',
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    // A note is carried only when the notes section is asked for, so a second,
    // non-note entry keeps the default summary's activity list non-empty.
    await insertActivity({
      workspaceId: READONLY_SITE,
      leadId: roLead,
      kind: 'call',
      body: null,
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    });
    await admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload, status)
      values (${READONLY_SITE}, 'lead_customer_email', 'ai-reads-seed', ${admin.json({})}, 'pending')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    reads = new DatabaseAiReadService(database);
    reports = new DatabaseReportStore(database);
    siteContexts = new DatabaseAiSiteContextStore(database);
  }, 60_000);

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id in ${admin(WORKSPACE_IDS)}`;
    await database?.close();
    await admin?.end();
  }, 60_000);

  /** Every id of a page, sorted so an ordering tie is not the test's subject. */
  const sortedIds = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id).sort();

  test('the same person and order number in another site never cross the tenant', async () => {
    const byName = await reads.findLeads(scopeA, {
      search: 'Dana Duplicate',
      limit: 10,
      offset: 0,
    });
    expect(sortedIds(byName.rows)).toEqual([dupA]);
    expect(byName.total).toBe(1);

    // Both sites hold the same `external_ref`; a search for it finds only this
    // site's lead.
    const byRef = await reads.findLeads(scopeA, { search: 'MS-DUP-1', limit: 10, offset: 0 });
    expect(sortedIds(byRef.rows)).toEqual([dupA]);
    const otherSiteByRef = await reads.findLeads(scopeB, {
      search: 'MS-DUP-1',
      limit: 10,
      offset: 0,
    });
    expect(otherSiteByRef.rows).toHaveLength(1);
    expect(otherSiteByRef.rows[0]?.id).not.toBe(dupA);

    // A foreign lead id answers the same neutral `undefined` as an unknown one.
    const foreignId = otherSiteByRef.rows[0]?.id;
    if (!foreignId) throw new Error('the other site did not return its lead');
    expect(await reads.leadSummary(scopeA, { leadId: foreignId })).toBe(undefined);
    // The row exists: its own site reads it, so the undefined above is isolation.
    const foreign = await reads.leadSummary(scopeB, { leadId: foreignId });
    expect(foreign?.lead.id).toBe(foreignId);
    expect((await reads.leadSummary(scopeA, { leadId: dupA }))?.lead.id).toBe(dupA);
  });

  test('overview counts drafts in, archived and restricted out, by creation window', async () => {
    const week = await reads.overview(overviewScope, { leadType: 'sim_order', window: WEEK });
    // Four of the seven seeded leads are inside the window and visible.
    expect(week.received).toBe(4);
    expect(week.submitted).toBe(3);
    expect(week.byStage.map((entry) => [entry.stage, entry.count])).toEqual([
      ['pending', 2],
      ['incomplete', 1],
      ['verified', 1],
    ]);
    expect(week.byStage.some((entry) => entry.stage === 'cancelled')).toBe(false);

    // The same site over 30 days gains the lead created outside the 7-day window.
    const month = await reads.overview(overviewScope, { leadType: 'sim_order', window: MONTH });
    expect(month.received).toBe(5);
    expect(month.submitted).toBe(4);
    expect(month.byStage.map((entry) => [entry.stage, entry.count])).toEqual([
      ['pending', 2],
      ['completed', 1],
      ['incomplete', 1],
      ['verified', 1],
    ]);
  });

  test('findLeads searches, filters and pages without selecting contact columns', async () => {
    const all = await reads.findLeads(scopeA, { limit: 10, offset: 0 });
    expect(all.total).toBe(4);
    expect(sortedIds(all.rows)).toEqual([aSecond, dupA, filterInternet, filterStage].sort());

    const byName = await reads.findLeads(scopeA, { search: 'Filter', limit: 10, offset: 0 });
    expect(sortedIds(byName.rows)).toEqual([filterInternet, filterStage].sort());
    const byReference = await reads.findLeads(scopeA, { search: 'WEB-1', limit: 10, offset: 0 });
    expect(sortedIds(byReference.rows)).toEqual([filterInternet]);
    const archivedByName = await reads.findLeads(scopeA, {
      search: 'Filter Archived',
      limit: 10,
      offset: 0,
    });
    expect(archivedByName.total).toBe(0);
    const restrictedByName = await reads.findLeads(scopeA, {
      search: 'Filter Restricted',
      limit: 10,
      offset: 0,
    });
    expect(restrictedByName.total).toBe(0);

    const internet = await reads.findLeads(scopeA, {
      leadType: 'internet',
      limit: 10,
      offset: 0,
    });
    expect(sortedIds(internet.rows)).toEqual([aSecond, filterInternet].sort());
    const verified = await reads.findLeads(scopeA, { stage: 'verified', limit: 10, offset: 0 });
    expect(sortedIds(verified.rows)).toEqual([filterStage]);

    const mine = await reads.findLeads(scopeA, { assignee: 'me', limit: 10, offset: 0 });
    expect(sortedIds(mine.rows)).toEqual([dupA]);
    const unassigned = await reads.findLeads(scopeA, { assignee: 'none', limit: 10, offset: 0 });
    expect(sortedIds(unassigned.rows)).toEqual([aSecond, filterInternet].sort());
    const colleague = await reads.findLeads(scopeA, {
      assignee: COLLEAGUE,
      limit: 10,
      offset: 0,
    });
    expect(sortedIds(colleague.rows)).toEqual([filterStage]);

    const archived = await reads.findLeads(scopeA, { archived: true, limit: 10, offset: 0 });
    expect(archived.rows).toHaveLength(1);
    expect(archived.rows[0]?.full_name).toBe('Filter Archived');
    expect(archived.rows[0]?.deleted_at).not.toBeNull();

    // The page is bounded, the total is the whole match set, and pages do not overlap.
    const firstPage = await reads.findLeads(scopeA, { limit: 2, offset: 0 });
    const secondPage = await reads.findLeads(scopeA, { limit: 2, offset: 2 });
    expect(firstPage.rows).toHaveLength(2);
    expect(secondPage.rows).toHaveLength(2);
    expect(firstPage.total).toBe(4);
    expect(secondPage.total).toBe(4);
    expect(
      sortedIds(firstPage.rows).filter((id) => sortedIds(secondPage.rows).includes(id)),
    ).toEqual([]);
    // An offset past the last row still reports the cohort's true size.
    const pastEnd = await reads.findLeads(scopeA, { limit: 2, offset: 4 });
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.total).toBe(4);

    // The projection is the documented row — never a contact column.
    const dupRow = all.rows.find((row) => row.id === dupA);
    if (!dupRow) throw new Error('the duplicate lead was not returned');
    expect(Object.keys(dupRow).sort()).toEqual([
      'assignee_name',
      'created_at',
      'deleted_at',
      'external_ref',
      'full_name',
      'id',
      'lead_type',
      'stage',
      'status',
      'updated_at',
    ]);
    expect(dupRow.assignee_name).toBe('Ava Owner');
    expect(JSON.stringify(all.rows)).not.toContain('dana.duplicate@example.test');
    expect(JSON.stringify(all.rows)).not.toContain('403 555 0101');
  });

  test('leadSummary caps tasks and activity at ten, in the documented order', async () => {
    const summary = await reads.leadSummary(summaryScope, { leadId: summaryLead });
    if (!summary) throw new Error('the summary lead was not readable');

    expect(summary.lead.id).toBe(summaryLead);
    expect(summary.lead.full_name).toBe('Summary Lead');
    expect(summary.lead.external_ref).toBe('MS-SUM-1');
    expect(summary.lead.assignee_name).toBe('Ava Owner');
    expect(summary.lead.deleted_at).toBeNull();

    // Due date ascending, nulls last: the ten earliest open tasks, the two
    // latest and the done one left out.
    expect(summary.openTasks.map((task) => task.title)).toEqual([
      'Summary task 01',
      'Summary task 02',
      'Summary task 03',
      'Summary task 04',
      'Summary task 05',
      'Summary task 06',
      'Summary task 07',
      'Summary task 08',
      'Summary task 09',
      'Summary task 10',
    ]);
    const dueTimes = summary.openTasks.map((task) => task.due_at?.getTime() ?? 0);
    expect(dueTimes).toEqual([...dueTimes].sort((a, b) => a - b));
    expect(summary.openTasks[0]).toMatchObject({
      lead_id: summaryLead,
      lead_ref: 'MS-SUM-1',
      lead_name: 'Summary Lead',
      assignee_name: 'Ava Owner',
    });

    // Newest first: the ten most recent activity entries.
    expect(summary.activity.map((entry) => entry.body)).toEqual([
      'Summary activity 01',
      'Summary activity 02',
      'Summary activity 03',
      'Summary activity 04',
      'Summary activity 05',
      'Summary activity 06',
      'Summary activity 07',
      'Summary activity 08',
      'Summary activity 09',
      'Summary activity 10',
    ]);
    expect(summary.activity.map((entry) => entry.kind)).toEqual([
      'note',
      'call',
      'note',
      'call',
      'note',
      'call',
      'note',
      'call',
      'note',
      'call',
    ]);

    // Notes are their own bounded read: the five most recent, newest first.
    const withNotes = await reads.leadSummary(summaryScope, {
      leadId: summaryLead,
      includeNotes: true,
    });
    if (!withNotes) throw new Error('the summary lead was not readable with notes');
    expect(withNotes.notes.map((entry) => entry.body)).toEqual([
      'Summary activity 01',
      'Summary activity 03',
      'Summary activity 05',
      'Summary activity 07',
      'Summary activity 09',
    ]);
    // Asking for notes does not change the ten-row activity page.
    expect(withNotes.activity).toHaveLength(10);
    expect(summary.notes).toEqual([]);

    // A restricted lead answers exactly like an unknown id.
    expect(await reads.leadSummary(summaryScope, { leadId: restrictedSummaryLead })).toBe(
      undefined,
    );
    expect(
      await reads.leadSummary(summaryScope, {
        leadId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).toBe(undefined);
  });

  test('findLeads ignores the archive unless it was asked for', async () => {
    const live = await reads.findLeads(scopeA, { limit: 10, offset: 0 });
    expect(live.rows.every((row) => row.deleted_at === null)).toBe(true);
    const archived = await reads.findLeads(scopeA, { archived: true, limit: 10, offset: 0 });
    expect(archived.rows.every((row) => row.deleted_at !== null)).toBe(true);
    expect(archived.total).toBe(1);
  });

  test('openTasks lists open work on active leads and honours the due windows', async () => {
    const allOpen = await reads.openTasks(tasksScope, {
      assignee: 'all',
      due: DUE_ANY,
      limit: 20,
      offset: 0,
    });
    // Open tasks only, and only on a lead that is neither archived nor restricted.
    expect(allOpen.total).toBe(6);
    expect(allOpen.rows.map((task) => task.title).sort()).toEqual([
      'Due today, colleague',
      'Due today, mine',
      'Due today, unassigned',
      'Due tomorrow',
      'Due yesterday',
      'No due date',
    ]);
    // Ordering: due date ascending, a task with no due date last.
    expect(allOpen.rows[0]?.title).toBe('Due yesterday');
    expect(allOpen.rows.at(-1)?.title).toBe('No due date');

    const mine = await reads.openTasks(tasksScope, {
      assignee: 'me',
      due: DUE_ANY,
      limit: 20,
      offset: 0,
    });
    expect(mine.total).toBe(4);
    expect(mine.rows.at(-1)?.title).toBe('No due date');

    const unassigned = await reads.openTasks(tasksScope, {
      assignee: 'none',
      due: DUE_ANY,
      limit: 20,
      offset: 0,
    });
    expect(unassigned.rows.map((task) => task.title)).toEqual(['Due today, unassigned']);

    const colleague = await reads.openTasks(tasksScope, {
      assignee: COLLEAGUE,
      due: DUE_ANY,
      limit: 20,
      offset: 0,
    });
    expect(colleague.rows.map((task) => task.title)).toEqual(['Due today, colleague']);
    expect(colleague.rows[0]?.assignee_name).toBe('Casey Colleague');

    // Noon UTC on the Toronto today label is inside both "today" and
    // "today or earlier"; yesterday is overdue only; tomorrow is in neither.
    const dueToday = await reads.openTasks(tasksScope, {
      assignee: 'all',
      due: DUE_TODAY,
      limit: 20,
      offset: 0,
    });
    expect(dueToday.total).toBe(3);
    expect(dueToday.rows.map((task) => task.title).sort()).toEqual([
      'Due today, colleague',
      'Due today, mine',
      'Due today, unassigned',
    ]);

    const overdue = await reads.openTasks(tasksScope, {
      assignee: 'all',
      due: DUE_OVERDUE,
      limit: 20,
      offset: 0,
    });
    expect(overdue.rows.map((task) => task.title)).toEqual(['Due yesterday']);

    const todayOrEarlier = await reads.openTasks(tasksScope, {
      assignee: 'all',
      due: DUE_TODAY_OR_EARLIER,
      limit: 20,
      offset: 0,
    });
    expect(todayOrEarlier.total).toBe(4);
    expect(todayOrEarlier.rows.map((task) => task.title)).not.toContain('Due tomorrow');
    expect(todayOrEarlier.rows.map((task) => task.title)).toContain('Due yesterday');
    // The window ends at the next UTC midnight of the label.
    expect(DUE_TODAY_OR_EARLIER.before?.toISOString()).toBe(
      `${noonUtcOn(1).toISOString().slice(0, 10)}T00:00:00.000Z`,
    );

    // The total stays the whole match set when the page is cut.
    const firstPage = await reads.openTasks(tasksScope, {
      assignee: 'all',
      due: DUE_ANY,
      limit: 2,
      offset: 0,
    });
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.total).toBe(6);

    // An offset past the last task still reports the whole match set.
    const pastEnd = await reads.openTasks(tasksScope, {
      assignee: 'all',
      due: DUE_ANY,
      limit: 2,
      offset: 6,
    });
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.total).toBe(6);

    // Nothing leaks across the tenant.
    const foreign = await reads.openTasks(scopeA, {
      assignee: 'all',
      due: DUE_ANY,
      limit: 20,
      offset: 0,
    });
    expect(foreign.rows).toEqual([]);
    expect(foreign.total).toBe(0);
  });

  test(
    'each read runs under the database’s own statement deadline',
    { timeout: STATEMENT_DEADLINE_MS + 15_000 },
    async () => {
      // Read back from Postgres — before the read's own statement runs — so the
      // deadline is proven to be the database's, not a JavaScript timer.
      const deadlinesBeforeRead: number[] = [];
      let slowStatementCancelled = false;
      let slowStatementMs = 0;

      const observingDatabase = {
        withTenantTx<T>(
          scope: TenantContext,
          work: (tx: TenantTransaction) => Promise<T> | T,
        ): Promise<T> {
          return database.withTenantTx(scope, async (tx) => {
            let statements = 0;
            const guarded = new Proxy(tx, {
              get(target, property, receiver) {
                if (property !== 'execute') return Reflect.get(target, property, receiver);
                return async (query: SQLWrapper) => {
                  statements += 1;
                  // The first statement is the service's own `set local`; every
                  // later one is a read that must already be bounded by it.
                  if (statements > 1) {
                    const [row] = await target.execute<{ seconds: number }>(sql`
                    select extract(epoch from current_setting('statement_timeout')::interval)::int
                      as "seconds"
                  `);
                    deadlinesBeforeRead.push(row?.seconds ?? -1);
                  }
                  return target.execute(query);
                };
              },
            });
            const result = await work(guarded);

            // A deliberately slow statement in the same read transaction is
            // cancelled at the deadline instead of hanging; the savepoint keeps
            // the transaction usable for its commit.
            await tx.execute(sql`savepoint ai_reads_deadline`);
            const started = Date.now();
            try {
              // One second past the deadline the service set.
              await tx.execute(sql`select pg_sleep(${STATEMENT_DEADLINE_MS / 1_000 + 1})`);
            } catch {
              slowStatementCancelled = true;
            }
            slowStatementMs = Date.now() - started;
            await tx.execute(sql`rollback to savepoint ai_reads_deadline`);
            return result;
          });
        },
      };

      const boundedReads = new DatabaseAiReadService(observingDatabase);
      const totals = await boundedReads.overview(overviewScope, {
        leadType: 'sim_order',
        window: WEEK,
      });

      expect(totals.received).toBe(4);
      // `overview` is one `set local` and then one statement.
      expect(deadlinesBeforeRead).toEqual([STATEMENT_DEADLINE_MS / 1_000]);
      expect(slowStatementCancelled).toBe(true);
      expect(slowStatementMs).toBeGreaterThanOrEqual(STATEMENT_DEADLINE_MS - 1_000);
      expect(slowStatementMs).toBeLessThan(STATEMENT_DEADLINE_MS + 2_000);
    },
  );

  test('a full tool turn writes no lead, timeline, job or run row', async () => {
    const snapshot = async (): Promise<{
      activities: number;
      outbox: number;
      runs: number;
      updatedAt: Date;
      deletedAt: Date | null;
    }> => {
      const [row] = await admin<
        {
          activities: number;
          outbox: number;
          runs: number;
          updatedAt: Date;
          deletedAt: Date | null;
        }[]
      >`
        select
          (select count(*)::int from app.lead_activities a
            where a.workspace_id = ${READONLY_SITE}) as "activities",
          (select count(*)::int from app.outbox_jobs j
            where j.workspace_id = ${READONLY_SITE}) as "outbox",
          (select count(*)::int from app.automation_runs r
            where r.workspace_id = ${READONLY_SITE}) as "runs",
          l.updated_at as "updatedAt",
          l.deleted_at as "deletedAt"
        from app.leads l
        where l.workspace_id = ${READONLY_SITE} and l.id = ${roLead}
      `;
      if (!row) throw new Error('the read-only lead is missing');
      return row;
    };

    const before = await snapshot();
    expect(before.activities).toBe(2);
    expect(before.outbox).toBe(1);
    expect(before.runs).toBe(0);

    const site = await siteContexts.siteContext(readOnlyScope);
    if (!site) throw new Error('the read-only site is missing');
    const owner: StaffAccessSnapshot = {
      membershipId: ACTOR_MEMBERSHIP_READONLY,
      status: 'active',
      roles: ['owner'],
      permissions: [],
    };
    const toolset = createAssistantTools({
      scope: readOnlyScope,
      site,
      now: NOW,
      budget: new TurnBudget(),
      sources: new SourceRegistry({ workspaceSlug: site.slug, asOf: NOW }),
      reads,
      reports,
      loadAccess: async () => owner,
    });

    // The five tools in one turn, through the same entry point the route uses.
    const overview = parseTool(await toolset.execute('getSiteOverview', {}));
    const found = parseTool(await toolset.execute('findLeads', { search: 'Rowan' }));
    const summary = parseTool(await toolset.execute('getLeadSummary', { leadId: roLead }));
    const tasks = parseTool(await toolset.execute('listOpenTasks', {}));
    const sources = parseTool(
      await toolset.execute('getSourcePerformance', { leadType: 'sim_order' }),
    );

    expect([overview.status, found.status, summary.status, tasks.status, sources.status]).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(overview.total).toBe(2);
    expect(found.total).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.sources[0]?.href).toBe(`/w/ai-reads-readonly/leads/${roLead}`);
    const summaryData = leadSummaryDataSchema.parse(summary.data);
    expect(summaryData.lead.leadId).toBe(roLead);
    expect(summaryData.openTasks).toHaveLength(1);
    // The default sections skip notes; the call is the one activity shown.
    expect(summaryData.recentActivity).toHaveLength(1);
    expect(summaryData.recentActivity[0]?.kind).toBe('call');
    expect(tasks.total).toBe(1);
    expect(sources.total).toBe(1);

    expect(await snapshot()).toEqual(before);
  });
});
