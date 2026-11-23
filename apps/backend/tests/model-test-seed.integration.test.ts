/**
 * The Model test seed (apps/backend/scripts/model-test/seed.sql): it applies
 * on the migrated schema, a second run changes nothing it should not, it
 * writes no other site's rows, and the facts the prompt set checks against
 * (docs/evals/model-test/prompts-v1.json) hold.
 */
import { readFile } from 'node:fs/promises';

import { applyMigrations } from '@gt-sales/db/migrations';
import { getDisposableTestDatabaseUrl } from '@gt-sales/db/test-helpers';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '0d0e1000-7e57-4000-8000-000000000001';
const OWNER = '0d0e1000-7e57-4000-8009-000000000001';
const LEADS = '0d0e1000-7e57-4000-8009-000000000002';
const OTHER_SITE = '0d0e1000-7e57-4000-8000-0000000000ff';

/** The seed with its two psql variables filled in, as the SQL editor variant asks. */
async function seedSql(): Promise<string> {
  const text = await readFile(new URL('../scripts/model-test/seed.sql', import.meta.url), 'utf8');
  return text
    .replace(":'owner_user_id'::uuid", `'${OWNER}'::uuid`)
    .replace(":'leads_user_id'::uuid", `'${LEADS}'::uuid`);
}

databaseTest('model test seed', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin`
      insert into app.workspaces (id, slug, name) values (${OTHER_SITE}, 'model-test-neighbour', 'Neighbour')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, full_name, consent_version)
      values ('0d0e1000-7e57-4000-80ff-000000000001', ${OTHER_SITE}, 'internet', 'submitted', 'new', 'Neighbour Lead', 'ci')
      on conflict (id) do update set stage = 'new'
    `;
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
  });

  test('applies twice and keeps one copy of every row', async () => {
    const sql = await seedSql();
    await admin.unsafe(sql);
    const counts = async () =>
      admin<{ table: string; n: number }[]>`
        select 'leads' as table, count(*)::int as n from app.leads where workspace_id = ${SITE}
        union all select 'activities', count(*)::int from app.lead_activities where workspace_id = ${SITE}
        union all select 'tasks', count(*)::int from app.lead_tasks where workspace_id = ${SITE}
        union all select 'members', count(*)::int from app.memberships where workspace_id = ${SITE}
        union all select 'roles', count(*)::int from app.membership_roles where workspace_id = ${SITE}
        union all select 'plans', count(*)::int from app.plans where workspace_id = ${SITE}
        order by 1
      `;
    const first = await counts();
    await admin.unsafe(sql);
    expect(await counts()).toEqual(first);
    expect(Object.fromEntries(first.map((row) => [row.table, row.n]))).toMatchObject({
      leads: 61,
      tasks: 12,
      members: 2,
      roles: 2,
      plans: 4,
    });
    const [neighbour] = await admin<{ stage: string }[]>`
      select stage from app.leads where id = '0d0e1000-7e57-4000-80ff-000000000001'
    `;
    expect(neighbour?.stage).toBe('new');
  }, 60_000);

  test('gives the two accounts the Owner and Leads roles and allows the eight models', async () => {
    const roles = await admin<{ user_id: string; name: string }[]>`
      select m.user_id, r.name::text as name
      from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id
      join app.roles r on r.id = mr.role_id
      where m.workspace_id = ${SITE}
      order by r.name::text
    `;
    expect(roles).toEqual([
      { user_id: LEADS, name: 'leads' },
      { user_id: OWNER, name: 'owner' },
    ]);
    const [settings] = await admin<{ models: number; default_model: string }[]>`
      select jsonb_array_length(allowed_models)::int as models, default_model
      from app.ai_model_settings where workspace_id = ${SITE}
    `;
    expect(settings).toEqual({ models: 8, default_model: 'openai/gpt-6-luna' });
  });

  test('holds the facts the prompt checks compare against', async () => {
    const [facts] = await admin<
      {
        pending: number;
        unopened: number;
        overdue: number;
        due_today: number;
        internet_30: number;
        internet_google_30: number;
        internet_won_30: number;
        internet_lost_30: number;
        oldest_overdue: string;
        newest_sim: string;
      }[]
    >`
      with today as (select (now() at time zone 'America/Toronto')::date as d)
      select
        (select count(*)::int from app.leads where workspace_id = ${SITE} and deleted_at is null
           and lead_type = 'sim_order' and stage = 'pending') as pending,
        (select count(*)::int from app.leads l where workspace_id = ${SITE} and deleted_at is null
           and not exists (select 1 from app.lead_activities a where a.workspace_id = l.workspace_id
             and a.lead_id = l.id and a.kind = 'system' and a.data ->> 'event' = 'opened')) as unopened,
        (select count(*)::int from app.lead_tasks, today where workspace_id = ${SITE}
           and status in ('open', 'in_progress') and (due_at at time zone 'America/Toronto')::date < today.d) as overdue,
        (select count(*)::int from app.lead_tasks, today where workspace_id = ${SITE}
           and status in ('open', 'in_progress') and (due_at at time zone 'America/Toronto')::date = today.d) as due_today,
        (select count(*)::int from app.leads where workspace_id = ${SITE} and deleted_at is null
           and lead_type = 'internet' and created_at > now() - interval '30 days') as internet_30,
        (select count(*)::int from app.leads where workspace_id = ${SITE} and deleted_at is null
           and lead_type = 'internet' and created_at > now() - interval '30 days'
           and attribution ->> 'utmSource' = 'google') as internet_google_30,
        (select count(*)::int from app.leads where workspace_id = ${SITE} and deleted_at is null
           and lead_type = 'internet' and created_at > now() - interval '30 days' and stage = 'won') as internet_won_30,
        (select count(*)::int from app.leads where workspace_id = ${SITE} and deleted_at is null
           and lead_type = 'internet' and created_at > now() - interval '30 days' and stage = 'lost') as internet_lost_30,
        (select title from app.lead_tasks where workspace_id = ${SITE}
           and status in ('open', 'in_progress') order by due_at limit 1) as oldest_overdue,
        (select external_ref from app.leads where workspace_id = ${SITE} and deleted_at is null
           and lead_type = 'sim_order' order by created_at desc limit 1) as newest_sim
    `;
    expect(facts).toEqual({
      pending: 4,
      unopened: 10,
      overdue: 4,
      due_today: 3,
      internet_30: 13,
      internet_google_30: 7,
      internet_won_30: 2,
      internet_lost_30: 1,
      oldest_overdue: 'Check documents for Finley',
      newest_sim: 'MS-1001',
    });
  });

  test('refuses one account id given twice', async () => {
    const text = (await seedSql()).replace(`'${LEADS}'`, `'${OWNER}'`);
    await expect(admin.unsafe(text)).rejects.toThrow('two different auth user ids');
    await admin.unsafe('rollback').catch(() => undefined);
  });
});
