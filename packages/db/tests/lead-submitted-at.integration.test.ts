import { readFileSync } from 'node:fs';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, migrationsFolder } from '../src/migrations.js';

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

// Ids of this file only; everything is written in a transaction rolled back at the end.
const SITE = '18000000-0000-4000-8000-000000009401';
const ACTOR = '28000000-0000-4000-8000-000000009411';

/** 0046, statement by statement, as the migrator runs it. */
function migrationStatements(): string[] {
  return readFileSync(`${migrationsFolder}/0046_lead_submitted_at.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

class RolledBack extends Error {}

databaseTest('migration 0046: when each submitted lead was submitted (#94)', () => {
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('dates each by its submitted entry, else its creation, once, touching nothing else', async () => {
    const outcome = await admin
      .begin(async (tx) => {
        await tx`
          insert into app.workspaces (id, slug, name)
          values (${SITE}, 'lead-submitted-at-9401', 'Submitted At Site')
        `;
        const created = new Date('2026-09-01T10:00:00.000Z');
        const submitted = new Date('2026-09-20T08:30:00.000Z');
        const resubmitted = new Date('2026-09-25T08:30:00.000Z');
        const updated = new Date('2026-10-01T00:00:00.000Z');
        const lead = async (status: string, restricted = false, stamp: Date | null = null) => {
          const [row] = await tx<{ id: string }[]>`
            insert into app.leads (workspace_id, lead_type, status, stage, consent_version,
              created_at, updated_at, submitted_at, customer_data_restricted_at)
            values (${SITE}, 'internet', ${status}, 'new', 'ci', ${created}, ${updated},
              ${stamp}, ${restricted ? updated : null})
            returning id
          `;
          if (!row) throw new Error('no lead');
          return row.id;
        };
        const entry = async (leadId: string, event: string, at: Date) => {
          await tx`
            insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, data, created_at)
            values (${SITE}, ${leadId}, ${ACTOR}, 'system', ${tx.json({ event })}, ${at})
          `;
        };
        // Submitted later than it was started (a rescue, or a draft finished later).
        const rescued = await lead('submitted');
        await entry(rescued, 'opened', new Date('2026-09-10T00:00:00.000Z'));
        await entry(rescued, 'submitted', resubmitted);
        await entry(rescued, 'submitted', submitted);
        // An imported legacy order: no submitted entry, keeps its own date.
        const imported = await lead('submitted');
        // A draft: never submitted, no date.
        const draft = await lead('incomplete');
        // Already dated by the new backend: left as it is.
        const stamped = await lead('submitted', false, resubmitted);
        // A restricted (erased) order still takes its date.
        const restricted = await lead('submitted', true);

        const read = () =>
          tx<{ id: string; submittedAt: Date | null; updatedAt: Date }[]>`
            select id, submitted_at as "submittedAt", updated_at as "updatedAt"
            from app.leads where workspace_id = ${SITE}
          `;
        for (const statement of migrationStatements()) await tx.unsafe(statement);
        const after = new Map((await read()).map((row) => [row.id, row]));
        expect(after.get(rescued)?.submittedAt).toEqual(submitted);
        expect(after.get(imported)?.submittedAt).toEqual(created);
        expect(after.get(draft)?.submittedAt).toBeNull();
        expect(after.get(stamped)?.submittedAt).toEqual(resubmitted);
        expect(after.get(restricted)?.submittedAt).toEqual(created);
        // The inbox order is not disturbed.
        for (const row of after.values()) expect(row.updatedAt).toEqual(updated);

        // A second run changes nothing.
        for (const statement of migrationStatements()) await tx.unsafe(statement);
        expect(new Map((await read()).map((row) => [row.id, row]))).toEqual(after);
        throw new RolledBack();
      })
      .catch((error: unknown) => error);
    if (!(outcome instanceof RolledBack)) throw outcome;
  });
});
