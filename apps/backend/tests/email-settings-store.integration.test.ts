import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_EMAIL_TEMPLATES,
  SITE_TEMPLATE_KEY_PATTERN,
  builtInFlowName,
  type FlowDefinition,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseFlowStore } from '../src/automations/flow-store.js';
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

// Site-made templates (phase 8).
const MADE_SITE = '18000000-0000-4000-8000-000000008801';
const LIMIT_SITE = '18000000-0000-4000-8000-000000008802';
const FLOW_SITE = '18000000-0000-4000-8000-000000008803';
const MADE_ACTOR = '28000000-0000-4000-8000-000000008801';
const MADE_REQUEST = '58000000-0000-4000-8000-000000008801';
const MADE_SITES = [MADE_SITE, LIMIT_SITE, FLOW_SITE];
const made = (workspaceId: string) => ({
  workspaceId,
  actorId: MADE_ACTOR,
  requestId: MADE_REQUEST,
});

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

    await admin`delete from app.workspaces where id in ${admin(MADE_SITES)}`;
    for (const [index, id] of MADE_SITES.entries()) {
      await admin`
        insert into app.workspaces (id, slug, name)
        values (${id}, ${`email-templates-880${index + 1}`}, ${`Templates site ${index + 1}`})
      `;
      await admin`
        insert into app.memberships (workspace_id, user_id, membership_type, status)
        values (${id}, ${MADE_ACTOR}, 'staff', 'active')
      `;
      await admin`
        insert into app.properties (workspace_id, object, key, origin, label, kind, position, sensitive, staff_only)
        values
          (${id}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1, false, false),
          (${id}, 'lead', 'custom_secret', 'custom', 'Secret', 'text', 2, true, false),
          (${id}, 'lead', 'custom_internal', 'custom', 'Internal', 'text', 3, false, true)
      `;
    }
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
        usedBy: expect.any(Array),
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
        usedBy: [{ key: 'order_received', name: builtInFlowName('order_received') }],
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

  // -------------------------------------------------------------------------
  // Site-made templates

  const resetMade = async (workspaceId: string) => {
    await admin`delete from app.email_template_versions where workspace_id = ${workspaceId}`;
    await admin`delete from app.email_templates where workspace_id = ${workspaceId}`;
    await admin`delete from app.audit_events where workspace_id = ${workspaceId}`;
    await admin`delete from app.automations where workspace_id = ${workspaceId}`;
  };

  const create = async (
    workspaceId: string,
    name: string,
    subject = 'Hello',
    body = 'Hi {first name}',
  ) => {
    const outcome = await store.createTemplate(made(workspaceId), { name, subject, body });
    if (outcome.kind !== 'saved') throw new Error(`not created: ${outcome.kind}`);
    return outcome.template;
  };

  it('a site-made template is created at version 1 with its version row and audit', async () => {
    await resetMade(MADE_SITE);
    const template = await create(
      MADE_SITE,
      'Size note',
      'About {prop:custom_size}',
      'Order {order number}',
    );
    expect(template.key).toMatch(SITE_TEMPLATE_KEY_PATTERN);
    expect(template).toMatchObject({ name: 'Size note', version: 1, archived: false, usedBy: [] });
    expect(await versionRows(MADE_SITE, template.key)).toEqual([
      {
        version: 1,
        subject: 'About {prop:custom_size}',
        body: 'Order {order number}',
        createdBy: MADE_ACTOR,
      },
    ]);
    expect((await audits(MADE_SITE)).map((row) => [row.action, row.after])).toEqual([
      ['email.template_created', { key: template.key, version: 1 }],
    ]);
    const listed = await store.listTemplates(made(MADE_SITE));
    expect(listed.map((entry) => entry.key)).toEqual([...CUSTOMER_EMAIL_TEMPLATES, template.key]);

    // A save is version 2, with the same property check.
    const saved = await store.putTemplate(made(MADE_SITE), template.key, {
      expectedVersion: 1,
      subject: 'Now {prop:custom_size}',
      body: 'Hi',
    });
    expect(saved).toMatchObject({ kind: 'saved', template: { version: 2, name: 'Size note' } });
    expect(
      await store.putTemplate(made(MADE_SITE), template.key, {
        expectedVersion: 2,
        subject: 'Secret {prop:custom_secret}',
        body: 'Hi',
      }),
    ).toMatchObject({ kind: 'invalid', error: 'invalid_fill_in', fillIn: 'prop:custom_secret' });
    expect(
      await store.putTemplate(made(MADE_SITE), 'tpl_nosuchtemplate01', {
        expectedVersion: 0,
        subject: 'Hi',
        body: 'Hi',
      }),
    ).toEqual({ kind: 'not_found' });
  });

  it('a sensitive, staff-only or unknown property is refused; a usable one is accepted', async () => {
    await resetMade(MADE_SITE);
    for (const property of ['custom_secret', 'custom_internal', 'custom_nothing']) {
      expect(
        await store.createTemplate(made(MADE_SITE), {
          name: property,
          subject: `About {prop:${property}}`,
          body: 'Hi',
        }),
      ).toMatchObject({
        kind: 'invalid',
        error: 'invalid_fill_in',
        fillIn: `prop:${property}`,
        where: 'subject',
      });
    }
    expect(
      (
        await store.createTemplate(made(MADE_SITE), {
          name: 'ok',
          subject: 'Hi',
          body: 'Size {prop:custom_size}',
        })
      ).kind,
    ).toBe('saved');
  });

  it('{code} is refused in a site-made template', async () => {
    await resetMade(MADE_SITE);
    expect(
      await store.createTemplate(made(MADE_SITE), {
        name: 'Code',
        subject: 'Hi',
        body: 'Your code {code}',
      }),
    ).toMatchObject({ kind: 'invalid', error: 'invalid_fill_in', fillIn: 'code', where: 'body' });
  });

  it('the 51st template is refused, concurrently too', async () => {
    await resetMade(LIMIT_SITE);
    for (let index = 0; index < 50; index += 1) await create(LIMIT_SITE, `Note ${index}`);
    expect(
      await store.createTemplate(made(LIMIT_SITE), { name: 'One more', subject: 'Hi', body: 'Hi' }),
    ).toEqual({ kind: 'limit_reached' });

    await resetMade(LIMIT_SITE);
    for (let index = 0; index < 46; index += 1) await create(LIMIT_SITE, `Note ${index}`);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.createTemplate(made(LIMIT_SITE), {
          name: `Race ${index}`,
          subject: 'Hi',
          body: 'Hi',
        }),
      ),
    );
    expect(results.filter((result) => result.kind === 'saved')).toHaveLength(4);
    expect(results.filter((result) => result.kind === 'limit_reached')).toHaveLength(4);
  });

  it('archive and restore are site-made only and counted', async () => {
    await resetMade(LIMIT_SITE);
    expect(await store.setTemplateArchived(made(LIMIT_SITE), 'dispatched', true)).toEqual({
      kind: 'builtin',
    });
    expect(await store.setTemplateArchived(made(LIMIT_SITE), 'tpl_nosuchtemplate01', true)).toEqual(
      {
        kind: 'not_found',
      },
    );
    const first = await create(LIMIT_SITE, 'First');
    const archived = await store.setTemplateArchived(made(LIMIT_SITE), first.key, true);
    expect(archived).toMatchObject({ kind: 'saved', template: { archived: true } });
    // An archived template cannot be saved.
    expect(
      await store.putTemplate(made(LIMIT_SITE), first.key, {
        expectedVersion: 1,
        subject: 'Hi',
        body: 'Hi',
      }),
    ).toEqual({ kind: 'not_found' });
    for (let index = 0; index < 50; index += 1) await create(LIMIT_SITE, `Note ${index}`);
    expect(await store.setTemplateArchived(made(LIMIT_SITE), first.key, false)).toEqual({
      kind: 'limit_reached',
    });
    const another = (await store.listTemplates(made(LIMIT_SITE))).at(-1);
    if (!another) throw new Error('no template');
    await store.setTemplateArchived(made(LIMIT_SITE), another.key, true);
    expect(await store.setTemplateArchived(made(LIMIT_SITE), first.key, false)).toMatchObject({
      kind: 'saved',
      template: { archived: false },
    });
    const actions = (await audits(LIMIT_SITE)).map((row) => row.action);
    expect(actions.filter((action) => action === 'email.template_archived')).toHaveLength(2);
    expect(actions.filter((action) => action === 'email.template_restored')).toHaveLength(1);
  });

  it('archived templates are listed a page at a time, however many there are', async () => {
    await resetMade(LIMIT_SITE);
    await admin`
      insert into app.email_templates (workspace_id, key, name, subject, body, version, updated_by, archived_at)
      select ${LIMIT_SITE}, 'tpl_archived' || lpad(n::text, 8, '0'), 'Old ' || n, 'Old', 'Old', 1,
        ${MADE_ACTOR}, now() - make_interval(secs => n)
      from generate_series(1, 120) n
    `;
    const live = await store.listTemplates(made(LIMIT_SITE));
    expect(live).toHaveLength(9);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await store.listArchivedTemplates(made(LIMIT_SITE), before ? { before } : {});
      expect(result.templates.length).toBeLessThanOrEqual(50);
      seen.push(...result.templates.map((template) => template.key));
      if (!result.nextBefore) break;
      before = result.nextBefore;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe('tpl_archived00000001');
  });

  it('usedBy lists the flows whose active version sends each template; archiving one marks that flow', async () => {
    await resetMade(FLOW_SITE);
    const flows = new DatabaseFlowStore(database);
    const template = await create(FLOW_SITE, 'Follow-up note');
    // Before the page was ever opened, the built-ins count with their defaults.
    let listed = await store.listTemplates(made(FLOW_SITE));
    expect(listed.find((entry) => entry.key === 'dispatched')?.usedBy).toEqual([
      { key: 'sim_order_dispatched', name: builtInFlowName('sim_order_dispatched') },
    ]);
    expect(
      listed.find((entry) => entry.key === 'activated')?.usedBy.map((entry) => entry.key),
    ).toEqual(['sim_order_activated', 'mobility_activated']);
    expect(listed.find((entry) => entry.key === template.key)?.usedBy).toEqual([]);

    const created = await flows.create(made(FLOW_SITE), { name: 'Follow up' });
    if (created.status !== 'ok') throw new Error('no flow');
    const definition: FlowDefinition = {
      schemaVersion: 1,
      trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when: null },
      steps: [{ id: 's_mail', kind: 'send_email', template: template.key }],
    };
    const saved = await flows.saveDraft(made(FLOW_SITE), created.value.key, {
      expectedRevision: 0,
      definition: JSON.parse(JSON.stringify(definition)),
    });
    expect(saved.status).toBe('ok');
    // A draft is not what the flow sends.
    listed = await store.listTemplates(made(FLOW_SITE));
    expect(listed.find((entry) => entry.key === template.key)?.usedBy).toEqual([]);
    expect(
      (
        await flows.activate(made(FLOW_SITE), created.value.key, {
          expectedRevision: 1,
          mayChangeLeads: false,
        })
      ).status,
    ).toBe('ok');
    listed = await store.listTemplates(made(FLOW_SITE));
    expect(listed.find((entry) => entry.key === template.key)?.usedBy).toEqual([
      { key: created.value.key, name: 'Follow up' },
    ]);
    expect((await flows.list(made(FLOW_SITE), { archived: false })).needsAttention.size).toBe(0);

    const archived = await store.setTemplateArchived(made(FLOW_SITE), template.key, true);
    expect(archived).toMatchObject({
      kind: 'saved',
      template: { usedBy: [{ key: created.value.key }] },
    });
    const { needsAttention } = await flows.list(made(FLOW_SITE), { archived: false });
    expect(needsAttention.get(created.value.key)).toEqual({
      path: 'steps.0.template',
      code: 'template_unavailable',
      ref: template.key,
    });
  });
});
