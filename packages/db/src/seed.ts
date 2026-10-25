import postgres from 'postgres';
import { postgresSsl, sslModeFromEnv, type SslMode } from './ssl.js';

import { staffPermissionNames, staffRoleNames } from '@gt-sales/types';

/**
 * Fixed ids for the synthetic development seed. The two sites mirror the
 * client's real websites by slug so local work reads like production, but the
 * actors and memberships are invented: this seed never targets a hosted
 * database (`assertSyntheticSeedTarget`).
 */
export const STAFF_SEED_IDS = {
  ownerActor: '20000000-0000-4000-8000-000000000100',
  getCanadaSimActor: '20000000-0000-4000-8000-000000000101',
  canadaWideActor: '20000000-0000-4000-8000-000000000102',
  getCanadaSimWorkspace: '10000000-0000-4000-8000-000000000101',
  canadaWideWorkspace: '10000000-0000-4000-8000-000000000102',
  getCanadaSimOwnerMembership: '30000000-0000-4000-8000-000000000101',
  canadaWideOwnerMembership: '30000000-0000-4000-8000-000000000102',
  getCanadaSimStaffMembership: '30000000-0000-4000-8000-000000000103',
  canadaWideStaffMembership: '30000000-0000-4000-8000-000000000104',
};

export const SEED_WORKSPACES = [
  {
    id: STAFF_SEED_IDS.getCanadaSimWorkspace,
    slug: 'getcanadasim',
    name: 'Get Canada Sim',
    domain: 'getcanadasim.com',
  },
  {
    id: STAFF_SEED_IDS.canadaWideWorkspace,
    slug: 'canadawide',
    name: 'CanadaWide',
    domain: 'canadawidesales.com',
  },
] as const;

export interface SeedDatabaseOptions {
  connectionString: string;
  ssl?: SslMode;
}

/** Idempotent synthetic development seed. It never creates Supabase Auth users. */
export async function seedDatabase(options: SeedDatabaseOptions): Promise<void> {
  const client = postgres(options.connectionString, {
    max: 1,
    prepare: false,
    ssl: postgresSsl(options.ssl, process.env.MIGRATION_DATABASE_SSL_CA),
  });

  try {
    await client.begin(async (tx) => {
      for (const workspace of SEED_WORKSPACES) {
        await tx`
          insert into app.workspaces (id, slug, name, domain)
          values (${workspace.id}, ${workspace.slug}, ${workspace.name}, ${workspace.domain})
          -- No conflict target, so a concurrent seed racing on the id *or* the
          -- slug unique key (parallel integration suites share one database) is
          -- skipped too. Never renames an existing site.
          on conflict do nothing
        `;
      }

      for (const workspace of SEED_WORKSPACES) {
        for (const name of staffRoleNames) {
          await tx`
            insert into app.roles (workspace_id, name)
            values (${workspace.id}, ${name})
            on conflict (workspace_id, name) do nothing
          `;
        }
        for (const name of staffPermissionNames) {
          await tx`
            insert into app.permissions (workspace_id, name)
            values (${workspace.id}, ${name})
            on conflict (workspace_id, name) do nothing
          `;
        }
      }

      await tx`
        insert into app.memberships (
          id, workspace_id, user_id, membership_type, status, accepted_at
        )
        values
          (${STAFF_SEED_IDS.getCanadaSimOwnerMembership}, ${STAFF_SEED_IDS.getCanadaSimWorkspace}, ${STAFF_SEED_IDS.ownerActor}, 'staff', 'active', now()),
          (${STAFF_SEED_IDS.canadaWideOwnerMembership}, ${STAFF_SEED_IDS.canadaWideWorkspace}, ${STAFF_SEED_IDS.ownerActor}, 'staff', 'active', now()),
          (${STAFF_SEED_IDS.getCanadaSimStaffMembership}, ${STAFF_SEED_IDS.getCanadaSimWorkspace}, ${STAFF_SEED_IDS.getCanadaSimActor}, 'staff', 'active', now()),
          (${STAFF_SEED_IDS.canadaWideStaffMembership}, ${STAFF_SEED_IDS.canadaWideWorkspace}, ${STAFF_SEED_IDS.canadaWideActor}, 'staff', 'active', now())
        on conflict (id) do nothing
      `;

      const assignments = [
        {
          workspaceId: STAFF_SEED_IDS.getCanadaSimWorkspace,
          membershipId: STAFF_SEED_IDS.getCanadaSimOwnerMembership,
          role: 'owner',
        },
        {
          workspaceId: STAFF_SEED_IDS.canadaWideWorkspace,
          membershipId: STAFF_SEED_IDS.canadaWideOwnerMembership,
          role: 'owner',
        },
        {
          workspaceId: STAFF_SEED_IDS.getCanadaSimWorkspace,
          membershipId: STAFF_SEED_IDS.getCanadaSimStaffMembership,
          role: 'leads',
        },
        {
          workspaceId: STAFF_SEED_IDS.canadaWideWorkspace,
          membershipId: STAFF_SEED_IDS.canadaWideStaffMembership,
          role: 'viewer',
        },
      ];
      for (const { workspaceId, membershipId, role } of assignments) {
        await tx`
          insert into app.membership_roles (workspace_id, membership_id, role_id)
          select ${workspaceId}, ${membershipId}, role_row.id
          from app.roles as role_row
          where role_row.workspace_id = ${workspaceId}
            and role_row.name = ${role}
          on conflict (workspace_id, membership_id, role_id) do nothing
        `;
      }
    });
  } finally {
    await client.end();
  }
}

/**
 * Refuses a hosted Supabase database unless its name marks it as disposable.
 * NODE_ENV alone is not a guard: it is usually unset in a shell or a CI step,
 * and the seed inserts invented staff memberships into the target.
 */
export function assertSyntheticSeedTarget(connectionString: string): void {
  const url = new URL(connectionString);
  const hosted = /(^|\.)supabase\.(co|com)$/i.test(url.hostname);
  const database = url.pathname.replace(/^\//, '');
  if (hosted && !/(_test|_dev)$/.test(database)) {
    throw new Error(
      `Refusing to seed ${url.hostname}/${database}: the synthetic seed never targets a hosted Supabase database.`,
    );
  }
}

function migrationSsl(): SslMode {
  return sslModeFromEnv('MIGRATION_DATABASE_SSL_MODE', process.env.MIGRATION_DATABASE_SSL_MODE);
}

if (process.argv[1]?.endsWith('seed.ts')) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The synthetic staff seed is disabled in production.');
  }
  if (process.env.DB_SEED_ALLOW_SYNTHETIC !== '1') {
    throw new Error(
      'Set DB_SEED_ALLOW_SYNTHETIC=1 to run the synthetic seed; it must never target a hosted Supabase database.',
    );
  }
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');
  assertSyntheticSeedTarget(connectionString);
  await seedDatabase({ connectionString, ssl: migrationSsl() });
  console.info('Seeded the getcanadasim and canadawide sites with synthetic staff.');
}
