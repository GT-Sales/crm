import { readFileSync } from 'node:fs';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, migrationsFolder } from '../src/migrations.js';
import { getDisposableTestDatabaseUrl } from '../src/test-helpers.js';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Ids of this file only; everything is written in a transaction rolled back at the end.
const SITE = '18000000-0000-4000-8000-000000008811';
const ACTOR = '28000000-0000-4000-8000-000000008821';

/** 0047, statement by statement, as the migrator runs it. */
function migrationStatements(): string[] {
  return readFileSync(`${migrationsFolder}/0047_one_current_document.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

class RolledBack extends Error {}

databaseTest('migration 0047: one current document per lead and type (#81)', () => {
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('reconciles stored duplicates (the newest upload wins), then refuses new ones', async () => {
    const outcome = await admin
      .begin(async (tx) => {
        // The duplicates the old backend could leave: rebuilt without the index.
        await tx`drop index app.files_one_current_per_slot`;
        await tx`
          insert into app.workspaces (id, slug, name)
          values (${SITE}, 'one-current-8811', 'One Current Site')
        `;
        const lead = async () => {
          const [row] = await tx<{ id: string }[]>`
            insert into app.leads (workspace_id, lead_type, status, stage, consent_version)
            values (${SITE}, 'sim_order', 'submitted', 'pending', 'ci')
            returning id
          `;
          if (!row) throw new Error('no lead');
          return row.id;
        };
        let n = 0;
        const file = async (leadId: string, documentType: string, createdAt: string) => {
          n += 1;
          const key = `candidate/${SITE}/one-current-${n}`;
          const [row] = await tx<{ id: string }[]>`
            insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
              staging_key, candidate_key, object_key, declared_content_type, detected_mime,
              declared_size_bytes, size_bytes, checksum_sha256, status, revision, uploaded_by,
              expires_at, created_at)
            values (${SITE}, 'lead', ${leadId}, ${documentType}, 'documents',
              ${`staging/${SITE}/one-current-${n}`}, ${key}, ${key}, 'application/pdf',
              'application/pdf', 10, 10, ${'f'.repeat(64)}, 'available', ${n}, ${ACTOR}, now(),
              ${createdAt})
            returning id
          `;
          if (!row) throw new Error('no file');
          return row.id;
        };
        const lead1 = await lead();
        const approvedOld = await file(lead1, 'passport', '2026-10-01T10:00:00Z');
        const newest = await file(lead1, 'passport', '2026-10-03T10:00:00Z');
        const middle = await file(lead1, 'passport', '2026-10-02T10:00:00Z');
        const visa = await file(lead1, 'visa', '2026-10-01T10:00:00Z');
        await tx`
          insert into app.file_review_events (workspace_id, file_id, actor_id, decision)
          values (${SITE}, ${approvedOld}, ${ACTOR}, 'approved')
        `;
        // A restricted lead's file may only be tombstoned (0001's guard).
        const lead2 = await lead();
        const restrictedOld = await file(lead2, 'passport', '2026-10-01T10:00:00Z');
        const restrictedNew = await file(lead2, 'passport', '2026-10-02T10:00:00Z');
        await tx`update app.leads set customer_data_restricted_at = now() where id = ${lead2}`;

        const read = () =>
          tx<{ id: string; status: string; supersededBy: string | null }[]>`
            select id, status, superseded_by_file_id as "supersededBy"
            from app.files where workspace_id = ${SITE} order by id
          `;
        for (const statement of migrationStatements()) await tx.unsafe(statement);
        const after = new Map((await read()).map((row) => [row.id, row]));
        expect(after.get(newest)).toMatchObject({ status: 'available', supersededBy: null });
        expect(after.get(middle)).toMatchObject({ status: 'available', supersededBy: newest });
        expect(after.get(approvedOld)).toMatchObject({ status: 'available', supersededBy: newest });
        expect(after.get(visa)).toMatchObject({ status: 'available', supersededBy: null });
        expect(after.get(restrictedNew)).toMatchObject({ status: 'available', supersededBy: null });
        expect(after.get(restrictedOld)).toMatchObject({ status: 'deleted', supersededBy: null });
        // The newest has no review: the old approval does not move to it.
        const [reviews] = await tx<{ count: number }[]>`
          select count(*)::int as count from app.file_review_events where file_id = ${newest}
        `;
        expect(reviews?.count).toBe(0);

        // Run again: nothing changes.
        for (const statement of migrationStatements()) await tx.unsafe(statement);
        expect(new Map((await read()).map((row) => [row.id, row]))).toEqual(after);

        // And a second current passport is refused now.
        const refused = await tx
          .savepoint(
            (sp) => sp`update app.files set superseded_by_file_id = null where id = ${middle}`,
          )
          .catch((caught: unknown) => caught);
        expect(refused).toMatchObject({ code: '23505' });
        throw new RolledBack();
      })
      .catch((error: unknown) => error);
    if (!(outcome instanceof RolledBack)) throw outcome;
  });
});
