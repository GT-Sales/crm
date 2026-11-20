import { eq } from 'drizzle-orm';
import { aiModelChoiceSchema, AI_MODEL_LIMITS, type AiModelChoice } from '@gt-sales/contracts';
import { aiModelSettings, auditEvents, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import { z } from 'zod';

import type { Scope, WriteScope } from '../tenant-scope.js';
import { DatabaseAiModelSchemaProbe, type AiModelSchemaProbe } from './model-schema.js';

/**
 * A site's Ask AI models (Settings → AI models, `app.ai_model_settings`): the
 * models its owner allows, each with the catalogue's name saved as its label,
 * and the default among them. One row per site, absent until the owner saves.
 * Every read and write runs in the site's own tenant transaction; a save
 * leaves an `ai.models_updated` audit event with the ids only.
 */
export interface StoredAiModelSettings {
  readonly allowedModels: readonly AiModelChoice[];
  readonly defaultModel: string;
  readonly updatedAt: Date;
}

export interface AiModelSettingsStore {
  /** Whether migration 0040 is applied; false when the database cannot say. */
  available(scope: Scope): Promise<boolean>;
  /** The site's saved models, or undefined when it saved none (or before 0040); rejects on a read failure. */
  get(scope: Scope): Promise<StoredAiModelSettings | undefined>;
  /** Saves the list (already checked against the catalogue) and its audit event. */
  save(
    scope: WriteScope,
    input: { allowedModels: readonly AiModelChoice[]; defaultModel: string },
  ): Promise<{ status: 'saved'; settings: StoredAiModelSettings } | { status: 'unavailable' }>;
}

const AUDIT_ACTOR_LABEL = 'staff actor';

const storedListSchema = z.array(aiModelChoiceSchema).min(1).max(AI_MODEL_LIMITS.maxAllowed);

/**
 * The stored row as members may use it. A row the database checks let
 * through but this backend cannot read (an id or label past today's bounds)
 * reads as nothing saved, so the deployment's model serves rather than a
 * model nobody checked.
 */
function toSettings(row: {
  allowedModels: unknown;
  defaultModel: string;
  updatedAt: Date;
}): StoredAiModelSettings | undefined {
  const list = storedListSchema.safeParse(row.allowedModels);
  if (!list.success) return undefined;
  if (!list.data.some((model) => model.id === row.defaultModel)) return undefined;
  return { allowedModels: list.data, defaultModel: row.defaultModel, updatedAt: row.updatedAt };
}

export class DatabaseAiModelSettingsStore implements AiModelSettingsStore {
  private readonly schema: AiModelSchemaProbe;

  constructor(
    private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
    schema?: AiModelSchemaProbe,
  ) {
    this.schema = schema ?? new DatabaseAiModelSchemaProbe(database);
  }

  available(scope: Scope): Promise<boolean> {
    return this.schema.ready(scope).catch(() => false);
  }

  async get(scope: Scope): Promise<StoredAiModelSettings | undefined> {
    if (!(await this.schema.ready(scope))) return undefined;
    return this.database.withTenantTx(scope, async (tx) => {
      const [row] = await tx
        .select({
          allowedModels: aiModelSettings.allowedModels,
          defaultModel: aiModelSettings.defaultModel,
          updatedAt: aiModelSettings.updatedAt,
        })
        .from(aiModelSettings)
        .where(eq(aiModelSettings.workspaceId, scope.workspaceId));
      return row ? toSettings(row) : undefined;
    });
  }

  async save(
    scope: WriteScope,
    input: { allowedModels: readonly AiModelChoice[]; defaultModel: string },
  ): Promise<{ status: 'saved'; settings: StoredAiModelSettings } | { status: 'unavailable' }> {
    if (!(await this.available(scope))) return { status: 'unavailable' };
    const allowedModels = input.allowedModels.map((model) => ({
      id: model.id,
      label: model.label,
    }));
    return this.database.withTenantTx(scope, async (tx) => {
      const [existing] = await tx
        .select({
          allowedModels: aiModelSettings.allowedModels,
          defaultModel: aiModelSettings.defaultModel,
        })
        .from(aiModelSettings)
        .where(eq(aiModelSettings.workspaceId, scope.workspaceId))
        .for('update');
      const now = new Date();
      const [saved] = await tx
        .insert(aiModelSettings)
        .values({
          workspaceId: scope.workspaceId,
          allowedModels,
          defaultModel: input.defaultModel,
          updatedBy: scope.actorId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: aiModelSettings.workspaceId,
          set: {
            allowedModels,
            defaultModel: input.defaultModel,
            updatedBy: scope.actorId,
            updatedAt: now,
          },
        })
        .returning({
          allowedModels: aiModelSettings.allowedModels,
          defaultModel: aiModelSettings.defaultModel,
          updatedAt: aiModelSettings.updatedAt,
        });
      const settings = saved ? toSettings(saved) : undefined;
      if (!settings) throw new Error('ai model settings upsert did not return a row');
      const ids = (list: unknown) =>
        Array.isArray(list)
          ? list.flatMap((entry: unknown) =>
              typeof entry === 'object' &&
              entry !== null &&
              'id' in entry &&
              typeof entry.id === 'string'
                ? [entry.id]
                : [],
            )
          : [];
      await tx.insert(auditEvents).values({
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        actorLabel: AUDIT_ACTOR_LABEL,
        action: 'ai.models_updated',
        entity: 'ai_model_settings',
        entityId: scope.workspaceId,
        requestId: scope.requestId,
        // Gateway model ids only: never a label, a price or anything a member typed.
        before: existing
          ? { allowedModels: ids(existing.allowedModels), defaultModel: existing.defaultModel }
          : null,
        after: {
          allowedModels: allowedModels.map((model) => model.id),
          defaultModel: input.defaultModel,
        },
      });
      return { status: 'saved' as const, settings };
    });
  }
}
