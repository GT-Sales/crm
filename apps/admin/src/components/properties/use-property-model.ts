'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPropertyCatalog,
  codePropertyCatalog,
  type PlanOption,
  type PropertyCatalog,
  type PropertyModelResponse,
  type PropertyObject,
  type PropertyRow,
  type SiteProperty,
} from '@gt-sales/contracts';

import { getPropertyModel } from '../../lib/api';
import { errorReason } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

// The catalogue reads neither timestamp; a row needs them to be a row.
const ROW_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function rowFor(property: SiteProperty, position: number, object: PropertyObject): PropertyRow {
  return {
    object,
    key: property.key,
    origin: property.origin,
    label: property.label,
    kind: property.kind,
    options: [...(property.options ?? [])],
    staffOnly: property.staffOnly,
    sensitive: property.sensitive,
    hidden: property.hidden,
    websiteVisible: property.websiteVisible,
    leadTypes: [...property.leadTypes],
    position,
    version: property.version ?? 1,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

/**
 * The site's catalogue from `GET /properties`: its custom properties (in the
 * order the backend lists them) and the built-ins it relabelled or hid, laid
 * over the code catalogue, with the site's plans (`plans`, each with its lead
 * type) as the order's `plan` options, so each order type offers only its
 * own. A site that changed nothing and sells no plans reads exactly as code.
 */
export function catalogFromModel(
  properties: readonly SiteProperty[],
  object: PropertyObject = 'lead',
  plans: readonly PlanOption[] = [],
): PropertyCatalog {
  const rows: PropertyRow[] = [];
  for (const property of properties) {
    if (property.origin === 'custom') {
      rows.push(rowFor(property, rows.length, object));
      continue;
    }
    // A plan has no built-in properties; only a lead's can be relabelled or hidden.
    const code = object === 'lead' ? codePropertyCatalog.get(property.key) : undefined;
    if (code && (code.label !== property.label || code.hidden !== property.hidden)) {
      rows.push(rowFor(property, 0, object));
    }
  }
  if (object === 'plan') return buildPropertyCatalog(rows, 'plan');
  return rows.length === 0 && plans.length === 0
    ? codePropertyCatalog
    : buildPropertyCatalog(rows, 'lead', { plans });
}

interface ModelState {
  workspaceId: string;
  model?: PropertyModelResponse;
  error?: string;
}

/**
 * The site's property model, asked for once per site and kept here. Until it
 * arrives (or when it cannot be read) the catalogue is the code one, so
 * screens keep working with the built-in properties. `object` names whose
 * properties: a lead's (the default) or a plan's, whose catalogue starts empty.
 */
export function usePropertyModel(
  workspaceId: string | undefined,
  object: PropertyObject = 'lead',
): {
  model: PropertyModelResponse | undefined;
  catalog: PropertyCatalog;
  reload(): Promise<void>;
  error: string | undefined;
} {
  const { accessToken } = useStaffSession();
  // A refreshed token is not a reason to ask again.
  const token = useRef(accessToken);
  useEffect(() => {
    token.current = accessToken;
  }, [accessToken]);

  const [state, setState] = useState<ModelState>();
  const latest = useRef(0);

  const load = useCallback(
    async (id: string) => {
      const credential = token.current;
      if (!credential) return;
      const request = ++latest.current;
      try {
        const model =
          object === 'plan'
            ? await getPropertyModel(credential, id, object)
            : await getPropertyModel(credential, id);
        if (latest.current === request) setState({ workspaceId: id, model });
      } catch (caught) {
        if (latest.current !== request) return;
        setState((previous) => ({
          workspaceId: id,
          ...(previous?.workspaceId === id && previous.model ? { model: previous.model } : {}),
          error: errorReason(caught),
        }));
      }
    },
    [object],
  );

  const hasToken = Boolean(accessToken);
  useEffect(() => {
    if (workspaceId && hasToken) void load(workspaceId);
  }, [workspaceId, hasToken, load]);

  const current = state && state.workspaceId === workspaceId ? state : undefined;
  const model = current?.model;
  const catalog = useMemo(
    () =>
      model
        ? catalogFromModel(model.properties, object, model.plans)
        : object === 'plan'
          ? buildPropertyCatalog([], 'plan')
          : codePropertyCatalog,
    [model, object],
  );
  const reload = useCallback(async () => {
    if (workspaceId) await load(workspaceId);
  }, [workspaceId, load]);

  return { model, catalog, reload, error: current?.error };
}
