import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRACKING_CODE_JOB_TYPE,
  TRACKING_CODE_TTL_MS,
  trackingCodeJobPayloadSchema,
  type TrackingOrder,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { openTrackingCode } from '../src/crypto/cipher.js';
import { hashContact } from '../src/email/hash.js';
import {
  emailBindingHash,
  normalizeTrackingEmail,
  signTrackingGrant,
} from '../src/tracking/secrets.js';
import { TrackingService } from '../src/tracking/service.js';
import { DatabaseTrackingStore, pendingDelivery } from '../src/tracking/store.js';

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

// Ported from the matching cases of Canadian Plans' tracking-store.integration.test.ts.
const SITE = '00000000-0000-4000-8000-000000006501';
const OTHER_SITE = '00000000-0000-4000-8000-000000006502';
const CREDENTIAL = '00000000-0000-4000-8000-000000006511';
const STAFF = '00000000-0000-4000-8000-000000006512';
const PLAN = '00000000-0000-4000-8000-000000006521';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const SECRET = 'tracking-store-test-secret-0123456789abcdef';
const CONTACT_SECRET = 'tracking-store-contact-secret-0123';
const NADIA = 'nadia@example.com';
const scope = { workspaceId: SITE, actorId: CREDENTIAL };
const T0 = new Date('2026-10-30T12:00:00.000Z');

const frozenPlan = {
  planId: PLAN,
  name: 'Unlimited data',
  priceMinor: 4000,
  currency: 'CAD',
  billingPeriod: '30_days',
  paymentRequired: false,
  requiredDocuments: ['passport', 'visa'],
  properties: {},
  frozenAt: '2026-10-01T10:00:00.000Z',
};

databaseTest('tracking store and service (challenges and the customer’s orders)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseTrackingStore;
  let clock: Date;
  let service: TrackingService;
  const leadIds: Record<string, string> = {};

  const insertLead = async (values: {
    site?: string;
    leadType?: string;
    status?: string;
    stage: string;
    email: string | null;
    externalRef?: string | null;
    createdAt: Date;
    deletedAt?: Date | null;
    restrictedAt?: Date | null;
    form?: Record<string, postgres.JSONValue>;
    orderDetails?: Record<string, postgres.JSONValue>;
    fullName?: string;
    phone?: string | null;
  }): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, full_name, email, phone,
        external_ref, payload, order_details, consent_version, deleted_at,
        customer_data_restricted_at, created_at, updated_at)
      values (${values.site ?? SITE}, ${values.leadType ?? 'sim_order'}, ${values.status ?? 'submitted'},
        ${values.stage}, ${values.fullName ?? 'Nadia Khan'}, ${values.email}, ${values.phone ?? null},
        ${values.externalRef ?? null},
        ${values.form ? admin.json({ schemaVersion: 1, payload: values.form }) : null},
        ${admin.json(values.orderDetails ?? {})}, 'ci', ${values.deletedAt ?? null},
        ${values.restrictedAt ?? null}, ${values.createdAt}, ${values.createdAt})
      returning id
    `;
    if (!row) throw new Error('the lead was not inserted');
    return row.id;
  };

  const days = (n: number) => new Date(T0.getTime() - n * 24 * 60 * 60 * 1000);

  const challenges = (workspaceId = SITE) =>
    admin<{ id: string; status: string; attempts: number; expiresAt: Date }[]>`
      select id, status, attempts, expires_at as "expiresAt" from app.tracking_challenges
      where workspace_id = ${workspaceId} order by created_at, id
    `;
  const jobs = (workspaceId = SITE) =>
    admin<
      {
        id: string;
        status: string;
        providerId: string | null;
        payload: unknown;
        payloadVersion: number;
        dedupeKey: string;
      }[]
    >`
      select id, status, provider_id as "providerId", payload, payload_version as "payloadVersion",
        dedupe_key as "dedupeKey"
      from app.outbox_jobs
      where workspace_id = ${workspaceId} and job_type = ${TRACKING_CODE_JOB_TYPE}
      order by created_at, id
    `;

  /** The code of the newest pending challenge, opened from its job as the code mail will. */
  const issuedCode = async (): Promise<string> => {
    const all = await jobs();
    const last = all.at(-1);
    const payload = trackingCodeJobPayloadSchema.parse(last?.payload);
    const code = openTrackingCode(
      SECRET,
      { workspaceId: SITE, challengeId: payload.challengeId },
      payload.sealedCode,
    );
    if (!code) throw new Error('the sealed code does not open');
    return code;
  };

  /** A six-digit code that is not `code`. */
  const wrong = (code: string, offset = 1) =>
    String((Number(code) + offset) % 1_000_000).padStart(6, '0');

  const clean = async () => {
    await admin`delete from app.tracking_challenges where workspace_id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      delete from app.outbox_jobs
      where workspace_id in (${SITE}, ${OTHER_SITE}) and job_type = ${TRACKING_CODE_JOB_TYPE}
    `;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its leads, files, challenges and jobs.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'tracking-store-651', 'Tracking Site'),
             (${OTHER_SITE}, 'tracking-store-652', 'Tracking Other Site')
    `;

    leadIds['pending'] = await insertLead({
      stage: 'pending',
      email: NADIA,
      externalRef: 'MS-6501',
      createdAt: days(10),
      phone: '+1 647 555 0123',
      form: {
        planId: 'unlimited-data-rogers',
        delivery: 'pickup',
        arrivalDate: '2026-11-20',
        permitType: 'student',
        flightBooked: true,
        shippingAddress: '1 Front St W, Toronto ON',
        canadaAddress: '1 Front St W, Toronto',
        // Imported orders carry staff keys outside the website's schema.
        simNumber: '+1 437 555 0199',
        customerNotes: 'staff only',
      },
      orderDetails: {
        planId: PLAN,
        plan: frozenPlan,
        quantity: 1,
        paymentStatus: 'pending',
        carrierCommission: 'not_yet',
        courier: 'Canada Post',
        trackingNumber: 'CP123',
        dispatchedAt: '2026-10-20',
      },
    });
    // Her newest order, typed with spaces and capitals, no number of its own.
    leadIds['verified'] = await insertLead({
      stage: 'verified',
      email: '  Nadia@Example.COM ',
      createdAt: days(2),
      form: { delivery: 'esim' },
    });
    leadIds['cancelled'] = await insertLead({
      stage: 'cancelled',
      email: NADIA,
      externalRef: 'MS-6502',
      createdAt: days(5),
    });
    leadIds['archived'] = await insertLead({
      stage: 'pending',
      email: NADIA,
      externalRef: 'MS-6503',
      createdAt: days(1),
      deletedAt: days(1),
    });
    leadIds['restricted'] = await insertLead({
      stage: 'pending',
      email: NADIA,
      externalRef: 'MS-6504',
      createdAt: days(1),
      restrictedAt: days(1),
    });
    leadIds['incomplete'] = await insertLead({
      status: 'incomplete',
      stage: 'incomplete',
      email: NADIA,
      createdAt: days(1),
    });
    leadIds['message'] = await insertLead({
      leadType: 'contact_message',
      stage: 'new',
      email: NADIA,
      createdAt: days(1),
    });
    leadIds['otherSite'] = await insertLead({
      site: OTHER_SITE,
      stage: 'pending',
      email: NADIA,
      externalRef: 'MS-6505',
      createdAt: days(1),
    });
    // Omar has an order only on the other site.
    await insertLead({
      site: OTHER_SITE,
      stage: 'pending',
      email: 'omar@example.com',
      createdAt: days(1),
    });
    // Mina has 51 orders.
    for (let index = 0; index < 51; index += 1) {
      await insertLead({
        stage: 'pending',
        email: 'mina@example.com',
        fullName: 'Mina Example',
        createdAt: new Date(days(60).getTime() + index * 60_000),
      });
    }

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 10,
    });
    store = new DatabaseTrackingStore(database);
  });

  beforeEach(async () => {
    await clean();
    clock = T0;
    service = new TrackingService({
      store,
      secret: SECRET,
      contactHash: (email) => hashContact(email, CONTACT_SECRET),
      now: () => clock,
    });
  });

  afterAll(async () => {
    await database?.close();
    if (admin) {
      await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
      await admin.end();
    }
  });

  it('queues nothing for an email with no orders here, even one with orders on another site', async () => {
    for (const email of ['nobody@example.com', 'omar@example.com']) {
      const emailHash = emailBindingHash(SECRET, SITE, email);
      expect(await store.hasTrackableLeads({ ...scope, normalizedEmail: email })).toBe(false);
      expect(
        await store.createChallengeAndQueue({
          ...scope,
          challengeId: crypto.randomUUID(),
          normalizedEmail: email,
          emailHash,
          codeHash: 'c'.repeat(64),
          sealedCode: 'sealed',
          contactHash: hashContact(email, CONTACT_SECRET),
          expiresAt: new Date(T0.getTime() + TRACKING_CODE_TTL_MS),
          now: T0,
        }),
      ).toBe('no_leads');
      await service.requestCode({ ...scope, email });
    }
    expect(await challenges()).toEqual([]);
    expect(await jobs()).toEqual([]);
    // An archived, restricted, incomplete order or a contact message is not trackable either.
    expect(await store.hasTrackableLeads({ ...scope, normalizedEmail: NADIA })).toBe(true);
  });

  it('queues one challenge and one job that carries the code only sealed', async () => {
    await service.requestCode({ ...scope, email: ' Nadia@Example.COM ' });
    const [challenge] = await challenges();
    expect(await challenges()).toHaveLength(1);
    expect(challenge).toMatchObject({ status: 'pending', attempts: 0 });
    expect(challenge?.expiresAt.getTime()).toBe(T0.getTime() + TRACKING_CODE_TTL_MS);

    const [job] = await jobs();
    expect(await jobs()).toHaveLength(1);
    expect(job).toMatchObject({ status: 'pending', payloadVersion: 1, dedupeKey: challenge?.id });
    const payload = trackingCodeJobPayloadSchema.parse(job?.payload);
    expect(Object.keys(job?.payload ?? {}).sort()).toEqual(
      ['challengeId', 'contactHash', 'expiresAt', 'sealedCode', 'toAddress'].sort(),
    );
    expect(payload).not.toHaveProperty('code');
    expect(payload.challengeId).toBe(challenge?.id);
    expect(payload.toAddress).toBe(NADIA);
    expect(payload.contactHash).toBe(hashContact(NADIA, CONTACT_SECRET));

    const code = await issuedCode();
    expect(code).toMatch(/^\d{6}$/);
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'challengeId' || key === 'contactHash') continue;
      expect(value, key).not.toContain(code);
    }
    // Nothing on the challenge row is the email or the code.
    const [row] = await admin<{ emailHash: string; codeHash: string }[]>`
      select email_hash as "emailHash", code_hash as "codeHash" from app.tracking_challenges
      where id = ${challenge?.id ?? ''}
    `;
    expect(row?.emailHash).toBe(emailBindingHash(SECRET, SITE, NADIA));
    expect(row?.codeHash).not.toContain(code);
  });

  it('a second request consumes the first challenge and completes its job, scrubbed', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const [first] = await challenges();
    await service.requestCode({ ...scope, email: NADIA });
    const all = await challenges();
    expect(all.map((row) => row.status)).toEqual(['consumed', 'pending']);
    const [firstJob, secondJob] = await jobs();
    expect(firstJob).toMatchObject({
      status: 'completed',
      providerId: 'skipped:superseded',
      payload: { challengeId: first?.id },
    });
    expect(Object.keys(firstJob?.payload ?? {})).toEqual(['challengeId']);
    expect(secondJob?.status).toBe('pending');
  });

  it('answers invalid to five wrong codes, then exhausted even to the right one', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const code = await issuedCode();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(
        await service.verifyCode({ ...scope, email: NADIA, code: wrong(code, attempt) }),
      ).toEqual({ status: 'invalid' });
    }
    expect((await challenges())[0]?.attempts).toBe(5);
    expect(await service.verifyCode({ ...scope, email: NADIA, code })).toEqual({
      status: 'exhausted',
    });
    expect((await challenges())[0]?.status).toBe('consumed');
  });

  it('verifies the right code once; used again it is not found', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const code = await issuedCode();
    const first = await service.verifyCode({ ...scope, email: ' NADIA@example.com', code });
    expect(first.status).toBe('verified');
    if (first.status !== 'verified') return;
    expect(Date.parse(first.grant.expiresAt) - T0.getTime()).toBe(1_800_000);
    expect(service.identify(first.grant.token, SITE)).toEqual({
      workspaceId: SITE,
      normalizedEmail: NADIA,
      emailHash: emailBindingHash(SECRET, SITE, NADIA),
    });
    expect(await service.verifyCode({ ...scope, email: NADIA, code })).toEqual({
      status: 'not_found',
    });
  });

  it("refuses an older challenge's code after a new request", async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const older = await issuedCode();
    await service.requestCode({ ...scope, email: NADIA });
    const newer = await issuedCode();
    if (older === newer) return; // one draw in a million: nothing to tell apart
    expect(await service.verifyCode({ ...scope, email: NADIA, code: older })).toEqual({
      status: 'invalid',
    });
    expect((await service.verifyCode({ ...scope, email: NADIA, code: newer })).status).toBe(
      'verified',
    );
  });

  it('answers expired one millisecond after the code expires', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const code = await issuedCode();
    clock = new Date(T0.getTime() + TRACKING_CODE_TTL_MS + 1);
    expect(await service.verifyCode({ ...scope, email: NADIA, code })).toEqual({
      status: 'expired',
    });
    expect((await challenges())[0]?.status).toBe('consumed');
  });

  it('verifies the right code once when two verifications race', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const code = await issuedCode();
    const outcomes = await Promise.all([
      service.verifyCode({ ...scope, email: NADIA, code }),
      service.verifyCode({ ...scope, email: NADIA, code }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['not_found', 'verified']);
  });

  it('counts every one of N racing wrong guesses, and never answers invalid more than five times', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const code = await issuedCode();
    const guesses = (n: number) =>
      Promise.all(
        Array.from({ length: n }, (_, index) =>
          service.verifyCode({ ...scope, email: NADIA, code: wrong(code, index + 1) }),
        ),
      );

    const four = await guesses(4);
    expect(four.map((outcome) => outcome.status)).toEqual(Array(4).fill('invalid'));
    expect((await challenges())[0]?.attempts).toBe(4);

    await service.requestCode({ ...scope, email: NADIA });
    const eight = (await guesses(8)).map((outcome) => outcome.status);
    expect(eight.filter((status) => status === 'invalid')).toHaveLength(5);
    expect(eight.filter((status) => status === 'exhausted')).toHaveLength(1);
    expect(eight.filter((status) => status === 'not_found')).toHaveLength(2);
    const [, second] = await challenges();
    expect(second).toMatchObject({ attempts: 5, status: 'consumed' });
  });

  it('normalizes an email exactly as the lookup compares it', async () => {
    for (const typed of [
      '  Nadia@Example.COM  ',
      '\tNadia@Example.com',
      'nadia@example.com\u00a0',
      '\u2003NADIA@example.com',
    ]) {
      const [row] = await admin<
        { normalized: string }[]
      >`select lower(btrim(${typed})) as normalized`;
      expect(normalizeTrackingEmail(typed), JSON.stringify(typed)).toBe(row?.normalized);
    }
  });

  it('a challenge is deliverable while pending, never after it is verified', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const [challenge] = await challenges();
    const delivery = () =>
      database.withTenantTx(scope, (tx) =>
        pendingDelivery(tx, { workspaceId: SITE, challengeId: challenge?.id ?? '', now: clock }),
      );
    expect(await delivery()).toEqual({
      codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      emailHash: emailBindingHash(SECRET, SITE, NADIA),
    });
    clock = new Date(T0.getTime() + TRACKING_CODE_TTL_MS);
    expect(await delivery()).toBeUndefined();
    clock = T0;
    expect(
      (await service.verifyCode({ ...scope, email: NADIA, code: await issuedCode() })).status,
    ).toBe('verified');
    expect(await delivery()).toBeUndefined();
  });

  it('a challenge with five wrong guesses is no longer deliverable', async () => {
    await service.requestCode({ ...scope, email: NADIA });
    const code = await issuedCode();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await service.verifyCode({ ...scope, email: NADIA, code: wrong(code, attempt) });
    }
    const [challenge] = await challenges();
    expect(
      await database.withTenantTx(scope, (tx) =>
        pendingDelivery(tx, { workspaceId: SITE, challengeId: challenge?.id ?? '', now: T0 }),
      ),
    ).toBeUndefined();
  });

  describe('the customer’s orders', () => {
    const identity = () => ({
      workspaceId: SITE,
      normalizedEmail: NADIA,
      emailHash: emailBindingHash(SECRET, SITE, NADIA),
    });

    it('lists her submitted orders here, newest first, the cancelled one as Cancelled', async () => {
      const orders = await service.listOrders(scope, identity());
      expect(orders.map((order) => order.reference)).toEqual([
        leadIds['verified'],
        'MS-6502',
        'MS-6501',
      ]);
      const [verified, cancelled, pending] = orders;
      expect(cancelled).toMatchObject({ stage: 'cancelled', stageLabel: 'Cancelled' });
      expect(cancelled?.canRequestChange).toBe(false);
      expect(verified).toMatchObject({
        stageLabel: 'Confirmed',
        canRequestChange: true,
        delivery: 'esim',
        plan: null,
      });
      expect(pending).toEqual({
        reference: 'MS-6501',
        leadType: 'sim_order',
        stage: 'pending',
        stageLabel: 'Received',
        submittedAt: days(10).toISOString(),
        plan: { id: PLAN, name: 'Unlimited data', priceMinor: 4000, billingPeriod: '30_days' },
        quantity: 1,
        delivery: 'pickup',
        courier: 'Canada Post',
        trackingNumber: 'CP123',
        dispatchedAt: '2026-10-20',
        simNumber: '+1 437 555 0199',
        details: {
          fullName: 'Nadia Khan',
          phone: '+1 647 555 0123',
          arrivalDate: '2026-11-20',
          permitType: 'student',
          canadaAddress: '1 Front St W, Toronto',
          shippingAddress: '1 Front St W, Toronto ON',
          flightBooked: true,
        },
        documents: [
          { documentType: 'passport', state: 'missing' },
          { documentType: 'visa', state: 'missing' },
        ],
        canRequestChange: true,
        pendingChange: null,
      } satisfies TrackingOrder);
      // Never staff notes, payment or commission.
      expect(JSON.stringify(orders)).not.toContain('staff only');
      expect(JSON.stringify(orders)).not.toContain('paymentStatus');
      expect(JSON.stringify(orders)).not.toContain('carrierCommission');
    });

    it('lists nothing for another email, and a grant from another site reads nothing', async () => {
      expect(
        await service.listOrders(scope, {
          ...identity(),
          normalizedEmail: 'omar@example.com',
        }),
      ).toEqual([]);
      const otherSiteGrant = signTrackingGrant(
        SECRET,
        { workspaceId: OTHER_SITE, normalizedEmail: NADIA },
        T0.getTime(),
      );
      expect(service.identify(otherSiteGrant.token, SITE)).toBeUndefined();
      expect(service.identify(otherSiteGrant.token, OTHER_SITE)?.workspaceId).toBe(OTHER_SITE);
      expect(service.identify(undefined, SITE)).toBeUndefined();
      expect(service.identify('garbage', SITE)).toBeUndefined();
    });

    it('lists at most fifty', async () => {
      const orders = await service.listOrders(scope, {
        workspaceId: SITE,
        normalizedEmail: 'mina@example.com',
        emailHash: emailBindingHash(SECRET, SITE, 'mina@example.com'),
      });
      expect(orders).toHaveLength(50);
    });

    it('reads a document approved, then received once a newer upload replaces it', async () => {
      const lead = leadIds['pending'] ?? '';
      await admin`delete from app.files where workspace_id = ${SITE} and record_id = ${lead}`;
      const file = async (key: string, createdAt: Date) => {
        const [row] = await admin<{ id: string }[]>`
          insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
            staging_key, candidate_key, object_key, declared_content_type, detected_mime,
            declared_size_bytes, size_bytes, checksum_sha256, status, uploaded_by, expires_at,
            finalized_at, created_at, updated_at)
          values (${SITE}, 'lead', ${lead}, 'passport', 'ci', ${`staging/${key}`}, ${`docs/${key}`},
            ${`docs/${key}`}, 'application/pdf', 'application/pdf', 100, 100, ${'a'.repeat(64)},
            'available', ${CREDENTIAL}, ${createdAt}, ${createdAt}, ${createdAt}, ${createdAt})
          returning id
        `;
        if (!row) throw new Error('the file was not inserted');
        return row.id;
      };
      const passport = async () =>
        (await service.listOrders(scope, identity()))
          .find((order) => order.reference === 'MS-6501')
          ?.documents.find((document) => document.documentType === 'passport')?.state;

      const first = await file(`${lead}-1`, days(9));
      expect(await passport()).toBe('received');
      await admin`
        insert into app.file_review_events (workspace_id, file_id, actor_id, decision)
        values (${SITE}, ${first}, ${STAFF}, 'approved')
      `;
      expect(await passport()).toBe('approved');

      const second = await file(`${lead}-2`, days(8));
      await admin`update app.files set superseded_by_file_id = ${second} where id = ${first}`;
      expect(await passport()).toBe('received');

      await admin`
        insert into app.file_review_events (workspace_id, file_id, actor_id, decision)
        values (${SITE}, ${second}, ${STAFF}, 'rejected')
      `;
      expect(await passport()).toBe('needs_replacement');
      await admin`delete from app.files where workspace_id = ${SITE} and record_id = ${lead}`;
    });

    it('drops an order a stored value keeps from the contract, logging only its id and the path', async () => {
      const rosa = 'rosa@example.com';
      const good = await insertLead({
        stage: 'pending',
        email: rosa,
        externalRef: 'MS-6510',
        createdAt: days(3),
      });
      const blankRef = await insertLead({
        stage: 'pending',
        email: rosa,
        externalRef: '   ',
        createdAt: days(2),
      });
      const badDocument = await insertLead({
        stage: 'pending',
        email: rosa,
        externalRef: 'MS-6512',
        createdAt: days(1),
      });
      await admin`
        insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
          staging_key, candidate_key, object_key, declared_content_type, detected_mime,
          declared_size_bytes, size_bytes, checksum_sha256, status, uploaded_by, expires_at)
        values (${SITE}, 'lead', ${badDocument}, 'Passport Scan', 'ci', ${`staging/${badDocument}`},
          ${`docs/${badDocument}`}, ${`docs/${badDocument}`}, 'application/pdf', 'application/pdf',
          100, 100, ${'a'.repeat(64)}, 'available', ${CREDENTIAL}, ${T0})
      `;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const orders = await service.listOrders(scope, {
          workspaceId: SITE,
          normalizedEmail: rosa,
          emailHash: emailBindingHash(SECRET, SITE, rosa),
        });
        expect(orders.map((order) => order.reference)).toEqual(['MS-6510']);
        const logged = warn.mock.calls.map((call) => String(call[0]));
        expect(logged).toHaveLength(2);
        expect(logged.map((line) => JSON.parse(line))).toEqual(
          expect.arrayContaining([
            {
              event: 'tracking_order_unlistable',
              workspaceId: SITE,
              leadId: blankRef,
              path: 'reference',
            },
            {
              event: 'tracking_order_unlistable',
              workspaceId: SITE,
              leadId: badDocument,
              path: 'documents.0.documentType',
            },
          ]),
        );
        for (const line of logged) {
          expect(line).not.toContain('rosa');
          expect(line).not.toContain('Passport Scan');
          expect(line).not.toContain(good);
        }
      } finally {
        warn.mockRestore();
        await admin`delete from app.leads where id in (${good}, ${blankRef}, ${badDocument})`;
      }
    });

    it('resolves a reference only together with its email', async () => {
      expect(await service.resolveLead(scope, identity(), 'MS-6501')).toEqual({
        leadId: leadIds['pending'],
        leadType: 'sim_order',
        stage: 'pending',
      });
      expect(await service.resolveLead(scope, identity(), leadIds['verified'] ?? '')).toEqual({
        leadId: leadIds['verified'],
        leadType: 'sim_order',
        stage: 'verified',
      });
      expect(
        await service.resolveLead(
          scope,
          { ...identity(), normalizedEmail: 'omar@example.com' },
          'MS-6501',
        ),
      ).toBeUndefined();
      for (const hidden of ['MS-6503', 'MS-6504', 'MS-6505', leadIds['incomplete'] ?? '']) {
        expect(await service.resolveLead(scope, identity(), hidden), hidden).toBeUndefined();
      }
      // A lead with a number is reached by its number, not by its id.
      expect(
        await service.resolveLead(scope, identity(), leadIds['pending'] ?? ''),
      ).toBeUndefined();
    });
  });

  it('is not configured without a secret: no code is queued and nothing verifies', async () => {
    const unconfigured = new TrackingService({
      store,
      secret: undefined,
      contactHash: (email) => hashContact(email, CONTACT_SECRET),
    });
    expect(unconfigured.configured).toBe(false);
    expect(service.configured).toBe(true);
    await unconfigured.requestCode({ ...scope, email: NADIA });
    expect(await challenges()).toEqual([]);
    expect(await unconfigured.verifyCode({ ...scope, email: NADIA, code: '123456' })).toEqual({
      status: 'not_found',
    });
    const grant = signTrackingGrant(
      SECRET,
      { workspaceId: SITE, normalizedEmail: NADIA },
      T0.getTime(),
    );
    expect(unconfigured.identify(grant.token, SITE)).toBeUndefined();
  });
});
