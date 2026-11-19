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
import { decideAiAccess } from '../routes/ai-assistant.js';
import { decideAccess, type StaffAccessSnapshot } from '../staff/authorization.js';
import { canSeeLeadDetails } from '../staff/lead-visibility.js';
import { TurnBudget } from './limits.js';
import { NAME_MAX, REFERENCE_MAX } from './projections.js';
import type { SourceRegistry } from './sources.js';
import {
  RECORD_DATA_NOTICE,
  inertRecordLines,
  inertRecordText,
  neutralizeSerialized,
} from './record-text.js';
import { AutomationAuthoringError, type AutomationAuthoringStore } from './automation-authoring.js';

function countRecords(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, item) => n + 1 + countRecords(item), 0);
  if (value && typeof value === 'object')
    return Object.values(value).reduce<number>((n, item) => n + countRecords(item), 0);
  return 0;
}
/** The longest string an automation read hands the model (a flow's description). */
const AUTOMATION_TEXT_MAX = 2000;

/**
 * Every string of an automation read, cleaned as record text (C12): flow
 * names and descriptions, template, plan and property names and members'
 * display names were typed by people. Keys and ids hold no such characters,
 * so they come through unchanged.
 */
function inertDeep(value: unknown): unknown {
  if (typeof value === 'string') return inertRecordLines(value, AUTOMATION_TEXT_MAX) ?? '';
  if (Array.isArray(value)) return value.map(inertDeep);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inertDeep(item)]));
  return value;
}

/** The read tools, offered to every Ask AI user as the staff routes allow with `workspace.read`. */
export const AUTOMATION_READ_TOOL_NAMES = [
  'listAutomations',
  'getAutomation',
  'getAutomationCatalog',
  'getAutomationRuns',
] as const;
export type AutomationReadToolName = (typeof AUTOMATION_READ_TOOL_NAMES)[number];

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
  /**
   * False for the read-only set every Ask AI user gets (the four read tools,
   * `decideAiAccess` at each call); true or absent for authoring, which keeps
   * `integration.manage` on every tool as before.
   */
  authoring?: boolean;
  /** The signing key and store a proposal needs; authoring only. */
  key?: string;
  flows: FlowStore;
  store?: AutomationAuthoringStore;
  /**
   * A run's lead by its reference and name, for members who see lead
   * details; active, unrestricted leads only, so a restricted lead's run
   * names nobody.
   */
  leadLabels?: (
    leadIds: readonly string[],
  ) => Promise<ReadonlyMap<string, { reference: string | null; name: string | null }>>;
  /**
   * The turn's source cards: a run's lead that is named gets its lead card,
   * as every other read that names a lead does, so a stored answer that
   * names it is never replayed once the lead is restricted and is found by
   * the erasure (docs/design/ai-chat.md, audit B2).
   */
  sources?: Pick<SourceRegistry, 'lead'>;
  loadAccess(): Promise<StaffAccessSnapshot | undefined>;
  now(): Date;
  budget: TurnBudget;
}) {
  const authoring = input.authoring !== false;
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
    const readOnly = AUTOMATION_READ_TOOL_NAMES.some((toolName) => toolName === name);
    if (!authoring && !readOnly) return JSON.stringify({ status: 'not_available' });
    if (
      authoring
        ? !decideAccess(access, 'workspace.read').allowed ||
          !decideAccess(access, 'integration.manage').allowed
        : !decideAiAccess(access).allowed
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
          // A run's lead by reference and name only for members who see lead
          // details, and only while that lead is active and unrestricted.
          const shown = runs?.runs.slice(0, 10) ?? [];
          const labels =
            input.leadLabels && canSeeLeadDetails(access)
              ? await input.leadLabels(shown.map((r) => r.leadId))
              : undefined;
          for (const run of shown) {
            const label = labels?.get(run.leadId);
            if (label === undefined) continue;
            input.sources?.lead(
              run.leadId,
              inertRecordText(label.reference, REFERENCE_MAX) ??
                inertRecordText(label.name, NAME_MAX) ??
                'Lead',
              `${input.site.name} · automation run`,
            );
          }
          result = {
            runs: runs?.runs.slice(0, 10).map((r) => {
              const label = labels?.get(r.leadId);
              return {
                id: r.id,
                status: r.status,
                reason: r.reason,
                version: r.version,
                resumeAt: r.resumeAt,
                ...(label === undefined
                  ? {}
                  : {
                      leadReference: inertRecordText(label.reference, REFERENCE_MAX),
                      leadName: inertRecordText(label.name, NAME_MAX),
                    }),
              };
            }),
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
          const authoringStore = input.store;
          const key = input.key;
          if (authoringStore === undefined || key === undefined)
            return JSON.stringify({ status: 'not_available' });
          preparing.add(proposalKey);
          let proposal: AiAutomationProposal;
          try {
            proposal = await authoringStore.prepare(
              { ...input.scope, requestId: crypto.randomUUID() },
              normalized,
              input.site.name,
              key,
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
    // Labelled and cleaned as every other tool result is (C12).
    const cleaned = inertDeep(result);
    const text = neutralizeSerialized(
      JSON.stringify(
        cleaned !== null && typeof cleaned === 'object' && !Array.isArray(cleaned)
          ? { ...cleaned, notice: RECORD_DATA_NOTICE }
          : cleaned,
      ),
    );
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
  if (authoring) {
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
  }
  return { definitions, execute, proposals, authoring };
}
