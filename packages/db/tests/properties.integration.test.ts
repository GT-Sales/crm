import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../src/migrations.js';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '../src/test-helpers.js';

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

const WORKSPACE_1 = '14000000-0000-4000-8000-000000000901';
const WORKSPACE_2 = '14000000-0000-4000-8000-000000000902';
const ACTOR_A = '15000000-0000-4000-8000-000000000901';
const ACTOR_B = '15000000-0000-4000-8000-000000000902';
const LEAD_1 = '16000000-0000-4000-8000-000000000901';

const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';

databaseTest('properties, property layouts, saved views and leads.custom_values', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;

  /** One app_runtime transaction with the tenant context withTenantTx would set. */
  function asRuntime<T>(
    workspaceId: string,
    actorId: string,
    body: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return runtimeSql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${workspaceId}, true),
               set_config('app.actor_id', ${actorId}, true)
      `;
      return body(tx);
    });
  }

  async function cleanUp(): Promise<void> {
    // Cascades to the memberships, leads, properties, layouts and views below.
    await admin`delete from app.workspaces where id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await setTestRuntimePassword(admin);
    await cleanUp();

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_1}, 'ci-properties-1', 'CI Properties 1'),
        (${WORKSPACE_2}, 'ci-properties-2', 'CI Properties 2')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values
        (${WORKSPACE_1}, ${ACTOR_A}, 'staff', 'active'),
        (${WORKSPACE_1}, ${ACTOR_B}, 'staff', 'active'),
        (${WORKSPACE_2}, ${ACTOR_A}, 'staff', 'active')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
  });

  afterAll(async () => {
    await runtimeSql?.end();
    if (admin) {
      await cleanUp();
      await admin.end();
    }
  });

  it('saved_views are visible only to their owner inside their workspace', async () => {
    const [mine] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.saved_views (workspace_id, actor_id, object, name, state)
        values (${WORKSPACE_1}, ${ACTOR_A}, 'lead', 'Mine', ${tx.json({ sort: 'updated' })})
        returning id
      `;
    });
    if (!mine) throw new Error('the view was not inserted');

    // Its owner sees it; another actor of the same site does not, and cannot
    // change it.
    const ownRows = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`select id from app.saved_views where id = ${mine.id}`;
    });
    expect(ownRows).toHaveLength(1);
    const otherRows = await asRuntime(WORKSPACE_1, ACTOR_B, (tx) => {
      return tx`select id from app.saved_views where id = ${mine.id}`;
    });
    expect(otherRows).toHaveLength(0);
    const updated = await asRuntime(WORKSPACE_1, ACTOR_B, (tx) => {
      return tx`update app.saved_views set name = 'Taken' where id = ${mine.id}`;
    });
    expect(updated.count).toBe(0);
    const deleted = await asRuntime(WORKSPACE_1, ACTOR_B, (tx) => {
      return tx`delete from app.saved_views where id = ${mine.id}`;
    });
    expect(deleted.count).toBe(0);

    // The owner in another site's context does not see it either.
    const otherSite = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx`select id from app.saved_views where id = ${mine.id}`;
    });
    expect(otherSite).toHaveLength(0);

    // The name is unique per owner, not per site, and case-insensitively.
    const theirs = await asRuntime(WORKSPACE_1, ACTOR_B, (tx) => {
      return tx`
        insert into app.saved_views (workspace_id, actor_id, object, name, state)
        values (${WORKSPACE_1}, ${ACTOR_B}, 'lead', 'Mine', '{}'::jsonb)
        returning id
      `;
    });
    expect(theirs).toHaveLength(1);
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.saved_views (workspace_id, actor_id, object, name, state)
          values (${WORKSPACE_1}, ${ACTOR_A}, 'lead', 'mine', '{}'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    // Nobody can save a view on someone else's behalf.
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_B, (tx) => {
        return tx`
          insert into app.saved_views (workspace_id, actor_id, object, name, state)
          values (${WORKSPACE_1}, ${ACTOR_A}, 'lead', 'Planted', '{}'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    // Shape checks: a trimmed name of 1-60 characters and an object state.
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.saved_views (workspace_id, actor_id, object, name, state)
          values (${WORKSPACE_1}, ${ACTOR_A}, 'lead', '   ', '{}'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.saved_views (workspace_id, actor_id, object, name, state)
          values (${WORKSPACE_1}, ${ACTOR_A}, 'lead', 'Array', '[]'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // The owner can delete their own view.
    const removed = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`delete from app.saved_views where id = ${mine.id}`;
    });
    expect(removed.count).toBe(1);
  });

  it('a deleted property key stays reserved and cannot be undeleted or retyped', async () => {
    const [property] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.properties (workspace_id, object, key, origin, label, kind, created_by)
        values (${WORKSPACE_1}, 'lead', 'custom_x', 'custom', 'X', 'text', ${ACTOR_A})
        returning id
      `;
    });
    if (!property) throw new Error('the property was not inserted');

    // A live custom property cannot change its kind, key or origin.
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.properties set kind = 'number' where id = ${property.id}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.properties set key = 'custom_y' where id = ${property.id}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.properties set origin = 'builtin' where id = ${property.id}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    // Its label can change, and it can be tombstoned, not deleted.
    const relabelled = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`
        update app.properties set label = 'X code', version = version + 1
        where id = ${property.id}
      `;
    });
    expect(relabelled.count).toBe(1);
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`delete from app.properties where id = ${property.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    const tombstoned = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`update app.properties set deleted_at = now() where id = ${property.id}`;
    });
    expect(tombstoned.count).toBe(1);

    // The key stays reserved, and the tombstone stays.
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.properties (workspace_id, object, key, origin, label, kind)
          values (${WORKSPACE_1}, 'lead', 'custom_x', 'custom', 'X again', 'text')
        `;
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.properties set deleted_at = null where id = ${property.id}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.properties set deleted_at = now() - interval '1 day' where id = ${property.id}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });

    // Another site may use the same key.
    const elsewhere = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx`
        insert into app.properties (workspace_id, object, key, origin, label, kind)
        values (${WORKSPACE_2}, 'lead', 'custom_x', 'custom', 'X', 'text')
        returning id
      `;
    });
    expect(elsewhere).toHaveLength(1);
    const visible = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx<{ workspaceId: string }[]>`
        select workspace_id as "workspaceId" from app.properties where key = 'custom_x'
      `;
    });
    expect(visible).toEqual([{ workspaceId: WORKSPACE_2 }]);
  });

  it('a built-in override row cannot be tombstoned', async () => {
    const [override] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.properties (workspace_id, object, key, origin, label, kind, hidden)
        values (${WORKSPACE_1}, 'lead', 'city', 'builtin', 'Town', 'text', true)
        returning id
      `;
    });
    if (!override) throw new Error('the override was not inserted');

    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.properties set deleted_at = now() where id = ${override.id}`;
      }),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    const shown = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`update app.properties set hidden = false, label = 'City' where id = ${override.id}`;
    });
    expect(shown.count).toBe(1);
  });

  it('properties and layouts check their shape', async () => {
    const invalidProperties = [
      { object: 'plan_x', key: 'custom_ok', origin: 'custom', label: 'Ok', kind: 'text' },
      { object: 'lead', key: 'Custom_bad', origin: 'custom', label: 'Bad', kind: 'text' },
      { object: 'lead', key: 'custom_ok', origin: 'other', label: 'Ok', kind: 'text' },
      { object: 'lead', key: 'custom_ok', origin: 'custom', label: '', kind: 'text' },
      { object: 'lead', key: 'custom_ok', origin: 'custom', label: 'Ok', kind: 'file' },
    ];
    for (const row of invalidProperties) {
      await expect(
        asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
          return tx`
            insert into app.properties (workspace_id, object, key, origin, label, kind)
            values (${WORKSPACE_1}, ${row.object}, ${row.key}, ${row.origin}, ${row.label}, ${row.kind})
          `;
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.properties (workspace_id, object, key, origin, label, kind, options)
          values (${WORKSPACE_1}, 'lead', 'custom_ok', 'custom', 'Ok', 'choice', '{}'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    const [layout] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ leadType: string; version: number }[]>`
        insert into app.property_layouts (workspace_id, object, layout, updated_by)
        values (${WORKSPACE_1}, 'lead', ${tx.json({ sections: [] })}, ${ACTOR_A})
        returning lead_type as "leadType", version
      `;
    });
    expect(layout).toEqual({ leadType: '', version: 1 });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.property_layouts (workspace_id, object, layout)
          values (${WORKSPACE_1}, 'lead', '{}'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.property_layouts (workspace_id, object, lead_type, layout)
          values (${WORKSPACE_1}, 'lead', 'sim_order', '[]'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`
          insert into app.property_layouts (workspace_id, object, lead_type, layout)
          values (${WORKSPACE_1}, 'lead', 'Sim-Order', '{}'::jsonb)
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // Layouts are replaced, never removed.
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`delete from app.property_layouts where workspace_id = ${WORKSPACE_1}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('leads.custom_values defaults to {} and rejects a non-object', async () => {
    const [lead] = await admin<{ customValues: unknown }[]>`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version)
      values (${LEAD_1}, ${WORKSPACE_1}, 'contact_message', 'submitted', 'ci-v1')
      returning custom_values as "customValues"
    `;
    expect(lead).toEqual({ customValues: {} });

    const written = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`
        update app.leads set custom_values = ${tx.json({ custom_x: 'abc' })}
        where id = ${LEAD_1}
      `;
    });
    expect(written.count).toBe(1);
    for (const value of ['[]', '"text"', '3', 'null']) {
      await expect(
        asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
          return tx`update app.leads set custom_values = ${value}::jsonb where id = ${LEAD_1}`;
        }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      admin`update app.leads set custom_values = null where id = ${LEAD_1}`,
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('every new RLS table has a backup_reader policy, FORCE RLS and least-privilege grants', async () => {
    const tables = await admin<
      {
        tablename: string;
        rowSecurity: boolean;
        forced: boolean;
        policies: string[];
      }[]
    >`
      select
        c.relname as tablename,
        c.relrowsecurity as "rowSecurity",
        c.relforcerowsecurity as forced,
        array(
          select p.policyname::text from pg_policies p
          where p.schemaname = 'app' and p.tablename = c.relname
          order by p.policyname
        ) as policies
      from pg_class c
      where c.relnamespace = 'app'::regnamespace
        and c.relname in ('properties', 'property_layouts', 'saved_views')
      order by c.relname
    `;
    expect(tables).toEqual([
      {
        tablename: 'properties',
        rowSecurity: true,
        forced: true,
        policies: ['properties_backup_reader_read', 'properties_tenant_policy'],
      },
      {
        tablename: 'property_layouts',
        rowSecurity: true,
        forced: true,
        policies: ['property_layouts_backup_reader_read', 'property_layouts_tenant_policy'],
      },
      {
        tablename: 'saved_views',
        rowSecurity: true,
        forced: true,
        policies: ['saved_views_backup_reader_read', 'saved_views_owner_policy'],
      },
    ]);

    const privileges = await admin<
      { tablename: string; select: boolean; insert: boolean; update: boolean; delete: boolean }[]
    >`
      select
        t.name as tablename,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'SELECT') as select,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'INSERT') as insert,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'UPDATE') as update,
        has_table_privilege('app_runtime', format('app.%I', t.name), 'DELETE') as delete
      from unnest(array['properties', 'property_layouts', 'saved_views']) as t(name)
      order by t.name
    `;
    expect(privileges).toEqual([
      { tablename: 'properties', select: true, insert: true, update: true, delete: false },
      { tablename: 'property_layouts', select: true, insert: true, update: true, delete: false },
      { tablename: 'saved_views', select: true, insert: true, update: true, delete: true },
    ]);
  });
});
