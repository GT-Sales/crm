import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';

/**
 * Ask AI's model choice (Settings → AI models): the Vercel AI Gateway models a
 * site's owner allows, the one that serves a turn nobody chose a model for,
 * and, in the composer, the member's pick among them. The backend checks every
 * id against the Gateway's own catalogue when the owner saves, and every
 * chat request's `model` against the site's saved list, so the browser never
 * names a model the server has not checked. Until migration 0040 is applied
 * nothing here is stored and Ask AI uses `AI_GATEWAY_MODEL` as before.
 */

export const AI_MODEL_LIMITS = {
  /** Models a site may allow at once. */
  maxAllowed: 8,
  /** A Gateway model id, in characters (`AI_GATEWAY_MODEL`'s own bound). */
  maxIdChars: 120,
  /** A model's label: the catalogue's name, cleaned, when it was saved. */
  maxLabelChars: 80,
  /** A catalogue entry's description, shortened to this many characters. */
  maxDescriptionChars: 240,
  /** Catalogue entries one answer holds. */
  maxCatalogue: 500,
} as const;

/**
 * A Gateway model id: `<vendor>/<model>`, letters, digits and `.`, `_`, `-`,
 * `:` only. The catalogue decides whether it exists; this only bounds what may
 * be stored, logged or sent.
 */
export const aiModelIdSchema = z
  .string()
  .min(3)
  .max(AI_MODEL_LIMITS.maxIdChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'gateway model id');
export type AiModelId = z.infer<typeof aiModelIdSchema>;

/** One allowed model as members see it: its id and the label saved with it. */
export const aiModelChoiceSchema = z.object({
  id: aiModelIdSchema,
  label: z.string().min(1).max(AI_MODEL_LIMITS.maxLabelChars),
});
export type AiModelChoice = z.infer<typeof aiModelChoiceSchema>;

/** A price in US dollars per million tokens; null when the catalogue has none. */
const pricePerMillionSchema = z.number().nonnegative().max(1_000_000).nullable();

/**
 * One language model of the Gateway catalogue, as Settings shows it: the id,
 * the catalogue's name and short description, the vendor (the id's first
 * part) and its list prices. The catalogue says nothing about tool calls, so
 * Settings says a model must support them; a turn on one that cannot is
 * refused by the Gateway (`has: ['tool-use']`) rather than answered without
 * the CRM's reads.
 */
export const aiCatalogueModelSchema = z.object({
  id: aiModelIdSchema,
  name: z.string().min(1).max(AI_MODEL_LIMITS.maxLabelChars),
  vendor: z.string().min(1).max(60),
  description: z.string().min(1).max(AI_MODEL_LIMITS.maxDescriptionChars).nullable(),
  inputPricePerMillion: pricePerMillionSchema,
  outputPricePerMillion: pricePerMillionSchema,
});
export type AiCatalogueModel = z.infer<typeof aiCatalogueModelSchema>;

/** What a site has saved: the allowed models, in the owner's order, and the default among them. */
export const aiSavedModelSettingsSchema = z.object({
  allowedModels: z.array(aiModelChoiceSchema).min(1).max(AI_MODEL_LIMITS.maxAllowed),
  defaultModel: aiModelIdSchema,
  updatedAt: isoDateTimeSchema,
});
export type AiSavedModelSettings = z.infer<typeof aiSavedModelSettingsSchema>;

/**
 * `GET /workspaces/:id/ai/model-settings` (owner only, the AI usage page's
 * action). `assistant`: whether Ask AI is on for the site, and the
 * deployment's own models (`AI_GATEWAY_MODEL`, and `AI_GATEWAY_MODEL_HIGH`
 * when High has a model of its own), ids only. `storage`: migration 0040 is
 * applied, so a list can be saved. `providers`: `AI_GATEWAY_PROVIDERS`, the
 * hosts every model must be served from (empty when unset; a model no listed
 * host serves fails). `saved`: the site's list, null until saved.
 * `catalogue`: the Gateway's language models, or `available: false` when the
 * catalogue could not be read (or Ask AI has no key here), which never
 * affects the chat. Not strict, so an older admin strips what it does not know.
 */
export const aiModelSettingsResponseSchema = z.object({
  assistant: z.object({
    enabled: z.boolean(),
    configuredModel: z.string().min(1).max(200).nullable(),
    highEffortModel: z.string().min(1).max(200).nullable(),
  }),
  storage: z.boolean(),
  providers: z.array(z.string().min(1).max(40)).max(8),
  saved: aiSavedModelSettingsSchema.nullable(),
  catalogue: z.object({
    available: z.boolean(),
    models: z.array(aiCatalogueModelSchema).max(AI_MODEL_LIMITS.maxCatalogue),
  }),
  maxAllowed: z.int().positive().max(AI_MODEL_LIMITS.maxAllowed),
  requestId: requestIdSchema,
});
export type AiModelSettingsResponse = z.infer<typeof aiModelSettingsResponseSchema>;

/**
 * `PUT /workspaces/:id/ai/model-settings`: the ids to allow (1–8, each once)
 * and the default among them. Labels are not sent: the server takes each
 * model's name from the catalogue it reads for the save. Refusals: `400
 * invalid_request` with `details.reason` `model_unavailable` (and
 * `details.modelId`) for an id the catalogue does not hold as a language
 * model; `503 ai_models_unavailable` with `details.reason` `storage` (0040 not
 * applied) or `catalogue` (the Gateway did not answer); `503 ai_unavailable`
 * when Ask AI has no key here.
 */
export const updateAiModelSettingsRequestSchema = z
  .object({
    allowedModels: z.array(aiModelIdSchema).min(1).max(AI_MODEL_LIMITS.maxAllowed),
    defaultModel: aiModelIdSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.allowedModels).size !== request.allowedModels.length) {
      context.addIssue({ code: 'custom', path: ['allowedModels'], message: 'each model once' });
    }
    if (!request.allowedModels.includes(request.defaultModel)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultModel'],
        message: 'the default must be one of the allowed models',
      });
    }
  });
export type UpdateAiModelSettingsRequest = z.infer<typeof updateAiModelSettingsRequestSchema>;

export const updateAiModelSettingsResponseSchema = z.object({
  saved: aiSavedModelSettingsSchema,
  requestId: requestIdSchema,
});
export type UpdateAiModelSettingsResponse = z.infer<typeof updateAiModelSettingsResponseSchema>;

/** Why a model setting could not be read or saved (`503 ai_models_unavailable`, `details.reason`). */
export const AI_MODELS_UNAVAILABLE_REASONS = ['storage', 'catalogue'] as const;
