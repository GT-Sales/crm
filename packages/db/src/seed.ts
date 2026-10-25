import postgres from 'postgres';
import { postgresSsl, sslModeFromEnv, type SslMode } from './ssl.js';

import { staffPermissionNames, staffRoleNames } from '@gt-sales/types';

export const STAFF_SEED_IDS = {
  ownerActor: '20000000-0000-4000-8000-000000000100',
  siteActor: '20000000-0000-4000-8000-000000000101',
  demoActor: '20000000-0000-4000-8000-000000000102',
  siteWorkspace: '10000000-0000-4000-8000-000000000101',
  demoWorkspace: '10000000-0000-4000-8000-000000000102',
  siteOwnerMembership: '30000000-0000-4000-8000-000000000101',
  demoOwnerMembership: '30000000-0000-4000-8000-000000000102',
  siteStaffMembership: '30000000-0000-4000-8000-000000000103',
  demoStaffMembership: '30000000-0000-4000-8000-000000000104',
};

export const PARTNER_SEED_IDS = {
  siteApprovedPartner: '80000000-0000-4000-8000-000000000101',
  siteSuspendedPartner: '80000000-0000-4000-8000-000000000102',
  sitePendingPartner: '80000000-0000-4000-8000-000000000103',
};

export const CATALOGUE_SEED_IDS = {
  siteStarterProduct: '90000000-0000-4000-8000-000000000101',
  siteStarterOfferVersion: '91000000-0000-4000-8000-000000000101',
  siteUnlimitedProduct: '90000000-0000-4000-8000-000000000102',
  siteUnlimitedOfferVersion: '91000000-0000-4000-8000-000000000102',
};

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
      await tx`
        insert into app.workspaces (id, slug, name)
        values
          (${STAFF_SEED_IDS.siteWorkspace}, 'site-1', 'Northern Arrival Mobile'),
          (${STAFF_SEED_IDS.demoWorkspace}, 'demo-2', 'Maple Demo Sandbox')
        -- Never rename an existing workspace: production site-1 was created
        -- from this seed id and has since been renamed by the owner. No conflict
        -- target, so a concurrent seed racing on the id *or* the slug unique key
        -- (parallel integration suites share one database) is skipped too.
        on conflict do nothing
      `;

      for (const workspaceId of [STAFF_SEED_IDS.siteWorkspace, STAFF_SEED_IDS.demoWorkspace]) {
        for (const name of staffRoleNames) {
          await tx`
            insert into app.roles (workspace_id, name)
            values (${workspaceId}, ${name})
            on conflict (workspace_id, name) do nothing
          `;
        }
        for (const name of staffPermissionNames) {
          await tx`
            insert into app.permissions (workspace_id, name)
            values (${workspaceId}, ${name})
            on conflict (workspace_id, name) do nothing
          `;
        }
      }

      await tx`
        insert into app.memberships (
          id, workspace_id, user_id, membership_type, status, accepted_at
        )
        values
          (${STAFF_SEED_IDS.siteOwnerMembership}, ${STAFF_SEED_IDS.siteWorkspace}, ${STAFF_SEED_IDS.ownerActor}, 'staff', 'active', now()),
          (${STAFF_SEED_IDS.demoOwnerMembership}, ${STAFF_SEED_IDS.demoWorkspace}, ${STAFF_SEED_IDS.ownerActor}, 'staff', 'active', now()),
          (${STAFF_SEED_IDS.siteStaffMembership}, ${STAFF_SEED_IDS.siteWorkspace}, ${STAFF_SEED_IDS.siteActor}, 'staff', 'active', now()),
          (${STAFF_SEED_IDS.demoStaffMembership}, ${STAFF_SEED_IDS.demoWorkspace}, ${STAFF_SEED_IDS.demoActor}, 'staff', 'active', now())
        on conflict (id) do nothing
      `;

      const assignments = [
        {
          workspaceId: STAFF_SEED_IDS.siteWorkspace,
          membershipId: STAFF_SEED_IDS.siteOwnerMembership,
          role: 'owner',
        },
        {
          workspaceId: STAFF_SEED_IDS.demoWorkspace,
          membershipId: STAFF_SEED_IDS.demoOwnerMembership,
          role: 'owner',
        },
        {
          workspaceId: STAFF_SEED_IDS.siteWorkspace,
          membershipId: STAFF_SEED_IDS.siteStaffMembership,
          role: 'orders',
        },
        {
          workspaceId: STAFF_SEED_IDS.demoWorkspace,
          membershipId: STAFF_SEED_IDS.demoStaffMembership,
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

      // Synthetic referral agencies for site-1 only, one per T4P lifecycle state.
      await tx`
        insert into app.partners (id, workspace_id, name, referral_code, status)
        values
          (${PARTNER_SEED_IDS.siteApprovedPartner}, ${STAFF_SEED_IDS.siteWorkspace}, 'Maple Leaf Referrals', 'MAPLE10', 'approved'),
          (${PARTNER_SEED_IDS.siteSuspendedPartner}, ${STAFF_SEED_IDS.siteWorkspace}, 'Northline Agents', 'NORTHLINE', 'suspended'),
          (${PARTNER_SEED_IDS.sitePendingPartner}, ${STAFF_SEED_IDS.siteWorkspace}, 'Harbourfront Mobility', 'HARBOUR5', 'pending')
        on conflict (id) do update
        set name = excluded.name, referral_code = excluded.referral_code, status = excluded.status
      `;

      // Synthetic site-1 catalogue (T10A): two products, one current offer
      // version each, one available and one withdrawn. Never updated once
      // inserted — offer_versions is immutable — so this is `do nothing`.
      await tx`
        insert into app.products (id, workspace_id, product_key)
        values
          (${CATALOGUE_SEED_IDS.siteStarterProduct}, ${STAFF_SEED_IDS.siteWorkspace}, 'starter-5gb'),
          (${CATALOGUE_SEED_IDS.siteUnlimitedProduct}, ${STAFF_SEED_IDS.siteWorkspace}, 'unlimited-plus')
        on conflict (id) do nothing
      `;

      const starterContent = JSON.stringify({
        name: 'Starter 5GB (TEST)',
        currency: 'CAD',
        recurringChargeAmountMinor: 2999,
        oneTimeFees: [],
        amountPayableTodayMinor: 2999,
        paymentRequired: true,
        documentChecklist: ['passport'],
        eligibility: 'TEST fixture — synthetic data only.',
        availability: 'TEST fixture — available across Canada.',
        billingParty: 'Canadian Plans',
        specs: { carrier: 'TEST Carrier', dataAllowance: '5GB' },
      });
      const unlimitedContent = JSON.stringify({
        name: 'Unlimited Plus (TEST)',
        currency: 'CAD',
        recurringChargeAmountMinor: 5999,
        oneTimeFees: [{ label: 'SIM kit', amountMinor: 500 }],
        amountPayableTodayMinor: 6499,
        paymentRequired: true,
        documentChecklist: ['passport', 'visa'],
        eligibility: 'TEST fixture — synthetic data only.',
        availability: 'TEST fixture — withdrawn from sale.',
        billingParty: 'Canadian Plans',
        specs: { carrier: 'TEST Carrier', dataAllowance: 'Unlimited' },
      });
      await tx`
        insert into app.offer_versions (
          id, workspace_id, product_id, content, content_hash
        )
        values
          (
            ${CATALOGUE_SEED_IDS.siteStarterOfferVersion},
            ${STAFF_SEED_IDS.siteWorkspace},
            ${CATALOGUE_SEED_IDS.siteStarterProduct},
            ${starterContent}::jsonb,
            'sha256:test-starter-5gb-v1'
          ),
          (
            ${CATALOGUE_SEED_IDS.siteUnlimitedOfferVersion},
            ${STAFF_SEED_IDS.siteWorkspace},
            ${CATALOGUE_SEED_IDS.siteUnlimitedProduct},
            ${unlimitedContent}::jsonb,
            'sha256:test-unlimited-plus-v1'
          )
        on conflict (id) do nothing
      `;

      // Starter stays available; Unlimited Plus is a synthetic withdrawn fixture.
      await tx`
        insert into app.product_availability (product_id, workspace_id, revoked_at)
        values
          (${CATALOGUE_SEED_IDS.siteStarterProduct}, ${STAFF_SEED_IDS.siteWorkspace}, null),
          (${CATALOGUE_SEED_IDS.siteUnlimitedProduct}, ${STAFF_SEED_IDS.siteWorkspace}, now())
        on conflict (product_id) do update
        set revoked_at = excluded.revoked_at
      `;
    });
  } finally {
    await client.end();
  }
}

/**
 * Refuses a hosted Supabase database unless its name marks it as disposable.
 * NODE_ENV alone is not a guard: it is usually unset in a shell or a CI step,
 * and the seed upserts synthetic partners and TEST offers into the target.
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
  console.info('Seeded isolated site-1 and demo-2 staff workspaces.');
}
