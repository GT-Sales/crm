import { createLeadRequestSchema } from '@gt-sales/contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  INTAKE_CHECK_CONSENT_VERSION,
  INTAKE_CHECK_CONTACT,
  INTAKE_CHECK_LEFTOVER_AGE_MS,
  INTAKE_CHECK_TIMEOUT_MS,
  intakeCheckCode,
  intakeCheckForm,
  runIntakeCheck,
  type IntakeCheckDependencies,
} from '../src/intake-check/check.js';
import {
  IntakeCheckSiteNotTestError,
  type IntakeCheckLead,
  type IntakeCheckStore,
} from '../src/intake-check/store.js';
import type { CreateLeadInput, CreateLeadResult } from '../src/leads/store.js';
import { checkLeadIntake } from '../src/leads/types.js';

const SITE = '16000000-0000-4000-8000-00000000f701';
const ACTOR = '26000000-0000-4000-8000-00000000f701';
const LEAD = '36000000-0000-4000-8000-00000000f701';
const REQUEST = '46000000-0000-4000-8000-00000000f701';
const START = new Date('2026-10-31T12:00:00.000Z');

const input = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };

function created(): CreateLeadResult {
  return {
    lead: {
      id: LEAD,
      workspaceId: SITE,
      status: 'submitted',
      externalRef: null,
      updatedAt: START.toISOString(),
    },
    grant: null,
    replayed: false,
  };
}

/** A clock that moves 250 ms each time it is read. */
function steppingClock(): () => Date {
  let reads = 0;
  return () => new Date(START.getTime() + 250 * reads++);
}

function fakes(
  options: {
    lead?: IntakeCheckLead | undefined;
    remaining?: number;
  } = {},
) {
  const createLead = vi.fn(async (_input: CreateLeadInput) => created());
  const store = {
    deleteLeftovers: vi.fn(async () => 0),
    readLead: vi.fn(async () =>
      'lead' in options
        ? options.lead
        : { leadType: 'internet', status: 'submitted', stage: 'new' },
    ),
    deleteLead: vi.fn(async () => ({ deleted: 1, remaining: options.remaining ?? 0 })),
  } satisfies IntakeCheckStore;
  const dependencies: IntakeCheckDependencies = {
    leads: { createLead },
    store,
    now: steppingClock(),
  };
  return { createLead, store, dependencies };
}

function silenceLogs() {
  return {
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runIntakeCheck', () => {
  test('creates a submitted internet lead with the synthetic contact as the given actor', async () => {
    silenceLogs();
    const { createLead, dependencies } = fakes();
    await runIntakeCheck(dependencies, input);
    expect(createLead).toHaveBeenCalledTimes(1);
    const call = createLead.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      workspaceId: SITE,
      actorId: ACTOR,
      requestId: REQUEST,
      leadType: 'internet',
      submit: true,
      contact: INTAKE_CHECK_CONTACT,
      consentVersion: 'intake-check-v1',
      form: intakeCheckForm(START),
    });
    expect(call).not.toHaveProperty('attribution');
    expect(call).not.toHaveProperty('order');
    expect(call).not.toHaveProperty('idempotency');
    expect(call).not.toHaveProperty('externalRef');
  });

  test("the request passes the website route's own checks", () => {
    const body = createLeadRequestSchema.parse({
      leadType: 'internet',
      contact: INTAKE_CHECK_CONTACT,
      form: intakeCheckForm(START),
      consentVersion: INTAKE_CHECK_CONSENT_VERSION,
      submit: true,
    });
    expect(checkLeadIntake(body).ok).toBe(true);
  });

  test('removes leftovers older than ten minutes first', async () => {
    silenceLogs();
    const { store, dependencies } = fakes();
    await runIntakeCheck(dependencies, input);
    expect(store.deleteLeftovers).toHaveBeenCalledWith(
      { workspaceId: SITE, actorId: ACTOR },
      new Date(START.getTime() - INTAKE_CHECK_LEFTOVER_AGE_MS),
    );
    expect(INTAKE_CHECK_LEFTOVER_AGE_MS).toBe(10 * 60_000);
  });

  test('reports ok with the duration', async () => {
    silenceLogs();
    const { store, dependencies } = fakes();
    const result = await runIntakeCheck(dependencies, input);
    expect(result).toEqual({ status: 'ok', durationMs: 250 });
    expect(store.deleteLead).toHaveBeenCalledWith({ workspaceId: SITE, actorId: ACTOR }, LEAD);
  });

  test('reports the step in progress when a dependency throws', async () => {
    silenceLogs();
    const leftovers = fakes();
    leftovers.store.deleteLeftovers.mockRejectedValueOnce(new Error('Something went wrong.'));
    expect(await runIntakeCheck(leftovers.dependencies, input)).toEqual({
      status: 'failed',
      step: 'leftovers',
      code: 'unexpected_error',
      durationMs: 250,
    });
    expect(leftovers.createLead).not.toHaveBeenCalled();

    const create = fakes();
    create.createLead.mockRejectedValueOnce(
      Object.assign(new Error('insert failed'), { cause: { code: '23503' } }),
    );
    expect(await runIntakeCheck(create.dependencies, input)).toMatchObject({
      status: 'failed',
      step: 'create',
      code: 'sqlstate_23503',
    });
    expect(create.store.readLead).not.toHaveBeenCalled();

    const remove = fakes();
    remove.store.deleteLead.mockRejectedValueOnce({ code: 'ECONNRESET' });
    expect(await runIntakeCheck(remove.dependencies, input)).toMatchObject({
      status: 'failed',
      step: 'delete',
      code: 'persistence_unavailable',
    });
  });

  test('a site that is not the test site fails at leftovers and nothing is created', async () => {
    silenceLogs();
    const { createLead, store, dependencies } = fakes();
    store.deleteLeftovers.mockRejectedValueOnce(new IntakeCheckSiteNotTestError());
    expect(await runIntakeCheck(dependencies, input)).toMatchObject({
      status: 'failed',
      step: 'leftovers',
      code: 'intake_check_site_not_test',
    });
    expect(createLead).not.toHaveBeenCalled();
    expect(store.deleteLead).not.toHaveBeenCalled();
  });

  test('gives up after the run deadline with the step in progress', async () => {
    expect(INTAKE_CHECK_TIMEOUT_MS).toBe(60_000);
    vi.useFakeTimers();
    const logs = silenceLogs();
    const { createLead, dependencies } = fakes();
    let release: (value: CreateLeadResult) => void = () => undefined;
    createLead.mockImplementationOnce(
      () =>
        new Promise<CreateLeadResult>((resolve) => {
          release = resolve;
        }),
    );
    const running = runIntakeCheck(dependencies, input);
    await vi.advanceTimersByTimeAsync(INTAKE_CHECK_TIMEOUT_MS - 1);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ status: 'failed', step: 'create', code: 'timeout' });

    // The hung call finishing later neither logs a second line nor throws.
    release(created());
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.info.mock.calls.length + logs.warn.mock.calls.length).toBe(1);
  });

  test('a failed verify still deletes the lead', async () => {
    silenceLogs();
    const cases: [IntakeCheckLead | undefined, string][] = [
      [undefined, 'lead_missing'],
      [{ leadType: 'mobility', status: 'submitted', stage: 'new' }, 'wrong_type'],
      [{ leadType: 'internet', status: 'incomplete', stage: 'new' }, 'not_submitted'],
      [{ leadType: 'internet', status: 'submitted', stage: 'contacted' }, 'wrong_stage'],
    ];
    for (const [lead, code] of cases) {
      const { store, dependencies } = fakes({ lead });
      expect(await runIntakeCheck(dependencies, input)).toMatchObject({
        status: 'failed',
        step: 'verify',
        code,
      });
      expect(store.deleteLead).toHaveBeenCalledTimes(1);
    }
  });

  test('a verify failure is reported even when its clean-up delete fails', async () => {
    silenceLogs();
    const { store, dependencies } = fakes({ lead: undefined });
    store.deleteLead.mockRejectedValueOnce(new Error('Something went wrong.'));
    expect(await runIntakeCheck(dependencies, input)).toMatchObject({
      status: 'failed',
      step: 'verify',
      code: 'lead_missing',
    });
  });

  test('delete_incomplete when a row remains', async () => {
    silenceLogs();
    const { dependencies } = fakes({ remaining: 1 });
    expect(await runIntakeCheck(dependencies, input)).toMatchObject({
      status: 'failed',
      step: 'delete',
      code: 'delete_incomplete',
    });
  });

  test('logs no value', async () => {
    const logs = silenceLogs();
    const ok = fakes();
    ok.store.deleteLeftovers.mockResolvedValueOnce(2);
    await runIntakeCheck(ok.dependencies, input);
    const failing = fakes({ lead: undefined });
    await runIntakeCheck(failing.dependencies, input);

    const lines = [...logs.info.mock.calls, ...logs.warn.mock.calls].map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    const records: unknown[] = lines.map((line) => JSON.parse(line));
    expect(records).toEqual([
      { event: 'intake_check', status: 'ok', durationMs: 250, leftovers: 2 },
      {
        event: 'intake_check',
        status: 'failed',
        step: 'verify',
        code: 'lead_missing',
        durationMs: 250,
      },
    ]);
    for (const line of lines) {
      expect(line).not.toContain(INTAKE_CHECK_CONTACT.email);
      expect(line).not.toContain(INTAKE_CHECK_CONTACT.phone);
      expect(line).not.toContain('Intake Check Street');
      expect(line).not.toContain(INTAKE_CHECK_CONTACT.fullName);
    }
  });
});

describe('intakeCheckCode', () => {
  test('maps a thrown value to a bounded code', () => {
    expect(intakeCheckCode({ code: 'ECONNREFUSED' })).toBe('persistence_unavailable');
    expect(intakeCheckCode(new Error('customer_data_restricted'))).toBe('customer_data_restricted');
    expect(
      intakeCheckCode(
        Object.assign(new Error('Failed query: insert'), { cause: { code: '23503' } }),
      ),
    ).toBe('sqlstate_23503');
    expect(intakeCheckCode({ code: '42P01' })).toBe('sqlstate_42p01');
    expect(intakeCheckCode(new Error('duplicate key value violates unique constraint'))).toBe(
      'unexpected_error',
    );
    expect(intakeCheckCode(new Error(`a${'_'.repeat(64)}`))).toBe('unexpected_error');
    expect(intakeCheckCode('a string')).toBe('unexpected_error');
    expect(intakeCheckCode(undefined)).toBe('unexpected_error');
  });

  test('follows the cause chain no deeper than eight', () => {
    let deep: { code?: string; cause?: unknown } = { code: '23505' };
    for (let depth = 0; depth < 9; depth += 1) deep = { cause: deep };
    expect(intakeCheckCode(deep)).toBe('unexpected_error');
    let shallow: { code?: string; cause?: unknown } = { code: '23505' };
    for (let depth = 0; depth < 8; depth += 1) shallow = { cause: shallow };
    expect(intakeCheckCode(shallow)).toBe('sqlstate_23505');
  });
});
