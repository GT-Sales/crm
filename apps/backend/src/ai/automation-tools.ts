import {
  automationModelProposalSchema,
  normalizeAutomationProposal,
  MemberChoiceError,
} from './automation-input.js';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  automationKeySchema,
  walkDraftSteps,
  type AiAutomationProposal,
} from '@gt-sales/contracts';
import type { Scope } from '../tenant-scope.js';
import type { FlowStore } from '../automations/flow-store.js';
import { decideAccess, type StaffAccessSnapshot } from '../staff/authorization.js';
import { TurnBudget } from './limits.js';
import { AutomationAuthoringError, type AutomationAuthoringStore } from './automation-authoring.js';

function countRecords(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, item) => n + 1 + countRecords(item), 0);
  if (value && typeof value === 'object')
    return Object.values(value).reduce<number>((n, item) => n + countRecords(item), 0);
  return 0;
}
export const AUTOMATION_TOOL_NAMES = [
  'listAutomations',
  'getAutomation',
  'getAutomationCatalog',
  'getAutomationRuns',
  'proposeAutomationCreate',
  'proposeAutomationEdit',
] as const;
export function createAutomationTools(input: {
  scope: Scope;
  site: { name: string; slug: string };
  key: string;
  flows: FlowStore;
  store: AutomationAuthoringStore;
  loadAccess(): Promise<StaffAccessSnapshot | undefined>;
  now(): Date;
  budget: TurnBudget;
}) {
  const proposals: AiAutomationProposal[] = [];
  const prepared = new Map<string, AiAutomationProposal>();
  // Drafts being written now (AUTH-6), counted toward the three-card limit.
  const preparing = new Set<string>();
  const schemas = {
    listAutomations: z
      .object({
        search: z.string().max(80).optional(),
        offset: z.int().min(0).max(1000).optional(),
      })
      .strict(),
    getAutomation: z
      .object({ key: automationKeySchema, version: z.int().positive().optional() })
      .strict(),
    getAutomationCatalog: z
      .object({
        leadType: z.string().max(80).optional(),
        section: z.enum(['overview', 'templates', 'members', 'properties', 'plans']).optional(),
        search: z.string().max(80).optional(),
        offset: z.int().min(0).max(1000).optional(),
      })
      .strict(),
    getAutomationRuns: z.object({ key: automationKeySchema, before: z.uuid().optional() }).strict(),
    proposeAutomationCreate: automationModelProposalSchema.omit({ target: true }),
    proposeAutomationEdit: automationModelProposalSchema.required({ target: true }),
  };
  async function execute(name: string, raw: unknown): Promise<string> {
    if (!input.budget.reserveToolCall()) return JSON.stringify({ status: 'budget_exceeded' });
    const access = await input.loadAccess();
    if (
      !decideAccess(access, 'workspace.read').allowed ||
      !decideAccess(access, 'integration.manage').allowed
    )
      return JSON.stringify({ status: 'not_available' });
    let result: unknown;
    try {
      switch (name) {
        case 'listAutomations': {
          const args = schemas.listAutomations.parse(raw);
          const list = await input.flows.list(input.scope, { archived: false });
          const matched = list.flows.filter(
            (f) => !args.search || f.name.toLowerCase().includes(args.search.toLowerCase()),
          );
          const offset = args.offset ?? 0;
          result = {
            nextOffset: offset + 20 < matched.length ? offset + 20 : null,
            flows: matched
              .filter(
                (f) => !args.search || f.name.toLowerCase().includes(args.search.toLowerCase()),
              )
              .slice(offset, offset + 20)
              .map((f) => ({
                key: f.key,
                name: f.name,
                enabled: f.enabled,
                revision: f.revision,
                hasDraft: !!f.draft,
                href: `/w/${encodeURIComponent(input.site.slug)}/automations/${f.key}`,
              })),
          };
          break;
        }
        case 'getAutomation': {
          const args = schemas.getAutomation.parse(raw);
          const current = await input.flows.get(input.scope, args.key);
          result = current
            ? {
                key: current.key,
                name: current.name,
                description: current.description,
                enabled: current.enabled,
                revision: current.revision,
                archived: current.archived,
                draft: current.draft ? { definition: current.draft.definition } : null,
                active: current.activeVersion
                  ? {
                      version: current.activeVersion.version,
                      definition: current.activeVersion.definition,
                    }
                  : null,
                ...(args.version
                  ? {
                      historical: await input.flows.getVersion(input.scope, args.key, args.version),
                    }
                  : {}),
              }
            : { status: 'not_found' };
          break;
        }
        case 'getAutomationCatalog': {
          const args = schemas.getAutomationCatalog.parse(raw);
          const catalog = await input.flows.catalog(input.scope);
          const offset = args.offset ?? 0;
          const section = args.section ?? 'overview';
          const allEntries =
            section === 'templates'
              ? catalog.templates.map((t) => ({ key: t.key, name: t.name }))
              : section === 'members'
                ? catalog.members
                : section === 'properties'
                  ? catalog.properties.filter(
                      (p) => !args.leadType || p.leadTypes.includes(args.leadType),
                    )
                  : section === 'plans'
                    ? catalog.plans.filter((p) => !args.leadType || p.leadType === args.leadType)
                    : catalog.leadTypes.filter((t) => !args.leadType || t.key === args.leadType);
          const entries = args.search
            ? allEntries.filter((entry) =>
                JSON.stringify(entry)
                  .toLowerCase()
                  .includes(args.search?.toLowerCase() ?? ''),
              )
            : allEntries;
          result = {
            currentMember: {
              reference: 'me',
              actorId: input.scope.actorId,
              displayName:
                catalog.members.find((m) => m.actorId === input.scope.actorId)?.displayName ??
                'You',
            },
            section,
            entries: entries.slice(offset, offset + 10),
            nextOffset: offset + 10 < entries.length ? offset + 10 : null,
            ...(section === 'overview'
              ? {
                  triggers: [
                    'lead_submitted',
                    'stage_entered',
                    'after_submitted',
                    'time_in_stage',
                    'task_overdue',
                  ],
                  actions: [
                    'send_email',
                    'create_task',
                    'assign_lead',
                    'update_lead',
                    'notify_staff',
                    'if_else',
                    'wait',
                  ],
                }
              : {}),
          };
          break;
        }
        case 'getAutomationRuns': {
          const args = schemas.getAutomationRuns.parse(raw);
          const runs = await input.flows.listRuns(input.scope, args.key, {
            ...(args.before ? { before: args.before } : {}),
            includeLeadNames: false,
          });
          // Do not expose stored details, lead identifiers or contact fields through explanations.
          result = {
            runs: runs?.runs.slice(0, 10).map((r) => ({
              id: r.id,
              status: r.status,
              reason: r.reason,
              version: r.version,
              resumeAt: r.resumeAt,
            })),
            nextBefore: runs && runs.runs.length > 10 ? runs.runs[9]?.id : runs?.nextBefore,
          };
          break;
        }
        case 'proposeAutomationCreate':
        case 'proposeAutomationEdit': {
          if (proposals.length >= 3) return JSON.stringify({ status: 'limit_reached' });
          const args =
            name === 'proposeAutomationCreate'
              ? schemas.proposeAutomationCreate.parse(raw)
              : schemas.proposeAutomationEdit.parse(raw);
          const catalog = await input.flows.catalog(input.scope);
          const normalized = normalizeAutomationProposal(
            args,
            input.scope.actorId,
            catalog.members,
          );
          const identity = structuredClone(normalized);
          if (!identity.target)
            walkDraftSteps(identity.draft.definition.steps, (step) => {
              step.id = 'new_step';
            });
          const proposalKey = JSON.stringify(identity);
          if (prepared.has(proposalKey) || preparing.has(proposalKey))
            return JSON.stringify({
              status: 'confirmation_required',
              message:
                'This draft is already prepared. Wait for the person to review the card; do not prepare it again.',
            });
          // AUTH-6: the slot and the draft are taken before the row is written,
          // so a parallel call is turned away first and no row is left orphaned.
          if (proposals.length + preparing.size >= 3)
            return JSON.stringify({ status: 'limit_reached' });
          preparing.add(proposalKey);
          let proposal: AiAutomationProposal;
          try {
            proposal = await input.store.prepare(
              { ...input.scope, requestId: crypto.randomUUID() },
              normalized,
              input.site.name,
              input.key,
              input.now(),
            );
          } finally {
            preparing.delete(proposalKey);
          }
          prepared.set(proposalKey, proposal);
          proposals.push(proposal);
          result = {
            status: 'confirmation_required',
            message:
              'Visual proposal prepared. No automation saved. The person must review and press Save draft.',
            issues: proposal.issues,
          };
          break;
        }
        default:
          throw new Error('unknown automation tool');
      }
    } catch (error) {
      if (error instanceof MemberChoiceError)
        return JSON.stringify({
          status: 'clarification_required',
          message: error.message,
          choices: error.choices.slice(0, 10),
        });
      if (error instanceof AutomationAuthoringError) return JSON.stringify({ status: error.code });
      if (error instanceof z.ZodError)
        return JSON.stringify({
          status: 'invalid',
          issues: error.issues.slice(0, 8).map((i) => ({ path: i.path, message: i.message })),
        });
      throw error;
    }
    const text = JSON.stringify(result);
    if (
      input.budget.acceptResult({ bytes: Buffer.byteLength(text), records: countRecords(result) })
        .rejected
    )
      return JSON.stringify({
        status: 'too_large',
        message: 'Narrow the request by flow name or lead type.',
      });
    return text;
  }
  const descriptions = {
    listAutomations: 'Find site automations by name; resolve ambiguity before editing.',
    getAutomation:
      'Read the current draft, active version and revision. Read before editing; select an existing draft explicitly.',
    getAutomationCatalog:
      'Read valid stages, templates, plans, members and properties. currentMember identifies the signed-in person. Me/myself always means this person; never ask for UUIDs. Ask named choices only for other ambiguous members.',
    getAutomationRuns: 'Read bounded recorded run statuses. Queued email is not delivery.',
    proposeAutomationCreate:
      'Prepare a visual automation draft only when requested. Use catalog IDs, never invented references. Ask for missing choices. No saving or activation occurs.',
    proposeAutomationEdit:
      'Prepare a visual edit after reading the flow and selecting draft or active base. Preserve unrelated nodes and step IDs. No saving or activation occurs.',
  };
  const definitions: ToolSet = {};
  definitions.listAutomations = tool({
    description: descriptions.listAutomations,
    inputSchema: schemas.listAutomations,
    execute: (args) => execute('listAutomations', args),
  });
  definitions.getAutomation = tool({
    description: descriptions.getAutomation,
    inputSchema: schemas.getAutomation,
    execute: (args) => execute('getAutomation', args),
  });
  definitions.getAutomationCatalog = tool({
    description: descriptions.getAutomationCatalog,
    inputSchema: schemas.getAutomationCatalog,
    execute: (args) => execute('getAutomationCatalog', args),
  });
  definitions.getAutomationRuns = tool({
    description: descriptions.getAutomationRuns,
    inputSchema: schemas.getAutomationRuns,
    execute: (args) => execute('getAutomationRuns', args),
  });
  definitions.proposeAutomationCreate = tool({
    description: descriptions.proposeAutomationCreate,
    inputSchema: schemas.proposeAutomationCreate,
    execute: (args) => execute('proposeAutomationCreate', args),
  });
  definitions.proposeAutomationEdit = tool({
    description: descriptions.proposeAutomationEdit,
    inputSchema: schemas.proposeAutomationEdit,
    execute: (args) => execute('proposeAutomationEdit', args),
  });
  return { definitions, execute, proposals };
}
