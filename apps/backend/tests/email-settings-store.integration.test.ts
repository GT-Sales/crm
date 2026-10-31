import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOMER_EMAIL_TEMPLATES } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseEmailSettingsStore, readEmailTemplate } from '../src/email/settings-store.js';
import { STARTER_TEMPLATES } from '../src/email/starters.js';

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

// Distinct id range for the email settings store tests.
const SITE = '1d000000-0000-4000-8000-000000000701';
const OTHER_SITE = '1d000000-0000-4000-8000-000000000702';
const ACTOR = '2d000000-0000-4000-8000-000000000701';
const REQUEST = '3d000000-0000-4000-8000-000000000701';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const scope = { workspaceId: SITE, actorId: ACTOR };
const write = { ...scope, requestId: REQUEST };
const otherScope = { workspaceId: OTHER_SITE, actorId: ACTOR };

const SETTINGS = {
  fromName: 'Get Canada Sim',
  fromAddress: 'orders@getcanadasim.example',
  replyTo: 'help@getcanadasim.example',
  logoUrl: 'https://getcanadasim.example/logo.png',
  brandColor: '#AA11CC',
  footerText: 'Get Canada Sim, Toronto',
  siteUrl: 'https://getcanadasim.example',
};

databaseTest('email settings store', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseEmailSettingsStore;

  const reset = async () => {
    const sites = [SITE, OTHER_SITE];
    await admin`delete from app.email_template_versions where workspace_id in ${admin(sites)}`;
    await admin`delete from app.email_templates where workspace_id in ${admin(sites)}`;
    await admin`delete from app.workspace_email_settings where workspace_id in ${admin(sites)}`;
    await admin`delete from app.audit_events where workspace_id in ${admin(sites)}`;
  };

  const versionRows = (workspaceId: string, key: string) =>
    admin<{ version: number; subject: string; body: string; createdBy: string }[]>`
      select version, subject, body, created_by as "createdBy" from app.email_template_versions
      where workspace_id = ${workspaceId} and key = ${key}
      order by version
    `;

  const audits = (workspaceId: string) =>
    admin<{ action: string; entity: string; entityId: string; before: unknown; after: unknown }[]>`
      select action, entity, entity_id as "entityId", before, after from app.audit_events
      where workspace_id = ${workspaceId}
      order by created_at, id
    `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its settings, templates and versions.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'email-settings-701', 'Email Settings Site'),
        (${OTHER_SITE}, 'email-settings-702', 'Email Settings Other')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabaseEmailSettingsStore(database);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  it('has no settings and the seven starters at version 0 for a site that saved nothing', async () => {
    await reset();
    expect(await store.getSettings(scope)).toBeUndefined();
    const templates = await store.listTemplates(scope);
    expect(templates.map((template) => template.key)).toEqual([...CUSTOMER_EMAIL_TEMPLATES]);
    CUSTOMER_EMAIL_TEMPLATES.forEach((key, index) => {
      expect(templates[index]).toEqual({
        key,
        name: null,
        archived: false,
        subject: STARTER_TEMPLATES[key].subject,
        body: STARTER_TEMPLATES[key].body,
        version: 0,
        updatedAt: null,
        updatedBy: null,
      });
    });
    expect(
      await database.withTenantTx(scope, (tx) => readEmailTemplate(tx, SITE, 'dispatched')),
    ).toEqual({
      ...STARTER_TEMPLATES.dispatched,
      key: 'dispatched',
      name: null,
      archived: false,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('saves a template at version 1, then 2, appending each version and keeping the first', async () => {
    await reset();
    const first = await store.putTemplate(write, 'order_received', {
      expectedVersion: 0,
      subject: 'Thanks, {first name}',
      body: 'Hi {first name},\n\nYour {site name} order is in.',
    });
    expect(first).toEqual({
      kind: 'saved',
      template: {
        key: 'order_received',
        name: null,
        archived: false,
        subject: 'Thanks, {first name}',
        body: 'Hi {first name},\n\nYour {site name} order is in.',
        version: 1,
        updatedAt: expect.any(Date),
        updatedBy: ACTOR,
      },
    });
    expect(await versionRows(SITE, 'order_received')).toEqual([
      {
        version: 1,
        subject: 'Thanks, {first name}',
        body: 'Hi {first name},\n\nYour {site name} order is in.',
        createdBy: ACTOR,
      },
    ]);

    const second = await store.putTemplate(write, 'order_received', {
      expectedVersion: 1,
      subject: 'Order received',
      body: 'We have your order, {first name}.',
    });
    expect(second.kind === 'saved' && second.template.version).toBe(2);
    expect(await versionRows(SITE, 'order_received')).toEqual([
      {
        version: 1,
        subject: 'Thanks, {first name}',
        body: 'Hi {first name},\n\nYour {site name} order is in.',
        createdBy: ACTOR,
      },
      {
        version: 2,
        subject: 'Order received',
        body: 'We have your order, {first name}.',
        createdBy: ACTOR,
      },
    ]);
    const listed = await store.listTemplates(scope);
    expect(listed.find((template) => template.key === 'order_received')).toMatchObject({
      subject: 'Order received',
      version: 2,
      updatedBy: ACTOR,
    });

    // The audit names the template and its version, never its words.
    const trail = await audits(SITE);
    expect(trail.map(({ action, entity, after }) => ({ action, entity, after }))).toEqual([
      {
        action: 'email.template_saved',
        entity: 'email_template',
        after: { key: 'order_received', version: 1 },
      },
      {
        action: 'email.template_saved',
        entity: 'email_template',
        after: { key: 'order_received', version: 2 },
      },
    ]);
    expect(JSON.stringify(trail)).not.toContain('first name');
    expect(JSON.stringify(trail)).not.toContain('order is in');
  });

  it('refuses a save from a stale version and writes nothing', async () => {
    await reset();
    await store.putTemplate(write, 'activated', {
      expectedVersion: 0,
      subject: 'Active',
      body: 'Your line is active.',
    });
    // An editor that loaded the starter (version 0) after someone saved version 1.
    expect(
      await store.putTemplate(write, 'activated', {
        expectedVersion: 0,
        subject: 'Stale',
        body: 'Stale words.',
      }),
    ).toEqual({ kind: 'version_conflict' });
    expect(
      await store.putTemplate(write, 'activated', {
        expectedVersion: 5,
        subject: 'Ahead',
        body: 'Ahead words.',
      }),
    ).toEqual({ kind: 'version_conflict' });
    expect((await versionRows(SITE, 'activated')).map((row) => row.version)).toEqual([1]);
    const stored = await database.withTenantTx(scope, (tx) =>
      readEmailTemplate(tx, SITE, 'activated'),
    );
    expect(stored).toMatchObject({ subject: 'Active', version: 1 });
    expect(await audits(SITE)).toHaveLength(1);
  });

  it('refuses a fill-in the template may not use, naming it, and writes nothing', async () => {
    await reset();
    expect(
      await store.putTemplate(write, 'cancelled', {
        expectedVersion: 0,
        subject: 'Cancelled',
        body: 'Your order with {courier} is cancelled.',
      }),
    ).toEqual({ kind: 'invalid', error: 'invalid_fill_in', fillIn: 'courier', where: 'body' });
    expect(
      await store.putTemplate(write, 'cancelled', {
        expectedVersion: 0,
        subject: 'Cancelled {tracking number}',
        body: 'Your order is cancelled.',
      }),
    ).toEqual({
      kind: 'invalid',
      error: 'invalid_fill_in',
      fillIn: 'tracking number',
      where: 'subject',
    });
    expect(
      await store.putTemplate(write, 'cancelled', {
        expectedVersion: 0,
        subject: 'Cancelled',
        body: '[button: One](https://a.example)\n\n[button: Two](https://b.example)',
      }),
    ).toEqual({ kind: 'invalid', error: 'invalid_email_markup', reason: 'two_buttons' });
    // A fill-in in a typed address would be sent as braces; one in a button label is checked.
    expect(
      await store.putTemplate(write, 'cancelled', {
        expectedVersion: 0,
        subject: 'Cancelled',
        body: '[button: Shop again](https://a.example/?for={first name})',
      }),
    ).toEqual({ kind: 'invalid', error: 'invalid_email_markup', reason: 'bad_link' });
    expect(
      await store.putTemplate(write, 'cancelled', {
        expectedVersion: 0,
        subject: 'Cancelled',
        body: '[button: Ask {courier}](https://a.example)',
      }),
    ).toEqual({ kind: 'invalid', error: 'invalid_fill_in', fillIn: 'courier', where: 'body' });
    expect(await versionRows(SITE, 'cancelled')).toEqual([]);
    const [templates] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.email_templates where workspace_id = ${SITE}
    `;
    expect(templates?.total).toBe(0);
    expect(await audits(SITE)).toEqual([]);
  });

  it('keeps each site’s templates and settings to itself', async () => {
    await reset();
    await store.putTemplate(write, 'dispatched', {
      expectedVersion: 0,
      subject: 'On its way',
      body: 'Shipped with {courier}.',
    });
    await store.putSettings(write, { ...SETTINGS, brandColor: '#aa11cc' });
    const other = await store.listTemplates(otherScope);
    expect(other.find((template) => template.key === 'dispatched')).toMatchObject({
      subject: STARTER_TEMPLATES.dispatched.subject,
      version: 0,
    });
    expect(await store.getSettings(otherScope)).toBeUndefined();
    // The other site's first save starts from its own version 0.
    const saved = await store.putTemplate({ ...otherScope, requestId: REQUEST }, 'dispatched', {
      expectedVersion: 0,
      subject: 'Shipped',
      body: 'Shipped.',
    });
    expect(saved.kind === 'saved' && saved.template.version).toBe(1);
    expect(
      (await store.listTemplates(scope)).find((template) => template.key === 'dispatched'),
    ).toMatchObject({ subject: 'On its way', version: 1 });
  });

  it('saves the settings with the colour in lower case and one audit row without addresses', async () => {
    await reset();
    const saved = await store.putSettings(write, SETTINGS);
    expect(saved).toEqual({
      ...SETTINGS,
      brandColor: '#aa11cc',
      updatedAt: expect.any(Date),
      updatedBy: ACTOR,
    });
    expect(await store.getSettings(scope)).toEqual(saved);
    const [row] = await admin<{ brandColor: string }[]>`
      select brand_color as "brandColor" from app.workspace_email_settings
      where workspace_id = ${SITE}
    `;
    expect(row?.brandColor).toBe('#aa11cc');

    const trail = await audits(SITE);
    expect(trail).toEqual([
      {
        action: 'email.settings_updated',
        entity: 'email_settings',
        entityId: SITE,
        before: null,
        after: {
          fields: [
            'fromName',
            'fromAddress',
            'replyTo',
            'logoUrl',
            'brandColor',
            'footerText',
            'siteUrl',
          ],
        },
      },
    ]);
    expect(JSON.stringify(trail)).not.toContain('@');

    // A second save replaces the row and names only what changed.
    const again = await store.putSettings(write, {
      ...SETTINGS,
      replyTo: null,
      logoUrl: null,
      footerText: '',
    });
    expect(again).toMatchObject({
      replyTo: null,
      logoUrl: null,
      footerText: '',
      brandColor: '#aa11cc',
    });
    const after = await audits(SITE);
    expect(after).toHaveLength(2);
    expect(after[1]?.after).toEqual({ fields: ['replyTo', 'logoUrl', 'footerText'] });
  });
});
