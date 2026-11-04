import { flowCatalogResponseSchema } from './automation-api';
import { z } from 'zod';
import { automationKeySchema } from './automation-keys';
import { flowDraftSchemaFor, flowIssueSchema } from './automation-flows';
import { leadTypeSchema } from './leads';

export const aiAutomationDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    definition: flowDraftSchemaFor('builtin'),
  })
  .strict();
export type AiAutomationDraft = z.infer<typeof aiAutomationDraftSchema>;
export const aiAutomationTargetSchema = z
  .object({
    key: automationKeySchema,
    expectedRevision: z.int().nonnegative(),
    base: z.enum(['draft', 'active']),
  })
  .strict();
export const aiAutomationProposalInputSchema = z
  .object({
    draft: aiAutomationDraftSchema,
    target: aiAutomationTargetSchema.optional(),
  })
  .strict();
export type AiAutomationProposalInput = z.infer<typeof aiAutomationProposalInputSchema>;
export const aiAutomationProposalSchema = z
  .object({
    id: z.uuid(),
    token: z.string().min(1).max(1000),
    expiresAt: z.iso.datetime(),
    siteName: z.string().max(160),
    draft: aiAutomationDraftSchema,
    before: aiAutomationDraftSchema.optional(),
    target: aiAutomationTargetSchema.optional(),
    issues: z.array(flowIssueSchema),
    changes: z.array(z.string().max(300)).max(100),
    catalog: flowCatalogResponseSchema.omit({ requestId: true }),
  })
  .strict();
export type AiAutomationProposal = z.infer<typeof aiAutomationProposalSchema>;
export const aiAutomationTokenRequestSchema = z
  .object({ token: z.string().min(1).max(1000) })
  .strict();
export const aiAutomationReviseRequestSchema = aiAutomationTokenRequestSchema
  .extend({ draft: aiAutomationDraftSchema })
  .strict();
export const aiAutomationSaveResponseSchema = z
  .object({ status: z.literal('saved'), key: automationKeySchema, revision: z.int().nonnegative() })
  .strict();
export type AiAutomationSaveResponse = z.infer<typeof aiAutomationSaveResponseSchema>;
export const aiAutomationScenarioSchema = z
  .object({
    leadType: leadTypeSchema,
    stage: z.string().min(1).max(80),
    planId: z.uuid().nullable(),
    assignedActorId: z.uuid().nullable(),
    properties: z
      .record(
        z.string().max(80),
        z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]),
      )
      .refine((v) => Object.keys(v).length <= 100),
  })
  .strict();
export const aiAutomationSimulateRequestSchema = aiAutomationTokenRequestSchema
  .extend({ scenario: aiAutomationScenarioSchema })
  .strict();
export const aiAutomationSimulationSchema = z
  .object({
    mode: z.literal('simulation'),
    triggerMatched: z.boolean(),
    emailsQueued: z.literal(0),
    steps: z.array(
      z.object({
        stepId: z.string(),
        stepKind: z.string(),
        outcome: z.string(),
        branch: z.string().nullable(),
        reason: z.string().nullable(),
        detail: z.string().nullable(),
        at: z.string(),
      }),
    ),
    uncoveredBranches: z.array(z.object({ stepId: z.string(), branch: z.enum(['yes', 'no']) })),
  })
  .strict();
export type AiAutomationSimulation = z.infer<typeof aiAutomationSimulationSchema>;

export type AiAutomationSimulateRequest = z.infer<typeof aiAutomationSimulateRequestSchema>;
