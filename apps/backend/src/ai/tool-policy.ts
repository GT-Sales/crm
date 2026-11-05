import type { ToolSet } from 'ai';

/** Model capabilities are fixed in reviewed code, never supplied by a prompt or request. */
const ALLOWED_TOOLS = new Set([
  'getSiteOverview',
  'findLeads',
  'getLeadSummary',
  'listOpenTasks',
  'getSourcePerformance',
  'getLeadUpdateOptions',
  'prepareLeadUpdate',
  'prepareNote',
  'prepareTask',
  'prepareEmail',
  'listAutomations',
  'getAutomation',
  'getAutomationCatalog',
  'getAutomationRuns',
  'proposeAutomationCreate',
  'proposeAutomationEdit',
  'askFollowUp',
]);

/** Refuse extra tools or provider-executed/dynamic tools before contacting the model. */
export function assertAssistantToolPolicy(tools: ToolSet): void {
  const prototype: unknown = Object.getPrototypeOf(tools);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error('assistant tool policy rejected');
  for (const [name, definition] of Object.entries(tools)) {
    if (
      !ALLOWED_TOOLS.has(name) ||
      (definition.type !== undefined && definition.type !== 'function') ||
      !Object.hasOwn(definition, 'execute') ||
      typeof definition.execute !== 'function'
    )
      throw new Error('assistant tool policy rejected');
  }
}
