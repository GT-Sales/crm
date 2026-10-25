'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeadListItem, LeadStatus, PageInfo } from '@gt-sales/contracts';
import { Badge, Button } from '@gt-sales/ui';

import { BackendError, getStaffLeads } from '../lib/api';
import { useStaffSession } from './staff-session-provider';

const STATUS_FILTERS: readonly { label: string; value: LeadStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Incomplete', value: 'incomplete' },
  { label: 'Submitted', value: 'submitted' },
];

function contactLabel(contact: LeadListItem['contact']): string {
  return contact.fullName ?? contact.email ?? contact.phone ?? '—';
}

/** Every present attribution field, for a hover tooltip beyond the short source label. */
function attributionDetail(attribution: LeadListItem['attribution']): string {
  const entries = Object.entries(attribution).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return 'No attribution captured.';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function LeadsList({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const accessToken = staff.accessToken;

  const [statusFilter, setStatusFilter] = useState<LeadStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<PageInfo>({ page: 1, pageSize: 25, total: 0 });
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!accessToken || !workspaceId) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await getStaffLeads(accessToken, workspaceId, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        page,
        pageSize: 25,
      });
      if (requestVersion.current !== version) return;
      setLeads(result.leads);
      setPageInfo(result.page);
    } catch (error) {
      if (requestVersion.current !== version) return;
      setMessage(
        `Could not load leads. Reason: ${error instanceof BackendError ? error.code : 'internal_error'}.`,
      );
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [accessToken, workspaceId, statusFilter, page]);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersion.current += 1;
    };
  }, [refresh]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => {
              setStatusFilter(filter.value);
              setPage(1);
            }}
            aria-pressed={statusFilter === filter.value}
            className={`rounded-full border px-3 py-1 text-sm ${
              statusFilter === filter.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-foreground'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : leads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No leads yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground uppercase">
                <th className="py-2 pr-4 font-medium">Contact</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{contactLabel(lead.contact)}</td>
                  <td className="py-2 pr-4">
                    <code className="text-xs" title={lead.externalRef ?? undefined}>
                      {lead.leadType}
                    </code>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge variant={lead.status === 'submitted' ? 'default' : 'secondary'}>
                      {lead.status}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4">
                    <code className="text-xs" title={attributionDetail(lead.attribution)}>
                      {lead.source}
                    </code>
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {new Date(lead.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label="Lead pages" className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {pageInfo.page} of {Math.max(1, Math.ceil(pageInfo.total / pageInfo.pageSize))} ·{' '}
          {pageInfo.total} lead(s)
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || page * pageInfo.pageSize >= pageInfo.total}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </Button>
      </nav>

      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
