import { sql } from 'drizzle-orm';
import { evaluateSyntheticConditionGroup } from '../automations/conditions.js';
import { withTenantTx, type DatabaseClient } from '@gt-sales/db';
import {
  flowDefinitionSchemaFor,
  isLeadStage,
  checkFlowAgainstSite,
  triggerLeadTypes,
  walkSteps,
  aiAutomationScenarioSchema,
  type AiAutomationSimulation,
} from '@gt-sales/contracts';
import type { z } from 'zod';
import type { WriteScope } from '../tenant-scope.js';
import { runFlowTest } from '../automations/test-run.js';
import { loadFlowSite } from '../automations/site.js';
import { AutomationAuthoringError, type AutomationAuthoringStore } from './automation-authoring.js';

export async function simulateAutomation(
  input: {
    scope: WriteScope;
    token: string;
    key: string;
    now: Date;
    store: AutomationAuthoringStore;
    scenario: z.infer<typeof aiAutomationScenarioSchema>;
  },
  database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
): Promise<AiAutomationSimulation> {
  const proposal = await input.store.load(input.scope, input.token, input.key, input.now, {
    lock: false,
  });
  const scenario = aiAutomationScenarioSchema.parse(input.scenario);
  return database.withTenantTx(input.scope, async (tx) => {
    await tx.execute(sql`set transaction read only`);
    // AUTH-3: an edit is parsed as the flow it edits is (a custom flow cannot
    // gain a built-in's `main` step); a new flow is always custom.
    let origin: 'builtin' | 'custom' = 'custom';
    if (proposal.target) {
      const [flow] = await tx.execute<{ origin: string }>(sql`
        select origin from app.automations
        where workspace_id = ${input.scope.workspaceId} and key = ${proposal.target.key}
      `);
      if (!flow) throw new AutomationAuthoringError('not_found');
      origin = flow.origin === 'builtin' ? 'builtin' : 'custom';
    }
    const definition = flowDefinitionSchemaFor(origin).safeParse(proposal.draft.definition);
    if (!definition.success) throw new AutomationAuthoringError('invalid');
    const site = await loadFlowSite(tx, input.scope.workspaceId);
    if (checkFlowAgainstSite(definition.data, site).length)
      throw new AutomationAuthoringError('invalid');
    if (!isLeadStage(scenario.leadType, scenario.stage))
      throw new AutomationAuthoringError('invalid');
    if (scenario.planId && site.plans.get(scenario.planId)?.leadType !== scenario.leadType)
      throw new AutomationAuthoringError('invalid');
    if (scenario.assignedActorId && !site.memberIds.has(scenario.assignedActorId))
      throw new AutomationAuthoringError('invalid');
    const allowed = new Set(site.catalog.filterable(scenario.leadType).map((p) => p.key));
    if (Object.keys(scenario.properties).some((key) => !allowed.has(key)))
      throw new AutomationAuthoringError('invalid');
    const sample = { ...scenario, properties: new Map(Object.entries(scenario.properties)) };
    const trigger = definition.data.trigger;
    const triggerMatched =
      triggerLeadTypes(trigger).includes(scenario.leadType) &&
      (!(trigger.kind === 'stage_entered' || trigger.kind === 'time_in_stage') ||
        trigger.stage === scenario.stage) &&
      (!trigger.when ||
        (await evaluateSyntheticConditionGroup(tx, trigger.when, sample, site.catalog)));
    const result = triggerMatched
      ? await runFlowTest(tx, {
          scope: input.scope,
          flowKey: proposal.target?.key ?? 'flow_simulation',
          definition: definition.data,
          customerEmailEnvironment: undefined,
          simulation: { sample },
        })
      : { steps: [], emailsQueued: 0 };
    const uncoveredBranches: AiAutomationSimulation['uncoveredBranches'] = [];
    walkSteps(definition.data.steps, (step) => {
      if (step.kind === 'if_else')
        for (const branch of ['yes', 'no'] as const) {
          if (!result.steps.some((s) => s.stepId === step.id && s.branch === branch))
            uncoveredBranches.push({ stepId: step.id, branch });
        }
    });
    return {
      mode: 'simulation',
      triggerMatched,
      emailsQueued: 0,
      steps: result.steps,
      uncoveredBranches,
    };
  });
}
