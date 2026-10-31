import { z } from 'zod';

import { AUTOMATION_MAX_FLOWS, automationKeySchema, customFlowKeySchema } from './automation-keys';
import {
  AUTOMATION_RUN_PAGE,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_STEP_OUTCOMES,
  AUTOMATION_VERSION_STATUSES,
  FLOW_STEP_KINDS,
  FLOW_TRIGGER_KINDS,
  automationReasonSchema,
  flowDefinitionSchemaFor,
  flowDraftSchemaFor,
  flowIssueSchema,
  flowOverlapWarningSchema,
  flowTriggerSchema,
} from './automation-flows';
import { isoDateTimeSchema, requestIdSchema } from './common';
import { emailFillInNameSchema, emailTemplateKeySchema } from './customer-email';
import { leadTypeSchema } from './leads';
import { PROPERTY_KINDS, propertyKeySchema } from './properties';
import { leadStageSchema } from './workspace-leads';

/**
 * The staff API of automation flows (phase 8 spec §8), under
 * `/api/v1/staff/workspaces/:workspaceId/automations`. Reading needs
 * `workspace.read`; every change needs `integration.manage` (O6).
 *
 * A definition in a response or a draft save is parsed with the built-in
 * variant of its schema, which also takes the step `main`, so a built-in's
 * draft and active version travel like any flow's; the store checks a saved
 * draft again against the flow's own origin.
 */

const nameSchema = z.string().min(1).max(80);
const descriptionSchema = z.string().max(500);

/** A flow as the Automations list shows it. `needsAttention`: the first issue of its active version, if any. */
export const flowSummarySchema = z.object({
  key: automationKeySchema,
  origin: z.enum(['builtin', 'custom']),
  name: nameSchema,
  description: descriptionSchema.nullable(),
  enabled: z.boolean(),
  archived: z.boolean(),
  /** The active version's trigger; null before the first activation. */
  trigger: flowTriggerSchema.nullable(),
  activeVersion: z.int().positive().nullable(),
  hasDraft: z.boolean(),
  lastRunAt: isoDateTimeSchema.nullable(),
  runCount: z.int().min(0),
  needsAttention: flowIssueSchema.nullable(),
});
export type FlowSummary = z.infer<typeof flowSummarySchema>;

/** The archived flows come a page at a time: archiving has no limit. */
export const AUTOMATION_ARCHIVED_PAGE = 50;

/**
 * `?archived=1` lists the archived flows instead, most recently archived
 * first, `AUTOMATION_ARCHIVED_PAGE` at a time; `before` is the key the last
 * page ended with (its `nextBefore`).
 */
export const flowListQuerySchema = z
  .object({ archived: z.enum(['1']).optional(), before: customFlowKeySchema.optional() })
  .strict();
export type FlowListQuery = z.infer<typeof flowListQuerySchema>;

/**
 * `GET …/automations`: the site's flows (the six built-ins seeded first; at
 * most `AUTOMATION_MAX_FLOWS` are not archived), the overlap warnings (O10),
 * whether the caller may change them, whether the site has a sender, and the
 * limit. `nextBefore` pages the archived list; null otherwise.
 */
export const flowListResponseSchema = z.object({
  automations: z
    .array(flowSummarySchema)
    .max(Math.max(AUTOMATION_MAX_FLOWS, AUTOMATION_ARCHIVED_PAGE)),
  nextBefore: automationKeySchema.nullable(),
  warnings: z.array(flowOverlapWarningSchema).max(100),
  canManage: z.boolean(),
  hasSender: z.boolean(),
  limit: z.literal(AUTOMATION_MAX_FLOWS),
  requestId: requestIdSchema,
});
export type FlowListResponse = z.infer<typeof flowListResponseSchema>;

/** `POST …/automations`: a custom flow with an empty draft. */
export const createFlowRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateFlowRequest = z.infer<typeof createFlowRequestSchema>;

export const flowVersionSummarySchema = z.object({
  version: z.int().positive(),
  status: z.enum(AUTOMATION_VERSION_STATUSES),
  activatedAt: isoDateTimeSchema.nullable(),
  /** Null for a seeded built-in default, which nobody activated. */
  activatedBy: z.uuid().nullable(),
});
export type FlowVersionSummary = z.infer<typeof flowVersionSummarySchema>;

/**
 * `GET …/automations/:key` and the answer of every flow change: the flow,
 * its `revision` (the `expectedRevision` of the next change), its draft with
 * the site's warnings, its active definition and its versions, newest first.
 * A stored definition that no longer parses is served as `definition: null`
 * (the flow then needs attention, `definition_invalid`), so the page still
 * opens.
 */
export const flowDetailResponseSchema = z.object({
  automation: flowSummarySchema,
  revision: z.int().min(0),
  draft: z
    .object({
      version: z.int().positive(),
      definition: flowDraftSchemaFor('builtin').nullable(),
      issues: z.array(flowIssueSchema),
    })
    .nullable(),
  active: z
    .object({
      version: z.int().positive(),
      definition: flowDefinitionSchemaFor('builtin').nullable(),
    })
    .nullable(),
  versions: z.array(flowVersionSummarySchema).max(500),
  canManage: z.boolean(),
  requestId: requestIdSchema,
});
export type FlowDetailResponse = z.infer<typeof flowDetailResponseSchema>;

/** `PATCH …/automations/:key`: rename or describe; `description: null` clears it. */
export const updateFlowDetailsRequestSchema = z
  .object({
    expectedRevision: z.int().min(0),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type UpdateFlowDetailsRequest = z.infer<typeof updateFlowDetailsRequestSchema>;

/** `PUT …/automations/:key` (kept as phase 4 made it): switch on or off. */
export const toggleFlowRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type ToggleFlowRequest = z.infer<typeof toggleFlowRequestSchema>;

export const flowToggleResponseSchema = z.object({
  automation: flowSummarySchema,
  requestId: requestIdSchema,
});
export type FlowToggleResponse = z.infer<typeof flowToggleResponseSchema>;

/** `PUT …/automations/:key/draft`: the whole draft against the revision the editor loaded. */
export const saveFlowDraftRequestSchema = z
  .object({ expectedRevision: z.int().min(0), definition: flowDraftSchemaFor('builtin') })
  .strict();
export type SaveFlowDraftRequest = z.infer<typeof saveFlowDraftRequestSchema>;

/** `POST …/automations/:key/activate`: the draft becomes the active version. */
export const activateFlowRequestSchema = z.object({ expectedRevision: z.int().min(0) }).strict();
export type ActivateFlowRequest = z.infer<typeof activateFlowRequestSchema>;

/** `GET …/automations/:key/versions/:version`: one version, its definition shown as stored. */
export const flowVersionResponseSchema = z.object({
  version: flowVersionSummarySchema.extend({ definition: z.unknown() }),
  requestId: requestIdSchema,
});
export type FlowVersionResponse = z.infer<typeof flowVersionResponseSchema>;

/** One step's outcome in a run: keys, ids and fill-in names only. */
export const flowStepRunSchema = z.object({
  stepId: z.string(),
  stepKind: z.enum(FLOW_STEP_KINDS),
  outcome: z.enum(AUTOMATION_STEP_OUTCOMES),
  branch: z.enum(['yes', 'no']).nullable(),
  reason: automationReasonSchema.nullable(),
  detail: z.string().max(200).nullable(),
  at: isoDateTimeSchema,
});
export type FlowStepRun = z.infer<typeof flowStepRunSchema>;

/**
 * One firing of a flow for one lead. `leadName` is null without contact
 * access; `legacy` marks a phase 4 run, shown as one "Send email" step with its
 * old outcome and reason.
 */
export const flowRunSchema = z.object({
  id: z.uuid(),
  leadId: z.uuid(),
  leadName: z.string().nullable(),
  status: z.enum(AUTOMATION_RUN_STATUSES),
  reason: automationReasonSchema.nullable(),
  detail: z.string().max(200).nullable(),
  triggerKind: z.enum(FLOW_TRIGGER_KINDS).nullable(),
  version: z.int().positive().nullable(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  resumeAt: isoDateTimeSchema.nullable(),
  legacy: z.boolean(),
  steps: z.array(flowStepRunSchema).max(200),
});
export type FlowRun = z.infer<typeof flowRunSchema>;

/** `GET …/automations/:key/runs?before=<runId>`: the newest runs before that one. */
export const listFlowRunsQuerySchema = z.object({ before: z.uuid().optional() }).strict();
export type ListFlowRunsQuery = z.infer<typeof listFlowRunsQuerySchema>;

export const listFlowRunsResponseSchema = z.object({
  runs: z.array(flowRunSchema).max(AUTOMATION_RUN_PAGE),
  nextBefore: z.uuid().nullable(),
  requestId: requestIdSchema,
});
export type ListFlowRunsResponse = z.infer<typeof listFlowRunsResponseSchema>;

export const flowRunResponseSchema = z.object({ run: flowRunSchema, requestId: requestIdSchema });
export type FlowRunResponse = z.infer<typeof flowRunResponseSchema>;

/**
 * `GET …/automations/catalog`: what the editor's pickers offer. A property's
 * flags say where it may be used: in a condition, in Update lead, as a task
 * title variable, in a site-made email. A sensitive property is never listed.
 */
export const flowCatalogResponseSchema = z.object({
  leadTypes: z
    .array(
      z.object({
        key: leadTypeSchema,
        label: z.string(),
        stages: z.array(z.object({ key: leadStageSchema, label: z.string() })).max(100),
      }),
    )
    .max(50),
  templates: z
    .array(
      z.object({
        key: emailTemplateKeySchema,
        name: z.string().min(1).max(80),
        builtIn: z.boolean(),
        archived: z.boolean(),
        fillIns: z.array(emailFillInNameSchema).max(200),
      }),
    )
    .max(200),
  members: z.array(z.object({ actorId: z.uuid(), displayName: z.string().nullable() })).max(1000),
  plans: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).max(80),
        leadType: leadTypeSchema,
        active: z.boolean(),
      }),
    )
    .max(1000),
  properties: z
    .array(
      z.object({
        key: propertyKeySchema,
        label: z.string(),
        kind: z.enum(PROPERTY_KINDS),
        options: z
          .array(z.object({ value: z.string(), label: z.string() }))
          .max(1000)
          .optional(),
        leadTypes: z.array(leadTypeSchema).max(50),
        condition: z.boolean(),
        update: z.boolean(),
        taskVariable: z.boolean(),
        emailVariable: z.boolean(),
      }),
    )
    .max(500),
  taskVariables: z.array(z.string()).max(50),
  requestId: requestIdSchema,
});
export type FlowCatalogResponse = z.infer<typeof flowCatalogResponseSchema>;
