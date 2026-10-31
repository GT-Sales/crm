import type postgres from 'postgres';
import type { BuiltInAutomationKey } from '@gt-sales/contracts';

/**
 * Test helpers for automation flows, written through the admin connection the
 * way the flow store writes them (Batch 3's `ensureBuiltInFlows`, create and
 * activate): a flow row, its active version and `active_version_id`.
 */

type Admin = ReturnType<typeof postgres>;

/** The disposable database of the integration suites, or undefined when they are off. */
export function disposableTestDatabaseUrl(): string | undefined {
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

export interface SeededFlow {
  id: string;
  versionId: string;
}

/**
 * A built-in as `ensureBuiltInFlows` seeds it (its label, version 1 active
 * from `app.builtin_flow_definition`), switched as asked. Idempotent: an
 * existing row only has its switch set.
 */
export async function seedBuiltInFlow(
  admin: Admin,
  input: { workspaceId: string; key: BuiltInAutomationKey; enabled: boolean; actorId: string },
): Promise<SeededFlow> {
  const [flow] = await admin<{ id: string; activeVersionId: string | null }[]>`
    insert into app.automations (workspace_id, key, origin, name, enabled, updated_by, created_by)
    values (${input.workspaceId}, ${input.key}, 'builtin', app.builtin_flow_name(${input.key}),
      ${input.enabled}, ${input.actorId}, ${input.actorId})
    on conflict (workspace_id, key) do update set enabled = excluded.enabled
    returning id, active_version_id as "activeVersionId"
  `;
  if (!flow) throw new Error('the built-in was not seeded');
  if (flow.activeVersionId) return { id: flow.id, versionId: flow.activeVersionId };
  const [version] = await admin<{ id: string }[]>`
    insert into app.automation_versions
      (workspace_id, automation_id, version, status, definition, created_by, activated_at)
    values (${input.workspaceId}, ${flow.id}, 1, 'active', app.builtin_flow_definition(${input.key}),
      ${input.actorId}, now())
    returning id
  `;
  if (!version) throw new Error('the built-in version was not seeded');
  await admin`
    update app.automations set active_version_id = ${version.id} where id = ${flow.id}
  `;
  return { id: flow.id, versionId: version.id };
}

/**
 * A flow with one active version holding `definition` exactly as given (it
 * may be one the schemas would now refuse), on or off. The key is the
 * flow's; `activatedBy` is the version's activator (null for none).
 */
export async function insertActiveFlow(
  admin: Admin,
  input: {
    workspaceId: string;
    key: string;
    name: string;
    origin?: 'builtin' | 'custom';
    enabled: boolean;
    definition: unknown;
    actorId: string;
    activatedBy?: string | null;
  },
): Promise<SeededFlow> {
  const [flow] = await admin<{ id: string }[]>`
    insert into app.automations (workspace_id, key, origin, name, enabled, updated_by, created_by, created_at)
    values (${input.workspaceId}, ${input.key}, ${input.origin ?? 'custom'}, ${input.name},
      ${input.enabled}, ${input.actorId}, ${input.actorId}, clock_timestamp())
    returning id
  `;
  if (!flow) throw new Error('the flow was not inserted');
  const versionId = await addActiveVersion(admin, {
    workspaceId: input.workspaceId,
    automationId: flow.id,
    version: 1,
    definition: input.definition,
    actorId: input.actorId,
    activatedBy: input.activatedBy === undefined ? input.actorId : input.activatedBy,
  });
  return { id: flow.id, versionId };
}

/** Retires the active version (if any) and makes a new one active with `definition`. */
export async function addActiveVersion(
  admin: Admin | postgres.TransactionSql,
  input: {
    workspaceId: string;
    automationId: string;
    version: number;
    definition: unknown;
    actorId: string;
    activatedBy: string | null;
  },
): Promise<string> {
  await admin`
    update app.automation_versions set status = 'retired', retired_at = now()
    where workspace_id = ${input.workspaceId} and automation_id = ${input.automationId}
      and status = 'active'
  `;
  const [version] = await admin<{ id: string }[]>`
    insert into app.automation_versions
      (workspace_id, automation_id, version, status, definition, created_by, activated_by, activated_at)
    values (${input.workspaceId}, ${input.automationId}, ${input.version}, 'active',
      ${admin.json(JSON.parse(JSON.stringify(input.definition)))}, ${input.actorId},
      ${input.activatedBy}, now())
    returning id
  `;
  if (!version) throw new Error('the version was not inserted');
  await admin`
    update app.automations set active_version_id = ${version.id}
    where workspace_id = ${input.workspaceId} and id = ${input.automationId}
  `;
  return version.id;
}

/** A custom flow key from a 4-digit suite id and a 2-digit index: `flow_` + 16. */
export const flowKey = (suite: string, index: number) =>
  `flow_t${suite}${String(index).padStart(2, '0')}xxxxxxxxx`.slice(0, 21);
