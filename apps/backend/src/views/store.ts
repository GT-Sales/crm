import { and, eq, sql } from 'drizzle-orm';
import { savedViews, withTenantTx, type DatabaseClient, type TenantContext } from '@gt-sales/db';
import {
  DEFAULT_LEAD_VIEW_STATE,
  SAVED_VIEW_LIMIT,
  savedViewStateSchema,
  type CreateSavedViewRequest,
  type SavedView,
  type SavedViewObject,
  type UpdateSavedViewRequest,
} from '@gt-sales/contracts';

/**
 * A staff member's private saved views of the leads list (spec §5.4). The
 * owner policy on `app.saved_views` already limits every statement to the
 * caller's own rows in the current site; each statement here also names
 * `workspace_id` and `actor_id` itself, so the scoping does not rest on RLS
 * alone. Views are personal, so no audit events are written for them.
 *
 * The store returns the state exactly as saved; the routes clean it against
 * the site's current catalogue before answering, and never write that back.
 */

export type CreateSavedViewOutcome =
  { kind: 'created'; view: SavedView } | { kind: 'name_taken' } | { kind: 'limit_reached' };
export type UpdateSavedViewOutcome =
  | { kind: 'updated'; view: SavedView }
  | { kind: 'not_found' }
  | { kind: 'name_taken' }
  | { kind: 'version_conflict' };
export type DeleteSavedViewOutcome = { kind: 'deleted' } | { kind: 'not_found' };

export interface SavedViewStore {
  /** The caller's own views of the object in this site, ordered by `lower(name)`. */
  list(ctx: TenantContext, object: SavedViewObject): Promise<SavedView[]>;
  create(ctx: TenantContext, input: CreateSavedViewRequest): Promise<CreateSavedViewOutcome>;
  update(
    ctx: TenantContext,
    viewId: string,
    input: UpdateSavedViewRequest,
  ): Promise<UpdateSavedViewOutcome>;
  delete(ctx: TenantContext, viewId: string): Promise<DeleteSavedViewOutcome>;
}

type SavedViewDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const defaultSavedViewDatabase: SavedViewDatabase = { withTenantTx };

const VIEW_COLUMNS = {
  id: savedViews.id,
  object: savedViews.object,
  name: savedViews.name,
  state: savedViews.state,
  version: savedViews.version,
  updatedAt: savedViews.updatedAt,
};

interface ViewRow {
  id: string;
  object: string;
  name: string;
  state: unknown;
  version: number;
  updatedAt: Date;
}

/**
 * A stored row as the API shape. The table only allows `lead` today. A
 * stored state that no longer parses (the state schema is strict and may
 * tighten) opens as the default list rather than failing the whole listing.
 */
function toSavedView(row: ViewRow): SavedView {
  if (row.object !== 'lead') throw new Error('saved view with an unknown object');
  const state = savedViewStateSchema.safeParse(row.state);
  return {
    id: row.id,
    object: row.object,
    name: row.name,
    state: state.success ? state.data : DEFAULT_LEAD_VIEW_STATE,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The caller's own row, by id, in the current site. */
function ownView(ctx: TenantContext, viewId: string) {
  return and(
    eq(savedViews.id, viewId),
    eq(savedViews.workspaceId, ctx.workspaceId),
    eq(savedViews.actorId, ctx.actorId),
  );
}

/** `saved_views_owner_name_unique`: the caller already has a view by this name (any case). */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (!('cause' in error) || typeof error.cause !== 'object' || error.cause === null) return false;
  return 'code' in error.cause && error.cause.code === '23505';
}

export class DatabaseSavedViewStore implements SavedViewStore {
  constructor(private readonly database: SavedViewDatabase = defaultSavedViewDatabase) {}

  list(ctx: TenantContext, object: SavedViewObject): Promise<SavedView[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const rows = await tx
        .select(VIEW_COLUMNS)
        .from(savedViews)
        .where(
          and(
            eq(savedViews.workspaceId, ctx.workspaceId),
            eq(savedViews.actorId, ctx.actorId),
            eq(savedViews.object, object),
          ),
        )
        .orderBy(sql`lower(${savedViews.name})`, savedViews.id);
      return rows.map(toSavedView);
    });
  }

  async create(ctx: TenantContext, input: CreateSavedViewRequest): Promise<CreateSavedViewOutcome> {
    try {
      // A failed insert aborts the transaction, so its unique violation is
      // answered here, after the rollback.
      return await this.database.withTenantTx(ctx, async (tx) => {
        // Locking the owner's rows serialises their concurrent creates
        // against the count (an aggregate cannot be locked, so the rows are).
        const owned = await tx
          .select({ id: savedViews.id })
          .from(savedViews)
          .where(
            and(
              eq(savedViews.workspaceId, ctx.workspaceId),
              eq(savedViews.actorId, ctx.actorId),
              eq(savedViews.object, input.object),
            ),
          )
          .for('update');
        if (owned.length >= SAVED_VIEW_LIMIT) return { kind: 'limit_reached' };
        const [row] = await tx
          .insert(savedViews)
          .values({
            workspaceId: ctx.workspaceId,
            actorId: ctx.actorId,
            object: input.object,
            name: input.name,
            state: input.state,
          })
          .returning(VIEW_COLUMNS);
        if (!row) throw new Error('saved view insert returned no row');
        return { kind: 'created', view: toSavedView(row) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'name_taken' };
      throw error;
    }
  }

  async update(
    ctx: TenantContext,
    viewId: string,
    input: UpdateSavedViewRequest,
  ): Promise<UpdateSavedViewOutcome> {
    try {
      return await this.database.withTenantTx(ctx, async (tx) => {
        const [row] = await tx
          .update(savedViews)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.state === undefined ? {} : { state: input.state }),
            version: sql`${savedViews.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(and(ownView(ctx, viewId), eq(savedViews.version, input.expectedVersion)))
          .returning(VIEW_COLUMNS);
        if (row) return { kind: 'updated', view: toSavedView(row) };
        const [current] = await tx
          .select({ id: savedViews.id })
          .from(savedViews)
          .where(ownView(ctx, viewId));
        return current ? { kind: 'version_conflict' } : { kind: 'not_found' };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'name_taken' };
      throw error;
    }
  }

  delete(ctx: TenantContext, viewId: string): Promise<DeleteSavedViewOutcome> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const removed = await tx
        .delete(savedViews)
        .where(ownView(ctx, viewId))
        .returning({ id: savedViews.id });
      return removed.length > 0 ? { kind: 'deleted' } : { kind: 'not_found' };
    });
  }
}
