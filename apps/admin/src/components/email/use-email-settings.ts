'use client';

import { useMemo } from 'react';
import type { EmailSettingsResponse, SiteEmailTemplate } from '@gt-sales/contracts';

import { BackendError, getEmailSettings, listEmailTemplates } from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

const NO_TEMPLATES: readonly SiteEmailTemplate[] = [];

type Loaded =
  | { kind: 'loaded'; settings: EmailSettingsResponse; templates: readonly SiteEmailTemplate[] }
  | { kind: 'forbidden' };

/** Whether `error` is the backend refusing the caller (a 403). */
export function isForbidden(error: unknown): boolean {
  return error instanceof BackendError && error.status === 403;
}

/**
 * The site's email settings and its templates (Settings → Email), read
 * together. Until they arrive, or when they cannot be read, `settings` is
 * undefined and `error` says why; `forbidden` is true when the backend
 * refused the caller, who is then not allowed to change email settings.
 */
export function useEmailSettings(workspaceId: string | undefined): {
  settings: EmailSettingsResponse | undefined;
  templates: SiteEmailTemplate[];
  forbidden: boolean;
  reload(): Promise<void>;
  error?: string;
} {
  const { accessToken } = useStaffSession();
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? async (): Promise<Loaded> => {
            try {
              const [settings, list] = await Promise.all([
                getEmailSettings(accessToken, workspaceId),
                listEmailTemplates(accessToken, workspaceId),
              ]);
              return { kind: 'loaded', settings, templates: list.templates };
            } catch (error) {
              if (isForbidden(error)) return { kind: 'forbidden' };
              throw error;
            }
          }
        : undefined,
    [accessToken, workspaceId],
  );
  const { data, error, reload } = useResource(load);
  const loaded = data?.kind === 'loaded' ? data : undefined;
  const templates = useMemo(() => [...(loaded?.templates ?? NO_TEMPLATES)], [loaded]);

  return {
    settings: loaded?.settings,
    templates,
    forbidden: data?.kind === 'forbidden',
    reload,
    ...(error !== undefined ? { error } : {}),
  };
}
