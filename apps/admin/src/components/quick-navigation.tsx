'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SearchIcon, ArrowUpRightIcon, UserRoundIcon } from 'lucide-react';
import { leadStageLabel, leadTypeLabel, type LeadListItem } from '@gt-sales/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
} from '@gt-sales/ui';

import { getStaffLeads } from '../lib/api';
import { describeError } from '../lib/error-text';
import { leadDisplayName } from './leads/lead-display';
import { NAV_ITEMS } from './nav-items';
import { useStaffSession } from './staff-session-provider';

/** Leads are searched once this many characters are typed, a moment after typing stops. */
const LEAD_SEARCH_MIN = 2;
const LEAD_SEARCH_DELAY_MS = 250;
const LEAD_RESULTS = 6;

type LeadSearch =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; leads: LeadListItem[]; total: number }
  | { status: 'no_access' }
  | { status: 'failed'; message: string };

const RESULT_CLASS =
  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Ctrl/Cmd K: find a lead by name, order number, email or phone (the inbox's
 * own search, this site only, active leads), or jump to a page. Members whose
 * role does not show customer details get pages only. Enter opens the first
 * result.
 */
export function QuickNavigation({
  workspaceSlug,
  workspaceId,
}: {
  workspaceSlug: string;
  workspaceId?: string;
}) {
  const router = useRouter();
  const { accessToken } = useStaffSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<LeadSearch>({ status: 'idle' });
  // Only the newest search may answer; an older reply arriving late is dropped.
  const generation = useRef(0);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const term = query.trim();
  const searchable = Boolean(accessToken && workspaceId) && term.length >= LEAD_SEARCH_MIN;
  useEffect(() => {
    const current = ++generation.current;
    if (!searchable || !accessToken || !workspaceId) {
      setSearch({ status: 'idle' });
      return;
    }
    setSearch({ status: 'searching' });
    const timer = setTimeout(() => {
      getStaffLeads(accessToken, workspaceId, {
        q: term.slice(0, 100),
        view: 'active',
        pageSize: LEAD_RESULTS,
      }).then(
        (page) => {
          if (generation.current !== current) return;
          setSearch(
            page.access.contacts
              ? { status: 'done', leads: page.leads, total: page.page.total }
              : { status: 'no_access' },
          );
        },
        (error: unknown) => {
          if (generation.current !== current) return;
          setSearch({ status: 'failed', message: describeError(error, 'search the leads') });
        },
      );
    }, LEAD_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchable, term, accessToken, workspaceId]);

  const pages = NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(term.toLowerCase()));
  const leads = search.status === 'done' ? search.leads : [];
  const leadHref = (lead: LeadListItem) => `/w/${workspaceSlug}/leads/${lead.id}`;
  const firstHref = leads[0]
    ? leadHref(leads[0])
    : pages[0]
      ? `/w/${workspaceSlug}/${pages[0].section}`
      : undefined;

  function close() {
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-9 w-10 justify-start gap-2 text-muted-foreground shadow-none sm:w-48 lg:w-56"
        onClick={() => {
          setQuery('');
          setOpen(true);
        }}
        aria-label="Search leads and pages"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="hidden min-w-0 truncate text-xs sm:inline">Search leads, pages…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border bg-muted px-1.5 text-[10px] sm:inline">
          ⌘ K
        </kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Search</DialogTitle>
            <DialogDescription>
              Find a lead by name, order number, email or phone, or go to a page.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search leads and pages"
            placeholder="Name, MS-123, email, phone or a page…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && firstHref) {
                event.preventDefault();
                close();
                router.push(firstHref);
              }
            }}
          />
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {searchable ? (
              <section aria-label="Lead results" className="flex flex-col gap-1">
                <h3 className="px-3 text-xs font-medium text-muted-foreground">Leads</h3>
                {search.status === 'searching' ? (
                  <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                    Searching…
                  </p>
                ) : search.status === 'no_access' ? (
                  <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                    Your role does not show customer details, so leads cannot be searched here.
                  </p>
                ) : search.status === 'failed' ? (
                  <p role="alert" className="px-3 py-2 text-sm text-destructive">
                    {search.message}
                  </p>
                ) : search.status === 'done' && leads.length === 0 ? (
                  <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                    No active lead matches.
                  </p>
                ) : null}
                {leads.map((lead) => (
                  <Link
                    key={lead.id}
                    href={leadHref(lead)}
                    onClick={close}
                    className={RESULT_CLASS}
                  >
                    <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {leadDisplayName(lead.contact)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[
                          lead.externalRef,
                          leadTypeLabel(lead.leadType),
                          leadStageLabel(lead.leadType, lead.stage),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
                {search.status === 'done' && search.total > leads.length ? (
                  <Link
                    href={`/w/${workspaceSlug}/leads?q=${encodeURIComponent(term.slice(0, 100))}`}
                    onClick={close}
                    className="px-3 py-1.5 text-xs text-primary hover:underline"
                  >
                    See all {search.total} matches in Leads
                  </Link>
                ) : null}
              </section>
            ) : null}
            <nav aria-label="Page results" className="flex flex-col gap-1">
              {searchable ? (
                <h3 className="px-3 text-xs font-medium text-muted-foreground">Pages</h3>
              ) : null}
              {pages.map(({ section, label, icon: Icon }) => (
                <Link
                  key={section}
                  href={`/w/${workspaceSlug}/${section}`}
                  onClick={close}
                  className={RESULT_CLASS}
                >
                  <Icon className="size-4 text-muted-foreground" />
                  {label}
                  <ArrowUpRightIcon className="ml-auto size-3.5 text-muted-foreground" />
                </Link>
              ))}
              {pages.length === 0 && !searchable ? (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  No matching pages.
                </p>
              ) : null}
            </nav>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
