import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_KEY_SHAPE,
  AUTOMATION_REASONS,
  AUTOMATION_REASON_SHAPE,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_STEP_OUTCOMES,
  AUTOMATION_TIMER_KINDS,
  AUTOMATION_TIMER_STATUSES,
  AUTOMATION_VERSION_STATUSES,
  AUTOMATION_WAIT_STATUSES,
  BUILT_IN_AUTOMATION_KEYS,
  CUSTOMER_EMAIL_TEMPLATES,
  CUSTOM_FLOW_KEY_PATTERN,
  FLOW_STEP_KINDS,
  FLOW_TRIGGER_KINDS,
  SITE_TEMPLATE_KEY_PATTERN,
  STEP_ID_PATTERN,
  builtInFlowDefinition,
  builtInFlowName,
  flowDefinitionBytes,
  flowDefinitionSchemaFor,
} from '@gt-sales/contracts';
import { applyMigrations } from '@gt-sales/db/migrations';

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

/** The quoted values of a CHECK's `= ANY (ARRAY[…])` list, in order. */
function listValues(definition: string): string[] {
  const array = /ARRAY\[([^\]]*)\]/.exec(definition)?.[1] ?? '';
  return [...array.matchAll(/'([^']*)'::text/g)].map((match) => match[1] ?? '');
}

/** The patterns a CHECK matches with `~`. */
function patterns(definition: string): string[] {
  return [...definition.matchAll(/~ '([^']*)'::text/g)].map((match) => match[1] ?? '');
}

// Closes HANDOFF §5.3's "no test ties these SQL lists to the contracts" for
// the automation and template lists: a value added to contracts without its
// migration (or the reverse) fails here. No rows are needed.
databaseTest('automation and template SQL tied to the contracts', () => {
  let admin: ReturnType<typeof postgres>;
  const checks = new Map<string, string>();

  const check = (name: string): string => {
    const definition = checks.get(name);
    if (definition === undefined) throw new Error(`no constraint ${name}`);
    return definition;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    const rows = await admin<{ name: string; definition: string }[]>`
      select conname::text as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where connamespace = 'app'::regnamespace and contype = 'c'
    `;
    for (const row of rows) checks.set(row.name, row.definition);
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('the built-in key list and the custom key pattern are the contracts’', () => {
    const definition = check('automations_key_check');
    expect(listValues(definition)).toEqual([...BUILT_IN_AUTOMATION_KEYS]);
    expect(patterns(definition)).toEqual([CUSTOM_FLOW_KEY_PATTERN.source]);
    expect(patterns(check('automation_runs_automation_key_check'))).toEqual([
      AUTOMATION_KEY_SHAPE.source,
    ]);
  });

  it('both template key checks list the nine templates and the site-made pattern', () => {
    for (const name of ['email_templates_key_check', 'email_template_versions_key_check']) {
      const definition = check(name);
      expect(listValues(definition), name).toEqual([...CUSTOMER_EMAIL_TEMPLATES]);
      expect(patterns(definition), name).toEqual([SITE_TEMPLATE_KEY_PATTERN.source]);
    }
  });

  it('both reason checks carry the reason shape, and every reason matches it', () => {
    for (const name of ['automation_runs_reason_check', 'automation_step_runs_reason_check']) {
      expect(patterns(check(name)), name).toEqual([AUTOMATION_REASON_SHAPE.source]);
    }
    for (const reason of AUTOMATION_REASONS) expect(reason).toMatch(AUTOMATION_REASON_SHAPE);
  });

  it('the step id checks carry the step id pattern', () => {
    for (const name of ['automation_step_runs_step_id_check', 'automation_waits_step_id_check']) {
      expect(patterns(check(name)), name).toEqual([STEP_ID_PATTERN.source]);
    }
  });

  it('every status, outcome and kind list equals its contracts enum', () => {
    const lists: [string, readonly string[]][] = [
      ['automation_runs_status_check', AUTOMATION_RUN_STATUSES],
      ['automation_runs_trigger_kind_check', FLOW_TRIGGER_KINDS],
      ['automation_step_runs_outcome_check', AUTOMATION_STEP_OUTCOMES],
      ['automation_step_runs_step_kind_check', FLOW_STEP_KINDS],
      ['automation_versions_status_check', AUTOMATION_VERSION_STATUSES],
      ['automation_waits_status_check', AUTOMATION_WAIT_STATUSES],
      ['automation_timers_status_check', AUTOMATION_TIMER_STATUSES],
      ['automation_timers_trigger_kind_check', AUTOMATION_TIMER_KINDS],
    ];
    for (const [name, values] of lists) expect(listValues(check(name)), name).toEqual([...values]);
  });

  it('0020’s default definitions parse and equal builtInFlowDefinition, and the size measure is the CHECK’s', async () => {
    for (const key of BUILT_IN_AUTOMATION_KEYS) {
      const [row] = await admin<{ definition: unknown; bytes: number }[]>`
        select app.builtin_flow_definition(${key}) as definition,
          octet_length(app.builtin_flow_definition(${key})::text) as bytes
      `;
      const parsed = flowDefinitionSchemaFor('builtin').safeParse(row?.definition);
      expect(parsed.success, key).toBe(true);
      expect(row?.definition, key).toEqual(builtInFlowDefinition(key));
      expect(flowDefinitionBytes(builtInFlowDefinition(key)), key).toBe(row?.bytes);
    }
    const [unknown] = await admin<{ definition: unknown }[]>`
      select app.builtin_flow_definition('flow_abcdefghij012345') as definition
    `;
    expect(unknown?.definition).toBeNull();
  });

  it('0020’s default names, which the conversion writes, are builtInFlowName for all six', async () => {
    for (const key of BUILT_IN_AUTOMATION_KEYS) {
      const [row] = await admin<{ name: string | null }[]>`
        select app.builtin_flow_name(${key}) as name
      `;
      expect(row?.name, key).toBe(builtInFlowName(key));
    }
    const [unknown] = await admin<{ name: string | null }[]>`
      select app.builtin_flow_name('flow_abcdefghij012345') as name
    `;
    expect(unknown?.name).toBeNull();
  });
});
