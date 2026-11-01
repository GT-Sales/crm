'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SearchIcon, ArrowUpRightIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
} from '@gt-sales/ui';
import { NAV_ITEMS } from './nav-items';

export function QuickNavigation({ workspaceSlug }: { workspaceSlug: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
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
        aria-label="Find a page"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="hidden min-w-0 truncate text-xs sm:inline">Search pages...</span>
        <kbd className="ml-auto hidden shrink-0 rounded border bg-muted px-1.5 text-[10px] sm:inline">
          ⌘ K
        </kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Go to a page</DialogTitle>
            <DialogDescription>Jump to a section of this site.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Find a page"
            placeholder="Search pages..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <nav aria-label="Page results" className="flex flex-col gap-1">
            {NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).map(
              ({ section, label, icon: Icon }) => (
                <Link
                  key={section}
                  href={`/w/${workspaceSlug}/${section}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  {label}
                  <ArrowUpRightIcon className="ml-auto size-3.5 text-muted-foreground" />
                </Link>
              ),
            )}
            {!NAV_ITEMS.some((item) => item.label.toLowerCase().includes(query.toLowerCase())) ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                No matching pages.
              </p>
            ) : null}
          </nav>
        </DialogContent>
      </Dialog>
    </>
  );
}
