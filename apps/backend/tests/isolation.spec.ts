import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { apiErrorResponseSchema, createLeadResponseSchema } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import { SupabaseStaffSessionVerifier, type VerifiedStaffSession } from '../src/auth/session.js';
import { MachineRegistry, type MachineRegistryConfig } from '../src/machines/registry.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseStaffStore } from '../src/staff/store.js';
import { generateServiceSecret, hashServiceSecret } from '../src/website/credential.js';
import { DatabaseWebsiteCredentialStore } from '../src/website/store.js';

function disposableDatabaseUrl(): string | undefined {
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const enabled = process.env.DB_TEST_ALLOW_DESTRUCTIVE === '1';
  if (!migrationUrl && !enabled && !process.env.CI) return undefined;
  if (!migrationUrl || !enabled) {
    throw new Error(
      'Isolation integration tests require TEST_MIGRATION_DATABASE_URL and DB_TEST_ALLOW_DESTRUCTIVE=1 together.',
    );
  }
  const databaseName = decodeURIComponent(new URL(migrationUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_MIGRATION_DATABASE_URL must name a disposable database ending in _test.');
  }
  return migrationUrl;
}

const migrationUrl = disposableDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WORKSPACE_A = '11000000-0000-4000-8000-000000000a01';
const WORKSPACE_B = '11000000-0000-4000-8000-000000000a02';
const OWNER_A = '21000000-0000-4000-8000-000000000a01';
const VIEWER_B = '21000000-0000-4000-8000-000000000a02';
const OWNER_MEMBERSHIP_A = '31000000-0000-4000-8000-000000000a01';
const VIEWER_MEMBERSHIP_B = '31000000-0000-4000-8000-000000000a02';
const FOREIGN_CREDENTIAL_B = '81000000-0000-4000-8000-000000000a02';
const RUNTIME_PASSWORD = 'local_ci_runtime_password';
const { secret: WEBSITE_SECRET_A } = generateServiceSecret();
const { secret: REVOKED_WEBSITE_SECRET } = generateServiceSecret();
const { secret: FOREIGN_WEBSITE_SECRET } = generateServiceSecret();

const sessions = new Map<string, VerifiedStaffSession>([
  [
    'owner-aal2',
    { actorId: OWNER_A, verifiedEmail: 'owner-a@example.test', assuranceLevel: 'aal2' },
  ],
  [
    'viewer-forged-role',
    { actorId: VIEWER_B, verifiedEmail: 'viewer-b@example.test', assuranceLevel: 'aal2' },
  ],
]);
const signingKey = 'disposable-auth-fixture-signing-key';
const issuedTokens = new Map<string, { session: VerifiedStaffSession; expiresAt: number }>();
const tokens = new Map<string, string>();
for (const [name, session] of sessions) {
  for (const expired of [false, true]) {
    const expiresAt = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: session.actorId,
        email: session.verifiedEmail,
        aal: session.assuranceLevel,
        exp: expiresAt,
        iat: expiresAt - 3600,
      }),
    ).toString('base64url');
    const message = `${header}.${payload}`;
    if (!expired) {
      tokens.set(
        'forged-session',
        `${message}.${createHmac('sha256', 'untrusted-signing-key').update(message).digest('base64url')}`,
      );
    }
    const token = `${message}.${createHmac('sha256', signingKey).update(message).digest('base64url')}`;
    tokens.set(expired ? 'expired-session' : name, token);
    issuedTokens.set(token, { session, expiresAt });
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${tokens.get(token) ?? token}` };
}

databaseTest('Phase A tenant isolation gate', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let server: Server;
  let authServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id in (${WORKSPACE_A}, ${WORKSPACE_B})`;
    // Limiter windows outlive a run; a persistent local database must start empty.
    await admin`delete from app.rate_limit_buckets where bucket_key like 'foundation-%'`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_A}, 'isolation-a', 'Isolation A'),
        (${WORKSPACE_B}, 'isolation-b', 'Isolation B')
    `;
    await admin`
      insert into app.roles (workspace_id, name)
      values (${WORKSPACE_A}, 'owner'), (${WORKSPACE_B}, 'viewer')
    `;
    await admin`
      insert into app.memberships (
        id, workspace_id, user_id, membership_type, status, accepted_at
      ) values
        (${OWNER_MEMBERSHIP_A}, ${WORKSPACE_A}, ${OWNER_A}, 'staff', 'active', now()),
        (${VIEWER_MEMBERSHIP_B}, ${WORKSPACE_B}, ${VIEWER_B}, 'staff', 'active', now())
    `;
    await admin`
      insert into app.membership_roles (workspace_id, membership_id, role_id)
      select membership.workspace_id, membership.id, role.id
      from app.memberships as membership
      join app.roles as role on role.workspace_id = membership.workspace_id
      where membership.id in (${OWNER_MEMBERSHIP_A}, ${VIEWER_MEMBERSHIP_B})
    `;
    await admin`
      insert into app.service_credentials (id, workspace_id, secret_hash, scopes, revoked_at)
      values
        (${FOREIGN_CREDENTIAL_B}, ${WORKSPACE_B}, ${hashServiceSecret(FOREIGN_WEBSITE_SECRET)}, array['leads:write'], null),
        (default, ${WORKSPACE_A}, ${hashServiceSecret(WEBSITE_SECRET_A)}, array['leads:write'], null),
        (default, ${WORKSPACE_A}, ${hashServiceSecret(REVOKED_WEBSITE_SECRET)}, array['leads:write'], now())
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });

    const credentialStore = new DatabaseWebsiteCredentialStore(database);
    // Replace only the external Auth HTTP service. Exercise the production
    // Supabase SDK/verifier with signed, genuinely expired, and forged tokens.
    authServer = createServer((req, res) => {
      const issued = issuedTokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/auth/v1/user' || !issued || issued.expiresAt <= Date.now() / 1000) {
        res.writeHead(401).end(JSON.stringify({ message: 'invalid or expired token' }));
        return;
      }
      res.end(
        JSON.stringify({
          id: issued.session.actorId,
          email: issued.session.verifiedEmail,
          email_confirmed_at: '2026-01-01T00:00:00Z',
          factors: [],
        }),
      );
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => authServer.once('listening', resolve));
    const authAddress = authServer.address();
    if (!authAddress || typeof authAddress === 'string')
      throw new Error('expected Auth TCP server');
    vi.stubEnv('SUPABASE_URL', `http://127.0.0.1:${authAddress.port}`);
    vi.stubEnv('SUPABASE_ANON_KEY', 'disposable-auth-publishable-key');
    server = createApp({
      staff: {
        sessionVerifier: new SupabaseStaffSessionVerifier(),
        store: new DatabaseStaffStore(database),
        credentialStore,
        leadStore: new DatabaseLeadStore(database),
      },
      website: {
        auth: {
          resolveCredential: database.resolveWebsiteCredential,
          rateLimit: database.rateLimitHit,
          botCheck: () => true,
        },
        leads: { store: new DatabaseLeadStore(database) },
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await admin`
      update app.memberships
      set status = 'active', revoked_at = null
      where id = ${OWNER_MEMBERSHIP_A}
    `;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (authServer) await new Promise<void>((resolve) => authServer.close(() => resolve()));
    vi.unstubAllEnvs();
    // The opted-in disposable database owns teardown; cascading deletion must
    // not bypass the customer-erasure acknowledgement guard.
    if (database) await database.close();
    if (runtimeSql) await runtimeSql.end();
    if (admin) await admin.end();
  });

  test('altered staff workspace IDs and foreign fixture IDs fail closed', async () => {
    const alteredWorkspace = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_B}/access`,
      { headers: bearer('owner-aal2') },
    );
    expect(alteredWorkspace.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await alteredWorkspace.json()).error.code).toBe(
      'membership_missing',
    );

    const foreignMembership = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_A}/memberships/${VIEWER_MEMBERSHIP_B}`,
      { method: 'DELETE', headers: bearer('owner-aal2') },
    );
    expect(foreignMembership.status).toBe(404);

    const foreignCredential = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_A}/service-credentials/${FOREIGN_CREDENTIAL_B}`,
      { method: 'DELETE', headers: bearer('owner-aal2') },
    );
    expect(foreignCredential.status).toBe(404);

    const [unchanged] = await admin<{ membership_status: string; revoked_at: Date | null }[]>`
      select membership.status as membership_status, credential.revoked_at
      from app.memberships as membership
      join app.service_credentials as credential
        on credential.id = ${FOREIGN_CREDENTIAL_B}
      where membership.id = ${VIEWER_MEMBERSHIP_B}
    `;
    expect(unchanged).toEqual({ membership_status: 'active', revoked_at: null });
  });

  test('a removed membership is denied on the next request with the same session', async () => {
    const before = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_A}/access`, {
      headers: bearer('owner-aal2'),
    });
    expect(before.status).toBe(200);
    await admin`
      update app.memberships
      set status = 'revoked', revoked_at = now()
      where id = ${OWNER_MEMBERSHIP_A}
    `;
    const after = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_A}/access`, {
      headers: bearer('owner-aal2'),
    });
    expect(after.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await after.json()).error.code).toBe('membership_revoked');
  });

  test('expired or forged staff credentials and forged or revoked website credentials are denied', async () => {
    for (const token of ['expired-session', 'forged-session']) {
      const response = await fetch(`${baseUrl}/api/v1/staff/workspaces`, {
        headers: bearer(token),
      });
      expect(response.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
        'invalid_session',
      );
    }

    const forged = generateServiceSecret().secret;
    for (const [secret, code] of [
      [forged, 'invalid_credential'],
      [REVOKED_WEBSITE_SECRET, 'credential_revoked'],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/v1/website/leads`, {
        method: 'POST',
        headers: { ...bearer(secret), 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(code);
    }
  });

  test('caller workspace and role claims cannot override verified database state', async () => {
    const website = await fetch(`${baseUrl}/api/v1/website/leads`, {
      method: 'POST',
      headers: {
        ...bearer(WEBSITE_SECRET_A),
        'content-type': 'application/json',
        host: 'isolation-b.example.test',
        origin: 'https://isolation-b.example.test',
      },
      body: JSON.stringify({
        workspace_id: WORKSPACE_B,
        workspaceId: WORKSPACE_B,
        leadType: 'sim_order',
        consentVersion: 'terms-2026-09',
      }),
    });
    expect(website.status).toBe(201);
    expect(await website.json()).toMatchObject({ lead: { workspaceId: WORKSPACE_A } });

    const escalation = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_B}/service-credentials`,
      {
        method: 'POST',
        headers: {
          ...bearer('viewer-forged-role'),
          'content-type': 'application/json',
          'x-staff-role': 'owner',
        },
        body: JSON.stringify({ scopes: ['leads:write'] }),
      },
    );
    expect(escalation.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await escalation.json()).error.code).toBe(
      'permission_denied',
    );
  });

  test('website and staff identities cannot cross workspace boundaries for leads', async () => {
    const created = await fetch(`${baseUrl}/api/v1/website/leads`, {
      method: 'POST',
      headers: { ...bearer(WEBSITE_SECRET_A), 'content-type': 'application/json' },
      body: JSON.stringify({ leadType: 'sim_order', consentVersion: 'terms-2026-09' }),
    });
    expect(created.status).toBe(201);
    const createdBody = createLeadResponseSchema.parse(await created.json());

    const foreignUpdate = await fetch(`${baseUrl}/api/v1/website/leads/${createdBody.lead.id}`, {
      method: 'PATCH',
      headers: {
        ...bearer(FOREIGN_WEBSITE_SECRET),
        'content-type': 'application/json',
        'x-draft-grant': createdBody.draftGrant.token,
      },
      body: JSON.stringify({ contact: { fullName: 'Cross Workspace' } }),
    });
    expect(foreignUpdate.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await foreignUpdate.json()).error.code).toBe(
      'draft_not_found',
    );

    const foreignStaffList = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE_A}/leads`,
      { headers: bearer('viewer-forged-role') },
    );
    expect(foreignStaffList.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await foreignStaffList.json()).error.code).toBe(
      'membership_missing',
    );
  });

  test('missing database context denies and a pooled connection cannot reuse prior context', async () => {
    const missing = await runtimeSql`select id from app.memberships`;
    expect(missing).toHaveLength(0);

    const [scoped] = await database.withTenantTx(
      { workspaceId: WORKSPACE_A, actorId: OWNER_A },
      (tx) =>
        tx.execute<{ pid: number; workspaceId: string }>(sql`
          select pg_backend_pid() as pid,
                 current_setting('app.workspace_id', true) as "workspaceId"
        `),
    );
    const between = await database.db.execute(sql`select id from app.memberships`);
    const [next] = await database.withTenantTx(
      { workspaceId: WORKSPACE_B, actorId: VIEWER_B },
      (tx) =>
        tx.execute<{ pid: number; workspaceId: string }>(sql`
          select pg_backend_pid() as pid,
                 current_setting('app.workspace_id', true) as "workspaceId"
        `),
    );
    expect(scoped).toEqual({ pid: scoped?.pid, workspaceId: WORKSPACE_A });
    expect(between).toHaveLength(0);
    expect(next).toEqual({ pid: scoped?.pid, workspaceId: WORKSPACE_B });
  });

  test('machine registry rejects provider-account and workspace confusion', () => {
    const webhookSecret = 'isolation-webhook-secret-0000001';
    const rawBody = JSON.stringify({ event: 'offer.published' });
    const config: MachineRegistryConfig = {
      webhooks: [
        {
          selector: 'site-a',
          provider: 'sanity',
          providerAccount: 'project-a',
          workspaceId: WORKSPACE_A,
          actorId: '20000000-0000-4000-8000-0000000000a1',
          verificationSecret: webhookSecret,
          revoked: false,
        },
      ],
      schedulers: [],
    };
    // A fixed clock keeps the signed timestamp inside Sanity's freshness
    // window; the registry verifies `t=<seconds>,v1=<base64url>` over
    // `timestamp.rawBody`, so a plain hex HMAC is rejected as an invalid
    // signature before the account check this test targets is reached.
    const nowMs = Date.parse('2026-09-16T00:00:00.000Z');
    const registry = new MachineRegistry(config, () => nowMs);
    // Sanity signs with a millisecond Unix timestamp.
    const timestamp = String(nowMs);
    const signature = `t=${timestamp},v1=${createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('base64url')}`;

    expect(
      registry.resolveWebhook({
        selector: 'site-a',
        providerAccount: 'project-b',
        signature,
        rawBody,
      }),
    ).toEqual({ ok: false, reason: 'machine_account_mismatch' });
    expect(
      registry.resolveWebhook({
        selector: 'site-a',
        providerAccount: 'project-a',
        signature,
        rawBody,
        expectedWorkspaceId: WORKSPACE_B,
      }),
    ).toEqual({ ok: false, reason: 'machine_workspace_mismatch' });
  });

  test('re-invitation restores only fresh roles and consumes active-member invitations without escalation', async () => {
    const store = new DatabaseStaffStore(database);
    await admin`insert into app.roles(workspace_id, name) values (${WORKSPACE_A}, 'viewer') on conflict do nothing`;
    await admin`update app.memberships set status = 'revoked', revoked_at = now() where id = ${OWNER_MEMBERSHIP_A}`;
    await admin`insert into app.permissions(workspace_id, name) values (${WORKSPACE_A}, 'deletion') on conflict do nothing`;
    await admin`insert into app.membership_permissions(workspace_id, membership_id, permission_id)
      select workspace_id, ${OWNER_MEMBERSHIP_A}, id from app.permissions where workspace_id = ${WORKSPACE_A} and name = 'deletion'`;
    const input = {
      actorId: OWNER_A,
      workspaceId: WORKSPACE_A,
      normalizedEmail: 'owner-a@example.test',
      requestId: '70000000-0000-4000-8000-000000000011',
    };
    await store.inviteStaff({ ...input, roleNames: ['viewer'] });
    const bootstrap = {
      actorId: OWNER_A,
      verifiedEmail: input.normalizedEmail,
      requestId: input.requestId,
    };
    await Promise.all([store.bootstrapStaff(bootstrap), store.bootstrapStaff(bootstrap)]);
    expect(await store.loadStaffAccess(OWNER_A, WORKSPACE_A)).toMatchObject({
      membershipId: OWNER_MEMBERSHIP_A,
      status: 'active',
      roles: ['viewer'],
      permissions: [],
    });
    await store.inviteStaff({ ...input, roleNames: ['owner'] });
    await store.bootstrapStaff(bootstrap);
    expect(await store.loadStaffAccess(OWNER_A, WORKSPACE_A)).toMatchObject({ roles: ['viewer'] });
    const pending =
      await admin`select id from app.memberships where workspace_id = ${WORKSPACE_A} and status = 'pending'`;
    expect(pending).toHaveLength(0);
    const audit =
      await admin`select id from app.audit_events where workspace_id = ${WORKSPACE_A} and action = 'membership.invitation_consumed'`;
    expect(audit).toHaveLength(2);
  });

  test('concurrent limiter bursts enforce the exact cap without contaminating independent buckets', async () => {
    for (const concurrency of [20, 40, 100]) {
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          database.rateLimitHit({
            bucketKey: `foundation-burst-${concurrency}`,
            windowSeconds: 3600,
            maxCount: 10,
          }),
        ),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(10);
      expect(
        await database.rateLimitHit({
          bucketKey: `foundation-independent-${concurrency}`,
          windowSeconds: 3600,
          maxCount: 10,
        }),
      ).toMatchObject({ allowed: true });
      console.info(
        JSON.stringify({
          check: 'limiter-burst',
          concurrency,
          allowed: 10,
          elapsedMs: Math.round(performance.now() - started),
          poolConnections: 1,
        }),
      );
    }
  });
});
