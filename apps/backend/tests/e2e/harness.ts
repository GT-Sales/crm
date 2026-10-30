/**
 * Browser-test harness for the admin's lead journeys
 * (apps/admin/e2e/leads.spec.ts). Runs the REAL backend (`createApp`, the real
 * staff routes, authorization store, lead stores and RLS) against a
 * disposable Postgres. One seam only: a stub staff-session verifier that
 * admits one seeded owner for a fixed bearer token, because CI has no Supabase
 * Auth project. Everything past the verifier is the production code path.
 *
 * Each start resets the e2e sites and seeds them: CanadaWide with two staff
 * (the signed-in owner and a colleague), internet and mobility leads in a few
 * stages, and one open task; plus Get Canada Sim with SIM orders for property
 * filter, sort and column checks, two plans ("Rogers 60GB", payment required,
 * and "Fido 75GB", none) and one more SIM order that ordered Rogers 60GB, so
 * its order details carry the frozen plan. Rogers 60GB requires a passport,
 * and Nadia Khan's order has one, attached and not yet reviewed. Get Canada
 * Sim has its email settings saved and its Dispatched email saved once
 * (version 1), and no automation rule switched on. All of it is written
 * through the real stores: the plans through the plan store, the ordered SIM
 * order through `createLead` with `order` and `submit: true`, the call the
 * website route `POST /website/leads` makes once it has checked the site's
 * key, and the email settings through the email settings store. Only the
 * passport's file row is inserted directly, as the upload's finalize leaves
 * it: no object store runs here, so documents are reviewed against an
 * in-memory one.
 *
 * Never imported by the deployed server: tsup bundles only `src/server.ts`.
 */
import postgres from 'postgres';
import { InMemoryR2DocumentStore } from '@gt-sales/adapters';
import { codePropertyCatalog } from '@gt-sales/contracts';
import { createDatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { assertDisposableDatabaseUrl, setTestRuntimePassword } from '@gt-sales/db/test-helpers';

import { createApp } from '../../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../../src/auth/session.js';
import { DatabaseDocumentContextResolver } from '../../src/documents/resolver.js';
import { DocumentService } from '../../src/documents/service.js';
import { DatabaseDocumentStore } from '../../src/documents/store.js';
import { DatabaseEmailSettingsStore } from '../../src/email/settings-store.js';
import { STARTER_TEMPLATES } from '../../src/email/starters.js';
import { DatabaseLeadStore } from '../../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../../src/leads/work-store.js';
import { DatabasePlanStore } from '../../src/plans/store.js';
import { createDefaultStaffRouteDependencies } from '../../src/routes/staff.js';

const PORT = Number(process.env['E2E_HARNESS_PORT'] ?? 4100);
const WORKSPACE_ID = '10000000-0000-4000-8000-0000000e2e01';
const SIM_WORKSPACE_ID = '10000000-0000-4000-8000-0000000e2e02';
const OWNER_ID = '20000000-0000-4000-8000-0000000e2e01';
const COLLEAGUE_ID = '20000000-0000-4000-8000-0000000e2e02';
const WEBSITE_ACTOR_ID = '20000000-0000-4000-8000-0000000e2e09';
const PASSPORT_FILE_ID = '50000000-0000-4000-8000-0000000e2e01';
const STAFF_BEARER = process.env['E2E_STAFF_BEARER'] ?? 'e2e-staff-session-owner';
const ADMIN_URL = process.env['TEST_MIGRATION_DATABASE_URL'];
const RUNTIME_URL = process.env['DATABASE_URL'];

if (!ADMIN_URL || !RUNTIME_URL) {
  process.stderr.write('TEST_MIGRATION_DATABASE_URL and DATABASE_URL are required.\n');
  process.exit(1);
}
try {
  // The harness deletes a site and resets app_runtime's password.
  assertDisposableDatabaseUrl(ADMIN_URL);
  assertDisposableDatabaseUrl(RUNTIME_URL);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// Customer email through the fake provider; the site's saved settings are its sender.
process.env['EMAIL_PROVIDER'] ??= 'fake';
process.env['EMAIL_CONTACT_HASH_SECRET'] ??= 'e2e-email-contact-hash-secret-0123';

const internetPayload = (planLabel: string, city: string) => ({
  planId: 'ab-1gbps',
  planLabel,
  dateOfBirth: '1990-04-12',
  streetAddress: '12 Example Street',
  city,
  postalCode: 'T2P 1J9',
  currentProvider: 'Shaw',
  consent: true,
  consentedAt: '2026-10-20T10:00:00.000Z',
});

const mobilityPayload = (firstName: string, lastName: string) => ({
  planId: 'cw-100gb',
  planLabel: '100 GB $40',
  lineCount: 2,
  firstName,
  lastName,
  keepNumber: true,
  simType: 'esim',
  currentProvider: 'Rogers',
  streetAddress: '9 Sample Road',
  city: 'Edmonton',
  postalCode: 'T5J 0N3',
});

async function seed(): Promise<void> {
  let nadiaLeadId: string | undefined;
  const admin = postgres(ADMIN_URL ?? '', { max: 1, prepare: false, ssl: false });
  try {
    await setTestRuntimePassword(admin);
    // The cascade clears the sites' leads, tasks, timeline and memberships.
    await admin`delete from app.workspaces where id in (${WORKSPACE_ID}, ${SIM_WORKSPACE_ID})`;
    await admin`
      insert into app.workspaces (id, slug, name, domain)
      values
        (${WORKSPACE_ID}, 'canadawide', 'CanadaWide', 'canadawideinternet.com'),
        (${SIM_WORKSPACE_ID}, 'getcanadasim', 'Get Canada Sim', 'getcanadasim.com')
    `;
    await admin`
      insert into app.roles (workspace_id, name)
      select ${WORKSPACE_ID}, r from unnest(enum_range(null::app.role_name)) as r
    `;
    await admin`
      insert into app.roles (workspace_id, name)
      select ${SIM_WORKSPACE_ID}, r from unnest(enum_range(null::app.role_name)) as r
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at, display_name)
      values
        (${WORKSPACE_ID}, ${OWNER_ID}, 'staff', 'active', now(), 'Takib'),
        (${WORKSPACE_ID}, ${COLLEAGUE_ID}, 'staff', 'active', now(), 'Sam'),
        (${SIM_WORKSPACE_ID}, ${OWNER_ID}, 'staff', 'active', now(), 'Takib')
    `;
    await admin`
      insert into app.membership_roles (workspace_id, membership_id, role_id)
      select m.workspace_id, m.id, r.id
      from app.memberships m
      join app.roles r on r.workspace_id = m.workspace_id
        and r.name = case when m.user_id = ${OWNER_ID} then 'owner'::app.role_name else 'leads'::app.role_name end
      where m.workspace_id in (${WORKSPACE_ID}, ${SIM_WORKSPACE_ID})
    `;
  } finally {
    await admin.end();
  }

  const database = createDatabaseClient({
    connectionString: RUNTIME_URL ?? '',
    maxConnections: 1,
    ssl: false,
  });
  try {
    const leads = new DatabaseLeadStore(database);
    const work = new DatabaseLeadWorkStore(database);
    const website = {
      workspaceId: WORKSPACE_ID,
      actorId: WEBSITE_ACTOR_ID,
      requestId: '40000000-0000-4000-8000-0000000e2e01',
    };
    const owner = { ...website, actorId: OWNER_ID, catalog: codePropertyCatalog };

    const people = [
      ['Avery Example', 'avery@example.test', '403 555 0101', 'internet', 'new'],
      ['Blake Sample', 'blake@example.test', '403 555 0102', 'internet', 'new'],
      ['Casey Demo', 'casey@example.test', '403 555 0103', 'internet', 'contacted'],
      ['Drew Testcase', 'drew@example.test', '403 555 0104', 'internet', 'won'],
      ['Ellis Mobile', 'ellis@example.test', '780 555 0105', 'mobility', 'new'],
    ] as const;
    for (const [fullName, email, phone, leadType, stage] of people) {
      const [first = fullName, last = fullName] = fullName.split(' ');
      const created = await leads.createLead({
        ...website,
        leadType,
        contact: { fullName, email, phone, countryCode: 'CA' },
        form: {
          schemaVersion: 1,
          payload:
            leadType === 'internet'
              ? internetPayload('1Gbps', 'Calgary')
              : mobilityPayload(first, last),
        },
        attribution: { utmSource: 'google', utmMedium: 'cpc' },
        consentVersion: 'cw-e2e-2026-10',
        submit: true,
      });
      if (stage !== 'new') {
        await work.updateLead({ ...owner, leadId: created.lead.id, stage });
      }
      if (fullName === 'Casey Demo') {
        await work.updateLead({ ...owner, leadId: created.lead.id, assignedActorId: OWNER_ID });
        await work.createTask({
          ...owner,
          leadId: created.lead.id,
          title: 'Confirm the install window',
          dueAt: '2026-10-20T12:00:00.000Z',
          assignedActorId: OWNER_ID,
        });
      }
    }

    const simWebsite = {
      workspaceId: SIM_WORKSPACE_ID,
      actorId: WEBSITE_ACTOR_ID,
      requestId: '40000000-0000-4000-8000-0000000e2e02',
    };
    const simOwner = { ...simWebsite, actorId: OWNER_ID, catalog: codePropertyCatalog };
    const simOrders = [
      ['Priya Sharma', 'priya@example.test', '647 555 0201', 'student', '2026-11-15'],
      ['Arjun Patel', 'arjun@example.test', '647 555 0202', 'student', '2026-11-05'],
      ['Marco Rossi', 'marco@example.test', '647 555 0203', 'worker', '2026-11-01'],
    ] as const;
    for (const [fullName, email, phone, permitType, arrivalDate] of simOrders) {
      const created = await leads.createLead({
        ...simWebsite,
        leadType: 'sim_order',
        contact: { fullName, email, phone, countryCode: 'IN' },
        form: {
          schemaVersion: 1,
          payload: {
            planId: 'rogers_60gb',
            planLabel: 'Rogers 60 GB ($40/mo)',
            permitType,
            arrivalDate,
            delivery: 'esim',
            flightBooked: true,
            gotVisa: true,
          },
        },
        attribution: { utmSource: 'google', utmMedium: 'cpc' },
        consentVersion: 'gcs-e2e-2026-10',
        submit: true,
      });
      await work.updateLead({ ...simOwner, leadId: created.lead.id, stage: 'pending' });
    }

    // Two plans, then one SIM order that names the first: submitted, so the
    // plan is frozen on it and its payment is pending.
    const plansStore = new DatabasePlanStore(database);
    const planIds: string[] = [];
    for (const [name, priceMinor, paymentRequired] of [
      ['Rogers 60GB', 4000, true],
      ['Fido 75GB', 3500, false],
    ] as const) {
      const outcome = await plansStore.create(simOwner, {
        leadType: 'sim_order',
        name,
        priceMinor,
        billingPeriod: 'month',
        paymentRequired,
        active: true,
        requiredDocuments: name === 'Rogers 60GB' ? ['passport'] : [],
        customValues: {},
      });
      if (outcome.kind !== 'created') throw new Error(`seed plan ${name}: ${outcome.kind}`);
      planIds.push(outcome.plan.id);
    }
    const [rogersPlanId] = planIds;
    if (!rogersPlanId) throw new Error('seed plan Rogers 60GB was not created');
    const ordered = await leads.createLead({
      ...simWebsite,
      leadType: 'sim_order',
      contact: {
        fullName: 'Nadia Khan',
        email: 'nadia@example.test',
        phone: '647 555 0204',
        countryCode: 'IN',
      },
      form: {
        schemaVersion: 1,
        payload: {
          planId: rogersPlanId,
          planLabel: 'Rogers 60GB',
          permitType: 'worker',
          arrivalDate: '2026-11-20',
          delivery: 'esim',
          flightBooked: true,
          gotVisa: true,
        },
      },
      order: { planId: rogersPlanId, quantity: 1 },
      attribution: { utmSource: 'google', utmMedium: 'cpc' },
      consentVersion: 'gcs-e2e-2026-10',
      submit: true,
    });
    await work.updateLead({ ...simOwner, leadId: ordered.lead.id, stage: 'pending' });
    nadiaLeadId = ordered.lead.id;

    // Get Canada Sim's sender, and its Dispatched email saved once (version 1).
    // No automation rule is switched on: the journey does that.
    const email = new DatabaseEmailSettingsStore(database);
    await email.putSettings(simOwner, {
      fromName: 'Get Canada Sim',
      fromAddress: 'orders@getcanadasim.example',
      replyTo: null,
      logoUrl: null,
      brandColor: '#123abc',
      footerText: '',
      siteUrl: 'https://getcanadasim.example',
    });
    const dispatched = await email.putTemplate(simOwner, 'dispatched', {
      expectedVersion: 0,
      ...STARTER_TEMPLATES.dispatched,
    });
    if (dispatched.kind !== 'saved') throw new Error(`seed template: ${dispatched.kind}`);
  } finally {
    await database.close();
  }

  // Nadia Khan's passport, as an upload's finalize leaves it: attached, not reviewed.
  if (!nadiaLeadId) throw new Error('seed lead Nadia Khan was not created');
  const files = postgres(ADMIN_URL ?? '', { max: 1, prepare: false, ssl: false });
  try {
    await files`
      insert into app.files (
        id, workspace_id, record_type, record_id, document_type, bucket, staging_key,
        candidate_key, object_key, declared_content_type, detected_mime, declared_size_bytes,
        size_bytes, checksum_sha256, status, uploaded_by, expires_at, finalized_at
      ) values (
        ${PASSPORT_FILE_ID}, ${SIM_WORKSPACE_ID}, 'lead', ${nadiaLeadId}, 'passport', 'documents',
        ${`staging/${SIM_WORKSPACE_ID}/${PASSPORT_FILE_ID}`},
        ${`candidate/${SIM_WORKSPACE_ID}/${PASSPORT_FILE_ID}`},
        ${`candidate/${SIM_WORKSPACE_ID}/${PASSPORT_FILE_ID}`}, 'application/pdf',
        'application/pdf', 2048, 2048, ${'a'.repeat(64)}, 'available', ${WEBSITE_ACTOR_ID},
        now() + interval '1 hour', now()
      )
    `;
  } finally {
    await files.end();
  }
}

class StubStaffVerifier implements StaffSessionVerifier {
  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    return accessToken === STAFF_BEARER
      ? { actorId: OWNER_ID, verifiedEmail: 'owner@example.test' }
      : undefined;
  }
}

await applyMigrations({ connectionString: ADMIN_URL, ssl: false });
await seed();

const app = createApp({
  staff: {
    ...createDefaultStaffRouteDependencies(),
    sessionVerifier: new StubStaffVerifier(),
    // Reviews are database rows; no document is opened, so the objects can be in memory.
    documentService: new DocumentService(
      new DatabaseDocumentStore(),
      new InMemoryR2DocumentStore(),
      new DatabaseDocumentContextResolver(),
    ),
    // One browser on 127.0.0.1 makes every request; the limiter is not under test here.
    rateLimit: undefined,
  },
});
app.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`e2e harness listening on http://127.0.0.1:${PORT}\n`);
});
