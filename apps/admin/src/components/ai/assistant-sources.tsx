'use client';

import Link from 'next/link';
import { DatabaseIcon } from 'lucide-react';
import type { AiSource } from '@gt-sales/contracts';

import { dateTimeLabel } from '../../lib/dates';

/**
 * Only a server-built, site-relative path becomes a link. A value that could
 * leave the admin (`//elsewhere`, or a backslash a browser may read as one) is
 * shown as plain text instead.
 */
export function safeInternalHref(href: string): string | undefined {
  if (
    !href.startsWith('/') ||
    href.startsWith('//') ||
    href.includes('\\') ||
    Array.from(href).some((character) => character.charCodeAt(0) <= 32)
  )
    return undefined;
  return href;
}

/**
 * "Sources checked": the cards the backend produced from its own reads. The
 * model's text never decides what is linked — a card is only ever the server's
 * `sources` part, and its href is re-checked here.
 */
export function AssistantSources({ sources }: { sources: readonly AiSource[] }) {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Sources checked" className="mt-1">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <DatabaseIcon aria-hidden="true" className="size-3.5" />
        Sources checked
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {sources.map((source) => {
          const href = safeInternalHref(source.href);
          return (
            <li
              key={source.id}
              className="min-w-0 rounded-xl border border-border bg-muted/30 px-3 py-2"
            >
              {href === undefined ? (
                <p className="break-words text-xs font-medium text-foreground">{source.label}</p>
              ) : (
                <Link
                  href={href}
                  className="block break-words text-xs font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {source.label}
                </Link>
              )}
              <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                As of {dateTimeLabel(source.asOf)}
              </p>
              <p className="break-words text-[11px] text-muted-foreground">{source.scope}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
