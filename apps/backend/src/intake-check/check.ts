import { createLeadRequestSchema, initialLeadStage, type LeadForm } from '@gt-sales/contracts';

import { isConnectionLevelError } from '../http/logger.js';
import type { LeadStore } from '../leads/store.js';
import { checkLeadIntake } from '../leads/types.js';
import type { IntakeCheckLead, IntakeCheckStore } from './store.js';

/**
 * The intake check (spec §4): every run pushes one fictional `internet` lead
 * through the website's own intake code on the hidden test site, reads it
 * back and deletes it. A run that dies half-way leaves a lead the next run's
 * leftovers step removes. Nothing here sends mail: the test site has no
 * sender and no automation rows.
 */

/** A lead on the test site older than this is a leftover of a run that died; a younger one may be a concurrent run's. */
export const INTAKE_CHECK_LEFTOVER_AGE_MS = 10 * 60_000;
export const INTAKE_CHECK_LEAD_TYPE = 'internet';
export const INTAKE_CHECK_CONSENT_VERSION = 'intake-check-v1';
export const INTAKE_CHECK_CONTACT = {
  fullName: 'Intake Check',
  email: 'intake-check@example.invalid',
  phone: '403 555 0199',
  countryCode: 'CA',
} as const;

/** The fixed fictional internet form (R3); `consentedAt` is the run's time. */
export function intakeCheckForm(now: Date): LeadForm {
  return {
    schemaVersion: 1,
    payload: {
      planId: 'intake-check',
      planLabel: 'Intake check',
      dateOfBirth: '2000-01-01',
      streetAddress: '1 Intake Check Street',
      city: 'Toronto',
      consent: true,
      consentedAt: now.toISOString(),
    },
  };
}

export type IntakeCheckStep = 'leftovers' | 'create' | 'verify' | 'delete';

export type IntakeCheckResult =
  | { status: 'ok'; durationMs: number }
  | { status: 'failed'; step: IntakeCheckStep; code: string; durationMs: number };

export interface IntakeCheckDependencies {
  leads: Pick<LeadStore, 'createLead'>;
  store: IntakeCheckStore;
  now?: () => Date;
}

export interface IntakeCheckRunInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 8;

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if ('code' in current && typeof current.code === 'string') {
      if (SQLSTATE_PATTERN.test(current.code)) return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** A bounded snake-case code for any thrown value (never its message unless it is already a code). */
export function intakeCheckCode(error: unknown): string {
  if (isConnectionLevelError(error)) return 'persistence_unavailable';
  if (error instanceof Error && CODE_PATTERN.test(error.message)) return error.message;
  const state = sqlState(error);
  if (state !== undefined) return `sqlstate_${state.toLowerCase()}`;
  return 'unexpected_error';
}

/**
 * One JSON log line per run, written by `runIntakeCheck` itself (so manual
 * runs log too): the step, the code, counts and the duration, never a value.
 */
export function logIntakeCheck(result: IntakeCheckResult, leftovers: number): void {
  const record = {
    event: 'intake_check',
    status: result.status,
    ...(result.status === 'failed' ? { step: result.step, code: result.code } : {}),
    durationMs: result.durationMs,
    ...(leftovers > 0 ? { leftovers } : {}),
  };
  if (result.status === 'ok') console.info(JSON.stringify(record));
  else console.warn(JSON.stringify(record));
}

/** Why a read-back lead is not what intake should have stored, or `undefined` when it is. */
function verifyProblem(lead: IntakeCheckLead | undefined): string | undefined {
  if (!lead) return 'lead_missing';
  if (lead.leadType !== INTAKE_CHECK_LEAD_TYPE) return 'wrong_type';
  if (lead.status !== 'submitted') return 'not_submitted';
  if (lead.stage !== initialLeadStage(INTAKE_CHECK_LEAD_TYPE)) return 'wrong_stage';
  return undefined;
}

/** `leadType` → `lead_type`: a refused part's name as a code. */
function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

class StepFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StepFailure';
  }
}

/** Never throws: any failure is a `failed` result at the step in progress. */
export async function runIntakeCheck(
  dependencies: IntakeCheckDependencies,
  input: IntakeCheckRunInput,
): Promise<IntakeCheckResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const scope = { workspaceId: input.workspaceId, actorId: input.actorId };
  let step: IntakeCheckStep = 'leftovers';
  let leftovers = 0;
  let leadId: string | undefined;

  const finish = (outcome: { code: string } | undefined): IntakeCheckResult => {
    const durationMs = Math.max(0, now().getTime() - startedAt.getTime());
    const result: IntakeCheckResult =
      outcome === undefined
        ? { status: 'ok', durationMs }
        : { status: 'failed', step, code: outcome.code, durationMs };
    try {
      logIntakeCheck(result, leftovers);
    } catch {
      // A log line that cannot be written never turns a result into a throw.
    }
    return result;
  };

  try {
    leftovers = await dependencies.store.deleteLeftovers(
      scope,
      new Date(startedAt.getTime() - INTAKE_CHECK_LEFTOVER_AGE_MS),
    );

    step = 'create';
    // The website route's own checks, in its order (R4).
    const body = createLeadRequestSchema.safeParse({
      leadType: INTAKE_CHECK_LEAD_TYPE,
      contact: INTAKE_CHECK_CONTACT,
      form: intakeCheckForm(startedAt),
      consentVersion: INTAKE_CHECK_CONSENT_VERSION,
      submit: true,
    });
    if (!body.success) throw new StepFailure('intake_request_invalid');
    const intake = checkLeadIntake(body.data);
    if (!intake.ok) throw new StepFailure(`intake_refused_${snakeCase(intake.problem)}`);
    const created = await dependencies.leads.createLead({
      ...body.data,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      requestId: input.requestId,
    });
    leadId = created.lead.id;

    step = 'verify';
    const problem = verifyProblem(await dependencies.store.readLead(scope, leadId));
    if (problem !== undefined) throw new StepFailure(problem);

    step = 'delete';
    const removed = await dependencies.store.deleteLead(scope, leadId);
    if (removed.deleted !== 1 || removed.remaining !== 0) {
      throw new StepFailure('delete_incomplete');
    }
    return finish(undefined);
  } catch (error) {
    if (step === 'verify' && leadId !== undefined) {
      // A lead that reads back wrong is still removed; if that fails too, the
      // next run's leftovers step takes it.
      await dependencies.store.deleteLead(scope, leadId).catch(() => undefined);
    }
    return finish({ code: error instanceof StepFailure ? error.code : intakeCheckCode(error) });
  }
}
