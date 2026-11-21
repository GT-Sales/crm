import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../src/migrations.js';
import { getDisposableTestDatabaseUrl } from '../src/test-helpers.js';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Ids of this file only; everything is written in a transaction rolled back at the end.
const SITE = '18000000-0000-4000-8000-000000004901';
const ACTOR = '28000000-0000-4000-8000-000000004911';

class RolledBack extends Error {}

databaseTest('migration 0049: the index of opened leads', () => {
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('exists, is valid and holds only the opened entries', async () => {
    const [index] = await admin<{ definition: string; valid: boolean }[]>`
      select pg_get_indexdef(i.indexrelid) as definition, i.indisvalid as valid
      from pg_index i
      where i.indexrelid = to_regclass('app.lead_activities_opened_idx')
    `;
    expect(index?.valid).toBe(true);
    expect(index?.definition).toContain('(workspace_id, lead_id)');
    expect(index?.definition).toContain("kind = 'system'");
    expect(index?.definition).toContain("(data ->> 'event'::text) = 'opened'");
  });

  it('answers which of a site’s leads were opened, as the backend asks it', async () => {
    const outcome = await admin
      .begin(async (tx) => {
        await tx`
          insert into app.workspaces (id, slug, name)
          values (${SITE}, 'opened-index-4901', 'Opened Index Site')
        `;
        const lead = async () => {
          const [row] = await tx<{ id: string }[]>`
            insert into app.leads (workspace_id, lead_type, status, stage, consent_version)
            values (${SITE}, 'internet', 'submitted', 'new', 'ci')
            returning id
          `;
          if (!row) throw new Error('no lead');
          return row.id;
        };
        const entry = (leadId: string, kind: string, data: Record<string, string> | null) => tx`
          insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body, data)
          values (${SITE}, ${leadId}, ${ACTOR}, ${kind}, ${kind === 'note' ? 'A note' : null},
            ${data === null ? null : tx.json(data)})
        `;
        const opened = await lead();
        const unopened = await lead();
        await entry(opened, 'system', { event: 'opened' });
        await entry(opened, 'system', { event: 'submitted' });
        // Not an opening: another event, and a note that happens to carry the word.
        await entry(unopened, 'system', { event: 'submitted' });
        await entry(unopened, 'note', { event: 'opened' });

        // With sequential scans off the planner must use an index; the plan
        // names which one it could prove covers the question.
        await tx`set local enable_seqscan = off`;
        await tx`set local enable_bitmapscan = off`;
        const query = `
          select distinct activity.lead_id as "leadId"
          from app.lead_activities activity
          where activity.workspace_id = '${SITE}'
            and activity.kind = 'system'
            and activity.data ->> 'event' = 'opened'
        `;
        const rows = await tx.unsafe<{ leadId: string }[]>(query);
        const plan = await tx.unsafe<{ 'QUERY PLAN': string }[]>(`explain (costs off) ${query}`);
        expect(rows.map((row) => row.leadId)).toEqual([opened]);
        expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toContain(
          'lead_activities_opened_idx',
        );
        throw new RolledBack();
      })
      .catch((error: unknown) => error);
    if (!(outcome instanceof RolledBack)) throw outcome;
  });
});
